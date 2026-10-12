-- SiteLog · web panel gaps (2026-10-12)
--   1. org_settings.payroll_columns — payroll CSV column order (§P12 "columns order", §F15 step 5)
--   2. settings audit trail — every org_settings update writes audit_log (§F18 "Save → … audit log")
--   3. set_org_logo()     — admin sets / clears orgs.logo_path after a Storage upload (§F2, §F18)
--   4. update_reporter()  — Team → Edit reporter: name, role, sites, languages in one audited
--                            transaction (§P10). The phone number is not editable: disable + re-invite.
--   5. Storage: admins may overwrite (upsert) and delete their org's logo in bucket `logos`.

-- 1. Payroll CSV column order ------------------------------------------------------------------
-- Same names as the §F15 header. Exports normalise the list (unknown / duplicate names dropped,
-- missing ones appended), so the CSV always carries every column.
alter table org_settings
  add column payroll_columns text[] not null
    default '{date,site,project_code,company,trade,workers,hours,report_no,version}'
    constraint org_settings_payroll_columns_known check (
      payroll_columns <@ '{date,site,project_code,company,trade,workers,hours,report_no,version}'::text[]
      and cardinality(payroll_columns) between 1 and 9
    );

-- 2. Settings audit trail ---------------------------------------------------------------------
-- The panel saves settings with a plain RLS update (admin only); the diff of changed columns is
-- logged here so every path (panel, SQL console, service role) leaves a trace.
create or replace function audit_org_settings_update() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_diff jsonb;
begin
  select jsonb_object_agg(n.key, n.value) into v_diff
  from jsonb_each(to_jsonb(new)) as n(key, value)
  join jsonb_each(to_jsonb(old)) as o(key, value) on o.key = n.key
  where n.key <> 'updated_at' and n.value is distinct from o.value;
  if v_diff is not null then
    perform log_audit(new.org_id, case when auth.uid() is null then 'system' else 'user' end,
      auth.uid(), 'settings.updated', 'org', new.org_id, v_diff);
  end if;
  return null;
end $$;

create trigger org_settings_audit after update on org_settings
  for each row execute function audit_org_settings_update();

