-- SiteLog · photos after filing (W2-04; spec F9, F8 Filed, §9.3 Filed, §7.2, §12, §13, §19 Q67, Q89)
--
-- F9: photos added to a filed report become a new version ("2 photos added", author 'reporter',
-- via 'web'), re-rendered as `_v{n}` and emailed as "Updated". A filed or signed-off version is
-- never changed: the photos join a new one (§7.2 `filed → filed`).
--
-- The phone sends the photos it picked together (one "Add more photos", at most 4 per F9 window)
-- and, optionally, one short voice caption. They are one *batch*: each upload carries the batch
-- id and the batch's size, so whichever upload completes last knows the batch is whole, and the
-- version is made once for all of them (two photos make one version, "2 photos added"), whatever
-- order and however late (the offline queue) they arrive.
--
--   1. uploads.batch_id, uploads.batch_size (both null, or both set; spec §6.3 gains them).
--   2. field_complete_upload(): an upload of a batch completes on the day's filed (or signed-off)
--      report instead of being refused (`report_filed`): it is checked (F9's window, until 23:59
--      the day after the report's date, site time; at most 4 photos added after filing; one
--      caption per batch) and *staged* (uploads.report_id set, no report source, no version).
--      The answer says whether the batch is now complete (`batch.ready`); a complete batch with a
--      caption enqueues `transcribe_upload` with purpose 'caption' (the worker transcribes it and
--      then attaches the batch with the caption). Everything else as in 20261015000002.
--   3. field_attach_photos() (service role): the batch's photos as a new version: data.photos
--      gains them (with the caption, if any), report_sources rows, denormalised (weather_events
--      photo_count follows data.photos, so a weather day becomes claim-ready), the report back to
--      `filed` (a signed-off report's signer is told: F10's rule, the `report_edited` notice),
--      audited, then render_pdf for the new version with the "Updated" email. Idempotent: a batch
--      already attached answers the version that added it. field-api calls it when the batch is
--      complete without a caption (with the change note in the report language, from the shared
--      copy); the worker after the caption's transcription.
--
-- Which links may add photos is field-api's (`FILED_PHOTOS_ON_WEB_LINKS`, spec §19 Q89); the
-- window and the limit are checked here too.
--
-- Live database (staging): two nullable columns (no rewrite) with a check and a partial index on a
-- small table, one function replaced with the same signature (its grants are kept), one new
-- function (service role only). The deployed v1.0 code writes none of these.

set local lock_timeout = '5s';

-- 1. The batch columns ---------------------------------------------------------------------------------
alter table uploads
  add column batch_id uuid,
  add column batch_size smallint,
  add constraint uploads_batch_check check (
    (batch_id is null) = (batch_size is null) and (batch_size is null or batch_size between 1 and 5)
  );

create index uploads_batch_idx on uploads (batch_id) where batch_id is not null;

comment on column uploads.batch_id is
  'F9 (W2-04): photos (and one voice caption) added together to a filed report; null for report material.';
comment on column uploads.batch_size is
  'F9: how many uploads the batch holds (photos + caption); the last one to complete makes it whole.';

