-- SiteLog · companies typed in the panel (2026-10-13)
--   A crew row the office adds with "Add new…" (New report, or Edit on a report) reaches the RPCs
--   with companyId null and the typed name. Nothing created that company, so the report, the
--   Crew hours page and the client PDF showed the crew as UNCONFIRMED with no way to confirm it,
--   and it could not be invoiced. create_office_report() and create_report_version() now make
--   each typed name a confirmed company of the org, or link the company that already has that
--   name or alias (case-insensitive). They write its id into the row before the version is stored
--   and audit every company they create or confirm.
--   A name still pending review as `unknown_company:<name>` (heard on WhatsApp) is left alone: the
--   review banner adds it as a subcontractor or maps it to an existing company.

-- Internal: returns p_data with every typed company linked. Called by the two RPCs below only.
create or replace function link_typed_companies(p_org_id uuid, p_report_id uuid, p_data jsonb, p_skip text[] default '{}')
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_skip text[];
  v_row record;
  v_company companies%rowtype;
  v_links jsonb := '{}'::jsonb;  -- lower(typed name) -> {id, name}
begin
  -- Both callers check this already; it also guards a direct call should the revoke below lapse.
  if not has_role(p_org_id, '{admin,pm,ops}') then raise exception 'not allowed' using errcode = '42501'; end if;
  if jsonb_typeof(p_data->'manpower') is distinct from 'array' then return p_data; end if;
  select coalesce(array_agg(lower(btrim(x))), '{}') into v_skip from unnest(coalesce(p_skip, '{}')) x;

  for v_row in
    select distinct on (lower(btrim(m->>'companyName')))
           btrim(m->>'companyName') as name, nullif(btrim(m->>'trade'), '') as trade
    from jsonb_array_elements(p_data->'manpower') with ordinality e(m, i)
    where m->>'companyId' is null
      and coalesce(btrim(m->>'companyName'), '') <> ''
      and not (lower(btrim(m->>'companyName')) = any(v_skip))
    order by lower(btrim(m->>'companyName')), i
  loop
    select * into v_company from companies c
    where c.org_id = p_org_id
      and (lower(c.name) = lower(v_row.name)
           or exists (select 1 from unnest(c.aliases) a where lower(a) = lower(v_row.name)))
    order by (lower(c.name) = lower(v_row.name)) desc, c.created_at
    limit 1;
    if v_company.id is null then
      insert into companies (org_id, name, trade, status)
      values (p_org_id, v_row.name, v_row.trade, 'confirmed')
      on conflict (org_id, name) do update set status = 'confirmed'
      returning * into v_company;
      perform log_audit(p_org_id, 'user', auth.uid(), 'company.created', 'company', v_company.id,
        jsonb_build_object('name', v_company.name, 'trade', v_company.trade, 'status', 'confirmed',
                           'report_id', p_report_id, 'trigger', 'office_entry'));
    elsif v_company.status = 'unconfirmed' then
      update companies set status = 'confirmed' where id = v_company.id;
      perform log_audit(p_org_id, 'user', auth.uid(), 'company.confirmed', 'company', v_company.id,
        jsonb_build_object('name', v_company.name, 'from', 'unconfirmed',
                           'report_id', p_report_id, 'trigger', 'office_entry'));
    end if;
    v_links := v_links || jsonb_build_object(lower(v_row.name),
      jsonb_build_object('id', v_company.id, 'name', v_company.name));
  end loop;

  if v_links = '{}'::jsonb then return p_data; end if;
  return jsonb_set(p_data, '{manpower}', (
    select coalesce(jsonb_agg(
      case when m->>'companyId' is null and v_links ? lower(btrim(coalesce(m->>'companyName', '')))
           then m || jsonb_build_object(
                  'companyId', v_links->lower(btrim(m->>'companyName'))->>'id',
                  'companyName', v_links->lower(btrim(m->>'companyName'))->>'name')
           else m end
      order by i), '[]'::jsonb)
    from jsonb_array_elements(p_data->'manpower') with ordinality e(m, i)));
end $$;

-- create_office_report (20261013000001), now linking typed companies before version 1 is stored.
create or replace function create_office_report(p_site_id uuid, p_date date, p_data jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  s sites%rowtype;
  sd site_days%rowtype;
  v_existing reports%rowtype;
  v_deadline time;
  v_data jsonb;
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

  -- Every crew row here was typed by the office: each "Add new…" name becomes a company.
  v_data := link_typed_companies(s.org_id, v_report_id, v_data);
  insert into report_versions (report_id, version, data, summary, author, author_user_id)
  values (v_report_id, 1, v_data, nullif(v_data->>'summary', ''), 'office_user', auth.uid());
  perform denormalize_report_version(v_report_id, 1);

  update site_days set status = 'filed', report_id = v_report_id, is_late = v_late where id = sd.id;

  perform log_audit(s.org_id, 'user', auth.uid(), 'report.filed', 'report', v_report_id,
    jsonb_build_object('trigger', 'office_entry', 'version', 1, 'is_late', v_late, 'date', p_date));

  return jsonb_build_object('reportId', v_report_id, 'reportNo', v_report_no, 'created', true);
end $$;

-- create_report_version (20261011000005), now linking typed companies. Names the report still
-- has as `unknown_company:<name>` review reasons stay unlinked for the review banner.
create or replace function create_report_version(p_report_id uuid, p_data jsonb, p_change_note text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare r reports%rowtype; v_next int; v_signer uuid; v_data jsonb;
begin
  select * into r from reports where id = p_report_id for update;
  if r.id is null then raise exception 'report not found'; end if;
  if not has_role(r.org_id, '{admin,pm,ops}') then raise exception 'not allowed' using errcode = '42501'; end if;
  if r.status not in ('filed','signed_off') then raise exception 'only filed reports can be edited by the office'; end if;
  if coalesce(trim(p_change_note), '') = '' then raise exception 'change note required'; end if;
  v_next := r.current_version + 1;
  v_data := link_typed_companies(r.org_id, p_report_id, p_data,
    array(select substr(x, length('unknown_company:') + 1)
          from unnest(r.review_reasons) x where x like 'unknown_company:%'));
  insert into report_versions (report_id, version, data, summary, author, author_user_id, change_note)
  values (p_report_id, v_next, v_data, v_data->>'summary', 'office_user', auth.uid(), p_change_note);
  perform denormalize_report_version(p_report_id, v_next);
  v_signer := r.signed_off_by;
  update reports set current_version = v_next,
    status = 'filed', signed_off_by = null, signed_off_at = null
  where id = p_report_id;
  perform log_audit(r.org_id, 'user', auth.uid(), 'report.version_created', 'report', p_report_id,
    jsonb_build_object('version', v_next, 'change_note', p_change_note));
  if r.status = 'signed_off' then
    perform log_audit(r.org_id, 'user', auth.uid(), 'report.signoff_reverted', 'report', p_report_id, jsonb_build_object('version', v_next));
    perform notify_org(r.org_id, 'report_edited', r.report_no || ' was edited after sign-off', p_change_note, '/reports/' || p_report_id, v_signer);
  end if;
  perform enqueue_job('render_pdf', jsonb_build_object('reportId', p_report_id, 'version', v_next, 'emailRecipients', true, 'changeNote', p_change_note, 'notifyReporter', true),
                      null, 'render_pdf:' || p_report_id || ':' || v_next);
  return jsonb_build_object('version', v_next);
end $$;

revoke execute on function link_typed_companies(uuid, uuid, jsonb, text[]) from public, anon, authenticated;
