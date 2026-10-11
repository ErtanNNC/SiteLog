-- SiteLog · Stripe webhook idempotency (supabase/functions/stripe-webhook).
-- One row per Stripe event id; `processed_at` is set once the event was applied, so a retried
-- delivery of an already-applied event is acknowledged without re-running its side effects.
-- Service role only: RLS enabled with no policies.

create table stripe_events (
  id text primary key,                            -- Stripe event id (evt_…)
  type text not null,                             -- e.g. invoice.paid
  received_at timestamptz not null default now(),
  processed_at timestamptz
);

alter table stripe_events enable row level security;

create index on stripe_events (received_at desc);
