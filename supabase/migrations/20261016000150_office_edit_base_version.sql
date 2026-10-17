-- SiteLog · an office edit refuses a stale base version (W2-11 review; spec F18, §7.2, §19 Q106)
--
-- create_report_version() (latest body 20261015000080) made version n+1 from whatever data the
-- panel sent, with no check of the version the editor had opened. Since W2-04 and W2-11 the
-- reporter makes versions too (photos added after filing, Change something), so an office edit
-- opened on v1 and saved after the reporter's v2 silently replaced v2 (its change and the photos
-- added meanwhile). Spec §19 Q106 (decided: the recommended default): the edit names the version
-- it was opened on and is refused (`version_changed`) when the report has a newer one; the panel
-- says "This report changed. Reload to see the latest version."
--
--   1. create_report_version(p_report_id, p_data, p_change_note, p_photos, p_base_version):
--      a new overload, the body of 20261015000080 with the base check first.
--   2. create_report_version(p_report_id, p_data, p_change_note, p_photos default '[]'): the
--      existing signature, kept for existing callers, now the overload with no base (no check).
--
-- Live database (staging): one new function (authenticated, as the old one), one function body
-- replaced with the same signature (its grants kept). The deployed v1.0 code calls the old one.

set local lock_timeout = '5s';

-- 1. The overload with the base version ------------------------------------------------------------------
create function create_report_version(p_report_id uuid, p_data jsonb, p_change_note text, p_photos jsonb,
                                      p_base_version int)
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
  -- The version the edit was opened on (null: no check, the 4-argument callers). A newer one (the
  -- reporter's change from the phone, photos added) is never overwritten by an older edit.
  if p_base_version is not null and p_base_version <> r.current_version then
    raise exception 'version_changed' using errcode = 'P0001',
      detail = jsonb_build_object('currentVersion', r.current_version)::text;
  end if;
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

revoke execute on function create_report_version(uuid, jsonb, text, jsonb, int) from public, anon;
grant execute on function create_report_version(uuid, jsonb, text, jsonb, int) to authenticated;

-- 2. The old signature: no base, no check ------------------------------------------------------------------
create or replace function create_report_version(p_report_id uuid, p_data jsonb, p_change_note text, p_photos jsonb default '[]'::jsonb)
returns jsonb
language sql security definer set search_path = public as $$
  select create_report_version(p_report_id, p_data, p_change_note, coalesce(p_photos, '[]'::jsonb), null::int);
$$;
