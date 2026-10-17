-- SiteLog · after a call: hang-ups, the fallback recording and the post-call reconcile (W3-11;
-- spec §7.2 "Call: hang-up before confirmation", §7.3 `fallback_recording`, F6 failure handling,
-- F9, §10.1 `post_call_reconcile`, §10.2 calls, §10.5 step 2, §10.9, §19 Q122, Q123, Q152, Q153,
-- Q162, Q176)
--
-- The worker's `post_call_reconcile` job (`post_call:<call>`, queued by voice_call_end() and
-- voice-events' backstop) writes through these; each is one transaction, audited, and safe to run
-- again (the job retries).
--
--   1. report_sources.value_path, start_s, end_s: the precise call seconds of a value of the
--      confirmed version (`manpower[1]`, `weather.periods[0]`), written by the reconcile when the
--      recording agrees (§10.9 "attach precise timestamps as sources"); one row per report, call
--      and path. The call's own source row (path null) is unchanged. P7 plays these seconds.
--   2. calls.reconcile: how the call's reconcile went (`equal`, `mismatch`, `unreconciled`), when,
--      and what it compared; null until then.
--   3. job_lock_key(): `no_photo_check` under the report's key (as the other report jobs).
--   4. post_call_settle(): a call that ended before the yes (§19 Q122). With a report value in its
--      draft: outcome `draft_saved`, the call's open question handed to the web (`channel 'web'`,
--      F7 on the recorder); the worker then continues the draft on the web (decide_next with
--      `finish_report`). With none: outcome `abandoned`; a report the call alone made is voided
--      and its site-day goes back to the status it had before the call (the reminder ladder and
--      the missing alert run again), no text.
--   5. post_call_recording(): the recording's two-lane peaks (`{reporter, agent}`, W3-01) and
--      duration, and the reporter lane's batch transcript, which replaces the live row
--      (`transcripts.call_id`, §19 Q162; the live segments stay in the turns' inputs).
--   6. post_call_fallback_report(): F6's simple recording mode: the call's recording is a voice
--      note of today's report of its site (created with channel 'voice', or merged, §7.2), the
--      call one source of it, the report processing and `extract_report` queued
--      (`extract:<report>:call:<call>`); the web flow then shows the draft (`draft_ready`).
--   7. post_call_reconciled(): the reconcile's outcome on the filed report: the precise seconds
--      (1), the `call_mismatch:<path>:<heard>:<confirmed>` reasons with the §13 review notice,
--      `calls.reconcile`; the confirmed version itself never changes.
--   8. post_call_unreconciled(): a reconcile that cannot run (no recording, its job dead): the
--      filed report gets `call_unreconciled` (§19 Q123, Q153) and the review notice.
--   9. report_no_photo_check(): §10.5 step 2: a report with a call source and no photo at 23:59
--      site time gets `no_photo` and the review notice.
--
-- Every function is service-role only (the worker); no office user or field device calls them.
--
-- Live database (staging): three nullable columns and a check on report_sources, one partial
-- unique index on a column that is null on every row, one nullable column on calls, one queue
-- function replaced with one more job type, seven new functions (service only). The deployed
-- v1.0 code touches none of them.

set local lock_timeout = '5s';

-- 1. report_sources: precise call seconds ---------------------------------------------------------------
alter table report_sources
  add column value_path text
    check (value_path is null or value_path ~ '^[a-zA-Z]+(\[[0-9]{1,4}\]|\.[a-zA-Z]+){0,6}$'),
  add column start_s numeric check (start_s is null or start_s >= 0),
  add column end_s numeric check (end_s is null or end_s >= 0),
  add constraint report_sources_precise_check check (
    value_path is null
    or (call_id is not null and start_s is not null and (end_s is null or end_s >= start_s)));

create unique index report_sources_call_value_key on report_sources (report_id, call_id, value_path)
  where value_path is not null;

comment on column report_sources.value_path is
  'W3-11 (§10.9): the value of the confirmed version these precise call seconds are of (manpower[1], weather.periods[0]); null on the call''s own source row.';

-- 2. calls.reconcile ---------------------------------------------------------------------------------------
alter table calls
  add column reconcile jsonb check (reconcile is null or jsonb_typeof(reconcile) = 'object');

comment on column calls.reconcile is
  'W3-11 (§10.9, §19 Q123): the post-call reconcile: {status equal|mismatch|unreconciled, at, mismatches, precise, compared, reason?}.';

-- 3. Queue: no_photo_check under the report's key ---------------------------------------------------------
create or replace function job_lock_key(p_type text, p_payload jsonb) returns text
language sql stable security definer set search_path = public as $$
  with report as (
    select case
      when p_type in ('extract_report', 'decide_next', 'file_report', 'render_pdf', 'parse_answer',
                      'apply_correction', 'voice_turn', 'no_photo_check')
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

-- A report flag and the §13 review notice, once (the reason already there changes nothing).
create function post_call_flag(
  p_report reports, p_reasons text[], p_action text, p_detail jsonb,
  p_title text, p_body text, p_data jsonb
) returns text[]
language plpgsql security definer set search_path = public as $$
declare v_added text[];
begin
  select coalesce(array_agg(x order by o), '{}') into v_added
    from unnest(p_reasons) with ordinality as t(x, o)
   where x is not null and x <> '' and not (x = any (p_report.review_reasons));
  if cardinality(v_added) = 0 then
    return v_added;
  end if;
  update reports set needs_review = true, review_reasons = review_reasons || v_added
   where id = p_report.id;
  perform notify_org(p_report.org_id, 'needs_review', p_title, p_body, '/reports/' || p_report.id,
                     null, p_data);
  perform log_audit(p_report.org_id, 'system', null, p_action, 'report', p_report.id,
                    coalesce(p_detail, '{}'::jsonb) || jsonb_build_object('reasons', to_jsonb(v_added)));
  return v_added;
end $$;

-- 4. post_call_settle --------------------------------------------------------------------------------------
create function post_call_settle(p_call_id uuid, p_has_value boolean)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  c calls%rowtype;
  r reports%rowtype;
  sd site_days%rowtype;
  v_outcome call_outcome;
  v_action text;
  v_handed int := 0;
  v_others int;
  v_from site_day_status;
begin
  if p_has_value is null then
    raise exception 'invalid_request' using errcode = 'P0001';
  end if;
  select * into c from calls where id = p_call_id for update;
  if c.id is null then
    raise exception 'call_not_found' using errcode = 'P0002';
  end if;
  if c.ended_at is null then
    raise exception 'call_not_ended' using errcode = 'P0001';
  end if;

  if c.report_id is null then
    -- Nothing was drafted on the call: too little said (§19 Q122).
    v_action := 'none';
    v_outcome := 'abandoned';
  else
    -- field_complete_upload()'s lock order: the site-day, then the report.
    perform 1 from site_days where id = (select site_day_id from reports where id = c.report_id)
      for update;
    select * into r from reports where id = c.report_id for update;
    if r.status in ('filed', 'signed_off', 'void') then
      return jsonb_build_object('action', 'closed', 'outcome', c.outcome, 'reportId', r.id,
                                'status', r.status);
    end if;
    -- The yes went through and the filing is queued or running: nothing to continue.
    if exists (select 1 from jobs where type = 'file_report' and payload ->> 'reportId' = r.id::text
                                   and status in ('queued', 'running')) then
      return jsonb_build_object('action', 'filing', 'outcome', c.outcome, 'reportId', r.id,
                                'status', r.status);
    end if;
    if p_has_value then
      -- §19 Q122: the draft continues on the web; the call's open question is now the web's
      -- (the recorder answers only `web` questions, F7).
      v_outcome := 'draft_saved';
      v_action := 'continue';
      update questions set channel = 'web'
       where report_id = r.id and call_id = c.id and answered_at is null and channel = 'voice';
      get diagnostics v_handed = row_count;
      if v_handed > 0 then
        perform log_audit(r.org_id, 'system', null, 'report.questions_handed_to_web', 'report', r.id,
          jsonb_build_object('call_id', c.id, 'questions', v_handed));
      end if;
    else
      v_outcome := 'abandoned';
      select count(*) into v_others from report_sources
       where report_id = r.id and call_id is distinct from c.id;
      if v_others = 0 then
        -- The call alone made this report and said nothing for it: no draft (§19 Q122). The
        -- report goes; the site-day returns to its status before the call, so the reminder
        -- ladder and the missing alert run as if the call had not happened.
        update reports set status = 'void' where id = r.id;
        perform log_audit(r.org_id, 'system', null, 'report.status_changed', 'report', r.id,
          jsonb_build_object('from', r.status, 'to', 'void', 'reason', 'call_abandoned',
                             'call_id', c.id));
        select * into sd from site_days where id = r.site_day_id;
        select (a.diff ->> 'from')::site_day_status into v_from
          from audit_log a
         where a.entity = 'site_day' and a.entity_id = sd.id and a.action = 'site_day.status_changed'
           and a.diff ->> 'call_id' = c.id::text and a.diff ->> 'to' = 'processing'
         order by a.id desc limit 1;
        if v_from is not null and sd.status = 'processing'
           and not exists (select 1 from reports x where x.site_day_id = sd.id and x.status <> 'void') then
          update site_days set status = v_from where id = sd.id;
          perform log_audit(r.org_id, 'system', null, 'site_day.status_changed', 'site_day', sd.id,
            jsonb_build_object('from', 'processing', 'to', v_from, 'reason', 'call_abandoned',
                               'call_id', c.id, 'report_id', r.id));
        end if;
        v_action := 'voided';
      else
        -- Other sources (a voice note, an earlier call) keep the report as it was.
        v_action := 'kept';
      end if;
    end if;
  end if;

  if c.outcome is distinct from v_outcome then
    update calls set outcome = v_outcome where id = c.id;
    perform log_audit(c.org_id, 'system', null, 'call.outcome_settled', 'call', c.id,
      jsonb_build_object('from', c.outcome, 'to', v_outcome, 'report_id', c.report_id,
                         'action', v_action));
  end if;
  return jsonb_build_object('action', v_action, 'outcome', v_outcome, 'reportId', c.report_id,
                            'status', case when v_action = 'voided' then 'void' else r.status::text end,
                            'handed', v_handed);
end $$;

-- 5. post_call_recording -----------------------------------------------------------------------------------
create function post_call_recording(
  p_call_id uuid, p_peaks jsonb, p_duration_s numeric, p_transcript jsonb
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  c calls%rowtype;
  v_replaced text;
begin
  select * into c from calls where id = p_call_id for update;
  if c.id is null then
    raise exception 'call_not_found' using errcode = 'P0002';
  end if;
  if (p_peaks is not null
      and (jsonb_typeof(p_peaks) <> 'object' or jsonb_typeof(p_peaks -> 'reporter') <> 'array'
           or jsonb_typeof(p_peaks -> 'agent') <> 'array'))
     or (p_duration_s is not null and p_duration_s < 0)
     or (p_transcript is not null
         and (jsonb_typeof(p_transcript -> 'text') is distinct from 'string'
              or jsonb_typeof(p_transcript -> 'segments') is distinct from 'array'
              or jsonb_typeof(p_transcript -> 'model') is distinct from 'string')) then
    raise exception 'invalid_request' using errcode = 'P0001';
  end if;
  update calls set
      peaks = coalesce(p_peaks, peaks),
      duration_s = coalesce(round(p_duration_s)::int, duration_s)
    where id = c.id;
  if p_transcript is not null then
    select model into v_replaced from transcripts where call_id = c.id;
    -- §19 Q162: the batch transcript of the reporter lane replaces the live row.
    insert into transcripts (call_id, language, text, segments, model)
    values (c.id, p_transcript ->> 'language', p_transcript ->> 'text', p_transcript -> 'segments',
            p_transcript ->> 'model')
    on conflict (call_id) do update
      set language = excluded.language, text = excluded.text, segments = excluded.segments,
          model = excluded.model;
  end if;
  perform log_audit(c.org_id, 'system', null, 'call.recording_processed', 'call', c.id,
    jsonb_build_object('duration_s', p_duration_s, 'peaks', p_peaks is not null,
                       'transcript_model', p_transcript ->> 'model',
                       'segments', jsonb_array_length(coalesce(p_transcript -> 'segments', '[]'::jsonb)),
                       'replaced', v_replaced));
  return jsonb_build_object('stored', true, 'replaced', v_replaced);
end $$;

-- 6. post_call_fallback_report -----------------------------------------------------------------------------
create function post_call_fallback_report(p_call_id uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  c calls%rowtype;
  s sites%rowtype;
  sd site_days%rowtype;
  r reports%rowtype;
  v_date date;
  v_from report_status;
  v_created boolean := false;
  v_job bigint;
begin
  select * into c from calls where id = p_call_id for update;
  if c.id is null then
    raise exception 'call_not_found' using errcode = 'P0002';
  end if;
  if c.ended_at is null or c.outcome is distinct from 'fallback_recording' then
    raise exception 'invalid_request' using errcode = 'P0001';
  end if;
  if c.reporter_id is null or c.org_id is null then
    raise exception 'unknown_caller' using errcode = 'P0001';
  end if;
  if c.site_id is null then
    -- F14: the site was never picked; nothing names the report (the office hears the call).
    perform log_audit(c.org_id, 'system', null, 'call.fallback_unused', 'call', c.id,
      jsonb_build_object('reason', 'site_required'));
    return jsonb_build_object('status', 'site_required');
  end if;
  select * into s from sites where id = c.site_id;
  v_date := (coalesce(c.started_at, c.created_at) at time zone s.timezone)::date;
  sd := field_lock_site_day(s.id, v_date);
  select * into r from reports where site_day_id = sd.id and status <> 'void'
   order by created_at limit 1 for update;
  if (r.id is not null and r.status in ('filed', 'signed_off'))
     or (r.id is null and sd.status in ('filed', 'weather_day', 'no_work'))
     or (r.id is not null and exists (
           select 1 from jobs where type = 'file_report' and payload ->> 'reportId' = r.id::text
                                and status in ('queued', 'running'))) then
    perform log_audit(c.org_id, 'system', null, 'call.fallback_unused', 'call', c.id,
      jsonb_build_object('reason', 'report_closed', 'report_id', r.id));
    return jsonb_build_object('status', 'report_closed', 'reportId', r.id);
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
                         'status', r.status, 'call_id', c.id, 'fallback', true));
  elsif r.status <> 'processing' then
    -- §7.2: more audio puts the report back to processing.
    v_from := r.status;
    update reports set status = 'processing' where id = r.id returning * into r;
    perform log_audit(s.org_id, 'reporter', c.reporter_id, 'report.status_changed', 'report', r.id,
      jsonb_build_object('from', v_from, 'to', 'processing', 'call_id', c.id, 'fallback', true));
  end if;
  if not exists (select 1 from report_sources where report_id = r.id and call_id = c.id) then
    insert into report_sources (report_id, kind, call_id, taken_at)
    values (r.id, 'call', c.id, coalesce(c.answered_at, c.started_at, now()));
  end if;
  update calls set report_id = r.id, site_day_id = sd.id where id = c.id;
  if sd.status in ('pending', 'reminded', 'missing') then
    update site_days set status = 'processing' where id = sd.id;
    perform log_audit(s.org_id, 'reporter', c.reporter_id, 'site_day.status_changed', 'site_day',
      sd.id, jsonb_build_object('from', sd.status, 'to', 'processing', 'report_id', r.id,
                                'call_id', c.id));
  end if;
  v_job := enqueue_job('extract_report', jsonb_build_object('reportId', r.id, 'reason', 'call:' || c.id),
                       null, 'extract:' || r.id || ':call:' || c.id);
  perform log_audit(c.org_id, 'system', null, 'call.fallback_report', 'call', c.id,
    jsonb_build_object('report_id', r.id, 'job_id', v_job, 'report_created', v_created));
  return jsonb_build_object('status', 'queued', 'reportId', r.id, 'jobId', v_job,
                            'created', v_created);
end $$;

-- 7. post_call_reconciled ----------------------------------------------------------------------------------
create function post_call_reconciled(
  p_call_id uuid, p_report_id uuid, p_reasons text[], p_precise jsonb, p_result jsonb,
  p_title text, p_body text, p_data jsonb
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  c calls%rowtype;
  r reports%rowtype;
  v_added text[] := '{}';
  v_rows int := 0;
  v_status text;
begin
  if jsonb_typeof(p_precise) is distinct from 'array' or jsonb_typeof(p_result) is distinct from 'object'
     or p_reasons is null
     or exists (select 1 from unnest(p_reasons) x where x !~ '^call_mismatch:[^:]*:[^:]*:[^:]*$') then
    raise exception 'invalid_request' using errcode = 'P0001';
  end if;
  select * into c from calls where id = p_call_id for update;
  if c.id is null then
    raise exception 'call_not_found' using errcode = 'P0002';
  end if;
  if c.report_id is distinct from p_report_id then
    raise exception 'invalid_request' using errcode = 'P0001';
  end if;
  if c.reconcile is not null then
    return jsonb_build_object('repeat', true, 'status', c.reconcile ->> 'status', 'added', '[]'::jsonb);
  end if;
  select * into r from reports where id = p_report_id for update;
  if r.id is null or r.status not in ('filed', 'signed_off') then
    raise exception 'report_not_filed' using errcode = 'P0001';
  end if;

  -- §10.9 "Equal → attach precise timestamps as sources": beside the confirmed version.
  insert into report_sources (report_id, kind, call_id, taken_at, value_path, start_s, end_s)
  select r.id, 'call', c.id,
         coalesce(c.answered_at, c.started_at, c.created_at) + (e ->> 'start')::numeric * interval '1 second',
         e ->> 'path', (e ->> 'start')::numeric, (e ->> 'end')::numeric
    from jsonb_array_elements(p_precise) e
  on conflict (report_id, call_id, value_path) where value_path is not null do nothing;
  get diagnostics v_rows = row_count;

  -- Different → keep the confirmed version, flag it for the office (never a silent change).
  if cardinality(p_reasons) > 0 then
    v_added := post_call_flag(r, p_reasons, 'report.call_mismatch',
                              jsonb_build_object('call_id', c.id), p_title, p_body, p_data);
  end if;
  v_status := case when cardinality(p_reasons) > 0 then 'mismatch' else 'equal' end;
  update calls set reconcile = p_result || jsonb_build_object('status', v_status, 'at', now())
   where id = c.id;
  perform log_audit(c.org_id, 'system', null, 'call.reconciled', 'call', c.id,
    jsonb_build_object('report_id', r.id, 'status', v_status, 'mismatches', cardinality(p_reasons),
                       'precise', v_rows));
  return jsonb_build_object('repeat', false, 'status', v_status, 'added', to_jsonb(v_added),
                            'precise', v_rows);
end $$;

-- 8. post_call_unreconciled --------------------------------------------------------------------------------
create function post_call_unreconciled(
  p_call_id uuid, p_reason text, p_title text, p_body text, p_data jsonb
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  c calls%rowtype;
  r reports%rowtype;
  v_added text[] := '{}';
begin
  if p_reason is null or p_reason !~ '^[a-z_]{1,40}$' then
    raise exception 'invalid_request' using errcode = 'P0001';
  end if;
  select * into c from calls where id = p_call_id for update;
  if c.id is null then
    raise exception 'call_not_found' using errcode = 'P0002';
  end if;
  if c.reconcile ->> 'status' in ('equal', 'mismatch', 'unreconciled') then
    return jsonb_build_object('changed', false, 'status', c.reconcile ->> 'status');
  end if;
  select * into r from reports where id = c.report_id for update;
  if r.id is not null and r.status in ('filed', 'signed_off') then
    v_added := post_call_flag(r, array['call_unreconciled'], 'report.call_unreconciled',
                              jsonb_build_object('call_id', c.id, 'reason', p_reason),
                              p_title, p_body, p_data);
  end if;
  update calls set reconcile = jsonb_build_object('status', 'unreconciled', 'reason', p_reason,
                                                  'at', now())
   where id = c.id;
  perform log_audit(c.org_id, 'system', null, 'call.unreconciled', 'call', c.id,
    jsonb_build_object('reason', p_reason, 'report_id', r.id, 'flagged', cardinality(v_added) > 0));
  return jsonb_build_object('changed', true, 'status', 'unreconciled', 'added', to_jsonb(v_added));
end $$;

-- 9. report_no_photo_check ---------------------------------------------------------------------------------
create function report_no_photo_check(p_report_id uuid, p_title text, p_body text, p_data jsonb)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  r reports%rowtype;
  v_photos int;
  v_added text[] := '{}';
begin
  select * into r from reports where id = p_report_id for update;
  if r.id is null then
    raise exception 'report_not_found' using errcode = 'P0002';
  end if;
  if r.status = 'void' or r.kind <> 'daily'
     or not exists (select 1 from report_sources where report_id = r.id and kind = 'call') then
    return jsonb_build_object('flagged', false, 'reason', 'not_a_call_report');
  end if;
  select count(*) into v_photos from report_sources where report_id = r.id and kind = 'photo';
  if v_photos = 0 then
    select coalesce(jsonb_array_length(v.data -> 'photos'), 0) into v_photos
      from report_versions v where v.report_id = r.id and v.version = r.current_version;
  end if;
  if coalesce(v_photos, 0) > 0 then
    return jsonb_build_object('flagged', false, 'reason', 'photos');
  end if;
  v_added := post_call_flag(r, array['no_photo'], 'report.no_photo',
                            jsonb_build_object('report_no', r.report_no), p_title, p_body, p_data);
  return jsonb_build_object('flagged', cardinality(v_added) > 0, 'reason', 'no_photo');
end $$;

revoke execute on function post_call_flag(reports, text[], text, jsonb, text, text, jsonb),
  post_call_settle(uuid, boolean),
  post_call_recording(uuid, jsonb, numeric, jsonb),
  post_call_fallback_report(uuid),
  post_call_reconciled(uuid, uuid, text[], jsonb, jsonb, text, text, jsonb),
  post_call_unreconciled(uuid, text, text, text, jsonb),
  report_no_photo_check(uuid, text, text, jsonb)
  from public, anon, authenticated;
grant execute on function post_call_settle(uuid, boolean),
  post_call_recording(uuid, jsonb, numeric, jsonb),
  post_call_fallback_report(uuid),
  post_call_reconciled(uuid, uuid, text[], jsonb, jsonb, text, text, jsonb),
  post_call_unreconciled(uuid, text, text, text, jsonb),
  report_no_photo_check(uuid, text, text, jsonb)
  to service_role;
