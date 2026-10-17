# SiteLog Edge Functions

Deno 2 / TypeScript functions deployed to Supabase (spec §4.2, Appendix B). They share one Deno
config and import map, `deno.json`, which maps `@sitelog/shared` to `../../packages/shared/src`
so the webhook normaliser, reminder ladder, templates and `Database` type are the same code the
worker and the web panel use.

| Function                   | Auth                                              | Purpose                                                                                       |
| -------------------------- | ------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `whatsapp-webhook`         | Meta `X-Hub-Signature-256` (HMAC with app secret) | GET handshake; POST stores inbound messages + delivery statuses, enqueues `inbound_message`   |
| `scheduler-tick`           | `Authorization: Bearer $SCHEDULER_SECRET`         | Every 5 min via pg_cron: site-days, reminder ladder, missing alerts, weather, digest, cleanup |
| `stripe-webhook`           | `Stripe-Signature`                                | Mirrors Stripe into `orgs.billing_*`, idempotent per event (`stripe_events`)                  |
| `api-invite-reporter`      | Supabase JWT, org role admin/ops                  | Invite / re-send welcome / disable a reporter                                                 |
| `api-link-unknown-sender`  | Supabase JWT, admin/ops of the site's org         | Link or ignore an unknown number, re-process the held message                                 |
| `api-link-unknown-contact` | Supabase JWT, admin/ops of the site's org         | W1-16 (D38): link a caller or texter with F3 consent pending, or ignore; replaces the above   |
| `api-text-daily-link`      | Supabase JWT, admin/pm/ops of the site's org      | W1-16: "Text today's link": today's daily link to the site's reporter through the Notifier    |
| `api-export-payroll`       | Supabase JWT, any member role                     | `GET ?org&week&site` → payroll CSV                                                            |
| `api-evidence-pack`        | Supabase JWT, admin/pm/ops                        | Request an EOT evidence pack; fetch a 7-day signed download URL                               |
| `api-billing`              | Supabase JWT, admin                               | Stripe checkout / portal / quantity sync / pause & resume site / invoices / status            |
| `field-api`                | link code + `sl_dev_*` device cookie (no JWT)     | The field app's only backend (W1-07, spec §6.5, Appendix B): link, device, consent, uploads   |
| `field-api` `/voice/*`     | bearer `VOICE_AGENT_TOOL_SECRET` + `X-Call-Token` | W3-03: the voice agent's routes, server to server: call start, `get_context`, tools           |
| `field-api` `voice/token`  | link code + device cookie + consents              | W3-13: Talk now from the field app: the call row, its LiveKit room, the agent dispatch, token |
| `sms-webhook`              | `X-Twilio-Signature`; `/demo-reply`: JWT, admin   | Twilio inbound texts (§9.5 keywords, F13) and delivery status; the Demo phone's typed replies |
| `voice-events`             | LiveKit's webhook JWT (`LIVEKIT_API_SECRET`)      | W3-04: call rooms' events → `calls` status (never backwards); backstop on an unended call     |

Every function but `field-api` is `Deno.serve(withHandler(...))`: CORS preflight for the panel origin
(`APP_URL`), Zod-validated input, typed `createClient<AppDatabase>` (service role), JSON logs via
`console.log(JSON.stringify(...))`, and error mapping that never leaks internals. Decision logic
lives in `logic.ts` / `csv.ts` modules next to `*_test.ts` files; `index.ts` only does I/O.

`field-api` is a Hono app (GAP D6) mounted under `/field-api`: `app.ts` builds it from injected
dependencies (`FieldStore`, the code sender, the secret, the clock), `store_supabase.ts` is the
service-role store, `fake_store.ts` the in-memory one its Deno tests use, `logic.ts` the pure
decisions. `voice.ts` (W3-03) and `talk_now.ts` (W3-13, with its own store, the `LiveKitApi`
interface and `fake_talk_now.ts` for its tests) are mounted from `app.ts`; `voice_special.ts` (W3-14) from `voice.ts`. The field host proxies `/api/<route>` to it (D39, D43), so the device cookie stays
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
# İYS type of the TR texts (spec §19 Q49; W4-11): unset = informational, the recommendation;
# the worker reads the same variable, and its delivery-report poll is ILETIMERKEZI_STATUS (worker only)
# supabase secrets set ILETIMERKEZI_IYS=commercial   # only after counsel's answer and §19 Q281
# web push (W2-14): field-api serves the public key to the field app; the private key and the
# subject are the worker's only (never a functions secret). Unset: no Notifications toggle.
supabase secrets set VAPID_PUBLIC_KEY=B...
# voice agent (W3-03): field-api's /voice/* routes take VOICE_AGENT_TOOL_SECRET as the agent's
# bearer (the agent gets the same value); VOICE_CALL_TOKEN_SECRET signs the per-call tokens and is
# field-api's only (never the agent's, so it cannot mint the token of another call). Unset: the
# voice routes answer 500 "not configured", the field app's routes are unaffected.
supabase secrets set VOICE_AGENT_TOOL_SECRET=$(openssl rand -base64 32) \
  VOICE_CALL_TOKEN_SECRET=$(openssl rand -base64 32)