-- 2. field_complete_upload with batches ------------------------------------------------------------------
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
  v_done int;
  v_caption uuid;
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
    if u.batch_id is not null then
      select count(*) into v_done from uploads where batch_id = u.batch_id and report_id is not null;
      select id into v_caption from uploads
      where batch_id = u.batch_id and kind = 'audio' and report_id is not null limit 1;
    end if;
    return jsonb_build_object('reportId', r.id, 'reportNo', r.report_no, 'reportStatus', r.status,
                              'created', false, 'alreadyComplete', true, 'jobId', null)
      || case when u.batch_id is null then '{}'::jsonb else jsonb_build_object('batch',
           jsonb_build_object('id', u.batch_id, 'ready', v_done >= u.batch_size,
                              'captionUploadId', v_caption)) end;
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

  -- F9 (W2-04): a photo or caption added to the filed report, staged until its batch is whole.
  if u.batch_id is not null then
    if r.id is null or r.status not in ('filed', 'signed_off') then
      raise exception 'wrong_state' using errcode = 'P0001';
    end if;
    if now() > ((v_date + 1)::timestamp + time '23:59') at time zone s.timezone then
      raise exception 'photos_window_closed' using errcode = 'P0001';
    end if;
    -- One batch: one reporter, site, day and size.
    if exists (select 1 from uploads x where x.batch_id = u.batch_id
                 and (x.reporter_id is distinct from u.reporter_id or x.site_id <> u.site_id
                      or x.batch_size <> u.batch_size
                      or split_part(x.storage_path, '/', 3) <> split_part(u.storage_path, '/', 3)
                      or (x.report_id is not null and x.report_id <> r.id))) then
      raise exception 'invalid_batch' using errcode = 'P0001';
    end if;
    if u.kind = 'photo' and (select count(*) from uploads x
                             where x.report_id = r.id and x.batch_id is not null and x.kind = 'photo') >= 4 then
      raise exception 'photo_limit' using errcode = 'P0001';
    end if;
    if u.kind = 'audio' and exists (select 1 from uploads x where x.batch_id = u.batch_id
                                      and x.kind = 'audio' and x.report_id is not null) then
      raise exception 'invalid_batch' using errcode = 'P0001';
    end if;

    update uploads set report_id = r.id, received_at = now(), bytes = coalesce(p_bytes, bytes)
    where id = u.id;
    select count(*) into v_done from uploads where batch_id = u.batch_id and report_id is not null;
    if v_done >= u.batch_size then
      select id into v_caption from uploads
      where batch_id = u.batch_id and kind = 'audio' and report_id is not null limit 1;
      if v_caption is not null then
        -- The worker transcribes the caption, then attaches the batch with it (no re-extraction).
        v_job := enqueue_job('transcribe_upload',
          jsonb_build_object('uploadId', v_caption, 'purpose', 'caption'), null,
          'transcribe_upload:' || v_caption);
      end if;
    end if;
    perform log_audit(s.org_id, 'reporter', p_reporter_id, 'upload.completed', 'upload', u.id,
      jsonb_build_object('report_id', r.id, 'kind', u.kind, 'date', v_date, 'job_id', v_job,
                         'batch_id', u.batch_id, 'after_filing', true));
    return jsonb_build_object('reportId', r.id, 'reportNo', r.report_no, 'reportStatus', r.status,
                              'created', false, 'alreadyComplete', false, 'jobId', v_job,
                              'batch', jsonb_build_object('id', u.batch_id,
                                'ready', v_done >= u.batch_size, 'captionUploadId', v_caption));
  end if;

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

-- 3. field_attach_photos ----------------------------------------------------------------------------------
create function field_attach_photos(p_report_id uuid, p_batch_id uuid, p_change_note text, p_caption text default null)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  r reports%rowtype;
  v_total int;
  v_staged int;
  v_size int;
  v_reporter uuid;
  v_first uuid;
  v_version int;
  v_caption text := nullif(btrim(coalesce(p_caption, '')), '');
  v_prev jsonb;
  v_key text;
  v_listed jsonb;
  v_added jsonb;
  v_photos jsonb;
  v_data jsonb;
  v_next int;
  v_signer uuid;
