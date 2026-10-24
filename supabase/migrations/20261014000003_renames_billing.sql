-- SiteLog · spec v1.2 renames and billing columns (W1-05 step 11; docs/GAP_ANALYSIS.md §7, D19,
-- Appendix 9.1 and 9.3)
--
-- Renames (§6.2, §6.3). Each is a catalog change: no row is rewritten and no index rebuilt.
--   1. reporter_status 'verified' → 'active' (D19). The W1-01 inventory of staging (GAP §8) found
--      no reporter in 'verified', so the label is renamed as it is; the W1-19 inventory re-run
--      right before the push confirms it (docs/RUNBOOK.md §2).
--   2. version_author 'reporter_reply' → 'reporter'.
--   3. The type sender_status → contact_status (same labels).
--   4. unknown_senders → unknown_contacts, first_message_id → message_id, and the §6.3 columns
--      channel (field_channel) and call_id (calls). channel stays nullable (D13): the rows from
--      WhatsApp have none, and the WhatsApp worker keeps writing rows without one until step 22;
--      a text (W1-08) or a call (week 2) sets 'sms' or 'voice'. guessed_site_id stays (GAP 9.2).
--      Its constraints, indexes and policies take the new name. Policies, grants, the
--      supabase_realtime publication and the foreign keys follow the table by its oid; no function,
--      view or trigger names the table or its labels (src/renames.test.ts reads the catalog).
--   The panel may now update only status (ignore) on unknown_contacts, as on reporters
--   (20261013000007): phone_e164, org_id, the snippet and the keys are written by the service
--   (docs/AUDIT_BACKLOG.md "reporters and unknown_senders write policies …", unknown_senders half).
--
-- Billing (§6.3 orgs, GAP 9.1), expand/contract: billing_provider (default 'stripe'),
-- billing_customer_id and billing_subscription_id are the columns writers write and readers read
-- from this commit on (stripe-webhook, api-billing, the panel). stripe_customer_id and
-- stripe_subscription_id stay until the contract (step 23) and are kept equal to them by a BEFORE
-- trigger, so a writer of either generation is mirrored into the other: the functions deployed
-- before the cut-over (W1-19 pushes the database before it deploys the functions) and the new
-- ones. A trigger rather than a dual write in code, because the old functions cannot be changed.
-- When one statement writes both with different values, billing_* wins. The backfill copies
-- stripe_* into billing_* under the ALTER TABLE lock, so no write is lost in between. The trigger's
-- UPDATE OF list makes stripe_* depend on it: the contract drops the trigger and
-- sync_org_billing_ids() before the columns (docs/PLAN_WEEK1.md step 23).
--
-- Live database: one transaction (the Supabase CLI runs each file as one pipeline; nothing here
-- needs a transaction block). The deployed staging panel reads unknown_senders and the old labels,
-- so this migration reaches staging only together with the panel of this commit, at the W1-19
-- cut-over (docs/PLAN_WEEK1.md step 11, docs/RUNBOOK.md §2; the deploy guard prevents an earlier
-- push).

set local lock_timeout = '5s';

-- 1–3. Enum labels and the contact status type ------------------------------------------------------
alter type reporter_status rename value 'verified' to 'active';
alter type version_author rename value 'reporter_reply' to 'reporter';
alter type sender_status rename to contact_status;

-- 4. unknown_contacts ---------------------------------------------------------------------------------
alter table unknown_senders rename to unknown_contacts;
alter table unknown_contacts rename column first_message_id to message_id;
alter table unknown_contacts
  add column channel field_channel,                 -- 'voice' (call) or 'sms'; null for WhatsApp (D13)
  add column call_id uuid references calls;

-- Constraint and index names (unknown_senders_pkey, …_org_id_fkey, …_first_message_id_fkey,
-- …_org_id_status_idx, and on Postgres 18 the named NOT NULLs). Renaming a primary key renames its
-- index too, so the indexes are read afterwards.
do $$
declare r record;
begin
  for r in select conname from pg_constraint
           where conrelid = 'unknown_contacts'::regclass and conname like 'unknown\_senders\_%' loop
    execute format('alter table unknown_contacts rename constraint %I to %I', r.conname,
      replace(replace(r.conname, 'unknown_senders_', 'unknown_contacts_'), 'first_message_id', 'message_id'));
  end loop;
  for r in select c.relname from pg_index i join pg_class c on c.oid = i.indexrelid
           where i.indrelid = 'unknown_contacts'::regclass and c.relname like 'unknown\_senders\_%' loop
    execute format('alter index %I rename to %I', r.relname,
      replace(r.relname, 'unknown_senders_', 'unknown_contacts_'));
  end loop;
end $$;

alter policy unknown_senders_select on unknown_contacts rename to unknown_contacts_select;
alter policy unknown_senders_update on unknown_contacts rename to unknown_contacts_update;

revoke update on unknown_contacts from anon, authenticated;
grant update (status) on unknown_contacts to authenticated;

-- 5. Billing columns (expand; stripe_* go in step 23) ---------------------------------------------------
alter table orgs
  add column billing_provider text default 'stripe',
  add column billing_customer_id text,
  add column billing_subscription_id text;

create function sync_org_billing_ids() returns trigger
language plpgsql set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    new.billing_customer_id := coalesce(new.billing_customer_id, new.stripe_customer_id);
    new.billing_subscription_id := coalesce(new.billing_subscription_id, new.stripe_subscription_id);
  else
    if new.billing_customer_id is not distinct from old.billing_customer_id
       and new.stripe_customer_id is distinct from old.stripe_customer_id then
      new.billing_customer_id := new.stripe_customer_id;
    end if;
    if new.billing_subscription_id is not distinct from old.billing_subscription_id
       and new.stripe_subscription_id is distinct from old.stripe_subscription_id then
      new.billing_subscription_id := new.stripe_subscription_id;
    end if;
  end if;
  new.stripe_customer_id := new.billing_customer_id;
  new.stripe_subscription_id := new.billing_subscription_id;
  return new;
end $$;

create trigger orgs_billing_ids before insert or update of
    billing_customer_id, billing_subscription_id, stripe_customer_id, stripe_subscription_id
  on orgs for each row execute function sync_org_billing_ids();

-- Backfill: every org that has a Stripe id (staging: none, GAP §8; the demo org in a seeded stack).
-- updated_at: orgs has none; the audit trigger skips the service (is_service()).
update orgs set billing_customer_id = stripe_customer_id, billing_subscription_id = stripe_subscription_id
where billing_customer_id is distinct from stripe_customer_id
   or billing_subscription_id is distinct from stripe_subscription_id;
