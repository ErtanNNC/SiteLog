-- SiteLog · country packs and the message channel type (W1-06a, GAP step 12a; GAP D47, D48)
--
-- Owner decision, 2026-10-14: SiteLog is a global product; everything country-specific is a
-- "country pack" (configuration), not code, and a new country is a new row. Spec §4.6 describes
-- the pack, §4.5 the message channels, §6.3 this DDL (D11 compares it with the spec's).
--   1. message_channel ('sms','whatsapp','push'): how SiteLog reaches a person. It is separate
--      from field_channel, which records how a report reached SiteLog (push is never inbound).
--      WhatsApp (through Twilio) and web push are labels now; their transports, consents and
--      storage come in week 2 with the M6 reminders (D48).
--   2. countries: one row per pack (D47). Every signed-in user reads it (the setup wizard runs
--      before the user has an org); no client writes it (no insert, update or delete grant).
--      Policy values change only by forward migration. The per-environment values sms_sender_id
--      and voice_number are seeded null and set per database with set_country_endpoints() (8);
--      no later migration may write those two columns, with one exception: a migration that
--      changes a pack's sms_sender_type also sets its sms_sender_id to null in the same update.
--      The table checks a sender id's shape against its type (as set_country_endpoints() does),
--      so a type change that keeps a set sender fails at push time on that database; the new
--      sender is then set with set_country_endpoints(). A null sender id means the console
--      transport, so nothing is sent before a sender is approved (week 1 behaviour unchanged).
--   3. The US and TR launch packs (values and sources: spec §4.6). Both order {sms} in week 1.
--   4. A guard: every org's country must have a pack before the swap (the old check allowed US
--      and TR only, both seeded here), so a surprise fails here with the offending codes.
--   5. orgs.country references countries(code) instead of check (country in ('US','TR')). The
--      default 'US' stays as the fallback for service inserts, as do the locale and units checks.
--   6. on_org_created(): org_settings.pdf_paper from the org's pack (US letter, TR a4; D32 amended).
--   7. create_org(): the same parameter names plus p_country default 'US'; locale, units,
--      currency and (when p_timezone is empty) the time zone come from the pack. The 4-argument
--      function is dropped, not overloaded: two candidates would make PostgREST's named call
--      ambiguous (PGRST203). The deployed panel's named call {p_name, p_timezone, p_address,
--      p_license_no} resolves to this function and creates a US org as before.
--   8. set_country_endpoints(): service role only, audited (country.endpoints_set): sets a pack's
--      sender id and voice number in one database (pnpm countries:set, owner-approved on hosted
--      databases).
--   9. job_priority(): 'notify', the channel-neutral Notifier job (W1-10), with the messages (0).
--      Every existing name keeps its rank; send_message (the live v1.0 job) is never reused.
--
-- Live database: one new type, one new table with two rows, a constraint swap on orgs validated
-- against rows the old check limited to US and TR, and function replacements. No row of an
-- existing table is rewritten. The v1.0 worker and webhook never call create_org and never
-- insert orgs; the deployed panel calls create_org by name (still resolves) and update_org (not
-- changed). Locks: the constraint swap holds an ACCESS EXCLUSIVE lock on orgs (and SHARE ROW
-- EXCLUSIVE on countries) until the file commits, while the foreign key is checked against the
-- few org rows; give up instead of queueing behind a long query.

set local lock_timeout = '5s';

-- 1. How SiteLog reaches a person (field_channel records how a report reached SiteLog) -------------
create type message_channel as enum ('sms', 'whatsapp', 'push');

