-- SiteLog · Appendix B RPCs, job queue functions, audit helper, denormalisation.
-- All office-facing RPCs are security definer and check roles themselves (§6.5).

-- Scheduler bookkeeping (previous tick time for weather slots, digest runs)
create table scheduler_state (
  key text primary key,
  value jsonb not null default '{}',
  updated_at timestamptz not null default now()
);
alter table scheduler_state enable row level security;

-- Audit ------------------------------------------------------------------------
create or replace function log_audit(
  p_org uuid, p_actor_type text, p_actor_id uuid, p_action text, p_entity text, p_entity_id uuid, p_diff jsonb default null
) returns void language sql security definer set search_path = public as $$
  insert into audit_log (org_id, actor_type, actor_id, action, entity, entity_id, diff)
  values (p_org, p_actor_type, p_actor_id, p_action, p_entity, p_entity_id, p_diff);
$$;

create or replace function notify_org(
  p_org uuid, p_kind text, p_title text, p_body text default null, p_target_path text default null, p_user_id uuid default null
) returns uuid language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  insert into notifications (org_id, user_id, kind, title, body, target_path)
  values (p_org, p_user_id, p_kind, p_title, p_body, p_target_path) returning id into v_id;
  return v_id;
end $$;

-- Jobs -------------------------------------------------------------------------
create or replace function enqueue_job(
  p_type text, p_payload jsonb, p_run_after timestamptz default null, p_dedupe_key text default null
) returns bigint language plpgsql security definer set search_path = public as $$
declare v_id bigint;
begin
  if p_dedupe_key is not null then
    select id into v_id from jobs where dedupe_key = p_dedupe_key and status in ('queued','running') limit 1;
    if v_id is not null then return v_id; end if;
  end if;
  insert into jobs (type, payload, run_after, dedupe_key)
  values (p_type, p_payload, coalesce(p_run_after, now()), p_dedupe_key)
  returning id into v_id;
  return v_id;
end $$;

-- FOR UPDATE SKIP LOCKED claim; stuck "running" jobs (> 15 min) are reclaimed.
create or replace function claim_jobs(p_worker text, p_limit int default 4)
returns setof jobs language sql security definer set search_path = public as $$
  with candidates as (
    select id from jobs
    where (status = 'queued' and run_after <= now())
       or (status = 'running' and locked_at < now() - interval '15 minutes')
    order by run_after, id
    limit p_limit
    for update skip locked
  )
  update jobs j
  set status = 'running', locked_at = now(), locked_by = p_worker, attempts = j.attempts + 1
  from candidates c
  where j.id = c.id
  returning j.*;
$$;

create or replace function complete_job(p_job_id bigint) returns void
language sql security definer set search_path = public as $$
  update jobs set status = 'done', finished_at = now(), locked_at = null, locked_by = null where id = p_job_id;
$$;

-- Backoff per §10.1: 30 s, 2 min, 10 min, 30 min, 2 h; after 5 attempts → dead.
create or replace function fail_job(p_job_id bigint, p_error text) returns void
language plpgsql security definer set search_path = public as $$
declare v_attempts int; v_delay interval;
begin
  select attempts into v_attempts from jobs where id = p_job_id;
  if v_attempts is null then return; end if;
  if v_attempts >= 5 then
    update jobs set status = 'dead', last_error = p_error, finished_at = now(), locked_at = null, locked_by = null where id = p_job_id;
    return;
  end if;
  v_delay := case v_attempts when 1 then interval '30 seconds' when 2 then interval '2 minutes'
                              when 3 then interval '10 minutes' when 4 then interval '30 minutes' else interval '2 hours' end;
  update jobs set status = 'queued', last_error = p_error, run_after = now() + v_delay, locked_at = null, locked_by = null
  where id = p_job_id;
end $$;

-- Reports ----------------------------------------------------------------------
create or replace function next_report_no(p_site_id uuid) returns text
language plpgsql security definer set search_path = public as $$
declare v_code text; v_seq int;
begin
  update sites set report_seq = report_seq + 1 where id = p_site_id returning project_code, report_seq into v_code, v_seq;
  if v_code is null then raise exception 'site not found'; end if;
  return v_code || '-' || lpad(v_seq::text, 4, '0');
end $$;

