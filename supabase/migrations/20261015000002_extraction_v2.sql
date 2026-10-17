-- SiteLog · extraction v2, questions and the web answer (W1-12, GAP §7 step 17; spec §7.2, §10.3,
-- §10.5, Appendix B `reports/:id/answer`; GAP D20, D25, D28)
--
--   1. create_office_report(): writes report data v2 (§10.3): `schemaVersion` 2, the report date,
--      the org's report language (org_report_language()) and units are stamped by the server,
--      photos keyed `uploadId` (report_photo_key()). A panel built before this change sends v1
--      (`schemaVersion` 1) and still gets a v1 version, so a cached old tab keeps working.
--   2. field_complete_upload(): a photo on a report awaiting confirmation moves it back to
--      processing and enqueues extract_report (§7.2 "more photos"; W1-07 attached photos without
--      reopening the draft until this ticket), keyed `extract:<report>:photo:<upload>` (a photo
--      completes once; jobKeys.extractPhoto). Everything else as in 20261015000001.
--   3. field_answer_question(): field-api's `reports/:id/answer`. Under the site-day lock that
--      field_complete_upload() and field_confirm_report() take: the question must be the report's
--      open web question and the report awaiting an answer; the draft must still be the one
--      field-api read (`p_base`, else `draft_changed`). It stores the draft field-api computed in
--      code (applyAnswer, @sitelog/shared), the answer, its source and time, puts the report back
--      to processing, audits `report.question_answered` as the reporter and enqueues decide_next
--      keyed `decide:<report>:answer:<question>` (a question is answered once). A retry with the
--      same answer returns `already_answered`; another answer to an answered question is
--      `question_closed`. "Add <company>" (`p_new_company` {name, manpowerIndex}) creates the
--      unconfirmed company (F7), points the crew at it and flags the report for review
--      (`unknown_company:<name>`), as the WhatsApp handler does. Service role only.
--
-- Forward-only and CLI-safe: `create or replace` of two existing functions (their grants are
-- kept) and one new function, no lock or transaction-block statement. Live: the deployed panel
-- (v1 build) keeps filing v1 typed reports through (1); the WhatsApp worker writes neither.

create or replace function create_office_report(p_site_id uuid, p_date date, p_data jsonb, p_photos jsonb default '[]'::jsonb)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  s sites%rowtype;
  sd site_days%rowtype;
  v_existing reports%rowtype;
  v_deadline time;
  v_data jsonb;
  v_photos jsonb;
  v_report_id uuid;
  v_report_no text;
  v_late boolean;