-- 2. Country packs (spec §4.6). Spec §6.3 holds this DDL verbatim (D11 compares definitions) -------
create table countries (
  code text primary key check (code ~ '^[A-Z]{2}$'),
  default_locale text not null check (default_locale in ('en-US','tr-TR')),
  field_locales text[] not null check (cardinality(field_locales) > 0 and field_locales <@ array['en-US','es-US','tr-TR']),
  units text not null check (units in ('imperial','metric')),
  paper text not null check (paper in ('letter','a4')),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  default_timezone text not null,
  message_channels message_channel[] not null check (cardinality(message_channels) > 0),
  sms_provider text not null default 'twilio' check (sms_provider in ('twilio','iletimerkezi')),
  whatsapp_provider text not null default 'twilio' check (whatsapp_provider in ('twilio')),
  sms_sender_type text not null check (sms_sender_type in ('toll_free','long_code','short_code','alphanumeric')),
  sms_sender_id text,
  two_way_sms boolean not null,
  sms_links_allowed boolean not null,
  voice_number text check (voice_number ~ '^\+[1-9][0-9]{6,14}$'),
  legal_keys jsonb not null default '{}'::jsonb check (jsonb_typeof(legal_keys) = 'object'),
  created_at timestamptz not null default now(),
  check (sms_sender_type <> 'alphanumeric' or not two_way_sms),
  check (sms_links_allowed or message_channels && array['whatsapp','push']::message_channel[]),
  check (sms_sender_id is null or (sms_sender_id = btrim(sms_sender_id) and case sms_sender_type
    when 'alphanumeric' then sms_sender_id ~ '^[A-Za-z0-9 ]{1,11}$'
    when 'short_code' then sms_sender_id ~ '^[0-9]{3,8}$'
    else sms_sender_id ~ '^\+[1-9][0-9]{6,14}$' end))
);
alter table countries enable row level security;
-- Supabase's default privileges give anon and authenticated every privilege on a new table.
revoke all on countries from anon, authenticated;
grant select on countries to authenticated;
create policy countries_select on countries for select to authenticated using (true);

-- 3. Launch packs. Per-environment values stay null here and are set per database with
--    set_country_endpoints(); no later migration writes sms_sender_id or voice_number, except to
--    clear the sender id of a pack whose sender type it changes (header, 2).
insert into countries (code, default_locale, field_locales, units, paper, currency, default_timezone,
                       message_channels, sms_provider, whatsapp_provider, sms_sender_type,
                       sms_sender_id, two_way_sms, sms_links_allowed, voice_number, legal_keys)
values
  ('US', 'en-US', '{en-US,es-US}', 'imperial', 'letter', 'USD', 'America/Chicago',
   '{sms}', 'twilio', 'twilio', 'toll_free', null, true, true, null, '{}'),
  ('TR', 'tr-TR', '{tr-TR,en-US}', 'metric', 'a4', 'TRY', 'Europe/Istanbul',
   '{sms}', 'iletimerkezi', 'twilio', 'alphanumeric', null, false, true, null, '{}');

-- 4. Guard before the swap: fail loudly (the W1-19 staging push) instead of half-applying ----------
do $$
declare v_bad text;
begin
  select string_agg(distinct o.country, ', ') into v_bad
  from orgs o where not exists (select 1 from countries c where c.code = o.country);
  if v_bad is not null then
    raise exception 'orgs outside the country packs: %', v_bad;
  end if;
end $$;

-- 5. orgs.country → countries. The exact name Postgres gave the check in 20261013000007 (no
--    "if exists": a missing check is a surprise worth stopping for). Default 'US' stays.
alter table orgs
  drop constraint orgs_country_check,
  add constraint orgs_country_fkey foreign key (country) references countries (code);

-- 6. New orgs get their pack's paper -------------------------------------------------------------
create or replace function on_org_created() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into org_settings (org_id, pdf_paper)
  values (new.id, coalesce((select paper from countries where code = new.country), 'letter'))
  on conflict do nothing;
  insert into companies (org_id, name, trade, is_self_perform)
  values (new.id, new.name || ' self-perform', 'General labor', true)
  on conflict do nothing;
  return new;
end $$;

-- 7. create_org(p_country): presets from the pack -------------------------------------------------
drop function create_org(text, text, text, text);