-- Rebuild the denormalised rows of one version from report_versions.data (§10.3). Idempotent.
create or replace function denormalize_report_version(p_report_id uuid, p_version int) returns void
language plpgsql security definer set search_path = public as $$
declare v_data jsonb; v_site uuid; v_date date; v_photo_count int;
begin
  select rv.data, r.site_id, (rv.data->>'reportDate')::date
    into v_data, v_site, v_date
  from report_versions rv join reports r on r.id = rv.report_id
  where rv.report_id = p_report_id and rv.version = p_version;
  if v_data is null then raise exception 'version not found'; end if;
  v_photo_count := coalesce(jsonb_array_length(v_data->'photos'), 0);

  delete from manpower_entries where report_id = p_report_id and version = p_version;
  delete from work_items where report_id = p_report_id and version = p_version;
  delete from weather_events where report_id = p_report_id and version = p_version;

  insert into manpower_entries (report_id, version, company_id, company_name_heard, company_name, trade, area, workers, hours, hours_basis, source, confidence)
  select p_report_id, p_version,
         case when (m->>'companyId') ~ '^[0-9a-f-]{36}$' then (m->>'companyId')::uuid else null end,
         m->>'companyNameHeard', m->>'companyName', m->>'trade', m->>'area',
         coalesce((m->>'workers')::int, 0), coalesce((m->>'totalHours')::numeric, 0),
         m->>'hoursBasis', m->'source'->0, (m->>'confidence')::numeric
  from jsonb_array_elements(coalesce(v_data->'manpower', '[]'::jsonb)) m;

  insert into work_items (report_id, version, area, activity, status, percent, quantity, source)
  select p_report_id, p_version, w->>'area', w->>'activity', w->>'status', (w->>'percentComplete')::int,
         case when w ? 'quantity' then (w->'quantity'->>'value') || ' ' || (w->'quantity'->>'unit') end,
         w->'source'->0
  from jsonb_array_elements(coalesce(v_data->'workPerformed', '[]'::jsonb)) w;

  insert into weather_events (report_id, version, site_id, date, start_local, end_local, condition, impact, lost_hours, full_day, audio_source, photo_count, observed)
  select p_report_id, p_version, v_site, v_date,
         nullif(p->>'start','')::time, nullif(p->>'end','')::time, p->>'condition', p->>'impact',
         coalesce((p->>'lostHours')::numeric, 0), coalesce((p->>'fullDay')::boolean, false),
         (select s from jsonb_array_elements(coalesce(p->'source','[]'::jsonb)) s where s->>'type' = 'audio' limit 1),
         v_photo_count, v_data->'weather'->'observed'
  from jsonb_array_elements(coalesce(v_data->'weather'->'periods', '[]'::jsonb)) p;
end $$;

