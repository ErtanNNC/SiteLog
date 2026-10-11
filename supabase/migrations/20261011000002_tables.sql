-- SiteLog · §6.3 tables
-- Deviations from the spec DDL are marked "-- +" (additions needed by the flows in §7–§10).

-- ORGS & MEMBERS ---------------------------------------------------------
create table orgs (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  address text,
  license_no text,
  logo_path text,
  timezone text not null default 'America/Chicago',
  stripe_customer_id text,
  stripe_subscription_id text,
  billing_status text default 'trialing',       -- mirrors Stripe: trialing | active | past_due | canceled | paused
  trial_ends_at timestamptz,                    -- + §19 #4: 14-day trial per org
  created_at timestamptz not null default now()
);

create table org_members (
  org_id uuid not null references orgs on delete cascade,
  user_id uuid not null references auth.users on delete cascade,
  role member_role not null default 'ops',
  display_name text,
  title text,
  created_at timestamptz not null default now(),  -- +
  primary key (org_id, user_id)
);

create table org_settings (
  org_id uuid primary key references orgs on delete cascade,
  default_deadline time not null default '17:30',
  working_days smallint[] not null default '{1,2,3,4,5}',
  default_shift_hours numeric(4,2) not null default 8,
  heads_up_enabled boolean not null default true,
  heads_up_offset_min int not null default -35,
  reminder1_enabled boolean not null default true,  -- + ladder toggles (§F18)
  reminder1_offset_min int not null default 15,
  reminder2_enabled boolean not null default true,  -- +
  reminder2_offset_min int not null default 60,
  missing_enabled boolean not null default true,    -- +
  missing_offset_min int not null default 90,
  required_fields text[] not null default '{manpower,hours,weather,work_performed,safety,photo}',
  filing_mode text not null default 'confirm' check (filing_mode in ('confirm','auto_15min')),
  signoff_required boolean not null default true,
  email_pdf_on_file boolean not null default true,
  max_questions_per_report int not null default 3,
  payroll_csv_format text not null default 'generic',
  pdf_paper text not null default 'letter' check (pdf_paper in ('letter','a4')),  -- + §F18 PDF template
  pdf_footer_enabled boolean not null default true,                                -- +
  pdf_max_photos int not null default 4,                                           -- +
  letterhead_lines text[] not null default '{}',                                   -- +
  no_work_pdf boolean not null default false,                                      -- + §F10 step 4
  include_unconfirmed_in_payroll boolean not null default true,                    -- + §P12
  past_due_grace_days int not null default 14,                                     -- + §F19 step 5
  updated_at timestamptz not null default now()
);

-- SITES & PEOPLE -----------------------------------------------------------
create table sites (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs on delete cascade,
  name text not null,
  project_code text not null,
  address text,
  lat double precision,
  lng double precision,
  timezone text not null,
  deadline time,                                -- null → org default
  working_hours text default '07:00–15:30',
  status site_status not null default 'active',
  active_since date default current_date,
  paused_at timestamptz,                        -- +
  report_seq int not null default 0,
  created_at timestamptz not null default now(),
  unique (org_id, project_code)
);

create table reporters (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs on delete cascade,
  name text not null,
  phone_e164 text not null check (phone_e164 ~ '^\+[1-9][0-9]{6,14}$'),
  role reporter_role not null default 'site_manager',
  languages text[] not null default '{en}',
  status reporter_status not null default 'invited',
  invited_at timestamptz,
  verified_at timestamptz,
  last_invite_error text,                       -- + "Not on WhatsApp" (§F3 edge case)
  created_at timestamptz not null default now(),
  unique (org_id, phone_e164)
);

create table site_reporters (
  site_id uuid not null references sites on delete cascade,
  reporter_id uuid not null references reporters on delete cascade,
  is_primary boolean not null default true,
  primary key (site_id, reporter_id)
);

create table site_recipients (
  site_id uuid not null references sites on delete cascade,
  email text not null,
  primary key (site_id, email)
);

create table companies (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs on delete cascade,
  name text not null,
  trade text,
  aliases text[] not null default '{}',
  is_self_perform boolean not null default false,
  status company_status not null default 'confirmed',
  created_at timestamptz not null default now(),
  unique (org_id, name)
);

