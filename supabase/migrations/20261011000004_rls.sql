-- SiteLog · §6.5 Row Level Security
-- Office users read/write through PostgREST with their JWT; the worker and Edge Functions use the
-- service role (bypasses RLS). Reporters never touch the database.

-- Helpers ---------------------------------------------------------------------
create or replace function is_member(org uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from org_members where org_id = org and user_id = auth.uid());
$$;

create or replace function has_role(org uuid, roles member_role[]) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from org_members where org_id = org and user_id = auth.uid() and role = any(roles)
  );
$$;

create or replace function my_org_ids() returns setof uuid
language sql stable security definer set search_path = public as $$
  select org_id from org_members where user_id = auth.uid();
$$;

-- org_id lookups for child tables (stable, used inside policies)
create or replace function site_org(p_site_id uuid) returns uuid
language sql stable security definer set search_path = public as $$
  select org_id from sites where id = p_site_id;
$$;

create or replace function report_org(p_report_id uuid) returns uuid
language sql stable security definer set search_path = public as $$
  select org_id from reports where id = p_report_id;
$$;

create or replace function conversation_org(p_conversation_id uuid) returns uuid
language sql stable security definer set search_path = public as $$
  select org_id from conversations where id = p_conversation_id;
$$;

create or replace function message_org(p_message_id uuid) returns uuid
language sql stable security definer set search_path = public as $$
  select c.org_id from messages m join conversations c on c.id = m.conversation_id where m.id = p_message_id;
$$;

create or replace function reporter_org(p_reporter_id uuid) returns uuid
language sql stable security definer set search_path = public as $$
  select org_id from reporters where id = p_reporter_id;
$$;

grant execute on function is_member(uuid), has_role(uuid, member_role[]), my_org_ids(),
  site_org(uuid), report_org(uuid), conversation_org(uuid), message_org(uuid), reporter_org(uuid)
  to authenticated, anon;

-- Enable RLS everywhere ---------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array[
    'orgs','org_members','org_settings','sites','reporters','site_reporters','site_recipients','companies',
    'conversations','messages','transcripts','unknown_senders','site_days','reports','report_versions',
    'report_sources','manpower_entries','work_items','weather_events','questions','glossary_terms',
    'sub_invoices','evidence_packs','jobs','audit_log','notifications'
  ] loop
    execute format('alter table %I enable row level security', t);
  end loop;
end $$;

-- Roles with full panel access (everything except billing/settings writes)
-- admin, pm, ops: read org data. accounts: companies, current_manpower (via manpower_entries), sub_invoices, sites (names).

-- orgs
create policy orgs_select on orgs for select to authenticated using (is_member(id));
create policy orgs_update on orgs for update to authenticated using (has_role(id, '{admin}')) with check (has_role(id, '{admin}'));
-- Orgs are created through create_org() (setup wizard, §F2): the caller becomes the first admin.
-- Every new org gets default settings and a self-perform company.
create or replace function on_org_created() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into org_settings (org_id) values (new.id) on conflict do nothing;
  insert into companies (org_id, name, trade, is_self_perform)
  values (new.id, new.name || ' self-perform', 'General labor', true)
  on conflict do nothing;
  return new;
end $$;
create trigger orgs_after_insert after insert on orgs for each row execute function on_org_created();