# voice-events (W3-04): LiveKit signs its webhooks with the project's API key and secret (the JWT's
# iss and HS256 key). Unset: voice-events answers 500 "not configured" and LiveKit retries.
supabase secrets set LIVEKIT_API_KEY=API... LIVEKIT_API_SECRET=...
# Optional (W3-09, §19 Q117): how long update_draft / record_answer wait for their worker turn
# before answering `pending`; default 12000, at most 15000.
# supabase secrets set VOICE_TOOL_WAIT_MS=12000
# Talk now (W3-13): with LIVEKIT_URL and the same key pair, field-api answers talkNow in resolve and
# today (for an org that is not billing-blocked, §19 Q121) and serves voice/token: it creates the
# room call-{callId} and dispatches LIVEKIT_AGENT_NAME (default sitelog-voice) through LiveKit's
# Twirp API with tokens it mints itself (talk_now.ts, WebCrypto, no SDK). Unset: talkNow false.
supabase secrets set LIVEKIT_URL=wss://<project>.livekit.cloud LIVEKIT_AGENT_NAME=sitelog-voice
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
supabase functions deploy voice-events     --no-verify-jwt   # LiveKit's webhook JWT (W3-04)

# panel API: gateway JWT check stays on; each function also resolves the user + org role
supabase functions deploy api-invite-reporter
supabase functions deploy api-link-unknown-sender   # until the demo, then deleted (D38)
supabase functions deploy api-link-unknown-contact
supabase functions deploy api-text-daily-link
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
  exactly `SMS_WEBHOOK_URL`, since the signature covers the URL. Add Twilio's connection
  overrides to the URL you register, `…/sms-webhook#rp=ct,rt,5xx&rc=3` (retry connection and
  read timeouts and a 5xx up to three times; Twilio's default `rp=ct` retries connection
  failures only, and the fragment is never sent, so the signature and `SMS_WEBHOOK_URL` stay
  as they are): the function stores the text, its audit and the worker's `sms_inbound` job in one
  transaction (`receive_sms_inbound()`), and the retries cover a failure before it commits. Delivery callbacks need nothing: each send names
  `{SMS_WEBHOOK_URL}/status`. Twilio's own STOP/HELP handling: spec §19 Q45 (when Twilio sends `OptOutType`, SiteLog records the change and sends no reply of its own; RUNBOOK §2).
