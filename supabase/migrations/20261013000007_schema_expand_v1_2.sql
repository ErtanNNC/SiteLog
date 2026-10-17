-- SiteLog · spec v1.2 schema, expand phase A2 (W1-05 step 9, first half; docs/GAP_ANALYSIS.md §7)
--   1. orgs: the §6.3 profile columns (country, locale, units, currency, tax_no) and is_demo, all
--      with the spec's constant defaults; is_demo = true on the seeded Kestrel demo org if present.
--   2. org_members.ui_locale, the org_settings link and call columns, the reporters v1.2 columns.
--   3. The six v1.2 tables with RLS: consents, field_links, field_devices, uploads, calls,
--      rate_limits. The field-side ones (field_links, field_devices, rate_limits) are service only:
--      no policy and no grant to anon or authenticated (field users never get a database session,
--      §6.5; field-api uses the service role). uploads and calls are report sources: admin, pm,
--      ops of the org read them (§2.2 "View reports"). consents belong to managing reporters and
--      their channel preferences: admin and ops read them (§2.2). Nobody but the service writes
--      any of them (office writes come as security definer RPCs, e.g. office photos in step 10).
--      uploads.reporter_id is nullable and uploaded_by names the office user of an office photo
--      (GAP D14, a recorded deviation).
--   4. messages extended in place for SMS (GAP D15): reporter_id, phone_e164, provider,
--      provider_message_id, copy_key, all nullable (WhatsApp rows have none); type is no longer
--      required (SMS rows have no WhatsApp type). An SMS row carries org_id (it has no
--      conversation), which messages_conversation_or_org requires and messages_select
--      (20261013000005) already reads: admin, pm and ops of that org see it, nobody else.
--      messages joins the realtime publication (Demo phone, Team).
--   5. The v1.2 keys and channels: reports.channel / language / confirmed_via,
--      report_versions.via, transcripts.upload_id / call_id, report_sources.upload_id / call_id /
--      question_id / created_at, questions.channel / call_id / answer_source and the asked_at
--      default. channel stays nullable (GAP D13): WhatsApp-era rows have none, every v1.2 writer
--      sets one, and the insert trigger that rejects a null waits for step 22. reports.language is
--      backfilled and made NOT NULL in step 10.
--   6. WhatsApp-only constraints relaxed so v1.2 writers fit: transcripts.message_id and
--      report_sources.message_id are no longer required, report_sources.kind also takes the
--      source_kind labels, and a transcript has at most one of upload_id / call_id. The spec's
--      exact XOR (and kind as source_kind) waits for step 23: a NOT VALID check still checks new
--      rows, and the WhatsApp transcribe_audio path writes transcripts with neither key (and
--      sources with the old kinds) until step 22.
--   7. orgs column lockdown: orgs_update let an admin write every column, billing state included
--      (docs/AUDIT_BACKLOG.md "Org admins can overwrite the Stripe-mirrored billing columns").
--      UPDATE is revoked and re-granted on the profile columns an admin edits directly: name,
--      address, license_no, tax_no, timezone, locale and units. Billing (stripe_*, billing_status,
--      trial_ends_at, and billing_* from step 11), is_demo, country and currency (they decide the
--      price, the currency and the SMS provider, §1.3, §4.5) and logo_path (set_org_logo() checks
--      the path) stay with the service role and the security definer RPCs (update_org,
--      set_org_logo, create_org). A column added later is not granted, so it starts service only.
--      A direct edit of the granted columns is audited as org.updated (the RPCs log their own).
--   8. report_archive selects r.*, which Postgres expands when the view is created: recreated so
--      the new reports columns reach the archive.
--   9. The §6.4 indexes of the new tables and columns; the private `calls` bucket (call
--      recordings, written by the voice agent from week 2) with an admin / pm / ops read policy.
--  10. transcripts_select also finds the org of a v1.2 transcript (upload_id or call_id, no
--      message_id) through upload_org() / call_org(); before, message_org(null) hid it from
--      every office user.
--  11. reporters lockdown: the row now holds the opt-out and activation records, and consents,
--      field_links and field_devices cascade from it, but reporters_write (20261011000004_rls.sql)
--      let admin and ops insert, update and delete anything (docs/AUDIT_BACKLOG.md "reporters and
--      unknown_senders write policies allow forging verification state"). INSERT and DELETE are
--      revoked (reporters are created by api-invite-reporter and api-link-unknown-sender with
--      the service role; a delete would take the consent evidence with it, §17), UPDATE is
--      re-granted on status and invited_at only (the panel's disable and re-invite; edits go
--      through update_reporter()), and a guard lets a client set status only to invited or
--      disabled, never out of opted_out (STOP and START are the reporter's, F15).
--
-- Live database: additive DDL, plus three swaps that change nothing for existing rows or readers
-- (the kind check is replaced by a wider one, report_archive by the same query, transcripts_select
-- by one that finds the same org for every existing transcript). New columns are nullable or have
-- constant defaults (no table rewrite; report_sources.created_at gets its now() default after the
-- column exists, so existing rows keep a null rather than the migration's time). No row is
-- rewritten except the one demo org. The WhatsApp worker, the webhook, the deployed panel and the
-- office RPCs read and write exactly what they did before: the panel writes orgs only through
-- RPCs and reporters only as a status change to disabled or invited (with invited_at).
-- Locks: every statement is short, but the ALTERs hold their locks until the file commits, so
-- give up instead of queueing behind a long query (and blocking the panel behind us).

set local lock_timeout = '5s';

-- 1. Orgs ---------------------------------------------------------------------------------------
alter table orgs
  add column country text not null default 'US' check (country in ('US','TR')),
  add column locale text not null default 'en-US' check (locale in ('en-US','tr-TR')),  -- report language, panel default
  add column units text not null default 'imperial' check (units in ('imperial','metric')),
  add column currency text not null default 'USD',
  add column tax_no text,
  add column is_demo boolean not null default false;  -- demo orgs: console SMS driver + /dev/phone

-- The seeded Kestrel demo org (DEMO_ORG_ID, packages/shared/src/demo/kestrel.ts), where it exists.
-- A fresh database gets it from seed.sql after the migrations (W1-06 seeds is_demo there).
with flagged as (
  update orgs set is_demo = true
  where id = '7a0cfa5d-2a29-43fb-8665-fcd9bed4106d' and not is_demo
  returning id
)
insert into audit_log (org_id, actor_type, action, entity, entity_id, diff)
select id, 'system', 'org.demo_flagged', 'org', id, '{"is_demo":{"from":false,"to":true}}'::jsonb
from flagged;

-- 2. Members, settings, reporters ---------------------------------------------------------------
alter table org_members add column ui_locale text;  -- null → org locale (§11.2 i18n)

alter table org_settings
  add column daily_link_time time default '17:00',        -- daily SMS link for 'link' reporters
  add column auto_call_enabled boolean default true,      -- outbound calls for 'call' reporters
  add column second_call_enabled boolean default true,    -- retry call at reminder 2
  add column call_window_start time default '07:00',
  add column call_window_end time default '20:00';

alter table reporters
  add column locale text not null default 'en-US',        -- language SiteLog speaks/texts: en-US, es-US, tr-TR
  add column contact_pref contact_pref not null default 'link',
  add column activated_at timestamptz,                    -- backfilled in step 10
  add column opted_out_at timestamptz;

-- 3. New tables -----------------------------------------------------------------------------------
create table consents (
  id uuid primary key default gen_random_uuid(),
  reporter_id uuid not null references reporters on delete cascade,
  type consent_type not null,
  method text not null,                          -- 'web_checkbox' | 'sms_reply_yes' | 'voice_yes' | 'office_attested'
  text_version text not null,                    -- version of the consent wording shown/spoken
  evidence jsonb,                                -- {upload_id|call_id|message_id, ip, user_agent}
  given_at timestamptz not null default now(),
  revoked_at timestamptz
);

create table field_links (
  id uuid primary key default gen_random_uuid(),
  code_hash text not null unique,                -- sha256 of the short code; the code itself is never stored
  reporter_id uuid not null references reporters on delete cascade,
  site_id uuid references sites,                 -- null for personal links (all the reporter's sites)
  kind link_kind not null,
  report_date date,                              -- for daily/photos links
  expires_at timestamptz,                        -- null for personal links (revocable)
  revoked_at timestamptz,
  last_opened_at timestamptz,
  created_at timestamptz default now()
);

create table field_devices (
  id uuid primary key default gen_random_uuid(),
  reporter_id uuid not null references reporters on delete cascade,
  device_token_hash text not null unique,        -- httpOnly cookie, 180 days
  user_agent text,
  verified_at timestamptz,                       -- after SMS one-time code
  last_seen_at timestamptz,
  revoked_at timestamptz
);

create table uploads (                           -- web recorder files (+ office photos, D14)
  id uuid primary key default gen_random_uuid(),
  report_id uuid references reports on delete cascade,
  reporter_id uuid references reporters,         -- + nullable: office photos have no reporter (D14)
  site_id uuid not null references sites,
  kind upload_kind not null,
  storage_path text not null,
  mime text,
  bytes int,
  duration_s numeric,
  peaks jsonb,                                   -- waveform peaks for the panel player
  recorded_at timestamptz,                       -- client clock
  received_at timestamptz default now(),
  caption text,
  uploaded_by uuid                               -- + the office user of an office photo (D14)
);

create table calls (
  id uuid primary key default gen_random_uuid(),
  org_id uuid references orgs,
  reporter_id uuid references reporters,
  site_id uuid references sites,
  report_id uuid references reports,
  direction call_direction not null,
  transport call_transport not null default 'pstn',
  purpose text,                                  -- 'daily_report' | 'reminder' | 'callback' | 'edit'
  provider_call_id text unique,                  -- LiveKit room name (call-{uuid}); SIP call id in metrics
  from_e164 text,
  to_e164 text,
  status call_status not null default 'queued',
  outcome call_outcome,
  disclosure_played boolean default false,
  started_at timestamptz,
  answered_at timestamptz,
  ended_at timestamptz,
  duration_s int,
  recording_path text,                           -- dual-channel (reporter / agent), bucket `calls`
  peaks jsonb,
  dialog_log jsonb,                              -- [{t:12.4, speaker:'agent'|'reporter', text, tool?}]
  metrics jsonb,                                 -- latency p50/p95, interruptions, stt confidence
  created_at timestamptz default now()
);

create table rate_limits (                       -- field-api throttling (per device / per phone)
  key text not null,                             -- 'dev:<device_id>' | 'code:<e164>'
  window_start timestamptz not null,
  count int not null default 0,
  primary key (key, window_start)
);

-- 4. Messages: SMS in place (D15) -------------------------------------------------------------------
alter table messages
  add column reporter_id uuid references reporters on delete set null,
  add column phone_e164 text,                    -- NOT NULL in step 23 (WhatsApp and office rows have none)
  add column provider text,                      -- twilio | iletimerkezi | console
  add column provider_message_id text unique,
  add column copy_key text;                      -- e.g. 'daily_link', 'reminder_1' (§9.2)
alter table messages alter column type drop not null;  -- SMS rows have no WhatsApp type
-- Policy: messages_select reads coalesce(conversation's org, org_id), so an SMS row (no
-- conversation, org_id set) is its org's. The D21 change (org_id first) comes with step 9b.

-- 5. Channels and v1.2 keys on reports, versions, transcripts, sources, questions -----------------
alter table reports
  add column channel field_channel,              -- channel of the first submission (nullable, D13)
  add column language text,                      -- report output language: 'en' | 'tr' (NOT NULL in step 10)
  add column confirmed_via field_channel;

alter table report_versions add column via field_channel;  -- for reporter edits

alter table transcripts
  add column upload_id uuid unique references uploads on delete cascade,
  add column call_id uuid unique references calls on delete cascade;

alter table report_sources
  add column upload_id uuid references uploads,
  add column call_id uuid references calls,
  add column question_id uuid,
  add column created_at timestamptz;
alter table report_sources alter column created_at set default now();

alter table questions
  add column channel field_channel,              -- nullable (D13)
  add column call_id uuid references calls,
  add column answer_source jsonb;
alter table questions alter column asked_at set default now();

-- 6. Relax the WhatsApp-only constraints ------------------------------------------------------------
alter table transcripts alter column message_id drop not null;
alter table transcripts add constraint transcripts_one_source check (num_nonnulls(upload_id, call_id) <= 1);

alter table report_sources alter column message_id drop not null;
alter table report_sources drop constraint report_sources_kind_check;
alter table report_sources add constraint report_sources_kind_check
  check (kind in ('audio','photo','text','reply',              -- WhatsApp era, until step 22
                  'voice_note','call','answer'));                -- + source_kind (photo, text shared)

-- 3 (cont.). RLS and grants of the new tables ----------------------------------------------------
alter table consents enable row level security;
alter table field_links enable row level security;
alter table field_devices enable row level security;
alter table uploads enable row level security;
alter table calls enable row level security;
alter table rate_limits enable row level security;

-- Supabase's default privileges give anon and authenticated every privilege on a new table; RLS
-- would deny them anyway, but the field-side tables are not for API roles at all.
revoke all on consents, field_links, field_devices, uploads, calls, rate_limits from anon, authenticated;
grant select on consents, uploads, calls to authenticated;

create policy consents_select on consents for select to authenticated
  using (has_role(reporter_org(reporter_id), '{admin,ops}'));
create policy uploads_select on uploads for select to authenticated
  using (has_role(site_org(site_id), '{admin,pm,ops}'));
create policy calls_select on calls for select to authenticated
  using (org_id is not null and has_role(org_id, '{admin,pm,ops}'));

-- 7. orgs column lockdown ---------------------------------------------------------------------------
revoke update on orgs from anon, authenticated;
grant update (name, address, license_no, tax_no, timezone, locale, units) on orgs to authenticated;

-- A direct edit of those columns (PostgREST PATCH) is audited like update_org() does it:
-- org.updated with {column: {from, to}}. The WHEN clause is evaluated as the caller, so an update
-- from inside a security definer RPC (update_org, set_org_logo: current_user is their owner) or by
-- the service (Stripe's billing mirror, this migration's demo flag) is not logged a second time.
create or replace function audit_org_update() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_diff jsonb;
begin
  select jsonb_object_agg(n.key, jsonb_build_object('from', o.value, 'to', n.value)) into v_diff
  from jsonb_each(to_jsonb(new)) as n(key, value)
  join jsonb_each(to_jsonb(old)) as o(key, value) on o.key = n.key
  where n.value is distinct from o.value;
  if v_diff is not null then
    perform log_audit(new.id, case when auth.uid() is null then 'system' else 'user' end,
      auth.uid(), 'org.updated', 'org', new.id, v_diff);
  end if;
  return null;
end $$;

create trigger orgs_audit after update on orgs
  for each row when (not is_service()) execute function audit_org_update();

-- 10. transcripts_select: v1.2 transcripts ------------------------------------------------------------
-- Lookup helpers like message_org(): a policy runs them as the querying user, so authenticated
-- keeps execute; anon gets none (src/anon.test.ts).
create or replace function upload_org(p_upload_id uuid) returns uuid
language sql stable security definer set search_path = public as $$
  select s.org_id from uploads u join sites s on s.id = u.site_id where u.id = p_upload_id;
$$;

create or replace function call_org(p_call_id uuid) returns uuid
language sql stable security definer set search_path = public as $$
  select org_id from calls where id = p_call_id;
$$;

revoke all on function upload_org(uuid), call_org(uuid) from public, anon;
grant execute on function upload_org(uuid), call_org(uuid) to authenticated, service_role;

-- A WhatsApp transcript keeps its message's org (the shared-phone fix, D21, comes with step 9b).
drop policy transcripts_select on transcripts;
create policy transcripts_select on transcripts for select to authenticated
  using (has_role(coalesce(message_org(message_id), upload_org(upload_id), call_org(call_id)),
                  '{admin,pm,ops}'));

-- 11. reporters lockdown -------------------------------------------------------------------------------
-- reporters_write stays for the rows (admin and ops of the org); the privileges decide the columns.
revoke insert, update, delete on reporters from anon, authenticated;
grant update (status, invited_at) on reporters to authenticated;

-- Security invoker, so is_service() sees the caller: the service role and the worker (sms-webhook
-- STOP / START, activation on first consent) and security definer RPCs pass. 'verified' (step 11:
-- 'active') follows a consent, 'opted_out' a STOP; the office only disables and re-invites.
create or replace function guard_reporter_status() returns trigger
language plpgsql set search_path = public as $$
begin
  if new.status is distinct from old.status and not is_service()
     and (old.status = 'opted_out' or new.status not in ('invited', 'disabled')) then
    raise exception 'reporter status % to % is set by SiteLog, not by the office', old.status, new.status
      using errcode = '42501';
  end if;
  return new;
end $$;

create trigger reporters_status_guard before update of status on reporters
  for each row execute function guard_reporter_status();

-- 9. Indexes (§6.4; the rest support lookups the field-api and consent checks make) ----------------
create index on uploads (report_id);
create index on calls (reporter_id, created_at desc);
create index on messages (reporter_id, created_at desc);
create index on field_links (reporter_id, kind);
create index consents_reporter_type on consents (reporter_id, type);
create index field_devices_reporter_id on field_devices (reporter_id);

-- 8. Reports archive (20261013000002_report_archive.sql), recreated for the new reports columns --
drop view report_archive;
create view report_archive as
  select r.*,
         sd.date,
         s.name as site_name,
         s.project_code,
         -- Scalar subquery: only evaluated when a query reads or filters on lost_hours.
         coalesce((select sum(w.lost_hours) from weather_events w
                   where w.report_id = r.id and w.version = r.current_version), 0)::numeric as lost_hours,
         coalesce(case when jsonb_typeof(v.data->'safety'->'incidents') = 'array'
                       then jsonb_array_length(v.data->'safety'->'incidents') end, 0) > 0 as has_incident,
         coalesce(v.summary, v.data->>'summary') as summary
  from reports r
  join site_days sd on sd.id = r.site_day_id
  join sites s on s.id = r.site_id
  left join report_versions v on v.report_id = r.id and v.version = r.current_version
  where r.status in ('filed', 'signed_off')
    and (is_service() or exists (select 1 from org_members om where om.org_id = r.org_id and om.user_id = auth.uid()
                                 and om.role in ('admin', 'pm', 'ops')));

revoke all on report_archive from anon, authenticated;
grant select on report_archive to authenticated, service_role;

-- 4 (cont.). Realtime: SMS threads (Demo phone) and undeliverable texts (Team) ------------------------
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_publication_tables
                     where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'messages') then
    alter publication supabase_realtime add table messages;
  end if;
end $$;

-- 9 (cont.). Storage: call recordings ---------------------------------------------------------------
-- Object paths start with {org_id}/ like every bucket (20261011000006_platform.sql); the voice
-- agent writes them with the service role. Readers: the roles that read reports (§2.2).
do $$
begin
  if exists (select 1 from pg_namespace where nspname = 'storage') then
    insert into storage.buckets (id, name, public) values ('calls', 'calls', false)
    on conflict (id) do nothing;
    execute $p$ create policy "office reads call recordings" on storage.objects for select to authenticated
      using (bucket_id = 'calls' and public.has_role(((storage.foldername(name))[1])::uuid, '{admin,pm,ops}')) $p$;
  end if;
end $$;