create or replace function create_org(p_name text, p_timezone text default 'America/Chicago', p_address text default null, p_license_no text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_org orgs%rowtype;
begin
  if auth.uid() is null then raise exception 'not signed in' using errcode = '42501'; end if;
  if coalesce(trim(p_name), '') = '' then raise exception 'company name required'; end if;
  insert into orgs (name, timezone, address, license_no, trial_ends_at)
  values (trim(p_name), coalesce(p_timezone, 'America/Chicago'), p_address, p_license_no, now() + interval '14 days')
  returning * into v_org;
  insert into org_members (org_id, user_id, role, display_name)
  values (v_org.id, auth.uid(), 'admin', coalesce(auth.jwt() ->> 'email', 'Admin'));
  insert into audit_log (org_id, actor_type, actor_id, action, entity, entity_id)
  values (v_org.id, 'user', auth.uid(), 'org.created', 'org', v_org.id);
  return to_jsonb(v_org);
end $$;
grant execute on function create_org(text, text, text, text) to authenticated;

-- org_members
create policy org_members_select on org_members for select to authenticated using (is_member(org_id));
create policy org_members_admin_insert on org_members for insert to authenticated with check (has_role(org_id, '{admin}'));
create policy org_members_admin_update on org_members for update to authenticated using (has_role(org_id, '{admin}')) with check (has_role(org_id, '{admin}'));
create policy org_members_admin_delete on org_members for delete to authenticated using (has_role(org_id, '{admin}') and user_id <> auth.uid());

-- org_settings
create policy org_settings_select on org_settings for select to authenticated using (is_member(org_id));
create policy org_settings_admin_write on org_settings for update to authenticated using (has_role(org_id, '{admin}')) with check (has_role(org_id, '{admin}'));
create policy org_settings_admin_insert on org_settings for insert to authenticated with check (has_role(org_id, '{admin}'));

-- sites (accounts may read names for the hours matrix)
create policy sites_select on sites for select to authenticated using (is_member(org_id));
create policy sites_admin_insert on sites for insert to authenticated with check (has_role(org_id, '{admin}'));
create policy sites_admin_update on sites for update to authenticated using (has_role(org_id, '{admin}')) with check (has_role(org_id, '{admin}'));

-- reporters & links: admin + ops manage (§2.2)
create policy reporters_select on reporters for select to authenticated using (has_role(org_id, '{admin,pm,ops}'));
create policy reporters_write on reporters for all to authenticated using (has_role(org_id, '{admin,ops}')) with check (has_role(org_id, '{admin,ops}'));
create policy site_reporters_select on site_reporters for select to authenticated using (has_role(site_org(site_id), '{admin,pm,ops}'));
create policy site_reporters_write on site_reporters for all to authenticated using (has_role(site_org(site_id), '{admin,ops}')) with check (has_role(site_org(site_id), '{admin,ops}'));
create policy site_recipients_select on site_recipients for select to authenticated using (has_role(site_org(site_id), '{admin,pm,ops}'));
create policy site_recipients_write on site_recipients for all to authenticated using (has_role(site_org(site_id), '{admin}')) with check (has_role(site_org(site_id), '{admin}'));

-- companies: all roles read; admin/pm/ops write
create policy companies_select on companies for select to authenticated using (is_member(org_id));
create policy companies_write on companies for all to authenticated using (has_role(org_id, '{admin,pm,ops}')) with check (has_role(org_id, '{admin,pm,ops}'));

-- conversations / messages / transcripts: read-only for office roles (source panel, activity)
create policy conversations_select on conversations for select to authenticated using (org_id is not null and has_role(org_id, '{admin,pm,ops}'));
create policy messages_select on messages for select to authenticated using (has_role(conversation_org(conversation_id), '{admin,pm,ops}'));
create policy transcripts_select on transcripts for select to authenticated using (has_role(message_org(message_id), '{admin,pm,ops}'));

-- unknown senders: admin/ops (Team page)
create policy unknown_senders_select on unknown_senders for select to authenticated using (org_id is not null and has_role(org_id, '{admin,ops}'));
create policy unknown_senders_update on unknown_senders for update to authenticated using (org_id is not null and has_role(org_id, '{admin,ops}')) with check (has_role(org_id, '{admin,ops}'));

-- site days / reports / versions / sources / denormalised rows
create policy site_days_select on site_days for select to authenticated using (has_role(site_org(site_id), '{admin,pm,ops}'));
create policy reports_select on reports for select to authenticated using (has_role(org_id, '{admin,pm,ops}'));
create policy report_versions_select on report_versions for select to authenticated using (has_role(report_org(report_id), '{admin,pm,ops}'));
create policy report_sources_select on report_sources for select to authenticated using (has_role(report_org(report_id), '{admin,pm,ops}'));
create policy manpower_entries_select on manpower_entries for select to authenticated using (is_member(report_org(report_id)));  -- accounts included
create policy work_items_select on work_items for select to authenticated using (has_role(report_org(report_id), '{admin,pm,ops}'));
create policy weather_events_select on weather_events for select to authenticated using (has_role(site_org(site_id), '{admin,pm,ops}'));
create policy questions_select on questions for select to authenticated using (has_role(report_org(report_id), '{admin,pm,ops}'));
-- Report edits, sign-off and no-work marking go through RPCs (security definer) — no direct update policies.

-- glossary: admin/pm/ops read + write; built-in (org_id null) readable by all authenticated
create policy glossary_select on glossary_terms for select to authenticated using (org_id is null or has_role(org_id, '{admin,pm,ops}'));
create policy glossary_write on glossary_terms for all to authenticated using (org_id is not null and has_role(org_id, '{admin,pm,ops}')) with check (org_id is not null and has_role(org_id, '{admin,pm,ops}'));

-- sub invoices: every role
create policy sub_invoices_select on sub_invoices for select to authenticated using (is_member(org_id));
create policy sub_invoices_write on sub_invoices for all to authenticated using (is_member(org_id)) with check (is_member(org_id));

-- evidence packs: admin/pm/ops
create policy evidence_packs_select on evidence_packs for select to authenticated using (has_role(org_id, '{admin,pm,ops}'));
create policy evidence_packs_insert on evidence_packs for insert to authenticated with check (has_role(org_id, '{admin,pm,ops}') and created_by = auth.uid());

-- jobs: service role only (no policies → denied for authenticated)

-- audit log: members read their org's log
create policy audit_log_select on audit_log for select to authenticated using (org_id is not null and is_member(org_id));

-- notifications: member reads org-wide + own; marks read via RPC
create policy notifications_select on notifications for select to authenticated using (is_member(org_id) and (user_id is null or user_id = auth.uid()));
