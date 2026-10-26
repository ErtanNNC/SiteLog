-- SiteLog · field-api (W1-07, GAP step 13; spec §6.5, Appendix B, F4, F5, F12, §7.1, §7.2)
--
--   1. field_devices.code_hash, code_expires_at: the one-time code of F4 step 2 (6 digits, 10
--      minutes). code_hash is an HMAC of the device id and the code under LINK_SIGNING_SECRET
--      (field-api), never the code; both are cleared when the device is verified. Spec §6.3 is
--      updated with the two columns (§6.3 named no place for the code).
--   2. field_lock_site_day(): the site-day of a site and date, created when missing (status
--      pending, the deadline of the site or the org, as create_office_report() computes it), and
--      locked for the caller's transaction. The row lock serialises everything field-api does to
--      one site-day.
--   3. field_complete_upload(): uploads/:id/complete in one transaction. On the first upload of a
--      site-day it numbers and inserts the report (next_report_no() inside the site-day lock, so
--      no number is burned and two concurrent completes make one report), channel 'web', the
--      org's report language, status 'processing' for a voice note ('collecting' for a photo:
--      §7.2, F5 "photos only"); it attaches the upload (uploads.report_id, a report_sources row),
--      moves the site-day to processing on a voice note (§7.1) and enqueues transcribe_upload
--      (dedupe key per upload). A filed or signed-off report, or a closed day (no work, weather
--      day, filed with no live report), refuses the upload: edits and photos after filing are
--      F9/F10 (week 2). So does a report being filed (a queued or running `file:<report>` job):
--      the confirmed draft is what gets filed.
--   4. field_set_day_status(): day-status (F12 buttons): pending or reminded → no_work or
--      weather_day (§7.1), only while the site-day has no live report. The site-day only: the
--      weather-day report (weather_events, lost hours, the PDF) and the no-work PDF are spec §19
--      Q41.
--   5. field_rate_limit(): rate_limits as a rolling window per key (spec §6.5, D26): the window
--      starts at the key's first hit; a hit over the limit is refused until the window ends.
--   6. field_confirm_report(): reports/:id/confirm (F8) under the same site-day lock as 3: the
--      report must still be awaiting_confirmation at the version the reporter confirmed; it
--      enqueues file_report {reportId, trigger 'confirm', version} (dedupe key file:<report>, the
--      WhatsApp confirm's and the timeouts'), and the worker files only that version.
--   7. Storage: the audio bucket takes audio/* only, audio and photos 50 MB a file (field-api also
--      checks each object's type and size when its upload completes). The photos bucket keeps any
--      type until step 22: the WhatsApp intake stores documents there.
--   Every function is service role only (field-api): field users never get a database session.
--   Each writes audit_log with actor_type 'reporter' for its state changes.
--
-- Live database: two nullable columns on a table with no rows outside the demo seed, new
-- functions, and two bucket limits the live writers already meet (WhatsApp audio is audio/*, and
-- the project's default upload limit is 50 MB); nothing reads the rest before field-api is
-- deployed.

set local lock_timeout = '5s';

-- 1. The one-time code of a device ----------------------------------------------------------------
alter table field_devices
  add column code_hash text,               -- HMAC of the 6-digit code (F4), cleared on verification
  add column code_expires_at timestamptz;  -- 10 minutes after the code was sent

-- 2. A site-day, created when missing, locked -------------------------------------------------------
create function field_lock_site_day(p_site_id uuid, p_date date) returns site_days
language plpgsql security definer set search_path = public as $$
declare
  s sites%rowtype;
  sd site_days%rowtype;
  v_deadline time;
begin
  select * into sd from site_days where site_id = p_site_id and date = p_date for update;
  if sd.id is not null then return sd; end if;
  select * into s from sites where id = p_site_id;
  if s.id is null then raise exception 'site_not_found' using errcode = 'P0002'; end if;
  v_deadline := coalesce(
    s.deadline,
    (select default_deadline from org_settings where org_id = s.org_id),
    '17:30'::time);
  -- A concurrent first insert is absorbed here; the select then waits for the winner's lock.
  insert into site_days (site_id, date, status, deadline_at)
  values (p_site_id, p_date, 'pending', (p_date + v_deadline)::timestamp at time zone s.timezone)
  on conflict (site_id, date) do nothing;
  select * into sd from site_days where site_id = p_site_id and date = p_date for update;
  return sd;
end $$;

-- The reporter is linked to the site, and both belong to the same org (field-api's scope).
create function field_reporter_on_site(p_reporter_id uuid, p_site_id uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from site_reporters sr
    join reporters r on r.id = sr.reporter_id
    join sites s on s.id = sr.site_id
    where sr.reporter_id = p_reporter_id and sr.site_id = p_site_id and r.org_id = s.org_id);
$$;

-- 3. uploads/:id/complete ----------------------------------------------------------------------------
create function field_complete_upload(p_upload_id uuid, p_reporter_id uuid, p_bytes int default null)
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
  -- joins the draft the reporter confirmed.
  if r.id is not null and exists (
       select 1 from jobs where dedupe_key = 'file:' || r.id and status in ('queued', 'running')) then
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
  end if;

  perform log_audit(s.org_id, 'reporter', p_reporter_id, 'upload.completed', 'upload', u.id,
    jsonb_build_object('report_id', r.id, 'kind', u.kind, 'date', v_date, 'job_id', v_job));
  return jsonb_build_object('reportId', r.id, 'reportNo', r.report_no, 'reportStatus', r.status,
                            'created', v_created, 'alreadyComplete', false, 'jobId', v_job);
end $$;

-- 4. day-status (F12 buttons) -------------------------------------------------------------------------
create function field_set_day_status(p_reporter_id uuid, p_site_id uuid, p_date date, p_status text,
                                     p_details jsonb default '{}'::jsonb)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  sd site_days%rowtype;
  r reports%rowtype;
  v_org uuid;
begin
  if p_status not in ('no_work', 'weather_day') then
    raise exception 'invalid_status' using errcode = '22023';
  end if;
  if not field_reporter_on_site(p_reporter_id, p_site_id) then
    raise exception 'site_not_found' using errcode = 'P0002';
  end if;
  v_org := site_org(p_site_id);
  sd := field_lock_site_day(p_site_id, p_date);
  if sd.status::text = p_status then
    return jsonb_build_object('siteDayId', sd.id, 'status', sd.status, 'changed', false);
  end if;
  select * into r from reports where site_day_id = sd.id and status <> 'void'
  order by created_at limit 1;
  if r.id is not null and r.status in ('filed', 'signed_off') then
    raise exception 'report_filed' using errcode = 'P0001';
  end if;
  if r.id is not null then
    raise exception 'report_in_progress' using errcode = 'P0001';
  end if;
  if sd.status not in ('pending', 'reminded') then
    raise exception 'wrong_state' using errcode = 'P0001';
  end if;
  update site_days set status = p_status::site_day_status where id = sd.id;
  perform log_audit(v_org, 'reporter', p_reporter_id, 'site_day.' || p_status, 'site_day', sd.id,
    jsonb_build_object('from', sd.status, 'to', p_status, 'date', p_date, 'channel', 'web',
                       'details', coalesce(p_details, '{}'::jsonb)));
  return jsonb_build_object('siteDayId', sd.id, 'status', p_status, 'changed', true);
end $$;

-- 5. Rate limits ----------------------------------------------------------------------------------------
-- Keys (§6.3 rate_limits): 'dev:<device_id>' 30 a minute, 'code_send:<e164>' 5 an hour,
-- 'code:<e164>' 5 verifications an hour (spec §6.5, GAP D26). Every hit counts, refused ones too.
create function field_rate_limit(p_key text, p_limit int, p_window_seconds int) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_row rate_limits%rowtype;
  v_window interval;
begin
  if p_key is null or p_limit < 1 or p_window_seconds < 1 then
    raise exception 'invalid rate limit' using errcode = '22023';
  end if;
  v_window := make_interval(secs => p_window_seconds);
  -- One hit at a time per key, so two first hits cannot open two windows.
  perform pg_advisory_xact_lock(hashtextextended('rate_limits:' || p_key, 0));
  select * into v_row from rate_limits
  where key = p_key and window_start > now() - v_window
  order by window_start desc limit 1;
  if v_row.key is null then
    delete from rate_limits where key = p_key;  -- the key's ended windows
    insert into rate_limits (key, window_start, count) values (p_key, now(), 1)
    returning * into v_row;
  else
    update rate_limits set count = count + 1
    where key = v_row.key and window_start = v_row.window_start
    returning * into v_row;
  end if;
  return jsonb_build_object('allowed', v_row.count <= p_limit, 'count', v_row.count,
                            'resetAt', v_row.window_start + v_window);
end $$;

-- 6. reports/:id/confirm (F8: Confirm & send) ----------------------------------------------------------
-- {status: 'queued', jobId, version} or {status: 'filed'} for a report already filed. Refusals:
-- report_not_found (not the reporter's site, void), wrong_state (not awaiting_confirmation),
-- draft_changed (a newer version than the one confirmed).
create function field_confirm_report(p_report_id uuid, p_reporter_id uuid, p_version int)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  r reports%rowtype;
  v_key text := 'file:' || p_report_id;
  v_job bigint;
begin
  select * into r from reports where id = p_report_id;
  if r.id is null or r.status = 'void' or not field_reporter_on_site(p_reporter_id, r.site_id) then
    raise exception 'report_not_found' using errcode = 'P0002';
  end if;
  -- field_complete_upload()'s lock: no voice note attaches between this check and the enqueue,
  -- and a second tap waits for the first.
  perform 1 from site_days where id = r.site_day_id for update;
  select * into r from reports where id = p_report_id for update;
  if r.status in ('filed', 'signed_off') then
    return jsonb_build_object('status', 'filed', 'jobId', null, 'version', r.current_version);
  end if;
  if r.status <> 'awaiting_confirmation' then
    raise exception 'wrong_state' using errcode = 'P0001';
  end if;
  if p_version is null or r.current_version <> p_version then
    raise exception 'draft_changed' using errcode = 'P0001';
  end if;
  select id into v_job from jobs where dedupe_key = v_key and status in ('queued', 'running') limit 1;
  if v_job is not null then
    return jsonb_build_object('status', 'queued', 'jobId', v_job, 'version', p_version);
  end if;
  begin
    v_job := enqueue_job('file_report',
      jsonb_build_object('reportId', r.id, 'trigger', 'confirm', 'version', p_version), null, v_key);
  exception when unique_violation then
    -- A WhatsApp confirm or a timeout took the key at the same moment: one filing wins.
    select id into v_job from jobs where dedupe_key = v_key and status in ('queued', 'running') limit 1;
  end;
  perform log_audit(r.org_id, 'reporter', p_reporter_id, 'report.confirm_requested', 'report', r.id,
    jsonb_build_object('job_id', v_job, 'version', p_version, 'channel', 'web'));
  return jsonb_build_object('status', 'queued', 'jobId', v_job, 'version', p_version);
end $$;

revoke execute on function field_lock_site_day(uuid, date), field_reporter_on_site(uuid, uuid),
  field_complete_upload(uuid, uuid, int), field_set_day_status(uuid, uuid, date, text, jsonb),
  field_rate_limit(text, int, int), field_confirm_report(uuid, uuid, int)
  from public, anon, authenticated;
grant execute on function field_lock_site_day(uuid, date), field_reporter_on_site(uuid, uuid),
  field_complete_upload(uuid, uuid, int), field_set_day_status(uuid, uuid, date, text, jsonb),
  field_rate_limit(text, int, int), field_confirm_report(uuid, uuid, int)
  to service_role;

-- 7. Storage limits of the upload buckets (a signed upload URL fixes neither type nor size) ---------
-- 52428800 = 50 MB, UPLOAD_MAX_BYTES (packages/shared/src/field-contract.ts). photos keeps any type
-- until step 22: the WhatsApp intake stores documents there (apps/worker/src/router/media.ts).
do $$
begin
  if exists (select 1 from pg_namespace where nspname = 'storage') then
    update storage.buckets set allowed_mime_types = array['audio/*'], file_size_limit = 52428800
    where id = 'audio';
    update storage.buckets set file_size_limit = 52428800 where id = 'photos';
  end if;
end $$;