begin
  select * into s from sites where id = p_site_id;
  if s.id is null then raise exception 'site not found'; end if;
  if not has_role(s.org_id, '{admin,pm,ops}') then raise exception 'not allowed' using errcode = '42501'; end if;
  if s.status = 'archived' then raise exception 'site is archived'; end if;
  if p_date is null then raise exception 'date required'; end if;
  if p_date > (now() at time zone s.timezone)::date then raise exception 'date is in the future'; end if;
  if jsonb_typeof(p_data) is distinct from 'object' then raise exception 'report data must be a JSON object'; end if;
  -- v2 (spec §10.3; W1-12): the date, the org's report language and units are the server's. A
  -- panel built before W1-12 sends v1 data (schemaVersion 1) and still gets a v1 version.
  if p_data ->> 'schemaVersion' = '1' then
    v_data := p_data || jsonb_build_object('reportDate', to_char(p_date, 'YYYY-MM-DD'), 'schemaVersion', 1);
  else
    v_data := p_data || jsonb_build_object(
      'schemaVersion', 2,
      'reportDate', to_char(p_date, 'YYYY-MM-DD'),
      'reportLanguage', org_report_language(s.org_id),
      'units', (select units from orgs where id = s.org_id));
  end if;

  -- The row lock serialises concurrent calls for one day; a concurrent first insert is absorbed
  -- by "on conflict do nothing" and the re-select then waits for the winner's lock.
  select * into sd from site_days where site_id = p_site_id and date = p_date for update;
  if sd.id is null then
    v_deadline := coalesce(
      s.deadline,
      (select default_deadline from org_settings where org_id = s.org_id),
      '17:30'::time);
    insert into site_days (site_id, date, status, deadline_at)
    values (p_site_id, p_date, 'pending', (p_date + v_deadline)::timestamp at time zone s.timezone)
    on conflict (site_id, date) do nothing;
    select * into sd from site_days where site_id = p_site_id and date = p_date for update;
  end if;

  -- A double submit returns the report the first call filed (its photos are attached already).
  select * into v_existing from reports
  where site_day_id = sd.id and status <> 'void'
  order by created_at
  limit 1;
  if v_existing.id is not null then
    return jsonb_build_object('reportId', v_existing.id, 'reportNo', v_existing.report_no, 'created', false);
  end if;

  v_report_no := next_report_no(p_site_id);
  v_late := now() > sd.deadline_at;
  insert into reports (org_id, site_id, site_day_id, report_no, status, kind, current_version,
                       reporter_id, received_at, confirmed_at, filed_at, is_late, channel, language)
  values (s.org_id, p_site_id, sd.id, v_report_no, 'filed', 'daily', 1,
          null, now(), null, now(), v_late,  -- confirmed_at: only a field confirm sets it
          'office', org_report_language(s.org_id))
  returning id into v_report_id;

  v_photos := place_office_photos('[]'::jsonb,
    attach_office_photos(v_report_id, p_photos, report_photo_key(v_data)), p_photos);
  v_data := v_data || jsonb_build_object('photos', v_photos);
  -- Every crew row here was typed by the office: each "Add new…" name becomes a company.
  v_data := link_typed_companies(s.org_id, v_report_id, v_data);
  insert into report_versions (report_id, version, data, summary, author, author_user_id)
  values (v_report_id, 1, v_data, nullif(v_data->>'summary', ''), 'office_user', auth.uid());
  perform denormalize_report_version(v_report_id, 1);

  update site_days set status = 'filed', report_id = v_report_id, is_late = v_late where id = sd.id;

  perform log_audit(s.org_id, 'user', auth.uid(), 'report.filed', 'report', v_report_id,
    jsonb_build_object('trigger', 'office_entry', 'version', 1, 'is_late', v_late, 'date', p_date,
                       'photos', jsonb_array_length(v_photos)));

  return jsonb_build_object('reportId', v_report_id, 'reportNo', v_report_no, 'created', true);
end $$;

create or replace function field_complete_upload(p_upload_id uuid, p_reporter_id uuid, p_bytes int default null)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  u uploads%rowtype;
  s sites%rowtype;
  sd site_days%rowtype;
  r reports%rowtype;
  v_date date;
  v_created boolean := false;
  v_from report_status;
  v_job bigint;
  v_reextract boolean := false;
