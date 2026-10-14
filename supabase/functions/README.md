# SiteLog Edge Functions

Deno 2 / TypeScript functions deployed to Supabase (spec §4.2, Appendix B). They share one Deno
config and import map, `deno.json`, which maps `@sitelog/shared` to `../../packages/shared/src`
so the webhook normaliser, reminder ladder, templates and `Database` type are the same code the
worker and the web panel use.

| Function                  | Auth                                              | Purpose                                                                                       |
| ------------------------- | ------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `whatsapp-webhook`        | Meta `X-Hub-Signature-256` (HMAC with app secret) | GET handshake; POST stores inbound messages + delivery statuses, enqueues `inbound_message`   |
| `scheduler-tick`          | `Authorization: Bearer $SCHEDULER_SECRET`         | Every 5 min via pg_cron: site-days, reminder ladder, missing alerts, weather, digest, cleanup |
| `stripe-webhook`          | `Stripe-Signature`                                | Mirrors Stripe into `orgs.billing_*`, idempotent per event (`stripe_events`)                  |
| `api-invite-reporter`     | Supabase JWT, org role admin/ops                  | Invite / re-send welcome / disable a reporter                                                 |
| `api-link-unknown-sender` | Supabase JWT, admin/ops of the site's org         | Link or ignore an unknown number, re-process the held message                                 |
| `api-export-payroll`      | Supabase JWT, any member role                     | `GET ?org&week&site` → payroll CSV                                                            |
| `api-evidence-pack`       | Supabase JWT, admin/pm/ops                        | Request an EOT evidence pack; fetch a 7-day signed download URL                               |
| `api-billing`             | Supabase JWT, admin                               | Stripe checkout / portal / quantity sync / pause & resume site / invoices / status            |
| `field-api`               | link code + `sl_dev_*` device cookie (no JWT)     | The field app's only backend (W1-07, spec §6.5, Appendix B): link, device, consent, uploads   |
| `sms-webhook`             | `X-Twilio-Signature`; `/demo-reply`: JWT, admin   | Twilio inbound texts (§9.5 keywords, F13) and delivery status; the Demo phone's typed replies |

Every function but `field-api` is `Deno.serve(withHandler(...))`: CORS preflight for the panel origin
(`APP_URL`), Zod-validated input, typed `createClient<AppDatabase>` (service role), JSON logs via
`console.log(JSON.stringify(...))`, and error mapping that never leaks internals. Decision logic
lives in `logic.ts` / `csv.ts` modules next to `*_test.ts` files; `index.ts` only does I/O.

`field-api` is a Hono app (GAP D6) mounted under `/field-api`: `app.ts` builds it from injected
dependencies (`FieldStore`, the code sender, the secret, the clock), `store_supabase.ts` is the
service-role store, `fake_store.ts` the in-memory one its Deno tests use, `logic.ts` the pure
decisions. The field host proxies `/api/<route>` to it (D39, D43), so the device cookie stays
first-party and there is no CORS: a browser `Origin` must be `FIELD_APP_URL` or one of
`CORS_EXTRA_ORIGINS`. Every answer is `Cache-Control: no-store`.

## Layout

```
supabase/
├─ config.toml                 # CLI config: verify_jwt per function, shared import_map
├─ functions/
│  ├─ deno.json                # import map + compilerOptions + lint/fmt (all functions)
│  ├─ _shared/                 # env, log, http (CORS/errors), supabase (typed clients),
│  │                           # auth (requireUser / requireOrgRole), jobs (enqueue_job),
│  │                           # audit (log_audit), notify (notify_org), billing, conversations
│  ├─ <function>/index.ts      # Deno.serve entrypoint
│  ├─ <function>/logic.ts      # pure, tested decisions
│  └─ <function>/*_test.ts     # Deno.test
└─ migrations/20261011000007_stripe_events.sql   # webhook idempotency table (RLS, no policies)
```