create function create_org(p_name text, p_timezone text default null, p_address text default null,
                           p_license_no text default null, p_country text default 'US')
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_org orgs%rowtype; v_pack countries%rowtype;
begin
  if auth.uid() is null then raise exception 'not signed in' using errcode = '42501'; end if;
  if coalesce(trim(p_name), '') = '' then raise exception 'company name required'; end if;
  select * into v_pack from countries where code = upper(btrim(coalesce(p_country, 'US')));
  if not found then raise exception 'unknown country' using errcode = '22023'; end if;
  insert into orgs (name, country, locale, units, currency, timezone, address, license_no, trial_ends_at)
  values (trim(p_name), v_pack.code, v_pack.default_locale, v_pack.units, v_pack.currency,
          coalesce(nullif(btrim(p_timezone), ''), v_pack.default_timezone),
          p_address, p_license_no, now() + interval '14 days')
  returning * into v_org;
  insert into org_members (org_id, user_id, role, display_name)
  values (v_org.id, auth.uid(), 'admin', coalesce(auth.jwt() ->> 'email', 'Admin'));
  insert into audit_log (org_id, actor_type, actor_id, action, entity, entity_id, diff)
  values (v_org.id, 'user', auth.uid(), 'org.created', 'org', v_org.id,
          jsonb_build_object('country', v_org.country));
  return to_jsonb(v_org);
end $$;
revoke execute on function create_org(text, text, text, text, text) from public, anon;
grant execute on function create_org(text, text, text, text, text) to authenticated;

-- 8. set_country_endpoints(): per-environment sender id and voice number (service role only) -------
-- null (or blank) clears a value: a null sender id means console, a null voice number Talk now only.
-- The sender is checked against the pack's sender type: an alphanumeric title (1–11 letters,
-- digits, spaces), a short code (3–8 digits), or an E.164 number for toll-free and long codes.
-- The table's check holds the same rule; this one comes first for a clearer error (22023).
create function set_country_endpoints(p_code text, p_sms_sender_id text, p_voice_number text)
returns countries language plpgsql security definer set search_path = public as $$
declare
  v_old countries%rowtype;
  v_new countries%rowtype;
  v_sender text := nullif(btrim(p_sms_sender_id), '');
  v_voice text := nullif(btrim(p_voice_number), '');
begin
  select * into v_old from countries where code = upper(btrim(p_code)) for update;
  if not found then raise exception 'unknown country' using errcode = '22023'; end if;
  if v_voice is not null and v_voice !~ '^\+[1-9][0-9]{6,14}$' then
    raise exception 'voice number must be E.164 (+ and 7 to 15 digits)' using errcode = '22023';
  end if;
  if v_sender is not null and not (case v_old.sms_sender_type
      when 'alphanumeric' then v_sender ~ '^[A-Za-z0-9 ]{1,11}$'
      when 'short_code' then v_sender ~ '^[0-9]{3,8}$'
      else v_sender ~ '^\+[1-9][0-9]{6,14}$'
    end) then
    raise exception 'not a valid % sender id for %', v_old.sms_sender_type, v_old.code
      using errcode = '22023';
  end if;
  update countries set sms_sender_id = v_sender, voice_number = v_voice
  where code = v_old.code
  returning * into v_new;
  insert into audit_log (org_id, actor_type, actor_id, action, entity, entity_id, diff)
  values (null, 'system', null, 'country.endpoints_set', 'country', null,
          jsonb_build_object(
            'code', v_new.code,
            'from', jsonb_build_object('sms_sender_id', v_old.sms_sender_id, 'voice_number', v_old.voice_number),
            'to', jsonb_build_object('sms_sender_id', v_new.sms_sender_id, 'voice_number', v_new.voice_number)));
  return v_new;
end $$;
revoke execute on function set_country_endpoints(text, text, text) from public, anon, authenticated;

-- 9. Priorities (lower first): notify joins the messages ------------------------------------------
-- create or replace keeps the existing revoke (20261014000001).
create or replace function job_priority(p_type text) returns int
language sql immutable set search_path = public as $$
  select case
    -- Messages and calls to and from the reporter.
    when p_type in ('inbound_message', 'send_message', 'send_template', 'send_welcome',
                    'send_sms', 'notify', 'place_call') then 0
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