begin
  select * into u from uploads where id = p_upload_id for update;
  if u.id is null or u.reporter_id is distinct from p_reporter_id
     or not field_reporter_on_site(p_reporter_id, u.site_id) then
    raise exception 'upload_not_found' using errcode = 'P0002';
  end if;
  select * into s from sites where id = u.site_id;

  -- Completing twice (a retry after a lost answer) returns what the first call did.
  if u.report_id is not null then
    select * into r from reports where id = u.report_id;
    return jsonb_build_object('reportId', r.id, 'reportNo', r.report_no, 'reportStatus', r.status,
                              'created', false, 'alreadyComplete', true, 'jobId', null);
  end if;

  -- field-api writes the path {org}/{site}/{date}/{upload id}.{ext} (uploadStoragePath()).
  if split_part(u.storage_path, '/', 1) <> s.org_id::text
     or split_part(u.storage_path, '/', 2) <> s.id::text
     or split_part(u.storage_path, '/', 3) !~ '^\d{4}-\d{2}-\d{2}$' then
    raise exception 'upload_path_mismatch' using errcode = 'P0001';
  end if;
  v_date := split_part(u.storage_path, '/', 3)::date;

  sd := field_lock_site_day(s.id, v_date);
  select * into r from reports where site_day_id = sd.id and status <> 'void'
  order by created_at limit 1 for update;
  if r.id is not null and r.status in ('filed', 'signed_off') then
    raise exception 'report_filed' using errcode = 'P0001';
  end if;
  if r.id is null and sd.status in ('filed', 'weather_day', 'no_work') then
    raise exception 'day_closed' using errcode = 'P0001';
  end if;
  -- Confirmed and being filed (field_confirm_report(), a WhatsApp confirm or a timeout): nothing
  -- joins the draft the reporter confirmed. A filing job of the report, whatever its key (W1-10:
  -- `file:<report>:v<version>`; a job queued before this migration: `file:<report>`).
  if r.id is not null and exists (
       select 1 from jobs where type = 'file_report' and payload ->> 'reportId' = r.id::text
                            and status in ('queued', 'running')) then
    raise exception 'report_filing' using errcode = 'P0001';
  end if;

  if r.id is null then
    insert into reports (org_id, site_id, site_day_id, report_no, status, kind, reporter_id,
                         received_at, channel, language)
    values (s.org_id, s.id, sd.id, next_report_no(s.id),
            case when u.kind = 'audio' then 'processing' else 'collecting' end::report_status,
            'daily', p_reporter_id, now(), 'web', org_report_language(s.org_id))
    returning * into r;
    v_created := true;
    perform log_audit(s.org_id, 'reporter', p_reporter_id, 'report.created', 'report', r.id,
      jsonb_build_object('report_no', r.report_no, 'date', v_date, 'channel', 'web',
                         'status', r.status, 'upload_id', u.id));
  elsif u.kind = 'audio' and r.status <> 'processing' then
    -- §7.2: more audio puts a report back to processing (collecting, a question, a draft).
    v_from := r.status;
    update reports set status = 'processing' where id = r.id returning * into r;
    perform log_audit(s.org_id, 'reporter', p_reporter_id, 'report.status_changed', 'report', r.id,
      jsonb_build_object('from', v_from, 'to', 'processing', 'upload_id', u.id));
  elsif u.kind = 'photo' and r.status = 'awaiting_confirmation' then
    -- W1-12, §7.2 "more photos": a photo on the draft reopens it for a new extraction.
    v_from := r.status;
    v_reextract := true;
    update reports set status = 'processing' where id = r.id returning * into r;
    perform log_audit(s.org_id, 'reporter', p_reporter_id, 'report.status_changed', 'report', r.id,
      jsonb_build_object('from', v_from, 'to', 'processing', 'upload_id', u.id));
  end if;

  update uploads set report_id = r.id, received_at = now(), bytes = coalesce(p_bytes, bytes)
  where id = u.id;
  insert into report_sources (report_id, kind, upload_id, taken_at)
  values (r.id, case when u.kind = 'audio' then 'voice_note' else 'photo' end, u.id, u.recorded_at);

  if u.kind = 'audio' then
    -- §7.1: a voice note starts the day's processing (a late one too: missing → processing).
    if sd.status in ('pending', 'reminded', 'missing') then
      update site_days set status = 'processing' where id = sd.id;
      perform log_audit(s.org_id, 'reporter', p_reporter_id, 'site_day.status_changed', 'site_day',
        sd.id, jsonb_build_object('from', sd.status, 'to', 'processing', 'report_id', r.id));
    end if;
    v_job := enqueue_job('transcribe_upload', jsonb_build_object('uploadId', u.id), null,
                         'transcribe_upload:' || u.id);
  elsif v_reextract then
    -- Every voice note is transcribed (the draft exists), so the extraction can run now.
    v_job := enqueue_job('extract_report',
      jsonb_build_object('reportId', r.id, 'reason', 'photo:' || u.id), null,
      'extract:' || r.id || ':photo:' || u.id);
  end if;

  perform log_audit(s.org_id, 'reporter', p_reporter_id, 'upload.completed', 'upload', u.id,
    jsonb_build_object('report_id', r.id, 'kind', u.kind, 'date', v_date, 'job_id', v_job));
  return jsonb_build_object('reportId', r.id, 'reportNo', r.report_no, 'reportStatus', r.status,
                            'created', v_created, 'alreadyComplete', false, 'jobId', v_job);
end $$;