-- WHATSAPP -----------------------------------------------------------------
create table conversations (
  id uuid primary key default gen_random_uuid(),
  org_id uuid references orgs on delete cascade,      -- null for unknown senders
  reporter_id uuid unique references reporters on delete cascade,
  phone_e164 text not null unique,
  state convo_state not null default 'new',
  context jsonb not null default '{}',
  last_inbound_at timestamptz,
  last_outbound_at timestamptz,                       -- +
  state_changed_at timestamptz not null default now(),-- + timeouts (§7.2)
  updated_at timestamptz not null default now()
);

create table messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references conversations on delete cascade,
  direction msg_direction not null,
  wa_message_id text unique,
  type msg_type not null,
  body text,
  payload jsonb,
  media_id text,
  media_mime text,
  storage_path text,
  duration_s numeric,
  template_name text,
  status msg_status not null default 'received',
  error text,
  created_at timestamptz not null default now()
);

create table transcripts (
  id uuid primary key default gen_random_uuid(),
  message_id uuid not null unique references messages on delete cascade,
  language text,
  text text not null,
  segments jsonb not null,
  model text,
  created_at timestamptz not null default now()
);

create table unknown_senders (
  id uuid primary key default gen_random_uuid(),
  org_id uuid references orgs on delete cascade,
  phone_e164 text not null,
  first_message_id uuid references messages on delete set null,
  snippet text,
  guessed_site_id uuid references sites on delete set null,   -- + "Link to {guessed site}"
  status sender_status not null default 'pending',
  created_at timestamptz not null default now()
);

-- DAYS, REPORTS, VERSIONS -----------------------------------------------------
create table site_days (
  id uuid primary key default gen_random_uuid(),
  site_id uuid not null references sites on delete cascade,
  date date not null,
  status site_day_status not null default 'pending',
  deadline_at timestamptz not null,
  reminder_stage smallint not null default 0,
  reminders_paused boolean not null default false,  -- + "stop" command (§7.2)
  is_late boolean not null default false,
  weather jsonb,
  report_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (site_id, date)
);

create table reports (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs on delete cascade,
  site_id uuid not null references sites on delete cascade,
  site_day_id uuid not null references site_days on delete cascade,
  report_no text not null,
  status report_status not null default 'collecting',
  current_version int not null default 1,
  reporter_id uuid references reporters on delete set null,
  received_at timestamptz,
  confirmed_at timestamptz,
  filed_at timestamptz,
  signed_off_by uuid references auth.users on delete set null,
  signed_off_at timestamptz,
  needs_review boolean not null default false,
  review_reasons text[] not null default '{}',
  is_late boolean not null default false,
  kind text not null default 'daily' check (kind in ('daily','weather_day','no_work')),  -- + §F10
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, report_no)
);
alter table site_days add constraint site_days_report_fk foreign key (report_id) references reports on delete set null;

create table report_versions (
  report_id uuid not null references reports on delete cascade,
  version int not null,
  data jsonb not null,
  summary text,
  pdf_path text,
  author version_author not null,
  author_user_id uuid,
  author_message_id uuid references messages on delete set null,  -- + reply that caused the version
  change_note text,
  created_at timestamptz not null default now(),
  primary key (report_id, version)
);

create table report_sources (
  id uuid primary key default gen_random_uuid(),
  report_id uuid not null references reports on delete cascade,
  message_id uuid not null references messages on delete cascade,
  kind text not null check (kind in ('audio','photo','text','reply')),
  caption text,
  taken_at timestamptz,
  unique (report_id, message_id)
);

-- Denormalised rows per version (for queries/aggregations) --------------------
create table manpower_entries (
  id uuid primary key default gen_random_uuid(),
  report_id uuid not null,
  version int not null,
  company_id uuid references companies on delete set null,
  company_name_heard text,
  company_name text,                             -- + name snapshot (unknown companies have no company_id)
  trade text,
  area text,
  workers int not null,
  hours numeric(6,2) not null,
  hours_basis text,                              -- +
  source jsonb,
  confidence numeric(3,2),
  foreign key (report_id, version) references report_versions on delete cascade
);

create table work_items (
  id uuid primary key default gen_random_uuid(),
  report_id uuid not null,
  version int not null,
  area text,
  activity text not null,
  status text,
  percent int,
  quantity text,                                 -- + "approx. 68 yd³"
  source jsonb,
  foreign key (report_id, version) references report_versions on delete cascade
);

