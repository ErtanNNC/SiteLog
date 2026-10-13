-- SiteLog · photos on reports typed or edited in the panel (2026-10-13)
--   An office without the WhatsApp worker types its daily reports in the panel, but a report could
--   only show photos a site manager had sent on WhatsApp. The panel now uploads photos to the
--   private `photos` bucket and files them with the report (New report) or with an edit (Edit).
--   1. messages: an office upload is stored like a WhatsApp photo, as a messages row (direction
--      in, type image, payload.source office_upload) plus a report_sources row (kind photo), so the
--      report page, the Photos tab, the worker PDF and the evidence pack read it unchanged. It has
--      no conversation: conversation_id is now nullable and the row carries org_id instead (one of
--      the two is required). message_org() and the messages policy read whichever is set.
--   2. Storage: office roles may upload to photos/{org}/{site}/office/{uuid}.{jpg|jpeg|png|webp}.
--      Names are random, so there is no overwrite (no UPDATE policy).
--   3. create_office_report() and create_report_version() take p_photos, the new uploads
--      [{path, mime, caption, takenAt, position}] (at most 20 per call). Each path must be an office
--      path of the report's org and site, its type must match its name, it must be in the bucket
--      and not attached yet. A version's data.photos lists the photos that version shows, in order:
--      an edit keeps the report's photos still listed in p_data.photos (with their edited captions;
--      the times stay the recorded ones) and places the new uploads among them at their `position`
--      (index in the final list; none: after them), so the office chooses which photos the PDF
--      prints first. A photo left out is removed from that version only: older versions and their
--      PDFs keep it. When p_data has no photos array the replaced version's photos are kept. The
--      photo count, added and removed are audited in report.filed / report.version_created.
--   4. An upload that was never attached (the call failed or found the day already filed, the tab
--      was closed) has no messages row, so the retention job's walk over messages never sees it:
--      list_orphan_office_photos() lists such objects for retention_cleanup to delete after a day.
--   The 3-argument functions are dropped so no overload remains; calls without p_photos still work.

-- 1. Messages without a conversation ----------------------------------------------------------------
alter table messages alter column conversation_id drop not null;
alter table messages add column org_id uuid references orgs on delete cascade;  -- + office uploads
alter table messages add constraint messages_conversation_or_org
  check (conversation_id is not null or org_id is not null);
create index messages_org_id on messages (org_id) where org_id is not null;
-- One message per uploaded object (retention purges set storage_path to null).
create unique index messages_office_storage_path on messages (storage_path)
  where org_id is not null and storage_path is not null;

create or replace function message_org(p_message_id uuid) returns uuid
language sql stable security definer set search_path = public as $$
  select coalesce(c.org_id, m.org_id)
  from messages m left join conversations c on c.id = m.conversation_id
  where m.id = p_message_id;
$$;

drop policy messages_select on messages;
create policy messages_select on messages for select to authenticated
  using (has_role(coalesce(conversation_org(conversation_id), org_id), '{admin,pm,ops}'));

-- 2. Storage: office uploads photos ----------------------------------------------------------------
-- Read access is "members read org files" (20261011000006_platform.sql).
do $$
begin
  if exists (select 1 from pg_namespace where nspname = 'storage') then
    execute $p$ create policy "office uploads photos" on storage.objects for insert to authenticated
      with check (bucket_id = 'photos'
                  and (storage.foldername(name))[3] = 'office'
                  and public.has_role(((storage.foldername(name))[1])::uuid, '{admin,pm,ops}')) $p$;
  end if;
end $$;

-- 3. Photos on office-filed reports and office edits -----------------------------------------------