## Secrets

`SUPABASE_URL`, `SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY` are injected by the platform.
Set everything else once per project (names from spec §5.1 and `.env.example`):

```bash
supabase secrets set \
  APP_URL=https://app.sitelog.app \
  WA_APP_SECRET=... \
  WA_VERIFY_TOKEN=... \
  SCHEDULER_SECRET=... \
  STRIPE_SECRET_KEY=sk_live_... \
  STRIPE_WEBHOOK_SECRET=whsec_... \
  STRIPE_PRICE_ID_SITE_US=price_...   # api-billing falls back to the old STRIPE_PRICE_ID_SITE
# optional: extra browser origins allowed by CORS (comma-separated), e.g. a preview deployment;
# field-api also accepts them as the Origin of the field app (a field preview)
supabase secrets set CORS_EXTRA_ORIGINS=https://preview.sitelog.app
# field-api: the HMAC key of the device codes, and the field app's origin; also the key the
# personal link codes are derived with (api-invite-reporter, sms-webhook and the worker use the
# same value)
supabase secrets set LINK_SIGNING_SECRET=$(openssl rand -hex 32) FIELD_APP_URL=https://go.sitelog.app
# SMS (W1-08): sms-webhook checks X-Twilio-Signature with TWILIO_AUTH_TOKEN against SMS_WEBHOOK_URL
# (default {SUPABASE_URL}/functions/v1/sms-webhook, which must be the URL Twilio posts to). The
# drivers need credentials only for packs whose sender id is set (`pnpm countries:set`).
supabase secrets set TWILIO_ACCOUNT_SID=AC... TWILIO_AUTH_TOKEN=... \
  SMS_WEBHOOK_URL=https://<project-ref>.supabase.co/functions/v1/sms-webhook
# only for a pack whose sms_provider is iletimerkezi (TR) and whose sender id is set
supabase secrets set ILETIMERKEZI_API_KEY=... ILETIMERKEZI_API_HASH=...
```

Local development reads the same names from `supabase/functions/.env` (`supabase functions serve
--env-file supabase/functions/.env`); never commit that file.

### Vault secrets for pg_cron (migration 0006)

The cron job in `20261011000006_platform.sql` posts to `scheduler-tick` every 5 minutes and reads
the URL and the bearer secret from Vault. Run once per project (SQL editor):

```sql
select vault.create_secret('https://<project-ref>.supabase.co/functions/v1/scheduler-tick', 'scheduler_tick_url');
select vault.create_secret('<the same value as the SCHEDULER_SECRET function secret>', 'scheduler_secret');
```

## Deploy

Deploy from the **repository root** so the bundler can follow the import map into
`packages/shared` (the paths in `deno.json` are relative to `supabase/functions`).

```bash
# database first (adds stripe_events + the pg_cron job)
supabase db push

# public endpoints: no gateway JWT check, they verify their own signatures / secret
supabase functions deploy whatsapp-webhook --no-verify-jwt
supabase functions deploy stripe-webhook   --no-verify-jwt
supabase functions deploy scheduler-tick   --no-verify-jwt
supabase functions deploy field-api        --no-verify-jwt   # link code + device cookie
supabase functions deploy sms-webhook      --no-verify-jwt   # Twilio signature; /demo-reply checks the JWT itself

# panel API: gateway JWT check stays on; each function also resolves the user + org role
supabase functions deploy api-invite-reporter
supabase functions deploy api-link-unknown-sender
supabase functions deploy api-export-payroll
supabase functions deploy api-evidence-pack
supabase functions deploy api-billing
supabase functions deploy api-invite-office-user

# or everything at once (config.toml carries verify_jwt / import_map per function)
supabase functions deploy
```

`config.toml` sets `verify_jwt = false` and `import_map = "./functions/deno.json"` for every
function, so a plain `supabase functions deploy` is equivalent to the explicit flags above. The
CLI accepts a `deno.json` wherever it accepts an `import_map.json` (it reads the `imports` key).

