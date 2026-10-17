-- SiteLog · SMS layer (W1-08, GAP step 14; spec §4.5, §4.6, §9.5, F13, §11.1)
--
--   1. countries_sms_sender_id_key: an SMS sender id belongs to one pack (spec §4.6). sms-webhook
--      finds the pack of an inbound text by the sender id that received it (Twilio's `To`, F13),
--      so two packs may not share one. Partial: packs without a sender in this database (null =
--      console) are not compared. set_country_endpoints() then refuses a sender another pack has
--      (unique_violation), which `pnpm countries:set` reports.
--   2. messages_conversation_or_org widened (the W1-05 step 9 note): a text from an unknown number
--      (F13) has no conversation and no org, only its phone; nobody in the panel reads such a row
--      (messages_select needs an org) until W1-16 lists unknown contacts.
--   3. console_emails: what EMAIL_PROVIDER=console would have sent (§5.1), for the Demo phone's
--      Email tab (§11.1): recipients, subject, the text body and the attachments' names and sizes
--      (never the files). The worker writes it with the service role; admins of the org read it,
--      as they read the Demo phone. A table of the console provider only: Resend sends instead.
--   4. sms_opt_outs: a phone's STOP on a pack's SMS sender (spec §9.5), kept whether or not the
--      phone belongs to a reporter, so it outlives a disabled reporter and reaches the next invite
--      of that number in any org of the pack: api-invite-reporter creates or re-enables such a
--      reporter `opted_out`, and the Notifier sends that phone nothing on the pack. Written by
--      sms-webhook (a STOP keyword on Twilio) and the Notifier (Twilio 21610: the carrier's opt-out
--      list), removed by START. Service role only, like rate_limits.
--   5. notification_audience(): `reporter_opted_out` (§13 "Message undeliverable / opted out")
--      goes to admin and ops, as `reporter_invite_failed` does.
--
-- Live database (staging): an index on two rows, a check that every existing row already meets
-- (it only adds an alternative), two new empty tables and a function replaced with one more
-- kind. The deployed v1.0 functions and worker write none of these.

set local lock_timeout = '5s';

-- 1. Sender ids unique across packs ------------------------------------------------------------------
create unique index countries_sms_sender_id_key on countries (sms_sender_id)
  where sms_sender_id is not null;

-- 2. A message may have only a phone ---------------------------------------------------------------
alter table messages
  drop constraint messages_conversation_or_org,
  add constraint messages_conversation_or_org
    check (conversation_id is not null or org_id is not null or phone_e164 is not null);

-- 3. Console emails -----------------------------------------------------------------------------------
create table console_emails (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs on delete cascade,
  kind text not null,                              -- the send_email kind, e.g. 'report_filed'
  recipients text[] not null,
  subject text not null,
  body_text text not null,
  attachments jsonb not null default '[]'::jsonb check (jsonb_typeof(attachments) = 'array'),  -- [{filename, bytes}]
  created_at timestamptz not null default now()
);
create index console_emails_org_created on console_emails (org_id, created_at desc);

alter table console_emails enable row level security;
revoke all on console_emails from anon, authenticated;
grant select on console_emails to authenticated;
create policy console_emails_select on console_emails for select to authenticated
  using (has_role(org_id, '{admin}'));

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_publication_tables
                     where pubname = 'supabase_realtime' and schemaname = 'public'
                       and tablename = 'console_emails') then
    alter publication supabase_realtime add table console_emails;
  end if;
end $$;

-- 4. Phone-level SMS opt-outs ------------------------------------------------------------------------
create table sms_opt_outs (
  phone_e164 text not null,
  country text not null references countries,
  method text not null check (method in ('sms_keyword','provider_opt_out')),
  opted_out_at timestamptz not null default now(),
  primary key (phone_e164, country)
);

alter table sms_opt_outs enable row level security;
revoke all on sms_opt_outs from anon, authenticated;

-- 5. Notification audience: opt-outs ------------------------------------------------------------------
-- 20261014000001's function with reporter_opted_out (packages/shared/src/notifications.ts).
create or replace function notification_audience(p_kind text) returns member_role[]
language sql stable set search_path = public as $$
  select (case p_kind
    when 'invoice_gap' then '{admin,ops,accounts}'        -- §13 "Invoice gap: ops, accounts"
    when 'billing' then '{admin}'                         -- §13 "Billing: admin"
    when 'missing_report' then '{admin,ops}'              -- §13 "Report missing: ops + admin"
    when 'unknown_sender' then '{admin,ops}'              -- §13 "Unknown contact: ops, admin"
    when 'unknown_contact' then '{admin,ops}'
    when 'reporter_invite_failed' then '{admin,ops}'      -- §13 "Message undeliverable / opted out"
    when 'reporter_opted_out' then '{admin,ops}'          -- the same row of §13
    when 'reporter_wrong_site' then '{admin,ops}'         -- §2.2 "Manage reporters": admin, ops
    else '{admin,pm,ops}'  -- needs_review (§13: ops, pm), glossary_review, processing_delayed, …
  end)::member_role[];
$$;
