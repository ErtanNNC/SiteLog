-- SiteLog · special requests on a call, consent asked on a first call, unknown callers (W3-14;
-- spec F3 step 2, F6 "Special intents during the call", F10 call, F12 call, F13, F15 call, §9.4
-- rule 6, §9.5, §19 Q79, Q81, Q99, Q120, Q124, Q128, Q129, Q136)
--
--   1. reporters.no_calls_until (§19 Q129): "not today" said on a call (and, with W3-17, from
--      Settings) sets the end of that day in the org's time zone; the ladder then sends the
--      messages a link reporter gets (W3-17 reads it).
--      calls.consent_declined_at (§19 Q120): the reporter said no to the consent question on this
--      call; nothing more of it is processed and its recording is deleted (field-api refuses the
--      upload without the recording consent; W3-11's post_call skips such a call).
--      draft_corrections.call_id: a change of a filed report said on a call (F10 call), whose
--      words cite the call's seconds (`source` set at request, `{type: 'call'}`).
--   2. voice_report_day_off() (F12 call, service role): field_report_day_off() for a call, after
--      code read the day off back and the reporter said yes (field-api's `isCallConfirm`, the
--      model never decides): the call's site and day (site time at the call's start), the same
--      refusals (§19 Q79: `report_in_progress` while a report is live, `report_filed`), a paused
--      site refused (`site_inactive`); the report (weather always, no work with no_work_pdf) with
--      channel `voice`, the call as its one source (`report_sources` kind `call`), version 1 built
--      in code with every value citing the call second, author `reporter` via `voice`, and its
--      file_report (`file:<report>:v1:<status>`); audited with the call and the words.
--   3. voice_request_filed_correction() (F10 call): sms_request_filed_correction() for the words
--      said on a call about a filed report `load_report` found: a site the call's reporter covers,
--      within the 14 days, the site active, one change at a time; the same words of the same call
--      again are the same correction (the agent asking again after `pending`).
--   4. voice_save_filed_correction() (F10 call): field_save_filed_correction() for that preview,
--      only after the reporter's yes to "Save it?" (`p_confirmed`, code's verdict on the words;
--      a refusal is audited `call.save_refused`): version n+1 author `reporter` via `voice`, the
--      signer told, render_pdf with the "Updated" email and `edit_applied`.
--   5. voice_record_consent() (F3 call, §19 Q120): yes stores `recording`, `data_processing` and
--      `sms` (each one not held, `voice_yes`, the wording's version, the call id and second as
--      evidence), audited `consent.given` via voice, and activates an invited reporter; no marks
--      the call (`consent_declined_at`), audited `consent.declined`, and answers whether texts
--      were consented before (field-api texts the link only then) and the recording path to delete.
--   6. voice_no_calls_today() (§19 Q129): no_calls_until, audited reporter.preferences_changed.
--   7. voice_unknown_caller() (F13, §19 Q124): the caller's 160-character snippet on
--      `unknown_contacts` (channel voice, the call, the org guessed only when the number's history
--      is in exactly one real org of the pack, §19 Q44), once per call; audited
--      unknown_contact.created. voice_unknown_recording(): the recording's path outside every org's
--      folder (`unknown/{call}.ogg`).
--   8. purge_unknown_callers() (§19 Q124, the worker's retention_cleanup): an unknown caller's
--      contact older than 30 days that the office did not link is deleted, with the call's
--      dialog log and recording path; the recording paths are returned for the storage delete.
--
-- Every function is service-role only (field-api, the worker). Live database (staging): three
-- nullable columns, no rewrite; eight new functions. The deployed code touches none of them.

set local lock_timeout = '5s';

-- 1. Columns --------------------------------------------------------------------------------------------------
alter table reporters add column no_calls_until timestamptz;
comment on column reporters.no_calls_until is
  'Spec §19 Q129 (W3-14): no automated calls until this instant (the end of the day "not today" was said, org time zone).';

alter table calls add column consent_declined_at timestamptz;
comment on column calls.consent_declined_at is
  'Spec §19 Q120 (W3-14): the reporter said no to the consent question on this call; nothing of it is processed.';

alter table draft_corrections add column call_id uuid references calls on delete set null;
comment on column draft_corrections.call_id is
  'W3-14 (F10 call): the call a change of a filed report was said on; its words cite the call seconds.';

-- 2. voice_report_day_off -------------------------------------------------------------------------------------
create function voice_report_day_off(
  p_call_id uuid, p_status text, p_details jsonb, p_data jsonb, p_utterance text
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  c calls%rowtype;
  s sites%rowtype;
  sd site_days%rowtype;
  r reports%rowtype;
  v_date date;
  v_make boolean;
  v_job bigint;
  v_said text := left(coalesce(p_utterance, ''), 200);
begin
  if p_status is null or p_status not in ('no_work', 'weather_day') then
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
  select * into s from sites where id = c.site_id;
  if s.status <> 'active' then
    raise exception 'site_inactive' using errcode = 'P0001';
  end if;
  -- The call's day: the site's local date when the call started (as voice_turn_submit()).
  v_date := (coalesce(c.started_at, now()) at time zone s.timezone)::date;
  sd := field_lock_site_day(s.id, v_date);
  if sd.status::text = p_status then
    -- Logged before (the agent's retry, a second yes): what the first one made.
    select * into r from reports where id = sd.report_id and kind = p_status;
    return jsonb_build_object('siteDayId', sd.id, 'status', sd.status, 'changed', false,
      'report', case when r.id is null then null
                     else jsonb_build_object('id', r.id, 'reportNo', r.report_no) end);
  end if;
  select * into r from reports where site_day_id = sd.id and status <> 'void'
   order by created_at limit 1;
  if r.id is not null and r.status in ('filed', 'signed_off') then
    raise exception 'report_filed' using errcode = 'P0001';
  end if;
  if r.id is not null then
    -- §19 Q79 (decided: keep refusing): the day's report is on its way; it is said in the report.
    raise exception 'report_in_progress' using errcode = 'P0001';
  end if;
  if sd.status not in ('pending', 'reminded') then
    raise exception 'wrong_state' using errcode = 'P0001';
  end if;

  v_make := p_status = 'weather_day'
    or coalesce((select no_work_pdf from org_settings where org_id = c.org_id), false);
  if v_make then
    if jsonb_typeof(p_data) is distinct from 'object' or p_data ->> 'schemaVersion' is distinct from '2' then
      raise exception 'invalid_day_off_data' using errcode = 'P0001';
    end if;
    insert into reports (org_id, site_id, site_day_id, report_no, status, kind, reporter_id,
                         received_at, channel, language, current_version)
    values (s.org_id, s.id, sd.id, next_report_no(s.id), 'processing', p_status,
            c.reporter_id, now(), 'voice', org_report_language(s.org_id), 1)
    returning * into r;
    insert into report_sources (report_id, kind, call_id, taken_at)
    values (r.id, 'call', c.id, coalesce(c.answered_at, c.started_at, now()));
    insert into report_versions (report_id, version, data, summary, author, via)
    values (r.id, 1, p_data, nullif(p_data ->> 'summary', ''), 'reporter', 'voice');
    v_job := enqueue_job('file_report', jsonb_build_object('reportId', r.id, 'trigger', p_status),
                         null, 'file:' || r.id || ':v1:' || p_status);
    perform log_audit(s.org_id, 'reporter', c.reporter_id, 'report.created', 'report', r.id,
      jsonb_build_object('report_no', r.report_no, 'date', v_date, 'channel', 'voice',
                         'kind', p_status, 'status', r.status, 'call_id', c.id, 'job_id', v_job));
  end if;

  update site_days set status = p_status::site_day_status, report_id = coalesce(r.id, report_id)
   where id = sd.id;
  update calls set report_id = coalesce(r.id, report_id), site_day_id = sd.id where id = c.id;
  perform log_audit(s.org_id, 'reporter', c.reporter_id, 'site_day.' || p_status, 'site_day', sd.id,
    jsonb_build_object('from', sd.status, 'to', p_status, 'date', v_date, 'channel', 'voice',
                       'details', coalesce(p_details, '{}'::jsonb), 'report_id', r.id,
                       'call_id', c.id, 'utterance', v_said));
  return jsonb_build_object('siteDayId', sd.id, 'status', p_status, 'changed', true,
    'report', case when r.id is null then null
                   else jsonb_build_object('id', r.id, 'reportNo', r.report_no) end);
end $$;

-- 3. voice_request_filed_correction ---------------------------------------------------------------------------
create function voice_request_filed_correction(
  p_call_id uuid, p_report_id uuid, p_text text, p_start numeric, p_end numeric default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  c calls%rowtype;
  r reports%rowtype;
  s sites%rowtype;
  d draft_corrections%rowtype;
  v_text text := left(btrim(coalesce(p_text, '')), 1000);
  v_date date;
  v_job bigint;
  v_source jsonb;
begin
  if v_text = '' or p_start is null or p_start < 0 or (p_end is not null and p_end < p_start) then
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
  select * into r from reports where id = p_report_id;
  -- §19 Q81: a report of a site the caller covers (a backup who covered the day too).
  if r.id is null or r.status = 'void' or not field_reporter_on_site(c.reporter_id, r.site_id) then
    raise exception 'out_of_scope' using errcode = 'P0001';
  end if;
  -- field_request_filed_correction()'s locks.
  perform 1 from site_days where id = r.site_day_id for update;
  select * into r from reports where id = p_report_id for update;
  -- The same words of this call again (the agent's retry, its call after `pending`): that change.
  select * into d from draft_corrections
   where call_id = c.id and report_id = r.id and text = v_text and status <> 'discarded'
   order by created_at desc limit 1;
  if d.id is not null then
    return jsonb_build_object('id', d.id, 'status', d.status, 'jobId', null, 'repeat', true);
  end if;
  if r.status not in ('filed', 'signed_off') then
    raise exception 'wrong_state' using errcode = 'P0001';
  end if;
  select * into s from sites where id = r.site_id;
  if s.status <> 'active' then
    -- §19 Q99: a paused or archived site's reports are not changed from the phone.
    raise exception 'site_inactive' using errcode = 'P0001';
  end if;
  select date into v_date from site_days where id = r.site_day_id;
  if not field_report_changeable(v_date, s.timezone) then
    raise exception 'report_locked' using errcode = 'P0001';
  end if;
  if exists (select 1 from draft_corrections where report_id = r.id and status = 'listening'
               and created_at > now() - interval '5 minutes') then
    raise exception 'correction_pending' using errcode = 'P0001';
  end if;
  v_source := jsonb_build_object('type', 'call', 'callId', c.id, 'start', p_start)
    || case when p_end is not null and p_end > p_start then jsonb_build_object('end', p_end)
            else '{}'::jsonb end;
  update draft_corrections set status = 'discarded', settled_at = coalesce(settled_at, now())
   where report_id = r.id and status in ('ready', 'unclear', 'listening');
  insert into draft_corrections (org_id, report_id, reporter_id, via, text, after_filing, call_id,
                                 source)
  values (r.org_id, r.id, c.reporter_id, 'voice', v_text, true, c.id, v_source)
  returning * into d;
  v_job := enqueue_job('apply_correction',
    jsonb_build_object('reportId', r.id, 'correctionId', d.id), null, 'correction:' || d.id);
  perform log_audit(r.org_id, 'reporter', c.reporter_id, 'report.correction_requested', 'report',
    r.id, jsonb_build_object('correction_id', d.id, 'via', 'voice', 'upload_id', null,
                             'channel', 'voice', 'call_id', c.id, 'job_id', v_job,
                             'after_filing', true, 'version', r.current_version));
  return jsonb_build_object('id', d.id, 'status', 'listening', 'jobId', v_job);
end $$;

-- 4. voice_save_filed_correction ------------------------------------------------------------------------------
create function voice_save_filed_correction(
  p_call_id uuid, p_correction_id uuid, p_utterance text, p_confirmed boolean,
  p_change_note text, p_message jsonb default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  c calls%rowtype;
  r reports%rowtype;
  s sites%rowtype;
  d draft_corrections%rowtype;
  v_date date;
  v_rev int;
  v_prev jsonb;
  v_data jsonb;
  v_next int;
  v_signer uuid;
  v_note text := left(btrim(coalesce(p_change_note, '')), 500);
  v_said text := left(coalesce(p_utterance, ''), 200);
  v_payload jsonb;
  v_job bigint;
begin
  if p_confirmed is null or p_utterance is null then
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
  select * into d from draft_corrections where id = p_correction_id;
  if d.id is null or d.call_id is distinct from c.id or not d.after_filing then
    raise exception 'correction_not_found' using errcode = 'P0002';
  end if;
  select * into r from reports where id = d.report_id;
  perform 1 from site_days where id = r.site_day_id for update;
  select * into r from reports where id = d.report_id for update;
  select * into d from draft_corrections where id = p_correction_id for update;
  -- Saved before (the agent's retry): the version it made.
  if d.status = 'applied' then
    return jsonb_build_object('status', 'applied', 'reportStatus', r.status,
                              'version', d.version_created, 'repeat', true);
  end if;
  if d.status <> 'ready' then
    raise exception 'correction_not_ready' using errcode = 'P0001';
  end if;
  -- Code read the words; not a yes: nothing saved, the agent asks again.
  if not p_confirmed then
    perform log_audit(c.org_id, 'reporter', c.reporter_id, 'call.save_refused', 'call', c.id,
      jsonb_build_object('report_id', r.id, 'correction_id', d.id, 'utterance', v_said));
    return jsonb_build_object('status', 'not_confirmed', 'reportStatus', r.status);
  end if;
  if r.status not in ('filed', 'signed_off') then
    raise exception 'wrong_state' using errcode = 'P0001';
  end if;
  select * into s from sites where id = r.site_id;
  if s.status <> 'active' then
    raise exception 'site_inactive' using errcode = 'P0001';
  end if;
  select date into v_date from site_days where id = r.site_day_id;
  if not field_report_changeable(v_date, s.timezone) then
    raise exception 'report_locked' using errcode = 'P0001';
  end if;
  if v_note = '' then
    raise exception 'change note required';
  end if;
  select draft_rev, data into v_rev, v_prev from report_versions
   where report_id = r.id and version = r.current_version;
  -- Only on the version the preview was made from.
  if r.current_version <> d.base_version or v_rev is distinct from d.base_rev then
    update draft_corrections set status = 'stale', reason = 'version_changed' where id = d.id;
    perform log_audit(r.org_id, 'reporter', c.reporter_id, 'report.correction_stale', 'report', r.id,
      jsonb_build_object('correction_id', d.id, 'status', r.status, 'version', r.current_version,
                         'base_version', d.base_version, 'after_filing', true, 'call_id', c.id));
    return jsonb_build_object('status', 'stale', 'reportStatus', r.status,
                              'currentVersion', r.current_version, 'draftRev', v_rev);
  end if;

  -- A change never touches photos: the version keeps its photos as they were.
  v_data := d.data - 'photos';
  if v_prev ? 'photos' then
    v_data := v_data || jsonb_build_object('photos', v_prev -> 'photos');
  end if;
  v_next := r.current_version + 1;
  insert into report_versions (report_id, version, data, summary, author, author_reporter_id, via,
                               change_note)
  values (r.id, v_next, v_data, nullif(v_data ->> 'summary', ''), 'reporter', c.reporter_id,
          'voice', v_note);
  perform denormalize_report_version(r.id, v_next);
  v_signer := r.signed_off_by;
  if v_signer is null then
    select (j.payload ->> 'signerId')::uuid into v_signer from jobs j
    where j.dedupe_key = 'render_pdf:' || r.id || ':' || r.current_version
      and j.payload ->> 'signerId' ~ '^[0-9a-f-]{36}$'
      and not exists (select 1 from jobs e
                      where e.dedupe_key = 'email:report_updated:' || r.id || ':' || r.current_version);
  end if;
  update reports set current_version = v_next,
    status = 'filed', signed_off_by = null, signed_off_at = null
  where id = r.id;
  update draft_corrections set status = 'applied', applied_at = now(), version_created = v_next
  where id = d.id;

  perform log_audit(r.org_id, 'reporter', c.reporter_id, 'report.version_created', 'report', r.id,
    jsonb_build_object('version', v_next, 'change_note', v_note, 'via', 'voice',
                       'correction_id', d.id, 'changes', d.changes, 'call_id', c.id));
  perform log_audit(r.org_id, 'reporter', c.reporter_id, 'report.correction_saved', 'report', r.id,
    jsonb_build_object('correction_id', d.id, 'via', 'voice', 'upload_id', null,
                       'channel', 'voice', 'call_id', c.id, 'utterance', v_said,
                       'from_version', r.current_version, 'version', v_next));
  if r.status = 'signed_off' then
    perform log_audit(r.org_id, 'reporter', c.reporter_id, 'report.signoff_reverted', 'report', r.id,
      jsonb_build_object('version', v_next, 'signed_off_by', v_signer));
    perform notify_org(r.org_id, 'report_edited', r.report_no || ' was edited after sign-off', v_note,
                       '/reports/' || r.id, v_signer,
                       jsonb_build_object('key', 'report_edited', 'params', jsonb_build_object('reportNo', r.report_no)));
  end if;

  v_payload := jsonb_build_object('reportId', r.id, 'version', v_next, 'emailRecipients', true,
                                  'changeNote', v_note);
  if v_signer is not null then
    v_payload := v_payload || jsonb_build_object('signerId', v_signer);
  end if;
  if jsonb_typeof(p_message) = 'object' and jsonb_typeof(p_message -> 'weekday') = 'string'
     and jsonb_typeof(p_message -> 'change') = 'string' then
    v_payload := v_payload || jsonb_build_object('editApplied', jsonb_build_object(
      'reporterId', c.reporter_id,
      'weekday', left(p_message ->> 'weekday', 40),
      'change', left(p_message ->> 'change', 300)));
  end if;
  v_job := enqueue_job('render_pdf', v_payload, null, 'render_pdf:' || r.id || ':' || v_next);
  return jsonb_build_object('status', 'applied', 'reportStatus', 'filed', 'version', v_next,
                            'jobId', v_job);
end $$;

-- 5. voice_record_consent -------------------------------------------------------------------------------------
create function voice_record_consent(
  p_call_id uuid, p_answer text, p_at numeric, p_text_version text
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  c calls%rowtype;
  rep reporters%rowtype;
  v_type consent_type;
  v_id uuid;
  v_given text[] := '{}';
  v_sms boolean;
  v_at numeric := round(greatest(0, least(coalesce(p_at, 0), 3600))::numeric, 2);
begin
  if p_answer is null or p_answer not in ('yes', 'no')
     or coalesce(btrim(p_text_version), '') = '' then
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
  select * into rep from reporters where id = c.reporter_id for update;
  if rep.status = 'disabled' then
    raise exception 'reporter_disabled' using errcode = 'P0001';
  end if;
  v_sms := exists (select 1 from consents where reporter_id = rep.id and type = 'sms'
                                            and revoked_at is null);

  if p_answer = 'no' then
    if c.consent_declined_at is null then
      update calls set consent_declined_at = now() where id = c.id returning * into c;
      perform log_audit(c.org_id, 'reporter', rep.id, 'consent.declined', 'reporter', rep.id,
        jsonb_build_object('via', 'voice', 'call_id', c.id, 'at', v_at,
                           'text_version', p_text_version));
    end if;
    return jsonb_build_object('status', 'declined', 'smsBefore', v_sms,
                              'recordingPath', c.recording_path, 'given', '[]'::jsonb);
  end if;

  -- A yes after this call's no would process a call the reporter refused: not on this call.
  if c.consent_declined_at is not null then
    raise exception 'wrong_state' using errcode = 'P0001';
  end if;
  foreach v_type in array array['recording', 'data_processing', 'sms']::consent_type[] loop
    if not exists (select 1 from consents where reporter_id = rep.id and type = v_type
                                            and revoked_at is null) then
      insert into consents (reporter_id, type, method, text_version, evidence)
      values (rep.id, v_type, 'voice_yes', p_text_version,
              jsonb_build_object('call_id', c.id, 'at', v_at))
      returning id into v_id;
      v_given := v_given || v_type::text;
      perform log_audit(c.org_id, 'reporter', rep.id, 'consent.given', 'consent', v_id,
        jsonb_build_object('type', v_type, 'method', 'voice_yes', 'via', 'voice',
                           'text_version', p_text_version, 'call_id', c.id, 'at', v_at));
    end if;
  end loop;
  -- F3 step 3: the first consent makes the reporter active (opted out stays opted out).
  if rep.status = 'invited' then
    update reporters set status = 'active', activated_at = coalesce(activated_at, now())
     where id = rep.id;
    perform log_audit(c.org_id, 'reporter', rep.id, 'reporter.activated', 'reporter', rep.id,
      jsonb_build_object('from', 'invited', 'via', 'voice', 'call_id', c.id));
  end if;
  return jsonb_build_object('status', 'given', 'smsBefore', v_sms, 'recordingPath', null,
                            'given', to_jsonb(v_given));
end $$;

-- 6. voice_no_calls_today -------------------------------------------------------------------------------------
create function voice_no_calls_today(p_call_id uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  c calls%rowtype;
  rep reporters%rowtype;
  v_tz text;
  v_until timestamptz;
begin
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
  select * into rep from reporters where id = c.reporter_id for update;
  select timezone into v_tz from orgs where id = rep.org_id;
  -- §19 Q129: the end of today in the org's time zone.
  v_until := (((now() at time zone v_tz)::date + 1)::timestamp) at time zone v_tz;
  if rep.no_calls_until is not null and rep.no_calls_until >= v_until then
    return jsonb_build_object('until', rep.no_calls_until, 'changed', false);
  end if;
  update reporters set no_calls_until = v_until where id = rep.id;
  perform log_audit(rep.org_id, 'reporter', rep.id, 'reporter.preferences_changed', 'reporter',
    rep.id, jsonb_build_object('from', jsonb_build_object('no_calls_until', rep.no_calls_until),
                               'to', jsonb_build_object('no_calls_until', v_until),
                               'channel', 'voice', 'call_id', c.id));
  return jsonb_build_object('until', v_until, 'changed', true);
end $$;

-- 7. Unknown callers ------------------------------------------------------------------------------------------
create function voice_unknown_caller(p_call_id uuid, p_snippet text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  c calls%rowtype;
  u unknown_contacts%rowtype;
  v_pack text;
  v_orgs uuid[];
  v_org uuid;
  v_snippet text := left(btrim(coalesce(p_snippet, '')), 160);
begin
  select * into c from calls where id = p_call_id for update;
  if c.id is null then
    raise exception 'call_not_found' using errcode = 'P0002';
  end if;
  if c.ended_at is not null then
    raise exception 'call_ended' using errcode = 'P0001';
  end if;
  -- F13 only: a known caller's words are a report, never a contact.
  if c.reporter_id is not null or c.from_e164 is null then
    raise exception 'out_of_scope' using errcode = 'P0001';
  end if;
  select * into u from unknown_contacts where call_id = c.id;
  if u.id is not null then
    update unknown_contacts set snippet = coalesce(nullif(v_snippet, ''), snippet)
     where id = u.id;
    return jsonb_build_object('id', u.id, 'orgId', u.org_id, 'created', false);
  end if;
  select code into v_pack from countries where voice_number = c.to_e164;
  -- §19 Q44: the org of the number's history (a disabled reporter, a contact that org linked)
  -- when there is exactly one real org of the pack; else none (SiteLog support on /ops).
  select array_agg(distinct o) into v_orgs from (
    select r.org_id as o from reporters r join orgs g on g.id = r.org_id
     where r.phone_e164 = c.from_e164 and g.country = v_pack and not g.is_demo
    union
    select x.org_id from unknown_contacts x join orgs g on g.id = x.org_id
     where x.phone_e164 = c.from_e164 and x.status = 'linked' and g.country = v_pack
       and not g.is_demo
  ) h;
  if coalesce(array_length(v_orgs, 1), 0) = 1 then
    v_org := v_orgs[1];
  end if;
  insert into unknown_contacts (org_id, phone_e164, channel, call_id, snippet, status)
  values (v_org, c.from_e164, 'voice', c.id, nullif(v_snippet, ''), 'pending')
  returning * into u;
  perform log_audit(v_org, 'system', null, 'unknown_contact.created', 'unknown_contact', u.id,
    jsonb_build_object('channel', 'voice', 'pack', v_pack, 'call_id', c.id,
                       'org_guessed', v_org is not null));
  return jsonb_build_object('id', u.id, 'orgId', v_org, 'created', true);
end $$;

create function voice_unknown_recording(p_call_id uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  c calls%rowtype;
  v_path text;
begin
  select * into c from calls where id = p_call_id for update;
  if c.id is null then
    raise exception 'call_not_found' using errcode = 'P0002';
  end if;
  if c.reporter_id is not null then
    raise exception 'out_of_scope' using errcode = 'P0001';
  end if;
  v_path := 'unknown/' || c.id || '.ogg';
  if c.recording_path is distinct from v_path then
    update calls set recording_path = v_path where id = c.id;
    perform log_audit(null, 'agent', null, 'call.recording_requested', 'call', c.id,
      jsonb_build_object('path', v_path, 'unknown', true));
  end if;
  return jsonb_build_object('path', v_path);
end $$;

-- 8. purge_unknown_callers (the worker's retention_cleanup) --------------------------------------------------
create function purge_unknown_callers(p_before timestamptz, p_limit int default 200)
returns table (contact_id uuid, call_id uuid, recording_path text)
language plpgsql security definer set search_path = public as $$
declare
  u record;
begin
  for u in
    select x.id, x.call_id, x.org_id, k.recording_path as path
      from unknown_contacts x left join calls k on k.id = x.call_id
     where x.channel = 'voice' and x.status <> 'linked' and x.created_at < p_before
     order by x.created_at
     limit greatest(1, least(coalesce(p_limit, 200), 1000))
     for update of x skip locked
  loop
    if u.call_id is not null then
      update calls set dialog_log = null, recording_path = null where id = u.call_id;
    end if;
    delete from unknown_contacts where id = u.id;
    perform log_audit(u.org_id, 'system', null, 'unknown_contact.purged', 'unknown_contact', u.id,
      jsonb_build_object('channel', 'voice', 'call_id', u.call_id, 'recording', u.path is not null));
    contact_id := u.id;
    call_id := u.call_id;
    recording_path := u.path;
    return next;
  end loop;
end $$;

revoke execute on function voice_report_day_off(uuid, text, jsonb, jsonb, text),
  voice_request_filed_correction(uuid, uuid, text, numeric, numeric),
  voice_save_filed_correction(uuid, uuid, text, boolean, text, jsonb),
  voice_record_consent(uuid, text, numeric, text),
  voice_no_calls_today(uuid),
  voice_unknown_caller(uuid, text),
  voice_unknown_recording(uuid),
  purge_unknown_callers(timestamptz, int)
  from public, anon, authenticated;
grant execute on function voice_report_day_off(uuid, text, jsonb, jsonb, text),
  voice_request_filed_correction(uuid, uuid, text, numeric, numeric),
  voice_save_filed_correction(uuid, uuid, text, boolean, text, jsonb),
  voice_record_consent(uuid, text, numeric, text),
  voice_no_calls_today(uuid),
  voice_unknown_caller(uuid, text),
  voice_unknown_recording(uuid),
  purge_unknown_callers(timestamptz, int)
  to service_role;
