-- SiteLog · the glossary through audited RPCs (W3-08; spec F21, P11, §2.2 "Manage glossary")
--
--   1. resolve_unknown_company() remembers the mapping in one glossary row (audit
--      "resolve_unknown_company adds a duplicate glossary row on every resolve"): its
--      `insert … on conflict do nothing` could never fire (glossary_terms has no unique key besides
--      the id), so every resolve added another confirmed "name → company" row, and the Glossary
--      page, the extraction prompt and the speech hints listed each one. Now the org's company
--      rows for that name (any case) are updated, and a row is inserted only when there is none,
--      as the worker's upsertGlossaryTerm does. Same signature, replaced in place; everything else
--      in the function is as 20261011000005_rpcs.sql wrote it.
--   2. add_glossary_term(): the panel's *Add term* (P11) as an audited RPC (`glossary.added`),
--      not a direct insert. The same heard phrase (any case), kind and scope as an existing row of
--      the org updates that row (official, language, confirmed) instead of adding a second one.
--      A new row starts at times_heard 0: nobody has said it yet.
--
-- Rows the old resolve duplicated stay (a cleanup deletes data on the live database: proposed to
-- the owner, not done here). The glossary_terms write policy stays, so a panel deployed before
-- this migration keeps working; the panel built with it writes only through the RPCs.
--
-- Live database (staging): one function replaced in place, one new function. No table change.

-- 1. resolve_unknown_company: update the mapping, insert only when there is none -----------------
create or replace function resolve_unknown_company(p_report_id uuid, p_name text, p_action text, p_company_id uuid default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare r reports%rowtype; v_company companies%rowtype; v_data jsonb; v_next int; v_reasons text[];
begin
  select * into r from reports where id = p_report_id for update;
  if r.id is null then raise exception 'report not found'; end if;
  if not has_role(r.org_id, '{admin,pm,ops}') then raise exception 'not allowed' using errcode = '42501'; end if;

  if p_action = 'add' then
    insert into companies (org_id, name, status) values (r.org_id, p_name, 'confirmed')
    on conflict (org_id, name) do update set status = 'confirmed'
    returning * into v_company;
  elsif p_action = 'map' then
    select * into v_company from companies where id = p_company_id and org_id = r.org_id;
    if v_company.id is null then raise exception 'company not found'; end if;
    if not (p_name = any(v_company.aliases)) and p_name <> v_company.name then
      update companies set aliases = array_append(aliases, p_name) where id = v_company.id;
    end if;
  else
    raise exception 'unknown action %', p_action;
  end if;

  -- glossary: remember the mapping, in the row(s) the org already has for this name
  update glossary_terms set status = 'confirmed', official = v_company.name, company_id = v_company.id
  where org_id = r.org_id and kind = 'company' and lower(heard) = lower(p_name);
  if not found then
    insert into glossary_terms (org_id, heard, official, kind, company_id, status, times_heard, last_seen_at)
    values (r.org_id, p_name, v_company.name, 'company', v_company.id, 'confirmed', 1, now());
  end if;

  select data into v_data from report_versions where report_id = p_report_id and version = r.current_version;
  v_data := jsonb_set(v_data, '{manpower}', (
    select coalesce(jsonb_agg(
      case when (m->>'companyId') is null and (lower(m->>'companyName') = lower(p_name) or lower(m->>'companyNameHeard') = lower(p_name))
           then m || jsonb_build_object('companyId', v_company.id::text, 'companyName', v_company.name,
                     'source', coalesce(m->'source','[]'::jsonb) || jsonb_build_array(jsonb_build_object('type','office_edit','userId', auth.uid()::text, 'at', now())))
           else m end
    ), '[]'::jsonb)
    from jsonb_array_elements(coalesce(v_data->'manpower','[]'::jsonb)) m
  ));
  v_next := r.current_version + 1;
  insert into report_versions (report_id, version, data, summary, author, author_user_id, change_note)
  values (p_report_id, v_next, v_data, v_data->>'summary', 'office_user', auth.uid(),
          case p_action when 'add' then 'Added ' || v_company.name || ' as subcontractor' else '"' || p_name || '" mapped to ' || v_company.name end);
  perform denormalize_report_version(p_report_id, v_next);
  v_reasons := array_remove(r.review_reasons, 'unknown_company:' || p_name);
  update reports set current_version = v_next, review_reasons = v_reasons, needs_review = (cardinality(v_reasons) > 0),
    status = case when status = 'signed_off' then 'filed' else status end, signed_off_by = null, signed_off_at = null
  where id = p_report_id;
  perform log_audit(r.org_id, 'user', auth.uid(), 'report.unknown_company_resolved', 'report', p_report_id,
    jsonb_build_object('name', p_name, 'action', p_action, 'company_id', v_company.id, 'version', v_next));
  perform enqueue_job('render_pdf', jsonb_build_object('reportId', p_report_id, 'version', v_next, 'emailRecipients', false), null, 'render_pdf:' || p_report_id || ':' || v_next);
  return jsonb_build_object('version', v_next, 'company_id', v_company.id);
end $$;

-- 2. add_glossary_term: the panel's Add term, audited --------------------------------------------
create or replace function add_glossary_term(
  p_org_id uuid, p_heard text, p_official text, p_kind term_kind,
  p_language text default 'en', p_scope_site_id uuid default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_heard text := btrim(coalesce(p_heard, ''));
  v_official text := btrim(coalesce(p_official, ''));
  v_language text := lower(btrim(coalesce(p_language, 'en')));
  v_id uuid;
  v_existing boolean;
begin
  if not has_role(p_org_id, '{admin,pm,ops}') then raise exception 'not allowed' using errcode = '42501'; end if;
  if v_heard = '' or length(v_heard) > 200 then raise exception 'heard phrase required (at most 200 characters)'; end if;
  if v_official = '' or length(v_official) > 200 then raise exception 'official term required (at most 200 characters)'; end if;
  if v_language !~ '^[a-z]{2}$' then raise exception 'language must be a two-letter code'; end if;
  if p_scope_site_id is not null and not exists (select 1 from sites where id = p_scope_site_id and org_id = p_org_id) then
    raise exception 'site not found';
  end if;

  select id into v_id from glossary_terms
  where org_id = p_org_id and kind = p_kind and lower(heard) = lower(v_heard)
    and scope_site_id is not distinct from p_scope_site_id and scope_reporter_id is null
  order by first_seen_at, id limit 1
  for update;
  v_existing := v_id is not null;
  if v_existing then
    update glossary_terms set official = v_official, language = v_language, status = 'confirmed'
    where id = v_id;
  else
    insert into glossary_terms (org_id, scope_site_id, heard, official, language, kind, status, times_heard)
    values (p_org_id, p_scope_site_id, v_heard, v_official, v_language, p_kind, 'confirmed', 0)
    returning id into v_id;
  end if;
  perform log_audit(p_org_id, 'user', auth.uid(), 'glossary.added', 'glossary_term', v_id,
    jsonb_build_object('heard', v_heard, 'official', v_official, 'kind', p_kind, 'language', v_language,
                       'scope_site_id', p_scope_site_id, 'existing', v_existing));
  return jsonb_build_object('id', v_id);
end $$;

revoke execute on function add_glossary_term(uuid, text, text, term_kind, text, uuid) from public, anon;
grant execute on function add_glossary_term(uuid, text, text, term_kind, text, uuid) to authenticated, service_role;
