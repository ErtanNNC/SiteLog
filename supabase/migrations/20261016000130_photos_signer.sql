-- SiteLog · photos after sign-off email the signer (W2-04 fix; spec F9, F10, §13)
--
-- field_attach_photos() (20261016000030) clears reports.signed_off_by when photos added to a
-- signed-off report reopen it, and then queued render_pdf without the signer, so the "Updated"
-- email went to the recipients only. §13 "Recipients + signer": the signer of the version it
-- reopened is emailed too. render_pdf now carries `signerId` (as field_save_filed_correction()
-- does since 20261016000110); the worker passes it to send_email. Everything else as in
-- 20261016000030.
--
-- Live database (staging): one function body replaced with the same signature (grants kept).

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