- **LiveKit** (Cloud project → Settings → Webhooks, W3-16 with the owner's approval): URL
  `https://<project-ref>.supabase.co/functions/v1/voice-events`, signed with the project's API key
  (the same `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` as the function's secrets). A test delivery
  for a room that is not `call-{uuid}`, or an event the function does not act on, answers 200
  `{received: true, ignored: true}` (the signature passed); 401 `invalid_signature` means the key
  pair differs.
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
so the signed upload URLs field-api returns name that host, which no browser reaches. Set
`STORAGE_PUBLIC_URL` in `supabase/functions/.env` to the API URL as the browser reaches it
(`http://127.0.0.1:54321` on the same machine, which CI sets for the field app's `e2e:supabase`; a
second HTTPS tunnel to port 54321 for a phone) and field-api re-bases the signed URLs on it (W1-09).
Leave it unset on hosted projects, whose `SUPABASE_URL` is public. Not `SUPABASE_*`: the CLI skips
env names with that prefix. The stack test replaces the origin itself.

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
  creation on working days, every ladder stage firing exactly once (`planLadder` over a whole
  day), the guards, two orgs, multi-site reporters, quiet hours, both DST changes in
  America/Chicago and the fixed offset of Europe/Istanbul, paused reminders and the billing grace
  period;
  `api-export-payroll/csv_test.ts` covers CSV escaping and the payroll columns.

## Behaviour notes and assumptions

- **whatsapp-webhook** answers 200 for every request with a valid signature, including payloads it
  cannot parse. The one exception is a storage failure (database unreachable): it answers 500 so
  Meta redelivers, which is safe because `messages.wa_message_id` is unique and the job dedupe key
  is `inbound:<wa_message_id>`. Unknown numbers get a conversation with `org_id = null`; the worker
  creates the `unknown_contacts` row (no `channel`, D13) after transcription (§F11). A phone that exists in several orgs
  gets `context.candidate_reporter_ids` and no `org_id` (§19 #1).
- **scheduler-tick** runs the ladder (W2-06) only for site-days in `pending`/`reminded` on the
  org's working days (§7.1 has no `processing → missing` transition: a report in flight is never
  "missing"). Each stage is claimed by `claim_site_day_reminder()` with its audit and its `notify`
  jobs in one transaction (the status re-read under the row lock, no live report), so overlapping
  ticks and a racing filing cannot double-send or overwrite. Every reporter of the site in its
  org gets the stage (`site_reporters`, primary first; `remind()` skips an inactive one); each
  message carries the reporter's daily link (`ensureDailyLink`, so the tick needs
  `LINK_SIGNING_SECRET` and `FIELD_APP_URL`, as field-api does). With nobody to text the stage is
  still claimed (audited) and the office alert fires at the missing step. `?now=` sets the tick's
  clock only where `SCHEDULER_CLOCK_OVERRIDE=true` (the local stack and CI's e2e-supabase; never
  a hosted project); the worker that sends those jobs follows the same test clock with
  `WORKER_CLOCK_OVERRIDE` / `WORKER_CLOCK_START` (CI only, refused in production). The past_due grace
  period starts at the latest `billing.status_changed → past_due` audit row written by
  `stripe-webhook`; a past_due org without such a row is treated as still inside the grace period.
  The weekly digest covers the previous Mon–Sun week and is tracked per org in
  `scheduler_state['weekly_digest_runs']`; retention runs once per UTC day after 03:00
  (`scheduler_state['retention_cleanup']`); `scheduler_state['last_tick']` holds the last run and
  its counters. On this branch the ladder is stopped (W1-10); the tick still marks a day past its
  deadline plus the missing offset `missing`, and the update that does it is the claim for the
  office alert: one `missing_report` notice and one `report_missing` email
  (`email:report_missing:<site-day>`), worded without any reminder (spec §19 Q55).
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
- **api-link-unknown-contact** (W1-16, D38) replaces api-link-unknown-sender: the panel calls it
  from W1-16 on, and the old function is deleted after the demo. A caller or texter (`channel`
  `'sms'`/`'voice'`) becomes a reporter `invited` until F3 consent (`opted_out` when the phone sent
  STOP on the pack's sender), with the pack's locale from "Speaks", their personal link
  (`field_link.created`) and `send_welcome`; an existing invited or active reporter of the org keeps
  their status. A WhatsApp-era sender (`channel` null) keeps the old function's rule (active, the
  held message re-processed). Refused: a contact no longer pending (409), of another org (404) or
  of no org (409, an SMS from an unknown number, spec §19 Q44), and a number whose reporter opted
  out or is disabled (409). A held call recording is not re-processed until calls exist (week 2).
  The rules are `checkContactLink` in `logic.ts`. Ignore works for every channel.
- **api-text-daily-link** (W1-16, F17) texts a site's reporter (the primary one, else the first
  active one) today's daily link: `{ siteId, requestId }` from admin, pm or ops (spec §19 Q69). The
  link is the reporter's live daily `field_links` row for the site and today's date in the site's
  time zone, else a new one expiring after `DAILY_LINK_TTL_HOURS` (default 72), its code derived
  under `LINK_SIGNING_SECRET` (`ensureDailyLink`), so a second tap texts the same link. The text is
  §9.2 `daily_link` through the Notifier (consent, opt-out, the pack's channels and sender; the
  `console` driver for demo orgs), with `office_daily_link:<requestId>` as its dedupe key, so a
  retried request texts once. Audited `field_link.created` and `daily_link.texted` (with the
  outcome). The answer is `{ sent, channel | reason, detail }` and never holds the code. The flow
  is `textDailyLink` in `app.ts`, on an injected store (`store_supabase.ts`).
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
- **field-api `/voice/*`** (W3-03, `voice.ts`; spec §6.5, §9.4, Appendix B "field-api voice
  routes"). Server to server: every route needs `Authorization: Bearer VOICE_AGENT_TOOL_SECRET`
  (constant-time) and refuses any browser `Origin`; every tool and the recording route also need
  `X-Call-Token` = `deriveCallToken(VOICE_CALL_TOKEN_SECRET, callId)` for the call the body names
  (checked before the call is read; nothing stored), 60 calls a minute per call. `calls/start`
  (`voice_call_start()`) finds a SIP caller by `from` in the real orgs of the pack whose
  `voice_number` is `to` (§19 Q44; `countries_voice_number_key`), or starts the Talk now / outbound
  row its `callId` names; it answers the first name, the locale and the token, never a number. The
  tools act on the call's reporter and sites only (403 `out_of_scope`); an unknown caller's call
  has `end_call` only (403 `unknown_caller`, F13). Served now: `get_context` (sites with today's
  status and deadline, companies, `buildKeyterms` with the caller's own terms, §19 Q143; the
  consents and wording versions), `pick_site` (F14; a number in two orgs moves the call to that
  site's reporter), `set_preference` (audited as the reporter, `channel: voice`; `noCallsToday`
  from W3-14), `load_report` (F10, 14 days, code's totals in the summary),
  `start_fallback_recording`, `end_call` (one `post_call_reconcile` job, `post_call:<call>`) and
  `calls/:id/recording` (a signed upload to `calls/{org}/{call}.ogg`, until an hour after the end;
  needs the `recording` consent). A write with `X-Request-Id` runs once per call
  (`voice_tool_requests`): the agent's retry gets the kept 2xx answer (`Idempotent-Replay: true`);
  the model-backed tools (W3-09 … W3-14, `file_report` among them) use the same `once()`.
  W3-09: `update_draft` and `record_answer` are live turns (§19 Q117): `voice_turn_submit()`
  (the day's report created or merged with the call as a source, the reporter's lane as the
  call's live transcript, a priority `voice_turn` job; the same words are the same turn) and a
  wait of `VOICE_TOOL_WAIT_MS` (default 12 s, at most 15 s) for the worker's answer, checked
  against the contract; past it 202 `{status: pending}` (the agent says a line and asks again with
  the same words). Refusals: 403 `consent_required` (the `recording` and `data_processing`
  consents), 409 `site_required` (F14 first), `report_closed`, `question_closed`; a turn the worker
  failed 503 `turn_failed` (the agent's retry runs it again). A retry whose first copy still runs
  waits for its answer instead of 409 (§19 Q151).
  W3-10: `apply_correction` is a third live turn (the change applied to the call's draft at once,
  its read-back alone answered; 409 `draft_required` before the call's first draft, 400
  `not_available` for another report until W3-14). `file_report` files only when `isCallConfirm`
  reads the verbatim words as a whole §9.5 confirm and the revision is the one read back
  (`voice_file_report()`, 20261016000350: one `file_report` job per revision, `via 'voice'`,
  audited with the words); otherwise `not_confirmed` or `draft_changed` with the draft read back
  again. The route waits for the worker's filing (`VOICE_TOOL_WAIT_MS`): `filed`, or 202
  `pending`; asked again it finds the same filing, and after it every request answers `filed`.
  W3-14 (`voice_special.ts`, its own `VoiceSpecialStore` on the RPCs of 20261016000370, mounted
  by `voice.ts` with its helpers; `fake_voice_special.ts` for the Deno tests): `set_day_status`
  in two steps (code's read-back with the lost hours and a `confirmKey`, then the reporter's
  verbatim yes → `voice_report_day_off()`; §19 Q79's `report_in_progress`), `apply_correction`
  with a `reportId` from `load_report` (F10: W2-11's preview citing the call seconds, read back
  with "Save it?") and `save_change` (version n+1 via `voice` after the yes), `noCallsToday`
  (`reporters.no_calls_until`, §19 Q129), `schedule_callback` (400 `not_available` until W3-17),
  `record_consent` (§19 Q120, `callYesNo`; a no refuses and deletes the recording and texts the
  daily link only with an earlier `sms` consent) and, for an unknown caller (F13, §19 Q124),
  `leave_message` (a 160-character snippet on `unknown_contacts`), the recording ≤ 60 s at
  `calls/unknown/{call}.ogg` and `calls/start`'s `locale`.
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
  `field_report_day_off()` (W2-08: `day-status` sets the site-day and, for a weather day or a
  no-work day with `no_work_pdf`, makes the report from the answers and queues its filing;
  `field_set_day_status()` before it), `field_answer_question_voice()` (W2-09: F7 _Other…_, a
  completed answer clip of the open question, `uploads.question_id`, handed to the worker's
  `parse_answer`; the clip completes onto the question's report as no report material),
  `field_request_correction()`, `field_apply_correction()` and `field_edit_draft()` (W2-10: F8
  _Fix by voice_ and the steppers; a completed correction clip of the draft,
  `uploads.correction_report_id`, or typed words, handed to the worker's `apply_correction`, whose
  preview **Save change** writes at the draft revision it was made from, else 409
  `draft_changed`; a stepper's crew line built in code with `applyCrewEdit`, citing
  `reporter_edit`), `field_request_filed_correction()` and `field_save_filed_correction()`
  (W2-11: F10 _Change something_; the same correction routes on a filed report of the last 14
  days, 409 `report_locked` older; **Save change** makes version n+1 with the change note code
  writes from the preview's lines, then `render_pdf` queues the "Updated" email and
  `edit_applied`), the
  test recording's `field_test_clip_create()`, `field_test_clip_complete()` and
  `field_test_clip_read()` (W2-13: F4's 20-second test outside any report, `test_clips`; the
  snippet answered once, then deleted), web push's `field_push_subscribe()` and
  `field_push_unsubscribe()` (W2-14: Settings' _Notifications_; `push/key` answers
  `VAPID_PUBLIC_KEY`, or null without one or on a pack without push; `push/subscribe` stores the
  browser's subscription and the `push` consent; `push/unsubscribe` and `device/sign-out` revoke
  the phone's subscriptions, the former also the consent with the last one) and
  `field_rate_limit()` (30 a minute per device, 5 code sends and 5 checks an hour per phone). `uploads/:id/complete` checks the stored object's type and size
  (Storage's object info) before it attaches it. Refusals are JSON `{error: <code>}` from
  `packages/shared/src/field-contract.ts`.
- **sms-webhook** (W1-08). `POST /` (or `/inbound`): a Twilio inbound text, signed over
  `SMS_WEBHOOK_URL` (403 otherwise); the pack is the one whose `sms_sender_id` is the `To` (none:
  logged and ignored). The row is stored once per `MessageSid` (real orgs only: a real sender
  never reaches a demo org's reporter) and handed to the worker as an `sms_inbound` job with
  that id as its dedupe key; the answer is empty TwiML. The worker runs the keyword plan
  (`packages/shared/src/sms/inbound.ts` over `keywords.ts`, spec §9.5): reporter changes audited
  as the reporter, the phone's own opt-out in `sms_opt_outs`, the office notice of a STOP
  (§13), at most one reply through the Notifier (`help`, `stop_confirm`, `unknown_number`,
  `pref_call_ok`, `pref_text_ok`; none when Twilio sent `OptOutType`, spec §19 Q45, Q46), then
  the row marked handled, so a late redelivery runs nothing. `POST /status`: Twilio's delivery
  callback moves `messages.status` forward only; a `welcome` that ends `undelivered` or `failed`
  sets the still-invited reporter's `last_invite_error` (Team: "Can't reach this number"),
  notifies the office and is audited. `POST /demo-reply` `{reporterId, body}`: the Demo phone
  types a text as a reporter of a demo org (admin JWT; 409 on a one-way pack or a disabled
  reporter), handled inline on a `console` row inside the caller's org only, and never recording
  the phone in `sms_opt_outs`.
- **stripe-webhook** maps Stripe statuses as trialing→trialing, active→active,
  past_due/unpaid/incomplete→past_due, canceled/incomplete_expired→canceled, paused→paused; an
  unknown status leaves `billing_status` untouched. `invoice.paid` only promotes to `active` when the
  org was past_due or the invoice amount is > 0 ($0 trial invoices do not end a trial).