create function field_answer_question(
  p_report_id uuid, p_question_id uuid, p_reporter_id uuid,
  p_base jsonb, p_data jsonb, p_answer jsonb, p_answer_source jsonb,
  p_new_company jsonb default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  r reports%rowtype;
  q questions%rowtype;
  c companies%rowtype;
  v_current jsonb;
  v_data jsonb := p_data;
  v_job bigint;
  v_name text;
  v_index int;
begin
  select * into r from reports where id = p_report_id;
  if r.id is null or r.status = 'void' or not field_reporter_on_site(p_reporter_id, r.site_id) then
    raise exception 'report_not_found' using errcode = 'P0002';
  end if;
  if jsonb_typeof(p_data) is distinct from 'object' or p_data ->> 'schemaVersion' is distinct from '2' then
    raise exception 'invalid_answer_data' using errcode = 'P0001';
  end if;
  -- field_complete_upload()'s and field_confirm_report()'s lock: a voice note, a photo on the
  -- draft or a confirm waits for this answer, or this answer for them.
  perform 1 from site_days where id = r.site_day_id for update;
  select * into r from reports where id = p_report_id for update;
  select * into q from questions where id = p_question_id and report_id = r.id for update;
  if q.id is null then
    raise exception 'question_not_found' using errcode = 'P0002';
  end if;
  if q.answered_at is not null then
    -- A retry of the same answer (a lost response) gets what the first call did.
    if q.answer = p_answer then
      return jsonb_build_object('status', 'already_answered', 'reportStatus', r.status, 'jobId', null);
    end if;
    raise exception 'question_closed' using errcode = 'P0001';
  end if;
  if q.channel is distinct from 'web' then
    raise exception 'question_closed' using errcode = 'P0001';
  end if;
  if r.status <> 'awaiting_answer' then
    raise exception 'wrong_state' using errcode = 'P0001';
  end if;
  select data into v_current from report_versions
  where report_id = r.id and version = r.current_version for update;
  if v_current is null or v_current is distinct from p_base then
    raise exception 'draft_changed' using errcode = 'P0001';
  end if;

  -- "Add <company>" (F7): the name the reporter confirmed becomes an unconfirmed company of the
  -- org (or the one of that name already there), the crew points at it, and the office reviews it.
  if p_new_company is not null then
    v_name := btrim(p_new_company ->> 'name');
    v_index := (p_new_company ->> 'manpowerIndex')::int;
    if coalesce(v_name, '') = '' or v_index is null
       or jsonb_typeof(v_data -> 'manpower' -> v_index) is distinct from 'object' then
      raise exception 'invalid_answer_data' using errcode = 'P0001';
    end if;
    select * into c from companies where org_id = r.org_id and lower(name) = lower(v_name) limit 1;
    if c.id is null then
      insert into companies (org_id, name, status) values (r.org_id, v_name, 'unconfirmed')
      returning * into c;
      perform log_audit(r.org_id, 'reporter', p_reporter_id, 'company.added_unconfirmed', 'company',
        c.id, jsonb_build_object('report_id', r.id, 'question_id', q.id));
    end if;
    v_data := jsonb_set(v_data, array['manpower', v_index::text, 'companyId'], to_jsonb(c.id::text));
    v_data := jsonb_set(v_data, array['manpower', v_index::text, 'companyName'], to_jsonb(c.name));
    update reports set needs_review = true,
      review_reasons = array(select distinct x from unnest(review_reasons || ('unknown_company:' || c.name)) x)
    where id = r.id;
  end if;

  update report_versions set data = v_data, summary = nullif(v_data ->> 'summary', '')
  where report_id = r.id and version = r.current_version;
  update questions set answer = p_answer, answer_source = p_answer_source, answered_at = now()
  where id = q.id;
  update reports set status = 'processing' where id = r.id;
  v_job := enqueue_job('decide_next', jsonb_build_object('reportId', r.id), null,
                       'decide:' || r.id || ':answer:' || q.id);
  perform log_audit(r.org_id, 'reporter', p_reporter_id, 'report.question_answered', 'report', r.id,
    jsonb_build_object('question_id', q.id, 'field', q.field, 'channel', 'web',
                       'option_id', p_answer -> 'optionId', 'company_id', c.id, 'job_id', v_job));
  return jsonb_build_object('status', 'processing', 'reportStatus', 'processing', 'jobId', v_job);
end $$;

revoke execute on function field_answer_question(uuid, uuid, uuid, jsonb, jsonb, jsonb, jsonb, jsonb)
  from public, anon, authenticated;
grant execute on function field_answer_question(uuid, uuid, uuid, jsonb, jsonb, jsonb, jsonb, jsonb)
  to service_role;