-- Internal: checks p_photos (the new uploads) against the report's org and site, stores each one as
-- a message + photo source of the report and returns their data.photos entries
-- [{messageId, caption?, takenAt}]. Called by the two RPCs below only.
create or replace function attach_office_photos(p_report_id uuid, p_photos jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  r reports%rowtype;
  v_photos jsonb := coalesce(p_photos, '[]'::jsonb);
  v_item jsonb;
  v_path text;
  v_mime text;
  v_caption text;
  v_taken timestamptz;
  v_uploaded boolean;
  v_message_id uuid;
  v_out jsonb := '[]'::jsonb;
begin
  select * into r from reports where id = p_report_id;
  if r.id is null then raise exception 'report not found'; end if;
  -- Both callers check this already; it also guards a direct call should the revoke below lapse.
  if not has_role(r.org_id, '{admin,pm,ops}') then raise exception 'not allowed' using errcode = '42501'; end if;
  if jsonb_typeof(v_photos) is distinct from 'array' then raise exception 'photos must be a JSON array'; end if;
  if jsonb_array_length(v_photos) > 20 then raise exception 'at most 20 photos at a time'; end if;

  for v_item in select e from jsonb_array_elements(v_photos) e loop
    if jsonb_typeof(v_item) is distinct from 'object' then raise exception 'photo must be a JSON object'; end if;
    v_path := case when jsonb_typeof(v_item->'path') = 'string' then v_item->>'path' end;
    if v_path is null or v_path !~ ('^' || r.org_id || '/' || r.site_id
        || '/office/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|jpeg|png|webp)$') then
      raise exception 'unexpected photo path';
    end if;
    v_mime := v_item->>'mime';
    if v_mime is null or v_mime not in ('image/jpeg', 'image/png', 'image/webp') then
      raise exception 'unsupported photo type';
    end if;
    -- The PDF renderers pick the image decoder from the file name.
    if v_mime <> (case substring(v_path from '\.([a-z]+)$')
                    when 'png' then 'image/png' when 'webp' then 'image/webp' else 'image/jpeg' end) then
      raise exception 'photo type does not match its file name';
    end if;
    if jsonb_typeof(v_item->'caption') not in ('string', 'null') then raise exception 'photo caption must be text'; end if;
    v_caption := nullif(btrim(v_item->>'caption'), '');
    if length(v_caption) > 500 then raise exception 'photo caption is too long'; end if;
    -- When the photo was taken (the panel reads it from the file); never later than now.
    v_taken := now();
    if jsonb_typeof(v_item->'takenAt') = 'string' then
      begin
        v_taken := (v_item->>'takenAt')::timestamptz;
      exception when others then
        raise exception 'invalid photo time';
      end;
      if not isfinite(v_taken) then raise exception 'invalid photo time'; end if;
      v_taken := least(v_taken, now());
    elsif jsonb_typeof(v_item->'takenAt') is distinct from 'null' and v_item ? 'takenAt' then
      raise exception 'invalid photo time';
    end if;
    -- Where the photo goes in the version's list (place_office_photos); absent or null: at the end.
    if jsonb_typeof(v_item->'position') = 'number' then
      if (v_item->>'position')::numeric <> trunc((v_item->>'position')::numeric)
         or (v_item->>'position')::numeric not between 0 and 1000 then
        raise exception 'invalid photo position';
      end if;
    elsif jsonb_typeof(v_item->'position') is distinct from 'null' and v_item ? 'position' then
      raise exception 'invalid photo position';
    end if;

    if exists (select 1 from messages m where m.org_id = r.org_id and m.storage_path = v_path) then
      raise exception 'photo already attached';
    end if;
    if to_regclass('storage.objects') is not null then
      execute 'select exists (select 1 from storage.objects where bucket_id = $1 and name = $2)'
        into v_uploaded using 'photos', v_path;
      if not v_uploaded then raise exception 'photo not uploaded'; end if;
    end if;

    insert into messages (org_id, conversation_id, direction, type, body, payload, media_mime, storage_path, status)
    values (r.org_id, null, 'in', 'image', v_caption,
            jsonb_build_object('source', 'office_upload', 'uploaded_by', auth.uid()),
            v_mime, v_path, 'received')
    returning id into v_message_id;
    insert into report_sources (report_id, message_id, kind, caption, taken_at)
    values (p_report_id, v_message_id, 'photo', v_caption, v_taken);
    v_out := v_out || jsonb_build_array(jsonb_strip_nulls(jsonb_build_object(
      'messageId', v_message_id,
      'caption', v_caption,
      'takenAt', to_char(v_taken at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))));
  end loop;
  return v_out;
end $$;

-- Internal: a version's data.photos from the entries it keeps (in their order) and the entries
-- attach_office_photos() returned for p_photos. An upload with a position is inserted at that index
-- of the final list, lowest first, so each lands where the panel showed it; one without follows at
-- the end, in p_photos order.
create or replace function place_office_photos(p_kept jsonb, p_added jsonb, p_photos jsonb) returns jsonb
language plpgsql immutable set search_path = public as $$
declare
  v_out jsonb := coalesce(p_kept, '[]'::jsonb);
  x record;
begin
  for x in
    select a.v as entry, (u.v->>'position')::numeric::int as pos
    from jsonb_array_elements(coalesce(p_added, '[]'::jsonb)) with ordinality a(v, i)
    join jsonb_array_elements(coalesce(p_photos, '[]'::jsonb)) with ordinality u(v, j) on u.j = a.i
    order by (u.v->>'position') is null, (u.v->>'position')::numeric, a.i
  loop
    if x.pos is null or x.pos >= jsonb_array_length(v_out) then
      v_out := v_out || jsonb_build_array(x.entry);
    else
      v_out := jsonb_insert(v_out, array[x.pos::text], x.entry);
    end if;
  end loop;
  return v_out;
end $$;

drop function if exists create_office_report(uuid, date, jsonb);
drop function if exists create_report_version(uuid, jsonb, text);

-- create_office_report (20261013000003), now with photos: version 1 shows the uploads in p_photos
-- (ordered by position, then as sent); any photos in p_data are replaced by them.
create function create_office_report(p_site_id uuid, p_date date, p_data jsonb, p_photos jsonb default '[]'::jsonb)
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
  v_data := p_data || jsonb_build_object('reportDate', to_char(p_date, 'YYYY-MM-DD'), 'schemaVersion', 1);

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
                       reporter_id, received_at, confirmed_at, filed_at, is_late)
  values (s.org_id, p_site_id, sd.id, v_report_no, 'filed', 'daily', 1,
          null, now(), null, now(), v_late)  -- confirmed_at: only a WhatsApp confirm sets it
  returning id into v_report_id;

  v_photos := place_office_photos('[]'::jsonb, attach_office_photos(v_report_id, p_photos), p_photos);
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

