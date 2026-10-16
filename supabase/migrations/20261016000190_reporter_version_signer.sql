-- SiteLog · a reporter's version carries the signer of a superseded reopening (W2-12 review; spec
-- F9, F10, §13, §19 Q101)
--
-- create_report_version() (20261016000160) carries the signer of the version an office edit
-- supersedes when that version had reopened a sign-off and was superseded before its render queued
-- the "Updated" email (render_pdf sends none for a superseded version). The reporter's own new
-- versions did not: photos added after filing (field_attach_photos(), 20261016000130) and a change
-- saved from Past reports (field_save_filed_correction(), 20261016000110) passed only the current
-- signed_off_by, so a signer whose sign-off a first change reopened never heard of the report when
-- a second change came before the first one's PDF. Both now look the signer up the same way.
-- Everything else as in those files.
--
-- Live database (staging): two function bodies replaced with the same signatures (grants kept).

set local lock_timeout = '5s';

create or replace function field_attach_photos(p_report_id uuid, p_batch_id uuid, p_change_note text, p_caption text default null)
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
  -- §19 Q101 (W2-12 review, as create_report_version() since 20261016000160): the version this
  -- one supersedes reopened a sign-off and its "Updated" email was never queued; its signer gets
  -- this one.
  if v_signer is null then
    select (j.payload ->> 'signerId')::uuid into v_signer from jobs j
    where j.dedupe_key = 'render_pdf:' || p_report_id || ':' || r.current_version
      and j.payload ->> 'signerId' ~ '^[0-9a-f-]{36}$'
      and not exists (select 1 from jobs e
                      where e.dedupe_key = 'email:report_updated:' || p_report_id || ':' || r.current_version);
  end if;
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
  -- §13 "Recipients + signer": the signer of the version this one reopened (signed_off_by is
  -- cleared above), emailed with the recipients (send_email signerId, as W2-11's change).
  perform enqueue_job('render_pdf', jsonb_build_object('reportId', p_report_id, 'version', v_next, 'emailRecipients', true, 'changeNote', p_change_note)
                        || case when v_signer is null then '{}'::jsonb
                                else jsonb_build_object('signerId', v_signer) end,
                      null, 'render_pdf:' || p_report_id || ':' || v_next);
  return jsonb_build_object('version', v_next, 'alreadyAttached', false,
                            'photosAdded', jsonb_array_length(v_added));
end $$;


create or replace function field_save_filed_correction(
  p_correction_id uuid, p_report_id uuid, p_reporter_id uuid, p_change_note text,
  p_message jsonb default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  r reports%rowtype;
  s sites%rowtype;
  c draft_corrections%rowtype;
  v_date date;
  v_rev int;
  v_prev jsonb;
  v_data jsonb;
  v_next int;
  v_signer uuid;
  v_note text := left(btrim(coalesce(p_change_note, '')), 500);
  v_payload jsonb;
  v_job bigint;
begin
  select * into r from reports where id = p_report_id;
  if r.id is null or r.status = 'void' or not field_reporter_on_site(p_reporter_id, r.site_id) then
    raise exception 'report_not_found' using errcode = 'P0002';
  end if;
  perform 1 from site_days where id = r.site_day_id for update;
  select * into r from reports where id = p_report_id for update;
  select * into c from draft_corrections where id = p_correction_id and report_id = r.id for update;
  if c.id is null or c.reporter_id <> p_reporter_id or not c.after_filing then
    raise exception 'correction_not_found' using errcode = 'P0002';
  end if;
  -- Saved before (a lost response): the version it made.
  if c.status = 'applied' then
    return jsonb_build_object('status', 'applied', 'reportStatus', r.status,
                              'version', c.version_created, 'repeat', true);
  end if;
  if c.status <> 'ready' then
    raise exception 'correction_not_ready' using errcode = 'P0001';
  end if;
  if r.status not in ('filed', 'signed_off') then
    raise exception 'wrong_state' using errcode = 'P0001';
  end if;
  select * into s from sites where id = r.site_id;
  select date into v_date from site_days where id = r.site_day_id;
  if not field_report_changeable(v_date, s.timezone) then
    raise exception 'report_locked' using errcode = 'P0001';
  end if;
  if v_note = '' then
    raise exception 'change note required';
  end if;
  select draft_rev, data into v_rev, v_prev from report_versions
  where report_id = r.id and version = r.current_version;
  -- Only on the version the preview was made from (the office edited it, photos were added: stale).
  if r.current_version <> c.base_version or v_rev is distinct from c.base_rev then
    update draft_corrections set status = 'stale', reason = 'version_changed' where id = c.id;
    perform log_audit(r.org_id, 'reporter', p_reporter_id, 'report.correction_stale', 'report', r.id,
      jsonb_build_object('correction_id', c.id, 'status', r.status, 'version', r.current_version,
                         'base_version', c.base_version, 'after_filing', true));
    return jsonb_build_object('status', 'stale', 'reportStatus', r.status,
                              'currentVersion', r.current_version, 'draftRev', v_rev);
  end if;

  -- A fix never changes photos (CORRECTION_ROOTS): the version keeps its photos exactly as they were.
  v_data := c.data - 'photos';
  if v_prev ? 'photos' then
    v_data := v_data || jsonb_build_object('photos', v_prev -> 'photos');
  end if;
  v_next := r.current_version + 1;
  insert into report_versions (report_id, version, data, summary, author, author_reporter_id, via, change_note)
  values (r.id, v_next, v_data, nullif(v_data ->> 'summary', ''), 'reporter', p_reporter_id, 'web', v_note);
  perform denormalize_report_version(r.id, v_next);
  v_signer := r.signed_off_by;
  -- §19 Q101 (W2-12 review, as create_report_version() since 20261016000160): the version this
  -- one supersedes reopened a sign-off and its "Updated" email was never queued; its signer gets
  -- this one.
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
  where id = c.id;

  perform log_audit(r.org_id, 'reporter', p_reporter_id, 'report.version_created', 'report', r.id,
    jsonb_build_object('version', v_next, 'change_note', v_note, 'via', 'web',
                       'correction_id', c.id, 'changes', c.changes));
  perform log_audit(r.org_id, 'reporter', p_reporter_id, 'report.correction_saved', 'report', r.id,
    jsonb_build_object('correction_id', c.id, 'via', c.via, 'upload_id', c.upload_id,
                       'channel', 'web', 'from_version', r.current_version, 'version', v_next));
  if r.status = 'signed_off' then
    -- F10: a change after sign-off reopens it (re-sign required), and the signer is told.
    perform log_audit(r.org_id, 'reporter', p_reporter_id, 'report.signoff_reverted', 'report', r.id,
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
      'reporterId', p_reporter_id,
      'weekday', left(p_message ->> 'weekday', 40),
      'change', left(p_message ->> 'change', 300)));
  end if;
  v_job := enqueue_job('render_pdf', v_payload, null, 'render_pdf:' || r.id || ':' || v_next);
  return jsonb_build_object('status', 'applied', 'reportStatus', 'filed', 'version', v_next,
                            'jobId', v_job);
end $$;

