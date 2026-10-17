-- SiteLog · W4-10 Billing on v1.2 (2026-10-17): the price per org, the billing provider per org,
-- SiteLog staff's billing controls on /ops and the quantity sync retried by a job.
--   Spec §1.3, F2 step 4, F23, P13, §13 Billing, §19 Q7–Q10, Q30, Q234 (`BILLING_PRICE_POLICY`),
--   Q235 (`TRIAL_END_POLICY`, code only: packages/shared/src/billing.ts), Q236 (TR `manual`).
--
--   1. billing_default_prices: SiteLog's default price per active site and month, per currency,
--      in minor units. create_org() presets a new org's price from it (Q234 names an env default,
--      but create_org() runs in Postgres, which has no env: README "Deliberate deviations"). USD
--      39900 (§1.3: $399); no TRY row until §19 Q9 sets the TR price, so a TR org starts with none.
--      Service role only (no policy); changed by a migration or by SQL with the owner's approval.
--   2. orgs.price_per_site_minor + orgs.price_currency (both or neither), outside the country pack
--      (§19 Q30); no grant to authenticated, so only the service role and ops_set_org_price() write
--      them. A billing_provider check: 'stripe' or 'manual' (Q236), the two BillingProviders.
--      Backfill: every org gets its currency's default (US orgs: $399, the price they were shown);
--      a TR org without a subscription is billed 'manual' (until Q8). Each change audited.
--   3. create_org(): billing_provider from the pack (billing_provider_for_country(): TR 'manual',
--      the twin of billingProviderForCountry() in shared) and the price from (1). Same signature.
--   4. /ops (platform admins only): ops_org_billing() lists the orgs with their billing;
--      ops_set_org_price() sets or clears an org's price (audited billing.price_set);
--      ops_set_org_billing_status() sets a manual org's billing_status (audited
--      billing.status_changed via ops, the row the scheduler reads as the start of arrears).
--      A Stripe org's status follows Stripe (stripe-webhook) and is refused here.
--   5. billing_sync: a site added, paused, resumed or archived in a real org with a Stripe
--      subscription queues a `billing_sync` job (the worker: subscription quantity = active
--      sites), two minutes later, after the panel's own api-billing `sync`; a sync that failed is
--      done by the job (docs/AUDIT_BACKLOG.md "Adding a site never increments …" caveat). The
--      key carries the site, its status and the instant (a key is never used twice, D16).

-- 1. Default prices --------------------------------------------------------------------------------
create table billing_default_prices (
  currency text primary key check (currency ~ '^[A-Z]{3}$'),
  price_per_site_minor int not null check (price_per_site_minor > 0),
  updated_at timestamptz not null default now()
);
alter table billing_default_prices enable row level security;
revoke all on billing_default_prices from anon, authenticated;
insert into billing_default_prices (currency, price_per_site_minor) values ('USD', 39900);

-- 2. The org's price and provider ------------------------------------------------------------------
alter table orgs
  add column price_per_site_minor int check (price_per_site_minor > 0),
  add column price_currency text check (price_currency ~ '^[A-Z]{3}$'),
  add constraint orgs_price_pair check ((price_per_site_minor is null) = (price_currency is null)),
  add constraint orgs_billing_provider_check check (billing_provider in ('stripe', 'manual'));

create function billing_provider_for_country(p_country text) returns text
language sql immutable set search_path = public as $$
  select case when upper(btrim(coalesce(p_country, ''))) in ('TR') then 'manual' else 'stripe' end;
$$;
revoke execute on function billing_provider_for_country(text) from public, anon, authenticated;

with changed as (
  update orgs o
  set price_per_site_minor = p.price_per_site_minor, price_currency = p.currency
  from billing_default_prices p
  where p.currency = o.currency and o.price_per_site_minor is null
  returning o.id, o.price_per_site_minor, o.price_currency
)
insert into audit_log (org_id, actor_type, action, entity, entity_id, diff)
select id, 'system', 'billing.price_set', 'org', id,
       jsonb_build_object('from', null,
                          'to', jsonb_build_object('minor', price_per_site_minor,
                                                   'currency', price_currency),
                          'via', 'migration', 'migration', '20261017000450')