-- 3. Company logo -------------------------------------------------------------------------------
-- The panel uploads the file to Storage (`logos/{org_id}/logo.png|svg`, PNG/SVG ≤ 2 MB checked
-- client-side) and then records the path here. null clears the logo; PDFs fall back to the name.
create or replace function set_org_logo(p_org_id uuid, p_logo_path text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_old text;
begin
  if not has_role(p_org_id, '{admin}') then raise exception 'not allowed' using errcode = '42501'; end if;
  if p_logo_path is not null and p_logo_path !~ ('^' || p_org_id::text || '/logo\.(png|svg)$') then
    raise exception 'logo path must be {org_id}/logo.png or {org_id}/logo.svg';
  end if;
  select logo_path into v_old from orgs where id = p_org_id for update;
  update orgs set logo_path = p_logo_path where id = p_org_id;
  perform log_audit(p_org_id, 'user', auth.uid(),
    case when p_logo_path is null then 'org.logo_removed' else 'org.logo_updated' end,
    'org', p_org_id, jsonb_build_object('from', v_old, 'to', p_logo_path));
  return jsonb_build_object('logo_path', p_logo_path);
end $$;

-- 4. Edit reporter ------------------------------------------------------------------------------
-- Replaces the reporter's site links with p_site_ids (all in the reporter's org, at least one).
-- New links become primary on sites without a primary (same rule as api-invite-reporter); a site
-- that loses its primary promotes the next reporter (enabled first, site managers first, oldest).
create or replace function update_reporter(
  p_reporter_id uuid,
  p_name text,
  p_role reporter_role,
  p_site_ids uuid[],
  p_languages text[]
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  r reporters%rowtype;
  v_name text := trim(coalesce(p_name, ''));
  v_sites uuid[];
  v_langs text[];
  v_before uuid[];
  v_added uuid[];
  v_removed uuid[];
  v_orphaned uuid[];
begin
  select * into r from reporters where id = p_reporter_id for update;
  if r.id is null then raise exception 'reporter not found'; end if;
  if not has_role(r.org_id, '{admin,ops}') then raise exception 'not allowed' using errcode = '42501'; end if;
  if v_name = '' then raise exception 'name required'; end if;

  v_sites := array(
    select s from unnest(coalesce(p_site_ids, '{}'::uuid[])) with ordinality as u(s, ord)
    where s is not null group by s order by min(ord)
  );
  if cardinality(v_sites) = 0 then raise exception 'pick at least one site'; end if;
  if exists (select 1 from unnest(v_sites) as u(s) where site_org(s) is distinct from r.org_id) then
    raise exception 'site not found in this organisation';
  end if;

  v_langs := array(
    select l from (
      select lower(trim(x)) as l, min(ord) as ord
      from unnest(coalesce(p_languages, '{}'::text[])) with ordinality as u(x, ord)
      where trim(coalesce(x, '')) <> ''
      group by 1
    ) t order by ord
  );
  if cardinality(v_langs) = 0 then v_langs := '{en}'; end if;
  if exists (select 1 from unnest(v_langs) as u(l) where l !~ '^[a-z]{2,3}$') then
    raise exception 'unknown language code';
  end if;

  v_before := array(select site_id from site_reporters where reporter_id = r.id order by site_id);
  v_added := array(select s from unnest(v_sites) as u(s) where not (s = any(v_before)));
  v_removed := array(select s from unnest(v_before) as u(s) where not (s = any(v_sites)));
  v_orphaned := array(
    select site_id from site_reporters
    where reporter_id = r.id and is_primary and site_id = any(v_removed)
  );

  update reporters set name = v_name, role = p_role, languages = v_langs where id = r.id;

  delete from site_reporters where reporter_id = r.id and site_id = any(v_removed);
  insert into site_reporters (site_id, reporter_id, is_primary)
  select s, r.id, not exists (select 1 from site_reporters x where x.site_id = s and x.is_primary)
  from unnest(v_added) as u(s);

  update site_reporters sr set is_primary = true
  from (
    select distinct on (x.site_id) x.site_id, x.reporter_id
    from site_reporters x join reporters rr on rr.id = x.reporter_id
    where x.site_id = any(v_orphaned)
    order by x.site_id, (rr.status = 'disabled'), (rr.role = 'site_manager') desc, rr.created_at, rr.id
  ) nxt
  where sr.site_id = nxt.site_id and sr.reporter_id = nxt.reporter_id
    and not exists (select 1 from site_reporters y where y.site_id = nxt.site_id and y.is_primary);

  perform log_audit(r.org_id, 'user', auth.uid(), 'reporter.updated', 'reporter', r.id,
    jsonb_strip_nulls(jsonb_build_object(
      'name', case when r.name is distinct from v_name
                   then jsonb_build_object('from', r.name, 'to', v_name) end,
      'role', case when r.role is distinct from p_role
                   then jsonb_build_object('from', r.role, 'to', p_role) end,
      'languages', case when r.languages is distinct from v_langs
                        then jsonb_build_object('from', r.languages, 'to', v_langs) end,
      'sites_added', case when cardinality(v_added) > 0 then to_jsonb(v_added) end,
      'sites_removed', case when cardinality(v_removed) > 0 then to_jsonb(v_removed) end
    )));

  return jsonb_build_object(
    'id', r.id, 'name', v_name, 'role', p_role, 'languages', to_jsonb(v_langs),
    'site_ids', to_jsonb(v_sites), 'added', to_jsonb(v_added), 'removed', to_jsonb(v_removed)
  );
end $$;

revoke execute on function set_org_logo(uuid, text),
  update_reporter(uuid, text, reporter_role, uuid[], text[]) from public, anon;
grant execute on function set_org_logo(uuid, text),
  update_reporter(uuid, text, reporter_role, uuid[], text[]) to authenticated;

-- 5. Storage: logo overwrite + delete -----------------------------------------------------------
-- `upload(..., { upsert: true })` needs UPDATE (and SELECT) on an existing object; "admins upload
-- logos" (20261011000006) only covers INSERT. Removing / switching PNG ↔ SVG needs DELETE.
do $$
begin
  if exists (select 1 from pg_namespace where nspname = 'storage') then
    execute $p$ create policy "admins update logos" on storage.objects for update to authenticated
      using (bucket_id = 'logos' and public.has_role(((storage.foldername(name))[1])::uuid, '{admin}'))
      with check (bucket_id = 'logos' and public.has_role(((storage.foldername(name))[1])::uuid, '{admin}')) $p$;
    execute $p$ create policy "admins delete logos" on storage.objects for delete to authenticated
      using (bucket_id = 'logos' and public.has_role(((storage.foldername(name))[1])::uuid, '{admin}')) $p$;
  end if;
end $$;
