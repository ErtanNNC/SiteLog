-- SiteLog · spec v1.2 schema, expand phase A2 (W1-05 step 9, second half; docs/GAP_ANALYSIS.md §7)
--
-- Queue (moved in from W1-10; spec §10.1):
--   1. enqueue_job() wakes a LISTENing worker: pg_notify('jobs', <job id>) for a new job that is
--      due now. Same 4-argument signature, defaults and dedupe behaviour (no overload: a
--      3-argument one would make PostgREST's named-argument calls ambiguous). NOTIFY is delivered
--      on commit, so a rolled-back enqueue wakes no one; a dedupe hit or a job for later sends
--      nothing (W1-10's 5 s poll fallback finds it when it is due).
--   2. job_lock_key(): a 'report:<id>' branch, so the v1.2 report jobs (transcribe_upload by its
--      upload's report, extract_report, decide_next, file_report, post_call_reconcile by its
--      call's report) run one at a time per report. A report whose reporter has a WhatsApp
--      conversation keeps that conversation's key, so the WhatsApp jobs of that phone still
--      serialise with it until step 22.
--   3. job_priority(): the §10.1 job names, without moving any existing one: send_sms and
--      place_call with the messages (0), transcribe_upload and post_call_reconcile with the
--      transcription (2), fetch_weather and build_evidence_pack in the background (3).
--   4. claim_jobs(): a running job is stale after 10 minutes, not 15 (GAP D18; twice the
--      worker's 5-minute job timeout, JOB_TIMEOUT_MS). A reclaim keeps the key serialised: a
--      stale job is handed out alone, and the next job of its lock key waits until it finishes
--      (before, one claim returned both).
--
-- Row-level security and grants (GAP D21, D22; docs/AUDIT_BACKLOG.md):
--   5. site_reporters: a link needs a reporter and a site of the same org ("site_reporters write
--      policy does not check the reporter's org"): in the policy for the panel, and in a trigger
--      for the service-role writers (edge functions, worker, RPCs), which bypass RLS. Neither end
--      of a link changes org afterwards: API roles update only the site columns the panel saves
--      (not org_id, report_seq, active_since), and a trigger refuses moving a site or a reporter
--      to another org from every writer. A cross-org link written before this migration is
--      removed first, with an audit row.
--   6. evidence_packs: no client insert ("evidence_packs insert policy lets a user forge a 'ready'
--      pack"). Packs are requested through api-evidence-pack (service role: it checks the site,
--      audits and enqueues build_evidence_pack); the worker fills them. A pack written before
--      this migration for another org's site, or whose pdf_path lies outside its org and site,
--      is marked failed with the path cleared (audited); readers sign only a path under the
--      pack's org and site.
--   7. org_members: an org keeps at least one admin ("org_members update and delete policies
--      allow an org with zero admins"): a guard refuses demoting or removing the last admin, for
--      every writer, but lets a cascade through (the org or the user is being deleted). API roles
--      update only role, display_name, title and ui_locale, never the key (org_id, user_id: a
--      rewrite would hand a seat to another account or move a member between orgs unaudited).
--      Changes made from the panel (role, removal, addition) are audited, and a key change by a
--      writer that keeps the privilege is logged as a removal plus an addition; the RPCs and the
--      service log their own.
--   8. Shared phone ("Messages, transcripts and conversation context of a phone shared by two
--      orgs leak"): a message tagged with an org (messages.org_id: SMS rows, office uploads, and
--      a WhatsApp message the worker tags) belongs to that org, not to the org that attached the
--      conversation first: messages_select and message_org() (so transcripts_select) read org_id
--      before the conversation's org. Realtime applies messages_select to every subscriber, so
--      the fix covers the realtime publication too. conversations.context (active report and
--      candidate sites, possibly another org's) is no longer readable by API roles; the panel
--      never reads it.
--   9. org_settings: the half of "Org admins can overwrite the Stripe-mirrored billing columns
--      and the grace period" that 20261013000007 left: INSERT and UPDATE revoked, UPDATE
--      re-granted on the columns the panel saves (updated_at included), never org_id or
--      past_due_grace_days (scheduler-tick's billing block). Rows come from the orgs trigger.
--  10. accounts (§2.2 "hours and invoices"; GAP D22): no sites table (Crew hours reads the new
--      site_options view: id, org, name, project code, time zone and status of the org's sites,
--      which also feeds the org switcher's site count), no audit_log, and of the org-wide
--      notifications only those §13 addresses to accounts (invoice gaps). Storage: every member
--      reads `invoices`; audio, photos, pdfs, exports (EOT packs) and logos are admin, pm, ops
--      only. Payroll exports are not stored: api-export-payroll streams the CSV to any member.
--  11. notifications: an org-wide row (user_id null) is seen by the roles of its kind
--      (notification_audience(), from §13; admin, who holds every §2.2 capability, sees every
--      kind; an unknown kind goes to admin, pm, ops, never accounts), and mark_notifications_read
--      marks only rows the caller can see ("notifications and audit_log ignore the spec's role
--      restrictions"; "mark_notifications_read sets one shared read_at": an accounts user can no
--      longer hide a missing-report alert; the read state stays one per row).
--  12. anon: execute on every function in public revoked from PUBLIC and anon: the org lookup
--      helpers, is_service(), job_priority() and the office RPCs (src/anon.test.ts). Nothing the
--      panel runs before sign-in calls one (login, the magic-link callback and sign-up use Auth
--      only; create_org runs signed in); the field app reaches only field-api.
--
-- Live database: policy swaps and function replacements (same signatures), new grants, triggers
-- and one view; no table is rewritten. Rows change only where a hole was used: a cross-org
-- site_reporters link is removed and a pack with a foreign pdf_path is marked failed, each with
-- an audit row (none is expected). The WhatsApp worker and webhook keep working: they enqueue
-- through enqueue_job and write with the service role. The panel's role, settings, site and link
-- writes pass the new checks; it never inserts evidence packs or org_settings rows, and never
-- writes a member's key or a site's org_id or report_seq. Only the panel of this commit reads
-- site_options: an older one would show an accounts user Crew hours without site names (staging
-- gets both together at the cut-over).

set local lock_timeout = '5s';

-- 1. enqueue_job: wake the worker -----------------------------------------------------------------
create or replace function enqueue_job(
  p_type text, p_payload jsonb, p_run_after timestamptz default null, p_dedupe_key text default null
) returns bigint language plpgsql security definer set search_path = public as $$
declare
  v_id bigint;
  v_run_after timestamptz := coalesce(p_run_after, now());
begin
  if p_dedupe_key is not null then
    select id into v_id from jobs where dedupe_key = p_dedupe_key and status in ('queued','running') limit 1;
    if v_id is not null then return v_id; end if;
  end if;
  insert into jobs (type, payload, run_after, dedupe_key)
  values (p_type, p_payload, v_run_after, p_dedupe_key)
  returning id into v_id;
  if v_run_after <= now() then
    perform pg_notify('jobs', v_id::text);
  end if;
  return v_id;
end $$;

-- 2. Lock key: one job at a time per report -----------------------------------------------------------
create or replace function job_lock_key(p_type text, p_payload jsonb) returns text
language sql stable security definer set search_path = public as $$
  with report as (
    select case
      when p_type in ('extract_report', 'decide_next', 'file_report')
           and p_payload ->> 'reportId' ~ '^[0-9a-f-]{36}$'
        then (p_payload ->> 'reportId')::uuid
      when p_type = 'transcribe_upload' and p_payload ->> 'uploadId' ~ '^[0-9a-f-]{36}$'
        then (select u.report_id from uploads u where u.id = (p_payload ->> 'uploadId')::uuid)
      when p_type = 'post_call_reconcile' and p_payload ->> 'callId' ~ '^[0-9a-f-]{36}$'
        then (select c.report_id from calls c where c.id = (p_payload ->> 'callId')::uuid)
    end as id
  )
  select case
    when p_type in ('inbound_message', 'transcribe_audio', 'parse_reply')
         and p_payload ->> 'messageId' ~ '^[0-9a-f-]{36}$'
      then (select 'convo:' || m.conversation_id from messages m
             where m.id = (p_payload ->> 'messageId')::uuid and m.conversation_id is not null)
    when (select id from report) is not null
      -- WhatsApp (until step 22): the reporter's conversation, so a photo sent meanwhile waits.
      then coalesce(
        (select 'convo:' || c.id from reports r
           join reporters rp on rp.id = r.reporter_id
           join conversations c on c.phone_e164 = rp.phone_e164
          where r.id = (select id from report)
          limit 1),
        'report:' || (select id from report))
  end;
$$;

-- 3. Priorities (lower first) ---------------------------------------------------------------------
create or replace function job_priority(p_type text) returns int
language sql immutable set search_path = public as $$
  select case
    -- Messages and calls to and from the reporter.
    when p_type in ('inbound_message', 'send_message', 'send_template', 'send_welcome',
                    'send_sms', 'place_call') then 0
    -- The next step of a report someone is waiting for, its PDF and its email.
    when p_type in ('parse_reply', 'decide_next', 'file_report', 'render_pdf', 'send_email') then 1
    -- Transcription and extraction.
    when p_type in ('transcribe_audio', 'extract_report', 'transcribe_upload',
                    'post_call_reconcile') then 2
    -- Background: weather, evidence packs, digests, retention and anything else.
    when p_type in ('fetch_weather', 'build_evidence_pack') then 3
    else 3
  end;
$$;

-- 4. Claim: stale after 10 minutes ------------------------------------------------------------------
create or replace function claim_jobs(p_worker text, p_limit int default 4)
returns setof jobs language sql security definer set search_path = public as $$
  with candidates as (
    select j.id from jobs j
    where ((j.status = 'queued' and j.run_after <= now())
        or (j.status = 'running' and j.locked_at < now() - interval '10 minutes'))
      and (j.lock_key is null or not exists (
        select 1 from jobs o
        where o.lock_key = j.lock_key and o.id <> j.id
          and ((o.status = 'running' and o.locked_at >= now() - interval '10 minutes')
            -- A stale one is reclaimed first, never together with the next job of its key.
            or (o.status = 'running' and o.locked_at < now() - interval '10 minutes' and o.id < j.id)
            or (o.status = 'queued' and o.run_after <= now() and o.id < j.id))
      ))
    order by job_priority(j.type), j.run_after, j.id
    limit p_limit
    for update skip locked
  )
  update jobs j
  set status = 'running', locked_at = now(), locked_by = p_worker, attempts = j.attempts + 1
  from candidates c
  where j.id = c.id
  returning j.*;
$$;

-- 5. site_reporters: reporter and site of one org --------------------------------------------------
drop policy site_reporters_write on site_reporters;
create policy site_reporters_write on site_reporters for all to authenticated
  using (has_role(site_org(site_id), '{admin,ops}'))
  with check (has_role(site_org(site_id), '{admin,ops}')
              and reporter_org(reporter_id) = site_org(site_id));

-- Links written while the policy had the hole: no flow creates one, so one that exists was
-- forged, and scheduler-tick would keep choosing that reporter. Removed with an audit row in the
-- site's org that names both ends (the trigger below only checks new writes).
with removed as (
  delete from site_reporters sr
  using reporters r, sites s
  where r.id = sr.reporter_id and s.id = sr.site_id and r.org_id <> s.org_id
  returning sr.site_id, sr.reporter_id, sr.is_primary, s.org_id as site_org, r.org_id as reporter_org
)
insert into audit_log (org_id, actor_type, action, entity, entity_id, diff)
select site_org, 'system', 'site_reporter.removed_cross_org', 'site_reporter', reporter_id,
       jsonb_build_object('siteId', site_id, 'reporterOrgId', reporter_org, 'isPrimary', is_primary,
                          'migration', '20261014000001')
from removed;

-- After the row's policies (a panel write is refused with 42501 first); also for the service.
create or replace function guard_site_reporter_org() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if reporter_org(new.reporter_id) is distinct from site_org(new.site_id) then
    raise exception 'reporter % and site % belong to different organisations', new.reporter_id, new.site_id
      using errcode = '23514';
  end if;
  return null;
end $$;

create trigger site_reporters_same_org after insert or update on site_reporters
  for each row execute function guard_site_reporter_org();

-- The link's two ends keep their org: moving a site (an admin of both orgs could) would carry its
-- links, site days, weather, uploads and recipients into the other org without a write to any of
-- them. API roles update only the columns the panel saves (updateSite, pauseSite, resumeSite);
-- org_id, report_seq (next_report_no()), active_since and created_at are service and RPC only.
-- Reporters already update only status and invited_at (20261013000007).
revoke update on sites from anon, authenticated;
grant update (name, project_code, address, lat, lng, timezone, deadline, working_hours, status,
              paused_at)
  on sites to authenticated;

-- And for every writer: no flow moves a site or a reporter to another org.
create or replace function guard_org_fixed() returns trigger
language plpgsql set search_path = public as $$
begin
  raise exception '% % cannot move to another organisation', tg_table_name, old.id
    using errcode = '23514';
end $$;

create trigger sites_org_fixed before update of org_id on sites
  for each row when (new.org_id is distinct from old.org_id) execute function guard_org_fixed();
create trigger reporters_org_fixed before update of org_id on reporters
  for each row when (new.org_id is distinct from old.org_id) execute function guard_org_fixed();

-- 6. evidence_packs: requested through api-evidence-pack only ---------------------------------------
drop policy evidence_packs_insert on evidence_packs;
revoke all on evidence_packs from anon, authenticated;
grant select on evidence_packs to authenticated;  -- the Weather page and its realtime pack status

-- Packs inserted while the policy let a client choose the site, status and pdf_path: the worker
-- stores a pack at <org>/<site>/… (evidencePackStoragePath), so any other path was forged and
-- would be signed for download (api-evidence-pack, the worker's send_email), and a pack for
-- another org's site was never requested through api-evidence-pack. Marked failed, the path
-- cleared, with an audit row; api-evidence-pack and send_email also sign only a path under the
-- pack's org and site from now on.
with forged as (
  select p.id, p.org_id, p.site_id, p.status, p.pdf_path from evidence_packs p
  where (p.pdf_path is not null
         and (p.site_id is null
              or not starts_with(p.pdf_path, p.org_id::text || '/' || p.site_id::text || '/')))
     or exists (select 1 from sites s where s.id = p.site_id and s.org_id <> p.org_id)
), cleared as (
  update evidence_packs p
  set status = 'failed', pdf_path = null, ready_at = null,
      error = 'site or pdf_path outside the pack''s org (cleared by migration 20261014000001)'
  from forged f
  where p.id = f.id
  returning p.id
)
insert into audit_log (org_id, actor_type, action, entity, entity_id, diff)
select f.org_id, 'system', 'evidence_pack.forged_cleared', 'evidence_pack', f.id,
       jsonb_build_object('siteId', f.site_id, 'status', f.status, 'pdfPath', f.pdf_path,
                          'migration', '20261014000001')
from forged f join cleared c on c.id = f.id;

-- 7. org_members: at least one admin; panel changes audited -------------------------------------------
-- After the statement's row changes, so a statement that demotes several admins at once is
-- checked against its result.
create or replace function guard_last_admin() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  -- A role change that keeps the admin in its org takes nothing away.
  if tg_op = 'UPDATE' and new.role = 'admin' and new.org_id = old.org_id then return null; end if;
  -- A cascade from deleting the org or the user (their foreign-key trigger runs this delete).
  if pg_trigger_depth() > 1
     or not exists (select 1 from orgs where id = old.org_id)
     or not exists (select 1 from auth.users where id = old.user_id) then
    return null;
  end if;
  -- One check at a time per org: two admins demoting each other at once cannot both pass.
  perform 1 from orgs where id = old.org_id for no key update;
  if not exists (select 1 from org_members where org_id = old.org_id and role = 'admin') then
    raise exception 'an organisation needs at least one admin'
      using errcode = 'P0001', hint = 'Make another member an admin first.';
  end if;
  return null;
end $$;

create trigger org_members_keep_admin after update or delete on org_members
  for each row when (old.role = 'admin') execute function guard_last_admin();

-- A member row's key is not the panel's to change: rewriting user_id would hand a seat to
-- another account, and moving org_id (an admin of both orgs) would move a member between orgs,
-- both without a removal or an addition. The panel changes `role` only (changeMemberRole);
-- display_name, title and ui_locale (§6.3) stay with it. The key is service and RPC only.
revoke update on org_members from anon, authenticated;
grant update (role, display_name, title, ui_locale) on org_members to authenticated;

-- Direct writes from the panel (Team: change role, remove; an admin adding a member). The WHEN
-- clause runs as the caller, so the service (api-invite-office-user) and the security definer
-- RPCs (create_org) are not logged twice.
create or replace function audit_org_member_change() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    perform log_audit(new.org_id, 'user', auth.uid(), 'member.added', 'org_member', new.user_id,
      jsonb_build_object('role', new.role));
  elsif tg_op = 'DELETE' then
    perform log_audit(old.org_id, 'user', auth.uid(), 'member.removed', 'org_member', old.user_id,
      jsonb_build_object('role', old.role));
  elsif new.org_id is distinct from old.org_id or new.user_id is distinct from old.user_id then
    -- A writer that keeps the privilege on the key: the row now names another seat, so the old
    -- member left and a new one joined.
    perform log_audit(old.org_id, 'user', auth.uid(), 'member.removed', 'org_member', old.user_id,
      jsonb_build_object('role', old.role));
    perform log_audit(new.org_id, 'user', auth.uid(), 'member.added', 'org_member', new.user_id,
      jsonb_build_object('role', new.role));
  elsif new.role is distinct from old.role then
    perform log_audit(new.org_id, 'user', auth.uid(), 'member.role_changed', 'org_member', new.user_id,
      jsonb_build_object('role', jsonb_build_object('from', old.role, 'to', new.role)));
  end if;
  return null;
end $$;

create trigger org_members_audit after insert or update or delete on org_members
  for each row when (not is_service()) execute function audit_org_member_change();

-- 8. Shared phone: a tagged message is its org's ------------------------------------------------------
create or replace function message_org(p_message_id uuid) returns uuid
language sql stable security definer set search_path = public as $$
  select coalesce(m.org_id, c.org_id)
  from messages m left join conversations c on c.id = m.conversation_id
  where m.id = p_message_id;
$$;

drop policy messages_select on messages;
create policy messages_select on messages for select to authenticated
  using (has_role(coalesce(org_id, conversation_org(conversation_id)), '{admin,pm,ops}'));

revoke select on conversations from anon, authenticated;
grant select (id, org_id, reporter_id, phone_e164, state, last_inbound_at, last_outbound_at,
              state_changed_at, updated_at) on conversations to authenticated;

-- 9. org_settings column lockdown ------------------------------------------------------------------
drop policy org_settings_admin_insert on org_settings;
revoke insert, update on org_settings from anon, authenticated;
grant update (default_deadline, working_days, default_shift_hours,
              heads_up_enabled, heads_up_offset_min, reminder1_enabled, reminder1_offset_min,
              reminder2_enabled, reminder2_offset_min, missing_enabled, missing_offset_min,
              required_fields, filing_mode, signoff_required, email_pdf_on_file,
              max_questions_per_report, payroll_csv_format, payroll_columns,
              pdf_paper, pdf_footer_enabled, pdf_max_photos, letterhead_lines, no_work_pdf,
              include_unconfirmed_in_payroll,
              daily_link_time, auto_call_enabled, second_call_enabled, call_window_start, call_window_end,
              updated_at)
  on org_settings to authenticated;

-- 10. accounts: sites through site_options; no audit_log ----------------------------------------------
drop policy sites_select on sites;
create policy sites_select on sites for select to authenticated
  using (has_role(org_id, '{admin,pm,ops}'));

-- Owner-privileged like current_manpower: the columns Crew hours shows (site names, the site
-- filter) and the org switcher counts (active sites), for every member of the org.
-- security_barrier: a caller's own conditions run after the membership filter, never before it.
create view site_options with (security_barrier) as
  select s.id, s.org_id, s.name, s.project_code, s.timezone, s.status
  from sites s
  where is_service() or exists (select 1 from org_members om where om.org_id = s.org_id and om.user_id = auth.uid());

revoke all on site_options from anon, authenticated;
grant select on site_options to authenticated, service_role;

drop policy audit_log_select on audit_log;
create policy audit_log_select on audit_log for select to authenticated
  using (org_id is not null and has_role(org_id, '{admin,pm,ops}'));

-- 11. Notifications by audience -------------------------------------------------------------------------
-- Kinds the repo writes (notify_org callers) with their §13 recipients, plus admin.
create or replace function notification_audience(p_kind text) returns member_role[]
language sql stable set search_path = public as $$
  select (case p_kind
    when 'invoice_gap' then '{admin,ops,accounts}'        -- §13 "Invoice gap: ops, accounts"
    when 'billing' then '{admin}'                         -- §13 "Billing: admin"
    when 'missing_report' then '{admin,ops}'              -- §13 "Report missing: ops + admin"
    when 'unknown_sender' then '{admin,ops}'              -- §13 "Unknown contact: ops, admin"
    when 'unknown_contact' then '{admin,ops}'
    when 'reporter_invite_failed' then '{admin,ops}'      -- §13 "Text undeliverable / opted out"
    when 'reporter_wrong_site' then '{admin,ops}'         -- §2.2 "Manage reporters": admin, ops
    else '{admin,pm,ops}'  -- needs_review (§13: ops, pm), glossary_review, processing_delayed, …
  end)::member_role[];
$$;

drop policy notifications_select on notifications;
create policy notifications_select on notifications for select to authenticated
  using (is_member(org_id)
         and (user_id = auth.uid()
              or (user_id is null and has_role(org_id, notification_audience(kind)))));

create or replace function mark_notifications_read(p_ids uuid[]) returns void
language sql security definer set search_path = public as $$
  update notifications set read_at = now()
  where id = any(p_ids) and read_at is null and is_member(org_id)
    and (user_id = auth.uid()
         or (user_id is null and has_role(org_id, notification_audience(kind))));
$$;

-- 12. anon executes nothing in public ---------------------------------------------------------------------
-- Policies run the lookup helpers as the querying user: authenticated keeps execute.
revoke execute on function is_member(uuid), has_role(uuid, member_role[]), my_org_ids(),
  site_org(uuid), report_org(uuid), conversation_org(uuid), message_org(uuid), reporter_org(uuid),
  notification_audience(text)
  from public, anon;
grant execute on function notification_audience(text) to authenticated, service_role;
-- Whoever reads an owner-privileged view needs execute on is_service(); anon reads none.
revoke execute on function is_service() from public, anon;
revoke all on current_manpower, current_weather from anon;
revoke execute on function job_priority(text) from public, anon, authenticated;
revoke execute on function create_org(text, text, text, text), invoice_gaps(uuid, date, date),
  mark_no_work(uuid), mark_notifications_read(uuid[]),
  resolve_unknown_company(uuid, text, text, uuid), review_glossary_term(uuid, text, text, uuid),
  sign_off_report(uuid), undo_sign_off(uuid)
  from public, anon;

-- 10 (cont.). Storage: accounts reads invoices only ----------------------------------------------------
do $$
begin
  if exists (select 1 from pg_namespace where nspname = 'storage') then
    execute $p$ drop policy "members read org files" on storage.objects $p$;
    execute $p$ create policy "office reads org files" on storage.objects for select to authenticated
      using (bucket_id in ('audio','photos','pdfs','exports','logos')
             and public.has_role(((storage.foldername(name))[1])::uuid, '{admin,pm,ops}')) $p$;
    execute $p$ create policy "members read invoices" on storage.objects for select to authenticated
      using (bucket_id = 'invoices' and public.is_member(((storage.foldername(name))[1])::uuid)) $p$;
  end if;
end $$;