from changed;

with changed as (
  update orgs
  set billing_provider = 'manual'
  where billing_provider_for_country(country) = 'manual'
    and coalesce(billing_provider, 'stripe') = 'stripe'
    and billing_subscription_id is null
  returning id
)
insert into audit_log (org_id, actor_type, action, entity, entity_id, diff)
select id, 'system', 'billing.provider_set', 'org', id,
       jsonb_build_object('from', 'stripe', 'to', 'manual', 'via', 'migration',
                          'migration', '20261017000450')
from changed;

-- 3. create_org(): provider and price from the pack ------------------------------------------------
create or replace function create_org(p_name text, p_timezone text default null,
                                      p_address text default null,
                                      p_license_no text default null, p_country text default 'US')
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_org orgs%rowtype; v_pack countries%rowtype; v_price billing_default_prices%rowtype;
begin
  if auth.uid() is null then raise exception 'not signed in' using errcode = '42501'; end if;
  if coalesce(trim(p_name), '') = '' then raise exception 'company name required'; end if;
  select * into v_pack from countries where code = upper(btrim(coalesce(p_country, 'US')));
  if not found then raise exception 'unknown country' using errcode = '22023'; end if;
  select * into v_price from billing_default_prices where currency = v_pack.currency;
  insert into orgs (name, country, locale, units, currency, timezone, address, license_no,
                    trial_ends_at, billing_provider, price_per_site_minor, price_currency)
  values (trim(p_name), v_pack.code, v_pack.default_locale, v_pack.units, v_pack.currency,
          coalesce(nullif(btrim(p_timezone), ''), v_pack.default_timezone),
          p_address, p_license_no, now() + interval '14 days',
          billing_provider_for_country(v_pack.code),
          v_price.price_per_site_minor, v_price.currency)
  returning * into v_org;
  insert into org_members (org_id, user_id, role, display_name)
  values (v_org.id, auth.uid(), 'admin', coalesce(auth.jwt() ->> 'email', 'Admin'));
  insert into audit_log (org_id, actor_type, actor_id, action, entity, entity_id, diff)
  values (v_org.id, 'user', auth.uid(), 'org.created', 'org', v_org.id,
          jsonb_build_object('country', v_org.country,
                             'billing_provider', v_org.billing_provider,
                             'price', case when v_org.price_per_site_minor is null then null
                                      else jsonb_build_object('minor', v_org.price_per_site_minor,
                                                              'currency', v_org.price_currency)
                                      end));
  return to_jsonb(v_org);
end $$;

-- 4. /ops: SiteLog staff's billing controls --------------------------------------------------------
create function ops_org_billing()
returns table (
  id uuid, name text, country text, is_demo boolean, billing_provider text, billing_status text,
  trial_ends_at timestamptz, has_subscription boolean, price_per_site_minor int,
  price_currency text, active_sites int
)
language plpgsql stable security definer set search_path = public as $$
begin
  if not is_platform_admin() then raise exception 'not allowed' using errcode = '42501'; end if;
  return query
    select o.id, o.name, o.country, o.is_demo, coalesce(o.billing_provider, 'stripe'),
           o.billing_status, o.trial_ends_at, o.billing_subscription_id is not null,
           o.price_per_site_minor, o.price_currency,
           (select count(*)::int from sites s where s.org_id = o.id and s.status = 'active')
    from orgs o
    order by o.is_demo, o.name;
end $$;

