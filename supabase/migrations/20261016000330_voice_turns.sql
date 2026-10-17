-- SiteLog · the live draft on a call (W3-09; spec §4.3 B step 3, §7.2, §9.4 `update_draft` /
-- `record_answer`, §10.4 live mode, §10.5, §19 Q117, Q151)
--
--   1. voice_turns: one live tool turn of a call. field-api (for the voice agent) submits it, the
--      worker's `voice_turn` job runs it with the worker's prompts, validation and code-computed
--      totals (§19 Q117: one prompt, one validator, one place where totals are computed) and
--      writes its answer in `result`, which field-api waits for (VOICE_TOOL_WAIT_MS, ≤ 15 s). The
--      same words of a call are one turn (`turn_key`, SHA-256 of the tool and its words), so the
--      agent's retry, or its call again after a `pending` answer, waits for the first run (§19
--      Q151) instead of starting a second extraction. Service role only.
--   2. voice_turn_submit(): in one transaction, under the site-day's lock as the recorder's
--      uploads take it:
--      - `update_draft`: today's report of the call's site created (channel 'voice', status
--        processing; audited `report.created`) or merged (§7.2: a second call or a voice note the
--        same day joins the report: back to processing), the call as one report source (kind
--        'call', one per report and call), the reporter's lane so far as the call's live
--        transcript (`transcripts.call_id`, model 'live'; a shorter, older copy never replaces a
--        longer one), the reporter's new lines appended to `calls.dialog_log`, the call's report
--        and site-day, the site-day processing (§7.1);
--      - `record_answer`: the call's open question (asked on this call) of its report, which
--        awaits the answer; the answer line appended to the dialog log;
--      then the turn and its `voice_turn` job (`voice_turn:<turn>`; a turn the worker failed runs
--      again on the agent's next request, `voice_turn:<turn>:<attempt>`), audited `call.turn`.
--      Refusals: `call_not_found`, `call_ended`, `unknown_caller`, `site_required` (F14: the site
--      first), `report_closed` (today's report is filed, being filed, or the day was closed as no
--      work or weather), `question_closed`, `invalid_request`.
--   3. job_priority(): `voice_turn` before everything (-1): someone is on the phone.
--      job_lock_key(): `voice_turn` under the report's key, so a turn never runs beside an
--      extraction, an answer or a filing of the same report.
--
-- Live database (staging): one new table (service only) and one new function (service only); two
-- queue functions replaced with one more job type each. The deployed v1.0 code touches none of
-- them.

set local lock_timeout = '5s';

-- 1. voice_turns ----------------------------------------------------------------------------------------------
create table voice_turns (
  id uuid primary key default gen_random_uuid(),
  call_id uuid not null references calls on delete cascade,
  report_id uuid not null references reports on delete cascade,
  kind text not null check (kind in ('update_draft', 'record_answer')),
  turn_key text not null check (turn_key ~ '^[0-9a-f]{64}$'),
  input jsonb not null check (jsonb_typeof(input) = 'object'),
  status text not null default 'pending' check (status in ('pending', 'done', 'failed')),
  result jsonb,
  error text,
  attempts int not null default 1 check (attempts >= 1),
  created_at timestamptz not null default now(),
  finished_at timestamptz,
  unique (call_id, kind, turn_key)
);

alter table voice_turns enable row level security;
revoke all on voice_turns from anon, authenticated;

comment on table voice_turns is
  'W3-09 (§19 Q117): a live tool turn of a call (update_draft, record_answer), run by the worker''s voice_turn job while field-api waits for its result.';

-- 2. voice_turn_submit ------------------------------------------------------------------------------------------
create function voice_turn_submit(p_call_id uuid, p_kind text, p_key text, p_input jsonb)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  c calls%rowtype;
  s sites%rowtype;
  sd site_days%rowtype;
  r reports%rowtype;
  q questions%rowtype;
  t voice_turns%rowtype;
  v_segments jsonb;
  v_lines jsonb;
  v_text text;
  v_last numeric;
  v_heard numeric;
  v_date date;
  v_from report_status;
  v_created boolean := false;
  v_job bigint;
begin
  if p_kind is null or p_kind not in ('update_draft', 'record_answer')
     or p_key is null or p_key !~ '^[0-9a-f]{64}$'
     or jsonb_typeof(p_input) is distinct from 'object' then
    raise exception 'invalid_request' using errcode = 'P0001';
  end if;
  select * into c from calls where id = p_call_id for update;
  if c.id is null then
    raise exception 'call_not_found' using errcode = 'P0002';
  end if;
  if c.ended_at is not null then
    raise exception 'call_ended' using errcode = 'P0001';
  end if;
  if c.reporter_id is null or c.org_id is null then
    raise exception 'unknown_caller' using errcode = 'P0001';
  end if;
  if c.site_id is null then
    raise exception 'site_required' using errcode = 'P0001';
  end if;

  -- The same words again (the agent's retry, or its call after `pending`): the same turn. A turn
  -- the worker failed runs again as its next attempt.
  select * into t from voice_turns
   where call_id = c.id and kind = p_kind and turn_key = p_key for update;
  if t.id is not null then
    if t.status = 'failed' then
      update voice_turns set status = 'pending', error = null, finished_at = null,
                             attempts = attempts + 1
       where id = t.id returning * into t;
      v_job := enqueue_job('voice_turn', jsonb_build_object('turnId', t.id, 'reportId', t.report_id),
                           null, 'voice_turn:' || t.id || ':' || t.attempts);
      perform log_audit(c.org_id, 'agent', null, 'call.turn', 'call', c.id,
        jsonb_build_object('turn_id', t.id, 'kind', t.kind, 'report_id', t.report_id,
                           'attempt', t.attempts, 'job_id', v_job));
    end if;
    return jsonb_build_object('turnId', t.id, 'reportId', t.report_id, 'status', t.status,
                              'result', t.result, 'error', t.error, 'repeat', true);
  end if;

  if p_kind = 'update_draft' then
    v_segments := p_input -> 'segments';
    if jsonb_typeof(v_segments) is distinct from 'array' or jsonb_array_length(v_segments) = 0
       or exists (select 1 from jsonb_array_elements(v_segments) e
                   where jsonb_typeof(e) <> 'object' or jsonb_typeof(e -> 'start') <> 'number'
                      or jsonb_typeof(e -> 'end') <> 'number' or jsonb_typeof(e -> 'text') <> 'string') then
      raise exception 'invalid_request' using errcode = 'P0001';
    end if;
    select * into s from sites where id = c.site_id;
    -- The call's day: the site's local date when the call started (as call_site_day()).
    v_date := (coalesce(c.started_at, now()) at time zone s.timezone)::date;
    sd := field_lock_site_day(s.id, v_date);
    select * into r from reports where site_day_id = sd.id and status <> 'void'
     order by created_at limit 1 for update;
    if r.id is not null and r.status in ('filed', 'signed_off') then
      raise exception 'report_closed' using errcode = 'P0001';
    end if;
    if r.id is null and sd.status in ('filed', 'weather_day', 'no_work') then
      raise exception 'report_closed' using errcode = 'P0001';
    end if;
    -- Confirmed and being filed: nothing joins the draft the reporter confirmed.
    if r.id is not null and exists (
         select 1 from jobs where type = 'file_report' and payload ->> 'reportId' = r.id::text
                              and status in ('queued', 'running')) then
      raise exception 'report_closed' using errcode = 'P0001';
    end if;

    if r.id is null then
      insert into reports (org_id, site_id, site_day_id, report_no, status, kind, reporter_id,
                           received_at, channel, language)
      values (s.org_id, s.id, sd.id, next_report_no(s.id), 'processing', 'daily', c.reporter_id,
              now(), 'voice', org_report_language(s.org_id))
      returning * into r;
      v_created := true;
      perform log_audit(s.org_id, 'reporter', c.reporter_id, 'report.created', 'report', r.id,
        jsonb_build_object('report_no', r.report_no, 'date', v_date, 'channel', 'voice',
                           'status', r.status, 'call_id', c.id));
    elsif r.status <> 'processing' then
      -- §7.2: the reporter talking again puts the report back to processing (a question, a draft).
      v_from := r.status;
      update reports set status = 'processing' where id = r.id returning * into r;
      perform log_audit(s.org_id, 'reporter', c.reporter_id, 'report.status_changed', 'report', r.id,
        jsonb_build_object('from', v_from, 'to', 'processing', 'call_id', c.id));
    end if;

    -- The call is one source of the report, however many turns it has.
    if not exists (select 1 from report_sources where report_id = r.id and call_id = c.id) then
      insert into report_sources (report_id, kind, call_id, taken_at)
      values (r.id, 'call', c.id, coalesce(c.answered_at, c.started_at, now()));
    end if;

    -- The reporter's lane so far: the call's live transcript (W3-11's batch transcript of the
    -- recording comes after the call). An older, shorter copy never replaces a longer one.
    select string_agg(btrim(e ->> 'text'), ' ' order by o),
           jsonb_agg(jsonb_build_object('start', (e ->> 'start')::numeric, 'end', (e ->> 'end')::numeric,
                                        'speaker', 'reporter', 'text', e ->> 'text') order by o),
           max((e ->> 'end')::numeric)
      into v_text, v_lines, v_last
      from jsonb_array_elements(v_segments) with ordinality as x(e, o);
    insert into transcripts (call_id, language, text, segments, model)
    values (c.id, c.language, coalesce(v_text, ''), v_lines, 'live')
    on conflict (call_id) do update
      set text = excluded.text, segments = excluded.segments, language = excluded.language
      where transcripts.model = 'live'
        and coalesce((select max((x.e ->> 'end')::numeric)
                        from jsonb_array_elements(transcripts.segments) as x(e)), 0) <= v_last;

    -- The reporter's new lines in the call's dialog log (end_call writes the whole log at the end).
    select coalesce(max((d ->> 't')::numeric), -1) into v_heard
      from jsonb_array_elements(coalesce(c.dialog_log, '[]'::jsonb)) as d
     where d ->> 'speaker' = 'reporter';
    update calls set
        report_id = r.id,
        site_day_id = sd.id,
        dialog_log = coalesce(dialog_log, '[]'::jsonb) || coalesce((
          select jsonb_agg(jsonb_build_object('t', (e ->> 'start')::numeric, 'speaker', 'reporter',
                                              'text', left(e ->> 'text', 4000), 'tool', 'update_draft')
                           order by o)
            from jsonb_array_elements(v_segments) with ordinality as x(e, o)
           where (e ->> 'start')::numeric > v_heard), '[]'::jsonb)
      where id = c.id;

    -- §7.1: the reporter talking starts the day's processing (a late call too: missing → processing).
    if sd.status in ('pending', 'reminded', 'missing') then
      update site_days set status = 'processing' where id = sd.id;
      perform log_audit(s.org_id, 'reporter', c.reporter_id, 'site_day.status_changed', 'site_day',
        sd.id, jsonb_build_object('from', sd.status, 'to', 'processing', 'report_id', r.id,
                                  'call_id', c.id));
    end if;
  else
    -- record_answer: the open question this call asked, of the call's report, awaiting the answer.
    if jsonb_typeof(p_input -> 'questionId') is distinct from 'string'
       or (p_input ->> 'questionId') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       or jsonb_typeof(p_input -> 'utterance') is distinct from 'string'
       or jsonb_typeof(p_input -> 'start') is distinct from 'number' then
      raise exception 'invalid_request' using errcode = 'P0001';
    end if;
    select * into r from reports where id = c.report_id for update;
    if r.id is null then
      raise exception 'question_closed' using errcode = 'P0001';
    end if;
    if r.status in ('filed', 'signed_off', 'void') then
      raise exception 'report_closed' using errcode = 'P0001';
    end if;
    select * into q from questions
     where id = (p_input ->> 'questionId')::uuid and report_id = r.id for update;
    if q.id is null or q.answered_at is not null or q.call_id is distinct from c.id
       or r.status <> 'awaiting_answer' then
      raise exception 'question_closed' using errcode = 'P0001';
    end if;
    update calls set dialog_log = coalesce(dialog_log, '[]'::jsonb) || jsonb_build_array(
        jsonb_build_object('t', (p_input ->> 'start')::numeric, 'speaker', 'reporter',
                           'text', left(p_input ->> 'utterance', 4000), 'tool', 'record_answer'))
      where id = c.id;
  end if;

  insert into voice_turns (call_id, report_id, kind, turn_key, input)
  values (c.id, r.id, p_kind, p_key, p_input)
  returning * into t;
  v_job := enqueue_job('voice_turn', jsonb_build_object('turnId', t.id, 'reportId', r.id), null,
                       'voice_turn:' || t.id);
  perform log_audit(c.org_id, 'agent', null, 'call.turn', 'call', c.id,
    jsonb_build_object('turn_id', t.id, 'kind', p_kind, 'report_id', r.id, 'job_id', v_job,
                       'report_created', v_created,
                       'segments', case when p_kind = 'update_draft'
                                        then jsonb_array_length(v_segments) end,
                       'question_id', case when p_kind = 'record_answer' then q.id end));
  return jsonb_build_object('turnId', t.id, 'reportId', r.id, 'status', t.status, 'result', null,
                            'error', null, 'repeat', false);
end $$;

revoke execute on function voice_turn_submit(uuid, text, text, jsonb) from public, anon, authenticated;
grant execute on function voice_turn_submit(uuid, text, text, jsonb) to service_role;

-- 3. Queue: voice_turn first, under the report's lock -------------------------------------------------------
create or replace function job_lock_key(p_type text, p_payload jsonb) returns text
language sql stable security definer set search_path = public as $$
  with report as (
    select case
      when p_type in ('extract_report', 'decide_next', 'file_report', 'render_pdf', 'parse_answer',
                      'apply_correction', 'voice_turn')
           and p_payload ->> 'reportId' ~ '^[0-9a-f-]{36}$'
        then (p_payload ->> 'reportId')::uuid
      when p_type = 'transcribe_upload' and p_payload ->> 'uploadId' ~ '^[0-9a-f-]{36}$'
        then (select u.report_id from uploads u where u.id = (p_payload ->> 'uploadId')::uuid)
      when p_type = 'post_call_reconcile' and p_payload ->> 'callId' ~ '^[0-9a-f-]{36}$'
        then (select c.report_id from calls c where c.id = (p_payload ->> 'callId')::uuid)
    end as id
  )
  select case
    when p_type in ('inbound_message', 'transcribe_audio', 'parse_reply')
         and p_payload ->> 'messageId' ~ '^[0-9a-f-]{36}$'
      then (select 'convo:' || m.conversation_id from messages m
             where m.id = (p_payload ->> 'messageId')::uuid and m.conversation_id is not null)
    -- W1-08: one phone's inbound texts one at a time, oldest first; W2-12: their keywords too;
    -- W2-16: its WhatsApp messages and their answers.
    when p_type in ('sms_inbound', 'sms_keyword', 'whatsapp_answer')
         and p_payload ->> 'messageId' ~ '^[0-9a-f-]{36}$'
      then (select 'sms:' || m.phone_e164 from messages m
             where m.id = (p_payload ->> 'messageId')::uuid and m.phone_e164 is not null)
    when (select id from report) is not null
      -- WhatsApp (until step 22): the reporter's conversation, so a photo sent meanwhile waits.
      then coalesce(
        (select 'convo:' || c.id from reports r
           join reporters rp on rp.id = r.reporter_id
           join conversations c on c.phone_e164 = rp.phone_e164
          where r.id = (select id from report)
          limit 1),
        'report:' || (select id from report))
  end;
$$;

create or replace function job_priority(p_type text) returns int
language sql immutable set search_path = public as $$
  select case
    -- W3-09: a live tool of a call; the reporter is on the phone, waiting for the answer.
    when p_type = 'voice_turn' then -1
    -- Messages and calls to and from the reporter.
    when p_type in ('inbound_message', 'sms_inbound', 'sms_keyword', 'send_message', 'send_template',
                    'send_welcome', 'send_sms', 'notify', 'place_call') then 0
    -- The next step of a report someone is waiting for, its PDF and its email.
    when p_type in ('parse_reply', 'decide_next', 'file_report', 'render_pdf', 'send_email',
                    'parse_answer', 'transcribe_test_clip', 'apply_correction',
                    'whatsapp_answer') then 1
    -- Transcription and extraction.
    when p_type in ('transcribe_audio', 'extract_report', 'transcribe_upload',
                    'post_call_reconcile') then 2
    -- Background: weather, evidence packs, digests, retention and anything else.
    when p_type in ('fetch_weather', 'build_evidence_pack') then 3
    else 3
  end;
$$;