### External endpoints to register

- **Meta** (App dashboard → WhatsApp → Configuration): callback URL
  `https://<project-ref>.supabase.co/functions/v1/whatsapp-webhook`, verify token =
  `WA_VERIFY_TOKEN`, subscribe to the `messages` field (spec §9.1).
- **Stripe** (Developers → Webhooks): endpoint
  `https://<project-ref>.supabase.co/functions/v1/stripe-webhook` with events
  `checkout.session.completed`, `customer.subscription.created|updated|deleted`,
  `invoice.payment_failed`, `invoice.paid`; copy the signing secret into
  `STRIPE_WEBHOOK_SECRET`. Pin the endpoint's API version to the SDK's
  (`stripe@23` → `2026-09-30.endive`) so event payload shapes match the types.
- **Twilio** (the US pack's sender, once approved and set with `pnpm countries:set`): the number's
  (or Messaging Service's) incoming-message webhook `POST https://<project-ref>.supabase.co/functions/v1/sms-webhook`,
  exactly `SMS_WEBHOOK_URL`, since the signature covers the URL. Delivery callbacks need nothing:
  each send names `{SMS_WEBHOOK_URL}/status`. Twilio's own STOP/HELP handling: spec §19 Q45.
- **pg_cron**: nothing to register; the Vault secrets above are enough.

## Local testing

```bash
supabase start                                   # local stack (Docker)
supabase db reset                                # migrations + seed
supabase functions serve --env-file supabase/functions/.env --no-verify-jwt

# handshake
curl "http://127.0.0.1:54321/functions/v1/whatsapp-webhook?hub.mode=subscribe&hub.verify_token=$WA_VERIFY_TOKEN&hub.challenge=42"

# signed inbound payload (the replay script in scripts/ signs fixtures the same way)
BODY='{"object":"whatsapp_business_account","entry":[]}'
SIG=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$WA_APP_SECRET" | sed 's/^.* //')
curl -X POST http://127.0.0.1:54321/functions/v1/whatsapp-webhook \
  -H "Content-Type: application/json" -H "X-Hub-Signature-256: sha256=$SIG" -d "$BODY"

# one scheduler tick
curl -X POST http://127.0.0.1:54321/functions/v1/scheduler-tick -H "Authorization: Bearer $SCHEDULER_SECRET"

# Stripe events
stripe listen --forward-to http://127.0.0.1:54321/functions/v1/stripe-webhook

# field-api: resolve a link (the demo seed's codes come from demoLinkCode(), packages/shared/src/demo/ids.ts)
curl -i -X POST http://127.0.0.1:54321/functions/v1/field-api/resolve \
  -H 'content-type: application/json' -d '{"code":"K7Q2MX"}'
# the field-api suite of test:stack (the RPC race needs only the database)
SUPABASE_DB_URL=... FIELD_API_URL=http://127.0.0.1:54321/functions/v1/field-api pnpm test:stack
```

Inside the local Edge Runtime `SUPABASE_URL` is the gateway's internal address (`http://kong:8000`),
so the signed upload URLs field-api returns name that host: replace the origin with the stack's API
URL to use one from the host machine (the stack test does).

Testing the field app on a phone against the local stack: use an HTTPS tunnel to the field app's
dev or preview server, not a LAN address. The device cookie is `Secure`, so a plain-http
`http://192.168.x.x:5174` page never keeps it and the device check loops. field-api reads its
allowed `Origin` from `supabase/functions/.env`, not from the root `.env`: put the tunnel URL in
`FIELD_APP_URL` (or `CORS_EXTRA_ORIGINS`) there too and restart `supabase functions serve`, or
every POST answers 403 `origin_not_allowed`. The device code of a demo org appears as a console
text in the Demo phone (`messages`); a real org gets one only once its pack's sender id is set
(spec §19 Q48).

sms-webhook locally: put any `TWILIO_AUTH_TOKEN` and `SMS_WEBHOOK_URL=http://127.0.0.1:54321/functions/v1/sms-webhook`
in `supabase/functions/.env`, then replay a fixture (`fixtures/sms/README.md`; the `To` must be a
pack's sender id in that database, or the text is ignored):

```bash
pnpm replay-webhook -- --sms-url http://127.0.0.1:54321/functions/v1/sms-webhook --token <token> \
  --to +18885550142 fixtures/sms/inbound-help.json
```

## Type-check, lint and tests (what CI runs)

```bash
deno lint supabase/functions
deno check --config supabase/functions/deno.json supabase/functions/*/index.ts
deno test  --config supabase/functions/deno.json --allow-env --allow-net supabase/functions
pnpm format:check        # prettier also covers supabase/functions
```

Notes:

- `deno.lock` next to `deno.json` pins the npm/jsr dependencies; commit it.
- Deno ≥ 2.6 refuses npm versions published less than 24 h ago (minimum dependency age). If a
  freshly pinned version trips it, add `--minimum-dependency-age 0` to the command or wait a day.
- Tests are pure (no network, no database): `scheduler-tick/logic_test.ts` covers site-day
  creation on working days, every ladder stage firing exactly once, the DST fall-back on
  Nov 1 2026 (America/Chicago), paused reminders and the billing grace period;
  `api-export-payroll/csv_test.ts` covers CSV escaping and the payroll columns.

## Behaviour notes and assumptions

- **whatsapp-webhook** answers 200 for every request with a valid signature, including payloads it
  cannot parse. The one exception is a storage failure (database unreachable): it answers 500 so
  Meta redelivers, which is safe because `messages.wa_message_id` is unique and the job dedupe key
  is `inbound:<wa_message_id>`. Unknown numbers get a conversation with `org_id = null`; the worker
  creates the `unknown_contacts` row (no `channel`, D13) after transcription (§F11). A phone that exists in several orgs
  gets `context.candidate_reporter_ids` and no `org_id` (§19 #1).
- **scheduler-tick** runs the ladder only for site-days in `pending`/`reminded` (§7.1 has no
  `processing → missing` transition: a report in flight is never "missing"). Stages are claimed
  with `update … where reminder_stage < stage`, so overlapping ticks cannot double-send. Reminders
  go to the primary **active** reporter's conversation (fallback: any active linked reporter);
  with nobody active the stage is left alone and only the office alert fires. The past_due grace
  period starts at the latest `billing.status_changed → past_due` audit row written by
  `stripe-webhook`; a past_due org without such a row is treated as still inside the grace period.
  The weekly digest covers the previous Mon–Sun week and is tracked per org in
  `scheduler_state['weekly_digest_runs']`; retention runs once per UTC day after 03:00
  (`scheduler_state['retention_cleanup']`); `scheduler_state['last_tick']` holds the last run and
  its counters.
- **api-invite-reporter** always enqueues `send_welcome` (also when an existing reporter is linked
  to another site). The worker should treat a welcome for an already-active reporter as
  informational and not reset the conversation. A re-send is allowed once, 48 h after `invited_at`
  (which the worker sets when the template was actually sent); the count comes from
  `reporter.reinvited` audit rows.
- **api-link-unknown-sender** reads `unknown_contacts` (the function keeps its name until W1-16's
  `api-link-unknown-contact`, D38) and links WhatsApp senders only (`channel` null): it creates the
  reporter as `active` (the number already wrote to us), enqueues `inbound_message` for the held
  WhatsApp message (`reprocess:<unknown_contact_id>`) and then `send_welcome`. A contact from a
  text or a call (`channel 'sms'`/`'voice'`) gets 409, because it becomes active only after F3
  consent (W1-16), and so does a number whose reporter opted out (STOP; only START reactivates
  it). The rules are `checkLink` in `logic.ts`. Ignore works for every channel.
- **api-export-payroll** exports the whole ISO week (Mon–Sun) from `current_manpower`; with
  `include_unconfirmed_in_payroll = false` rows of unconfirmed or unknown companies are dropped.
  Column order is exactly `date,site,project_code,company,trade,workers,hours,report_no,version`.
- **api-billing** omits `apiVersion` (the SDK's pinned version is used) and reads
  `current_period_end` from the subscription item (API ≥ 2025-03-31) with a fallback to the
  subscription. Quantity decreases use `proration_behavior: 'none'` (paused sites stop being billed
  from the next cycle, §19 #5); increases are prorated. Checkout requires at least one site and
  grants the 14-day trial only while `orgs.trial_ends_at` is null.
- **api-invite-office-user** uses `auth.admin.inviteUserByEmail` (Supabase sends the invite email,
  redirect `APP_URL/auth/callback`, user metadata `invited_org_id`/`invited_role`) and writes the
  `org_members` row up front so the membership exists on first sign-in. For an email that already
  has an account no invite can be sent; the membership is added and the user signs in with their
  usual magic link (`emailSent: false` in the response).
- **field-api** (W1-07). `resolve` takes the link code in its body, every other route in the
  `X-Link-Code` header; a new device gets the reporter's cookie `sl_dev_<8 hex>` (one per
  reporter; httpOnly, Secure, SameSite=Lax, Path=/, 180 days) from `device/send-code`, and
  `device/verify` marks it verified; field-api counts the 180 days from `verified_at` too. The
  one-time code is stored only as an HMAC under `LINK_SIGNING_SECRET` (`field_devices.code_hash`,
  10 min). It goes through the Notifier (W1-08, `code_sender.ts`): by SMS on the pack's driver, or
  as a `console` text (a `messages` row the Demo phone shows) on demo orgs; a real org on
  `console` gets none (409 `code_undeliverable`). Every query is scoped to the link's reporter and sites (a daily
  link: its site); the writes that must be atomic are the service-only RPCs
  `field_complete_upload()` (numbers and inserts the site-day's report in one transaction,
  enqueues `transcribe_upload`, refuses while the report is being filed), `field_confirm_report()`
  (enqueues `file_report` for the confirmed version under the same site-day lock),
  `field_set_day_status()` and `field_rate_limit()` (30 a minute per device, 5 code sends and 5
  checks an hour per phone). `uploads/:id/complete` checks the stored object's type and size
  (Storage's object info) before it attaches it. Refusals are JSON `{error: <code>}` from
  `packages/shared/src/field-contract.ts`.
- **sms-webhook** (W1-08). `POST /` (or `/inbound`): a Twilio inbound text, signed over
  `SMS_WEBHOOK_URL` (403 otherwise); the pack is the one whose `sms_sender_id` is the `To` (none:
  logged and ignored). The row is stored once per `MessageSid`; on a two-way pack the keyword plan
  (`packages/shared/src/sms/keywords.ts`, spec §9.5) runs inline: reporter changes audited as the
  reporter, at most one reply through the Notifier (`help`, `stop_confirm`, `unknown_number`),
  then the row is marked handled, so a Twilio retry re-runs only unhandled work; the answer is
  empty TwiML. `POST /status`: Twilio's delivery callback moves `messages.status` forward only.
  `POST /demo-reply` `{reporterId, body}`: the Demo phone types a text as a reporter of a demo org
  (admin JWT; 409 on a one-way pack or a disabled reporter), handled like an inbound text on a
  `console` row.
- **stripe-webhook** maps Stripe statuses as trialing→trialing, active→active,
  past_due/unpaid/incomplete→past_due, canceled/incomplete_expired→canceled, paused→paused; an
  unknown status leaves `billing_status` untouched. `invoice.paid` only promotes to `active` when the
  org was past_due or the invoice amount is > 0 ($0 trial invoices do not end a trial).