-- Null for both clears the price (the Billing page then says SiteLog sets it).
create function ops_set_org_price(p_org_id uuid, p_price_minor int, p_currency text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_old orgs%rowtype; v_currency text := upper(nullif(btrim(p_currency), ''));
begin
  if not is_platform_admin() then raise exception 'not allowed' using errcode = '42501'; end if;
  if (p_price_minor is null) <> (v_currency is null) then
    raise exception 'set the price and its currency together' using errcode = '22023';
  end if;
  if p_price_minor is not null and p_price_minor <= 0 then
    raise exception 'the price must be above zero' using errcode = '22023';
  end if;
  if v_currency is not null and v_currency !~ '^[A-Z]{3}$' then
    raise exception 'currency must be an ISO 4217 code' using errcode = '22023';
  end if;
  select * into v_old from orgs where orgs.id = p_org_id for update;
  if not found then raise exception 'org not found' using errcode = 'P0002'; end if;
  if v_old.price_per_site_minor is not distinct from p_price_minor
     and v_old.price_currency is not distinct from v_currency then
    return jsonb_build_object('id', p_org_id, 'changed', false);
  end if;
  update orgs set price_per_site_minor = p_price_minor, price_currency = v_currency
  where orgs.id = p_org_id;
  perform log_audit(p_org_id, 'user', auth.uid(), 'billing.price_set', 'org', p_org_id,
    jsonb_build_object(
      'from', case when v_old.price_per_site_minor is null then null
              else jsonb_build_object('minor', v_old.price_per_site_minor,
                                      'currency', v_old.price_currency) end,
      'to', case when p_price_minor is null then null
            else jsonb_build_object('minor', p_price_minor, 'currency', v_currency) end,
      'via', 'ops'));
  return jsonb_build_object('id', p_org_id, 'changed', true);
end $$;

create function ops_set_org_billing_status(p_org_id uuid, p_status text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_old orgs%rowtype;
begin
  if not is_platform_admin() then raise exception 'not allowed' using errcode = '42501'; end if;
  if p_status is null or p_status not in ('trialing', 'active', 'past_due', 'canceled', 'paused') then
    raise exception 'unknown billing status' using errcode = '22023';
  end if;
  select * into v_old from orgs where orgs.id = p_org_id for update;
  if not found then raise exception 'org not found' using errcode = 'P0002'; end if;
  if coalesce(v_old.billing_provider, 'stripe') <> 'manual' then
    raise exception 'a Stripe org''s status follows Stripe' using errcode = '22023';
  end if;
  if v_old.billing_status is not distinct from p_status then
    return jsonb_build_object('id', p_org_id, 'changed', false);
  end if;
  update orgs set billing_status = p_status where orgs.id = p_org_id;
  perform log_audit(p_org_id, 'user', auth.uid(), 'billing.status_changed', 'org', p_org_id,
    jsonb_build_object('from', v_old.billing_status, 'to', p_status, 'via', 'ops'));
  return jsonb_build_object('id', p_org_id, 'changed', true);
end $$;

revoke execute on function ops_org_billing(), ops_set_org_price(uuid, int, text),
  ops_set_org_billing_status(uuid, text) from public, anon;
grant execute on function ops_org_billing(), ops_set_org_price(uuid, int, text),
  ops_set_org_billing_status(uuid, text) to authenticated;

-- 5. The quantity sync retried by a job ------------------------------------------------------------
create function sites_billing_sync() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_org orgs%rowtype;
begin
  if tg_op = 'UPDATE' and new.status is not distinct from old.status then return null; end if;
  select * into v_org from orgs where id = new.org_id;
  if not found or v_org.is_demo or coalesce(v_org.billing_provider, 'stripe') <> 'stripe'
     or v_org.billing_subscription_id is null then
    return null;
  end if;
  perform enqueue_job('billing_sync', jsonb_build_object('orgId', new.org_id),
    now() + interval '2 minutes',
    'billing_sync:' || new.id || ':' || new.status || ':'
      || floor(extract(epoch from clock_timestamp()) * 1000)::bigint);
  return null;
end $$;
revoke execute on function sites_billing_sync() from public, anon, authenticated;

create trigger sites_billing_sync after insert or update of status on sites
  for each row execute function sites_billing_sync();
