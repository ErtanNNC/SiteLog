-- SiteLog · the read-back, the spoken yes, fixes and filing on a call (W3-10; spec F6 steps 5–7,
-- F8 call, F9 step 1, §7.2 `awaiting_confirmation → filed` on "yes (call)", §9.4 rule 5, §9.5
-- `confirm`, §10.6, §10.12, §13, §19 Q118, Q119, Q151)
--
--   1. voice_turns.kind takes `apply_correction` (F8 on a call): a change said on the call runs in
--      the worker as a live turn, like `update_draft` and `record_answer` (§19 Q117).
--   2. voice_turn_submit(): the `apply_correction` branch: the call's report (the one its turns
--      made), still open (not filed, signed off, void, nor being filed), the reporter's words
--      appended to the dialog log; refused `draft_required` before the call has a draft. The other
--      two branches are as in 20261016000330.
--   3. voice_file_report() (service role, field-api's `file_report`): code decided whether the
--      reporter's verbatim last utterance is a §9.5 confirm (`p_confirmed`, `isCallConfirm`, §19
--      Q119: no model takes part); under the call's, the site-day's and the report's locks (the
--      order voice_turn_submit() and field_complete_upload() take):
--      - the report must be the call's (`out_of_scope`); filed already → `filed` (a retry after the
--        filing gets the same answer, §19 Q151);
--      - not a confirm → `not_confirmed` (audited `call.file_refused`): the agent asks "Shall I
--        file it? Say yes or no.";
--      - the draft is not awaiting confirmation at the revision the read-back was made from →
--        `draft_changed` (audited `call.file_refused`): field-api reads the draft back again;
--      - else the filing of that version and revision: a filing already queued or running for it
--        is returned (`queued`, a retry waits for it: §19 Q151), otherwise `file_report`
--        (`trigger 'confirm'`, `via 'voice'`, the version and revision) under
--        `file:<report>:v<n>:r<rev>:call:<call>` (`…:c<n>` after one that finished without filing,
--        as field_confirm_report()), audited `report.confirm_requested` with channel `voice`, the
--        call and the words said. The worker files only that revision (`report.confirm_stale`
--        otherwise) and sends `filed` and, after a call, `photos_link` (F9) through the Notifier.
--
-- Live database (staging): a check constraint swapped for a wider one on a W3-09 table, one
-- function body replaced (same signature, grants kept), one new function (service role only).
-- The deployed v1.0 code touches none of them.

set local lock_timeout = '5s';

-- 1. voice_turns.kind ----------------------------------------------------------------------------------------
alter table voice_turns drop constraint voice_turns_kind_check;
alter table voice_turns add constraint voice_turns_kind_check
  check (kind in ('update_draft', 'record_answer', 'apply_correction'));

-- 2. voice_turn_submit with apply_correction -------------------------------------------------------------------
create or replace function voice_turn_submit(p_call_id uuid, p_kind text, p_key text, p_input jsonb)
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
  if p_kind is null or p_kind not in ('update_draft', 'record_answer', 'apply_correction')
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
  elsif p_kind = 'record_answer' then
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
  else
    -- W3-10 apply_correction (F8 on a call): a change of the call's draft, said on the call.
    if jsonb_typeof(p_input -> 'utterance') is distinct from 'string'
       or jsonb_typeof(p_input -> 'start') is distinct from 'number'
       or (p_input ? 'end' and jsonb_typeof(p_input -> 'end') is distinct from 'number') then
      raise exception 'invalid_request' using errcode = 'P0001';
    end if;
    select * into r from reports where id = c.report_id for update;
    if r.id is null then
      raise exception 'draft_required' using errcode = 'P0001';
    end if;
    if r.status in ('filed', 'signed_off', 'void') then
      raise exception 'report_closed' using errcode = 'P0001';
    end if;
    -- Confirmed and being filed (the yes went through): nothing changes the confirmed draft.
    if exists (select 1 from jobs where type = 'file_report' and payload ->> 'reportId' = r.id::text
                                    and status in ('queued', 'running')) then
      raise exception 'report_closed' using errcode = 'P0001';
    end if;
    update calls set dialog_log = coalesce(dialog_log, '[]'::jsonb) || jsonb_build_array(
        jsonb_build_object('t', (p_input ->> 'start')::numeric, 'speaker', 'reporter',
                           'text', left(p_input ->> 'utterance', 4000), 'tool', 'apply_correction'))
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

-- 3. voice_file_report ---------------------------------------------------------------------------------------
create function voice_file_report(p_call_id uuid, p_report_id uuid, p_draft_rev int,
                                  p_utterance text, p_confirmed boolean)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  c calls%rowtype;
  r reports%rowtype;
  v_rev int;
  v_job bigint;
  v_status job_status;
  v_n int;
  v_key text;
  v_requeued boolean := false;
  v_said text := left(coalesce(p_utterance, ''), 200);