-- Office edit → new version (§F14 step 3). Returns {version}.
create or replace function create_report_version(p_report_id uuid, p_data jsonb, p_change_note text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare r reports%rowtype; v_next int; v_signer uuid;
begin
  select * into r from reports where id = p_report_id for update;
  if r.id is null then raise exception 'report not found'; end if;
  if not has_role(r.org_id, '{admin,pm,ops}') then raise exception 'not allowed' using errcode = '42501'; end if;
  if r.status not in ('filed','signed_off') then raise exception 'only filed reports can be edited by the office'; end if;
  if coalesce(trim(p_change_note), '') = '' then raise exception 'change note required'; end if;
  v_next := r.current_version + 1;
  insert into report_versions (report_id, version, data, summary, author, author_user_id, change_note)
  values (p_report_id, v_next, p_data, p_data->>'summary', 'office_user', auth.uid(), p_change_note);
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

create or replace function sign_off_report(p_report_id uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare r reports%rowtype;
begin
  select * into r from reports where id = p_report_id for update;
  if r.id is null then raise exception 'report not found'; end if;
  if not has_role(r.org_id, '{admin,pm}') then raise exception 'not allowed' using errcode = '42501'; end if;
  if r.status <> 'filed' then raise exception 'only filed reports can be signed off (status %)', r.status; end if;
  update reports set status = 'signed_off', signed_off_by = auth.uid(), signed_off_at = now() where id = p_report_id;
  perform log_audit(r.org_id, 'user', auth.uid(), 'report.signed_off', 'report', p_report_id, jsonb_build_object('version', r.current_version));
  return jsonb_build_object('status', 'signed_off', 'signed_off_at', now(), 'version', r.current_version);
end $$;

-- "Signed off by … · Undo" within 10 minutes (§P7)
create or replace function undo_sign_off(p_report_id uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare r reports%rowtype;
begin
  select * into r from reports where id = p_report_id for update;
  if r.id is null then raise exception 'report not found'; end if;
  if r.status <> 'signed_off' then raise exception 'report is not signed off'; end if;
  if not (r.signed_off_by = auth.uid() or has_role(r.org_id, '{admin}')) then raise exception 'not allowed' using errcode = '42501'; end if;
  if r.signed_off_at < now() - interval '10 minutes' and not has_role(r.org_id, '{admin}') then raise exception 'undo window has passed'; end if;
  update reports set status = 'filed', signed_off_by = null, signed_off_at = null where id = p_report_id;
  perform log_audit(r.org_id, 'user', auth.uid(), 'report.signoff_undone', 'report', p_report_id, null);
  return jsonb_build_object('status', 'filed');
end $$;

create or replace function mark_no_work(p_site_day_id uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare sd site_days%rowtype; v_org uuid;
begin
  select * into sd from site_days where id = p_site_day_id for update;
  if sd.id is null then raise exception 'site day not found'; end if;
  v_org := site_org(sd.site_id);
  if not has_role(v_org, '{admin,pm,ops}') then raise exception 'not allowed' using errcode = '42501'; end if;
  if sd.status in ('filed') then raise exception 'a filed day cannot be marked no work'; end if;
  update site_days set status = 'no_work' where id = p_site_day_id;
  perform log_audit(v_org, 'user', auth.uid(), 'site_day.marked_no_work', 'site_day', p_site_day_id, jsonb_build_object('from', sd.status));
  return jsonb_build_object('status', 'no_work');
end $$;

-- §F14 step 6 — unknown company: add as subcontractor or map to existing. Creates a new version.
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

  -- glossary: remember the mapping
  insert into glossary_terms (org_id, heard, official, kind, company_id, status, times_heard, last_seen_at)
  values (r.org_id, p_name, v_company.name, 'company', v_company.id, 'confirmed', 1, now())
  on conflict do nothing;
  update glossary_terms set status = 'confirmed', official = v_company.name, company_id = v_company.id
  where org_id = r.org_id and kind = 'company' and lower(heard) = lower(p_name);

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

-- §F17 glossary review: approve | change | reject | add_company | map_company
create or replace function review_glossary_term(p_term_id uuid, p_action text, p_official text default null, p_company_id uuid default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare t glossary_terms%rowtype; v_company companies%rowtype;
begin
  select * into t from glossary_terms where id = p_term_id for update;
  if t.id is null or t.org_id is null then raise exception 'term not found'; end if;
  if not has_role(t.org_id, '{admin,pm,ops}') then raise exception 'not allowed' using errcode = '42501'; end if;
  case p_action
    when 'approve' then
      update glossary_terms set status = 'confirmed', official = coalesce(p_official, official) where id = p_term_id;
    when 'change' then
      if coalesce(trim(p_official),'') = '' then raise exception 'official term required'; end if;
      update glossary_terms set status = 'confirmed', official = p_official where id = p_term_id;
    when 'reject' then
      update glossary_terms set status = 'rejected' where id = p_term_id;
    when 'add_company' then
      insert into companies (org_id, name, status) values (t.org_id, coalesce(p_official, t.official, t.heard), 'confirmed')
      on conflict (org_id, name) do update set status = 'confirmed' returning * into v_company;
      update companies set aliases = array_append(aliases, t.heard) where id = v_company.id and not (t.heard = any(aliases));
      update glossary_terms set status = 'confirmed', kind = 'company', official = v_company.name, company_id = v_company.id where id = p_term_id;
    when 'map_company' then
      select * into v_company from companies where id = p_company_id and org_id = t.org_id;
      if v_company.id is null then raise exception 'company not found'; end if;
      update companies set aliases = array_append(aliases, t.heard) where id = v_company.id and not (t.heard = any(aliases));
      update glossary_terms set status = 'confirmed', kind = 'company', official = v_company.name, company_id = v_company.id where id = p_term_id;
    else
      raise exception 'unknown action %', p_action;
  end case;
  perform log_audit(t.org_id, 'user', auth.uid(), 'glossary.reviewed', 'glossary_term', p_term_id, jsonb_build_object('action', p_action, 'official', p_official, 'company_id', p_company_id));
  return jsonb_build_object('ok', true);
end $$;

create or replace function mark_notifications_read(p_ids uuid[]) returns void
language sql security definer set search_path = public as $$
  update notifications set read_at = now()
  where id = any(p_ids) and read_at is null and is_member(org_id) and (user_id is null or user_id = auth.uid());
$$;

-- Invoice gap helper for the Overview / Hours page: invoiced − reported per company for a period.
create or replace function invoice_gaps(p_org uuid, p_start date, p_end date)
returns table (company_id uuid, company_name text, invoiced numeric, reported numeric, gap numeric, invoice_id uuid, invoice_status text)
language sql stable security invoker set search_path = public as $$
  with reported as (
    select cm.company_id, sum(cm.hours) as hours
    from current_manpower cm
    where cm.org_id = p_org and cm.date between p_start and p_end and cm.company_id is not null
    group by cm.company_id
  )
  select c.id, c.name, coalesce(i.total_hours, 0), coalesce(r.hours, 0), coalesce(i.total_hours, 0) - coalesce(r.hours, 0), i.id, i.status
  from sub_invoices i
  join companies c on c.id = i.company_id
  left join reported r on r.company_id = i.company_id
  where i.org_id = p_org and i.period_start <= p_end and i.period_end >= p_start and is_member(p_org);
$$;

-- Grants: office RPCs callable by authenticated users; queue/internal ones by service role only.
grant execute on function sign_off_report(uuid), undo_sign_off(uuid), create_report_version(uuid, jsonb, text),
  mark_no_work(uuid), resolve_unknown_company(uuid, text, text, uuid), review_glossary_term(uuid, text, text, uuid),
  mark_notifications_read(uuid[]), invoice_gaps(uuid, date, date) to authenticated;
revoke execute on function enqueue_job(text, jsonb, timestamptz, text), claim_jobs(text, int), complete_job(bigint), fail_job(bigint, text),
  next_report_no(uuid), denormalize_report_version(uuid, int), log_audit(uuid, text, uuid, text, text, uuid, jsonb),
  notify_org(uuid, text, text, text, text, uuid) from public, anon, authenticated;
