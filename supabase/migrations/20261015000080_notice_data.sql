-- SiteLog · panel notices in the reader's language (review 2026-10-15)
--
-- Every notice was stored as English `title` / `body` and the panel showed them verbatim, so a
-- Turkish panel (Demir Yapı, or anyone who picks Türkçe) read English. The panel's language is
-- the reader's (§6.3: their choice, else the org locale), so the text cannot be decided when the
-- row is written. Each notice now also stores what it says as data, and the panel renders it
-- through its EN/TR copy (`shell.notifications.notices.<key>`, `parseNoticeData` in
-- packages/shared/src/notifications.ts):
--
--   1. notifications.data jsonb (null = no data: the row's English title / body, as before):
--      {"key": "<notice key>", "params": {...}}.
--   2. notify_org(..., p_data jsonb default null): the same function with a seventh argument. The
--      six-argument one is dropped, so every existing call (the deployed worker's positional six,
--      the edge functions' named ones, the SQL callers) resolves to this one with data null.
--   3. mark_site_day_missing(..., p_data jsonb default null): scheduler-tick passes the missing
--      notice's data; the deployed one (four named arguments) still works.
--   4. field_flag_late_upload() and create_report_version() pass the data of the notices they
--      write (`late_upload`, `report_edited`); their English title and body stay as they were.
--      create_report_version is 20261015000030's with only its notify_org call changed.
--
-- Live database (staging): one nullable column (no rewrite), two functions replaced by ones with
-- one more defaulted argument (service role only, as before), two replaced in place. Rows written
-- before stay data-less and keep rendering their English text.

set local lock_timeout = '5s';

-- 1. The data column ---------------------------------------------------------------------------------
alter table notifications add column data jsonb;

-- 2. notify_org with data ------------------------------------------------------------------------------
drop function notify_org(uuid, text, text, text, text, uuid);

create function notify_org(
  p_org uuid, p_kind text, p_title text, p_body text default null, p_target_path text default null,
  p_user_id uuid default null, p_data jsonb default null
) returns uuid language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  insert into notifications (org_id, user_id, kind, title, body, target_path, data)
  values (p_org, p_user_id, p_kind, p_title, p_body, p_target_path, p_data) returning id into v_id;
  return v_id;
end $$;

revoke execute on function notify_org(uuid, text, text, text, text, uuid, jsonb)
  from public, anon, authenticated;
grant execute on function notify_org(uuid, text, text, text, text, uuid, jsonb) to service_role;

-- 3. mark_site_day_missing with data -------------------------------------------------------------------
drop function mark_site_day_missing(uuid, timestamptz, text, text);

create function mark_site_day_missing(
  p_site_day_id uuid, p_missing_at timestamptz, p_title text, p_body text, p_data jsonb default null
) returns boolean
language plpgsql security definer set search_path = public as $$
declare
  v_from site_day_status;
  v_site uuid;
  v_org uuid;
begin
  select sd.status, sd.site_id into v_from, v_site
    from site_days sd
   where sd.id = p_site_day_id and sd.status in ('pending', 'reminded') and sd.reminder_stage < 4
     for update;
  if v_site is null then return false; end if;
  update site_days set status = 'missing', reminder_stage = 4 where id = p_site_day_id;
  v_org := site_org(v_site);
  perform log_audit(v_org, 'system', null, 'site_day.status_changed', 'site_day', p_site_day_id,
                    jsonb_build_object('from', v_from, 'to', 'missing', 'reminder_stage', 4,
                                       'missing_at', p_missing_at, 'by', 'scheduler-tick'));
  perform notify_org(v_org, 'missing_report', p_title, p_body, '/', null, p_data);
  perform enqueue_job('send_email',
                      jsonb_build_object('kind', 'report_missing', 'siteDayId', p_site_day_id,
                                         'siteId', v_site, 'orgId', v_org),
                      null,
                      'email:report_missing:' || p_site_day_id);
  return true;
end $$;

revoke execute on function mark_site_day_missing(uuid, timestamptz, text, text, jsonb)
  from public, anon, authenticated;
grant execute on function mark_site_day_missing(uuid, timestamptz, text, text, jsonb) to service_role;

-- 4. The SQL producers pass their notice's data ---------------------------------------------------------
create or replace function field_flag_late_upload(p_upload_id uuid, p_reporter_id uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  u uploads%rowtype;
  r reports%rowtype;
  sd site_days%rowtype;
  v_site text;
  v_reporter text;
  v_notified boolean := false;
begin
  select * into u from uploads where id = p_upload_id;
  if u.id is null or u.reporter_id is distinct from p_reporter_id or u.report_id is null
     or not field_reporter_on_site(p_reporter_id, u.site_id) then
    raise exception 'upload_not_found' using errcode = 'P0002';
  end if;
  -- The report's row lock serialises two late clips of one report (one notice).
  select * into r from reports where id = u.report_id for update;
  if exists (select 1 from audit_log
             where org_id = r.org_id and action = 'upload.accepted_late' and entity = 'upload'
               and entity_id = u.id) then
    return jsonb_build_object('flagged', false, 'reportId', r.id);
  end if;
  select * into sd from site_days where id = r.site_day_id;

  update reports set is_late = true where id = r.id and not is_late;
  update site_days set is_late = true where id = sd.id and not is_late;

  if not exists (select 1 from audit_log
                 where org_id = r.org_id and action = 'upload.accepted_late'
                   and diff ->> 'report_id' = r.id::text) then
    select name into v_site from sites where id = r.site_id;
    select name into v_reporter from reporters where id = p_reporter_id;
    perform notify_org(
      r.org_id,
      'late_upload',
      v_site || ' — late ' || case when u.kind = 'audio' then 'voice note' else 'photo' end
        || ' for ' || to_char(sd.date, 'Dy Mon FMDD'),
      coalesce(v_reporter, 'The site manager') || ' recorded it on that day, and it arrived after '
        || 'the day''s reporting window had closed. It is on report ' || r.report_no
        || ', marked late.',
      '/reports/' || r.id,
      null,
      jsonb_build_object('key', 'late_upload', 'params', jsonb_build_object(
        'site', v_site,
        'media', case when u.kind = 'audio' then 'audio' else 'photo' end,
        'date', to_char(sd.date, 'YYYY-MM-DD'),
        'reporter', v_reporter,
        'reportNo', r.report_no)));
    v_notified := true;
  end if;
  perform log_audit(r.org_id, 'reporter', p_reporter_id, 'upload.accepted_late', 'upload', u.id,
    jsonb_build_object('report_id', r.id, 'date', sd.date, 'kind', u.kind,
                       'recorded_at', u.recorded_at, 'received_at', u.received_at,
                       'notified', v_notified));
  return jsonb_build_object('flagged', true, 'reportId', r.id, 'notified', v_notified);
end $$;

create or replace function create_report_version(p_report_id uuid, p_data jsonb, p_change_note text, p_photos jsonb default '[]'::jsonb)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  r reports%rowtype;
  v_next int;
  v_signer uuid;
  v_data jsonb;
  v_key text;         -- data.photos key of the new version: uploadId (v2) or messageId (v1)
  v_prev jsonb;       -- data.photos of the version this edit replaces (null: none recorded)
  v_listed jsonb;     -- the photo entries to keep, before checking them
  v_kept jsonb;
  v_added jsonb;
  v_photos jsonb;
  v_prev_ids uuid[];
  v_ids uuid[];
begin
  select * into r from reports where id = p_report_id for update;
  if r.id is null then raise exception 'report not found'; end if;
  if not has_role(r.org_id, '{admin,pm,ops}') then raise exception 'not allowed' using errcode = '42501'; end if;
  if r.status not in ('filed','signed_off') then raise exception 'only filed reports can be edited by the office'; end if;
  if coalesce(trim(p_change_note), '') = '' then raise exception 'change note required'; end if;
  if jsonb_typeof(p_data) is distinct from 'object' then raise exception 'report data must be a JSON object'; end if;
  v_next := r.current_version + 1;
  v_key := report_photo_key(p_data);

  select case when jsonb_typeof(rv.data->'photos') = 'array' then rv.data->'photos' end into v_prev
  from report_versions rv where rv.report_id = p_report_id and rv.version = r.current_version;
  -- What the replaced version shows: its data.photos, or every photo of the report when it has none.
  v_prev_ids := case
    when v_prev is not null then array(
      select ps.media_id from jsonb_array_elements(v_prev) e
      join report_photo_sources(p_report_id) ps on ps.media_id::text = photo_entry_id(e))
    else array(select media_id from report_photo_sources(p_report_id))
  end;

  v_listed := case
    when jsonb_typeof(p_data->'photos') = 'array' then p_data->'photos'
    when v_prev is not null then v_prev
    else (select coalesce(jsonb_agg(jsonb_build_object('uploadId', ps.media_id, 'caption', ps.caption)
                                    order by ps.added_at, ps.media_id), '[]'::jsonb)
          from report_photo_sources(p_report_id) ps)
  end;
  select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
           v_key, k.media_id, 'caption', k.caption, 'takenAt', k.taken_at)) order by k.i), '[]'::jsonb)
  into v_kept
  from (
    select distinct on (ps.media_id) ps.media_id, e.i,
           nullif(btrim(case when jsonb_typeof(e.v->'caption') = 'string' then e.v->>'caption' end), '') as caption,
           coalesce(
             (select p->>'takenAt' from jsonb_array_elements(coalesce(v_prev, '[]'::jsonb)) p
              where photo_entry_id(p) = ps.media_id::text and jsonb_typeof(p->'takenAt') = 'string'
              limit 1),
             to_char(ps.taken_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
           ) as taken_at
    from jsonb_array_elements(v_listed) with ordinality e(v, i)
    join report_photo_sources(p_report_id) ps on ps.media_id::text = photo_entry_id(e.v)
    order by ps.media_id, e.i
  ) k;
  if exists (select 1 from jsonb_array_elements(v_kept) x where length(x->>'caption') > 500) then
    raise exception 'photo caption is too long';
  end if;
  v_added := attach_office_photos(p_report_id, p_photos, v_key);
  v_photos := place_office_photos(v_kept, v_added, p_photos);
  v_ids := array(select photo_entry_id(x)::uuid from jsonb_array_elements(v_photos) x);

  v_data := link_typed_companies(r.org_id, p_report_id, p_data,
    array(select substr(x, length('unknown_company:') + 1)
          from unnest(r.review_reasons) x where x like 'unknown_company:%'));
  v_data := v_data || jsonb_build_object('photos', v_photos);
  insert into report_versions (report_id, version, data, summary, author, author_user_id, change_note)
  values (p_report_id, v_next, v_data, v_data->>'summary', 'office_user', auth.uid(), p_change_note);
  perform denormalize_report_version(p_report_id, v_next);
  v_signer := r.signed_off_by;
  update reports set current_version = v_next,
    status = 'filed', signed_off_by = null, signed_off_at = null
  where id = p_report_id;
  perform log_audit(r.org_id, 'user', auth.uid(), 'report.version_created', 'report', p_report_id,
    jsonb_build_object('version', v_next, 'change_note', p_change_note,
      'photos', cardinality(v_ids),
      'photos_added', (select count(*) from unnest(v_ids) x where not x = any(v_prev_ids)),
      'photos_removed', (select count(distinct x) from unnest(v_prev_ids) x where not x = any(v_ids))));
  if r.status = 'signed_off' then
    perform log_audit(r.org_id, 'user', auth.uid(), 'report.signoff_reverted', 'report', p_report_id, jsonb_build_object('version', v_next));
    perform notify_org(r.org_id, 'report_edited', r.report_no || ' was edited after sign-off', p_change_note, '/reports/' || p_report_id, v_signer,
                       jsonb_build_object('key', 'report_edited', 'params', jsonb_build_object('reportNo', r.report_no)));
  end if;
  perform enqueue_job('render_pdf', jsonb_build_object('reportId', p_report_id, 'version', v_next, 'emailRecipients', true, 'changeNote', p_change_note),
                      null, 'render_pdf:' || p_report_id || ':' || v_next);
  return jsonb_build_object('version', v_next);
end $$;