begin
  select * into r from reports where id = p_report_id;
  if r.id is null or r.status = 'void' then
    raise exception 'report_not_found' using errcode = 'P0002';
  end if;
  -- field_complete_upload()'s lock: no upload of the day completes while the version is made.
  perform 1 from site_days where id = r.site_day_id for update;
  select * into r from reports where id = p_report_id for update;

  select count(*), count(*) filter (where report_id = p_report_id), max(batch_size), min(reporter_id::text)::uuid
  into v_total, v_staged, v_size, v_reporter
  from uploads where batch_id = p_batch_id;
  if v_total = 0 then
    raise exception 'batch_not_found' using errcode = 'P0002';
  end if;
  if v_staged < v_total or v_total < v_size then
    raise exception 'batch_incomplete' using errcode = 'P0001';
  end if;
  select id into v_first from uploads where batch_id = p_batch_id and kind = 'photo'
  order by recorded_at nulls last, id limit 1;
  if v_first is null then
    raise exception 'invalid_batch' using errcode = 'P0001';
  end if;

  -- A batch attached before (a retried complete, the worker after field-api): its version.
  if exists (select 1 from report_sources where report_id = p_report_id and upload_id = v_first) then
    select min(rv.version) into v_version from report_versions rv
    where rv.report_id = p_report_id and jsonb_typeof(rv.data -> 'photos') = 'array'
      and exists (select 1 from jsonb_array_elements(rv.data -> 'photos') e
                  where photo_entry_id(e) = v_first::text);
    return jsonb_build_object('version', coalesce(v_version, r.current_version), 'alreadyAttached', true);
  end if;

  if r.status not in ('filed', 'signed_off') then
    raise exception 'wrong_state' using errcode = 'P0001';
  end if;
  if coalesce(btrim(p_change_note), '') = '' then
    raise exception 'change note required';
  end if;
  if length(v_caption) > 500 then
    v_caption := left(v_caption, 500);
  end if;

  select rv.data into v_prev from report_versions rv
  where rv.report_id = p_report_id and rv.version = r.current_version;
  v_prev := coalesce(v_prev, '{}'::jsonb);
  v_key := report_photo_key(v_prev);
  -- What the filed version shows: its data.photos, or every photo of the report when it has none.
  v_listed := case
    when jsonb_typeof(v_prev -> 'photos') = 'array' then v_prev -> 'photos'
    else (select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
                   v_key, ps.media_id, 'caption', ps.caption,
                   'takenAt', to_char(ps.taken_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')))
                 order by ps.added_at, ps.media_id), '[]'::jsonb)
          from report_photo_sources(p_report_id) ps)
  end;

  select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
           v_key, u.id, 'caption', v_caption,
           'takenAt', to_char(least(coalesce(u.recorded_at, u.received_at), now()) at time zone 'UTC',
                              'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')))
         order by u.recorded_at nulls last, u.id), '[]'::jsonb)
  into v_added
  from uploads u where u.batch_id = p_batch_id and u.kind = 'photo';

  insert into report_sources (report_id, kind, upload_id, caption, taken_at)
  select p_report_id, 'photo', u.id, v_caption, least(coalesce(u.recorded_at, u.received_at), now())
  from uploads u where u.batch_id = p_batch_id and u.kind = 'photo'
  order by u.recorded_at nulls last, u.id;
  if v_caption is not null then
    update uploads set caption = v_caption where batch_id = p_batch_id and kind = 'photo';
  end if;

  v_photos := v_listed || v_added;
  v_data := v_prev || jsonb_build_object('photos', v_photos);
  v_next := r.current_version + 1;
  insert into report_versions (report_id, version, data, summary, author, via, change_note)
  values (p_report_id, v_next, v_data, nullif(v_data ->> 'summary', ''), 'reporter', 'web', p_change_note);
  perform denormalize_report_version(p_report_id, v_next);
  v_signer := r.signed_off_by;
  update reports set current_version = v_next,
    status = 'filed', signed_off_by = null, signed_off_at = null
  where id = p_report_id;

  perform log_audit(r.org_id, 'reporter', v_reporter, 'report.version_created', 'report', p_report_id,
    jsonb_build_object('version', v_next, 'change_note', p_change_note, 'via', 'web',
      'photos', jsonb_array_length(v_photos), 'photos_added', jsonb_array_length(v_added),
      'batch_id', p_batch_id, 'caption', v_caption is not null));
  if r.status = 'signed_off' then
    -- F10's rule: a change after sign-off reopens it, and the signer is told.
    perform log_audit(r.org_id, 'reporter', v_reporter, 'report.signoff_reverted', 'report', p_report_id,
      jsonb_build_object('version', v_next));
    perform notify_org(r.org_id, 'report_edited', r.report_no || ' was edited after sign-off', p_change_note,
                       '/reports/' || p_report_id, v_signer,
                       jsonb_build_object('key', 'report_edited', 'params', jsonb_build_object('reportNo', r.report_no)));
  end if;
  perform enqueue_job('render_pdf', jsonb_build_object('reportId', p_report_id, 'version', v_next, 'emailRecipients', true, 'changeNote', p_change_note),
                      null, 'render_pdf:' || p_report_id || ':' || v_next);
  return jsonb_build_object('version', v_next, 'alreadyAttached', false,
                            'photosAdded', jsonb_array_length(v_added));
end $$;

revoke execute on function field_attach_photos(uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function field_attach_photos(uuid, uuid, text, text) to service_role;