-- create_report_version (20261013000003), now with photos. data.photos of the new version: the
-- entries of p_data.photos that are photos of this report (first occurrence, in that order, caption
-- as sent, time as recorded), with the uploads in p_photos placed among them (place_office_photos).
create function create_report_version(p_report_id uuid, p_data jsonb, p_change_note text, p_photos jsonb default '[]'::jsonb)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  r reports%rowtype;
  v_next int;
  v_signer uuid;
  v_data jsonb;
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

  select case when jsonb_typeof(rv.data->'photos') = 'array' then rv.data->'photos' end into v_prev
  from report_versions rv where rv.report_id = p_report_id and rv.version = r.current_version;
  -- What the replaced version shows: its data.photos, or every photo of the report when it has none.
  v_prev_ids := case
    when v_prev is not null then array(
      select rs.message_id from jsonb_array_elements(v_prev) e
      join report_sources rs on rs.report_id = p_report_id and rs.kind = 'photo'
                            and rs.message_id::text = lower(e->>'messageId'))
    else array(select message_id from report_sources where report_id = p_report_id and kind = 'photo')
  end;

  v_listed := case
    when jsonb_typeof(p_data->'photos') = 'array' then p_data->'photos'
    when v_prev is not null then v_prev
    else (select coalesce(jsonb_agg(jsonb_build_object('messageId', rs.message_id, 'caption', rs.caption)
                                    order by m.created_at, rs.message_id), '[]'::jsonb)
          from report_sources rs join messages m on m.id = rs.message_id
          where rs.report_id = p_report_id and rs.kind = 'photo')
  end;
  select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
           'messageId', k.message_id, 'caption', k.caption, 'takenAt', k.taken_at)) order by k.i), '[]'::jsonb)
  into v_kept
  from (
    select distinct on (rs.message_id) rs.message_id, e.i,
           nullif(btrim(case when jsonb_typeof(e.v->'caption') = 'string' then e.v->>'caption' end), '') as caption,
           coalesce(
             (select p->>'takenAt' from jsonb_array_elements(coalesce(v_prev, '[]'::jsonb)) p
              where lower(p->>'messageId') = rs.message_id::text and jsonb_typeof(p->'takenAt') = 'string'
              limit 1),
             to_char(coalesce(rs.taken_at, m.created_at) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
           ) as taken_at
    from jsonb_array_elements(v_listed) with ordinality e(v, i)
    join report_sources rs on rs.report_id = p_report_id and rs.kind = 'photo'
                          and rs.message_id::text = lower(e.v->>'messageId')
    join messages m on m.id = rs.message_id
    order by rs.message_id, e.i
  ) k;
  if exists (select 1 from jsonb_array_elements(v_kept) x where length(x->>'caption') > 500) then
    raise exception 'photo caption is too long';
  end if;
  v_added := attach_office_photos(p_report_id, p_photos);
  v_photos := place_office_photos(v_kept, v_added, p_photos);
  v_ids := array(select (x->>'messageId')::uuid from jsonb_array_elements(v_photos) x);

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
    perform notify_org(r.org_id, 'report_edited', r.report_no || ' was edited after sign-off', p_change_note, '/reports/' || p_report_id, v_signer);
  end if;
  perform enqueue_job('render_pdf', jsonb_build_object('reportId', p_report_id, 'version', v_next, 'emailRecipients', true, 'changeNote', p_change_note, 'notifyReporter', true),
                      null, 'render_pdf:' || p_report_id || ':' || v_next);
  return jsonb_build_object('version', v_next);
end $$;

revoke execute on function create_office_report(uuid, date, jsonb, jsonb),
  create_report_version(uuid, jsonb, text, jsonb) from public, anon;
grant execute on function create_office_report(uuid, date, jsonb, jsonb),
  create_report_version(uuid, jsonb, text, jsonb) to authenticated;
revoke execute on function attach_office_photos(uuid, jsonb) from public, anon, authenticated;
revoke execute on function place_office_photos(jsonb, jsonb, jsonb) from public, anon, authenticated;

-- 4. Office uploads never attached to a report ------------------------------------------------------
-- Objects under {org}/{site}/office/ older than p_before that no message stores (an attached
-- upload always has one, until retention purges it). The worker's retention_cleanup deletes them
-- through the Storage API (service role); empty where there is no storage schema (tests).
create or replace function list_orphan_office_photos(p_before timestamptz, p_limit int default 200)
returns setof text
language plpgsql stable security definer set search_path = public as $$
begin
  if to_regclass('storage.objects') is null then return; end if;
  return query execute
    $q$select o.name::text from storage.objects o
       where o.bucket_id = 'photos'
         and o.name ~ '^[^/]+/[^/]+/office/[^/]+$'
         and o.created_at < $1
         and not exists (select 1 from public.messages m
                         where m.org_id is not null and m.storage_path = o.name)
       order by o.created_at, o.name
       limit $2$q$
    using p_before, greatest(coalesce(p_limit, 200), 0);
end $$;
revoke execute on function list_orphan_office_photos(timestamptz, int) from public, anon, authenticated;