create table weather_events (
  id uuid primary key default gen_random_uuid(),
  report_id uuid not null,
  version int not null,
  site_id uuid not null references sites on delete cascade,
  date date not null,
  start_local time,
  end_local time,
  condition text,
  impact text,
  lost_hours numeric(4,2) not null default 0,
  full_day boolean not null default false,
  audio_source jsonb,
  photo_count int not null default 0,
  observed jsonb,
  claim_ready boolean generated always as
    (audio_source is not null and photo_count > 0 and observed is not null) stored,
  foreign key (report_id, version) references report_versions on delete cascade
);

create table questions (
  id uuid primary key default gen_random_uuid(),
  report_id uuid not null references reports on delete cascade,
  field text not null,
  target jsonb,
  prompt text not null,
  options jsonb,
  asked_message_id uuid references messages on delete set null,
  answered_message_id uuid references messages on delete set null,
  answer jsonb,
  asked_at timestamptz,
  answered_at timestamptz,
  created_at timestamptz not null default now()
);

-- GLOSSARY, INVOICES, PACKS -----------------------------------------------------
create table glossary_terms (
  id uuid primary key default gen_random_uuid(),
  org_id uuid references orgs on delete cascade,  -- null = built-in global term
  scope_site_id uuid references sites on delete cascade,
  scope_reporter_id uuid references reporters on delete cascade,
  heard text not null,
  official text,
  language text not null default 'en',
  kind term_kind not null default 'term',
  company_id uuid references companies on delete set null,
  status term_status not null default 'auto_learned',
  times_heard int not null default 1,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz
);

create table sub_invoices (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs on delete cascade,
  company_id uuid not null references companies on delete cascade,
  invoice_no text,
  period_start date,
  period_end date,
  lines jsonb,
  total_hours numeric(8,2),
  file_path text,
  status text not null default 'open' check (status in ('open','queried','resolved')),
  queried_at timestamptz,                        -- +
  resolved_at timestamptz,                       -- +
  created_at timestamptz not null default now()
);

create table evidence_packs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs on delete cascade,
  site_id uuid references sites on delete cascade,
  period_start date not null,
  period_end date not null,
  status pack_status not null default 'queued',
  pdf_path text,
  sections text[] not null default '{summary,reports,transcripts,photos,weather}',  -- + §P9 checklist
  error text,                                    -- +
  created_by uuid,
  created_at timestamptz not null default now(),
  ready_at timestamptz                           -- +
);

-- OPS --------------------------------------------------------------------------
create table jobs (
  id bigserial primary key,
  type text not null,
  payload jsonb not null,
  status job_status not null default 'queued',
  attempts int not null default 0,
  run_after timestamptz not null default now(),
  locked_at timestamptz,
  locked_by text,                                -- + worker instance id
  last_error text,
  dedupe_key text,                               -- + idempotency (§15 reliability)
  created_at timestamptz not null default now(),
  finished_at timestamptz                        -- +
);

create table audit_log (
  id bigserial primary key,
  org_id uuid,
  actor_type text check (actor_type in ('user','reporter','agent','system')),
  actor_id uuid,
  action text not null,
  entity text,
  entity_id uuid,
  diff jsonb,
  created_at timestamptz not null default now()
);

-- + §13 in-app notification center (bell)
create table notifications (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs on delete cascade,
  user_id uuid,                                  -- null = every member with a matching role sees it
  kind text not null,                            -- missing_report | needs_review | unknown_sender | invoice_gap | glossary_review | pack_ready | billing | report_edited
  title text not null,
  body text,
  target_path text,
  read_at timestamptz,
  created_at timestamptz not null default now()
);

-- updated_at maintenance
create or replace function set_updated_at() returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

create trigger site_days_updated_at before update on site_days for each row execute function set_updated_at();
create trigger reports_updated_at before update on reports for each row execute function set_updated_at();
create trigger conversations_updated_at before update on conversations for each row execute function set_updated_at();
create trigger org_settings_updated_at before update on org_settings for each row execute function set_updated_at();

create or replace function track_state_change() returns trigger language plpgsql as $$
begin
  if new.state is distinct from old.state then
    new.state_changed_at := now();
  end if;
  return new;
end $$;
create trigger conversations_state_changed before update on conversations for each row execute function track_state_change();