begin
  if p_report_id is null or p_draft_rev is null or p_confirmed is null or p_utterance is null then
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
  -- Only the report this call's turns made (its site and day, §9.4 scoping).
  if c.report_id is distinct from p_report_id then
    raise exception 'out_of_scope' using errcode = 'P0001';
  end if;
  -- field_complete_upload()'s lock first: no voice note or photo joins between the check and the
  -- enqueue, and a second request waits for the first.
  perform 1 from site_days where id = (select site_day_id from reports where id = p_report_id)
    for update;
  select * into r from reports where id = p_report_id for update;
  if r.id is null or r.status = 'void' then
    raise exception 'report_closed' using errcode = 'P0001';
  end if;
  -- §19 Q151: a request after the filing (a retry, the agent asking again) gets the same answer.
  if r.status in ('filed', 'signed_off') then
    return jsonb_build_object('status', 'filed', 'reportNo', r.report_no);
  end if;
  select draft_rev into v_rev from report_versions
   where report_id = r.id and version = r.current_version for share;

  -- §19 Q119: code decided the words were not a confirm; the agent asks again.
  if not p_confirmed then
    perform log_audit(c.org_id, 'reporter', c.reporter_id, 'call.file_refused', 'call', c.id,
      jsonb_build_object('report_id', r.id, 'reason', 'not_confirmed', 'draft_rev', p_draft_rev,
                         'utterance', v_said));
    return jsonb_build_object('status', 'not_confirmed', 'reportNo', r.report_no);
  end if;
  -- The yes is for the draft that was read back: a newer draft (a turn, a photo's re-extraction)
  -- is read back again.
  if r.status <> 'awaiting_confirmation' or v_rev is distinct from p_draft_rev then
    perform log_audit(c.org_id, 'reporter', c.reporter_id, 'call.file_refused', 'call', c.id,
      jsonb_build_object('report_id', r.id, 'reason', 'draft_changed', 'draft_rev', p_draft_rev,
                         'current_draft_rev', v_rev, 'status', r.status, 'utterance', v_said));
    return jsonb_build_object('status', 'draft_changed', 'reportNo', r.report_no,
                              'draftRev', v_rev, 'reportStatus', r.status);
  end if;

  -- A filing already queued or running for this draft (the agent's retry, a web confirm of the
  -- same revision): that one files; this request waits for it (§19 Q151).
  select id into v_job from jobs
   where type = 'file_report' and payload ->> 'reportId' = r.id::text
     and status in ('queued', 'running')
     and not (payload ? 'draftRev'
              and (payload ->> 'version' is distinct from r.current_version::text
                   or payload ->> 'draftRev' is distinct from p_draft_rev::text))
   order by id limit 1;
  if v_job is not null then
    return jsonb_build_object('status', 'queued', 'jobId', v_job, 'reportNo', r.report_no);
  end if;

  v_key := 'file:' || r.id || ':v' || r.current_version || ':r' || p_draft_rev || ':call:' || c.id;
  v_job := enqueue_job('file_report',
    jsonb_build_object('reportId', r.id, 'trigger', 'confirm', 'version', r.current_version,
                       'draftRev', p_draft_rev, 'via', 'voice'), null, v_key);
  select status into v_status from jobs where id = v_job;
  if v_status = 'dead' then
    -- The draft's filing died (six failed attempts): this yes runs it again.
    v_requeued := requeue_dead_job(v_job);
  elsif v_status in ('done', 'failed') then
    -- That job finished without filing (a stale confirm): this yes is a new occurrence.
    select count(*) into v_n from audit_log
     where entity = 'report' and entity_id = r.id and action = 'report.confirm_requested';
    loop
      v_n := v_n + 1;
      v_job := enqueue_job('file_report',
        jsonb_build_object('reportId', r.id, 'trigger', 'confirm', 'version', r.current_version,
                           'draftRev', p_draft_rev, 'via', 'voice'), null, v_key || ':c' || v_n);
      select status into v_status from jobs where id = v_job;
      exit when v_status in ('queued', 'running');
      if v_status = 'dead' then
        v_requeued := requeue_dead_job(v_job);
        exit;
      end if;
      if v_n > 10000 then
        raise exception 'voice_file_report: no free filing key for report %', r.id;
      end if;
    end loop;
  end if;
  perform log_audit(r.org_id, 'reporter', c.reporter_id, 'report.confirm_requested', 'report', r.id,
    jsonb_build_object('job_id', v_job, 'version', r.current_version, 'draft_rev', p_draft_rev,
                       'channel', 'voice', 'call_id', c.id, 'utterance', v_said)
      || case when v_requeued then jsonb_build_object('requeued', true) else '{}'::jsonb end);
  return jsonb_build_object('status', 'queued', 'jobId', v_job, 'reportNo', r.report_no);
end $$;

revoke execute on function voice_file_report(uuid, uuid, int, text, boolean) from public, anon, authenticated;
grant execute on function voice_file_report(uuid, uuid, int, text, boolean) to service_role;
