# SiteLog runbook

Operational guide for staging and production. The product spec is `SITELOG_SPEC.md`.

## 1. Environments

| Piece                                   | Where                                                          | Notes                                                                                             |
| --------------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Postgres, Auth, Storage, Edge Functions | Supabase (staging, preview and prod projects)                  | migrations in `supabase/migrations`, functions in `supabase/functions`                            |
| Worker                                  | Fly.io / Render / Railway container                            | `apps/worker/Dockerfile`; needs ffmpeg (in the image)                                             |
| Web panel                               | Vercel / Netlify static                                        | `apps/web`, `VITE_*` env vars                                                                     |
| Field app                               | Netlify static, its own site (GAP D42)                         | `apps/field`; `/api/*` → `field-api` by a build-generated `_redirects`                            |
| WhatsApp (v1.0)                         | Meta Cloud API                                                 | one shared SiteLog number (§19 #1); retired at GAP step 22                                        |
| Messages (v1.2)                         | Twilio (SMS; WhatsApp from week 2), İletimerkezi (TR pack SMS) | provider, sender, two-way SMS and links per country pack (`countries`, below); credentials in env |
| AI                                      | OpenAI (transcription), Anthropic (extraction)                 | model names are env vars                                                                          |
| Weather                                 | Open-Meteo Standard (commercial)                               | `WEATHER_API_BASE`, `WEATHER_API_KEY`                                                             |
| Email                                   | Resend                                                         | `RESEND_API_KEY`, `EMAIL_FROM`                                                                    |
| Billing                                 | Stripe                                                         | per-site subscription quantity                                                                    |
| Monitoring                              | Sentry (web + worker), Supabase logs, worker `/health`         |                                                                                                   |

## 2. First deployment

1. **Supabase project**: create it, note `SUPABASE_URL`, anon and service-role keys, the DB connection string (`SUPABASE_DB_URL`).
2. **Schema**: `supabase link --project-ref <ref>` then `supabase db push`. The migrations enable RLS everywhere, create the job-queue functions and (when the extensions exist) storage buckets, realtime publication and the pg_cron schedule. On an existing project, push `20261012000001_web_gaps.sql` **before** redeploying `api-export-payroll` (it reads the new `org_settings.payroll_columns`); the same migration adds the `update_reporter` / `set_org_logo` RPCs, an `org_settings` audit trigger and the "admins update logos" / "admins delete logos" storage policies that logo re-uploads need.
3. **Vault secrets for pg_cron** (SQL editor):
   ```sql
   select vault.create_secret('https://<ref>.supabase.co/functions/v1/scheduler-tick', 'scheduler_tick_url');
   select vault.create_secret('<SCHEDULER_SECRET>', 'scheduler_secret');
   ```
   Re-run migration `20261011000006_platform.sql` (or the `cron.schedule` block in it) after the secrets exist.
4. **Edge functions**: `supabase secrets set` for every variable in `.env.example` that functions use (`WA_*`, `SCHEDULER_SECRET`, `STRIPE_*`, `APP_URL`), then `supabase functions deploy whatsapp-webhook --no-verify-jwt`, `scheduler-tick --no-verify-jwt`, `stripe-webhook --no-verify-jwt`, and the `api-*` functions (JWT verified). Details in `supabase/functions/README.md`.
5. **Auth**: enable email magic links; set the site URL to `APP_URL` and add `APP_URL/auth/callback` to redirect URLs; the magic-link and invite email templates as in "Auth email templates (W4-09)" below.
6. **Meta** (§9.1 checklist): verified business, WABA, number registered for Cloud API, display name "SiteLog", profile photo (`apps/web/public/brand/logo-avatar-circle.svg` exported to PNG), system-user token in `WA_ACCESS_TOKEN`, webhook URL `https://<ref>.supabase.co/functions/v1/whatsapp-webhook` with `WA_VERIFY_TOKEN`, subscribed field `messages`. Submit the six templates in §9.2 as **Utility / en** and wait for approval before inviting reporters.
7. **Worker**: set the env vars from `.env.example`, deploy the container, check `GET /health` returns `{ ok: true, listening: true }` and that `jobs` rows move from `queued` to `done`. The worker LISTENs for `NOTIFY jobs` (W1-10) on its own session connection: `SUPABASE_DB_LISTEN_URL`, or `SUPABASE_DB_URL` when that is empty. A transaction pooler (Supavisor, port 6543) delivers no notifications, so when `SUPABASE_DB_URL` is the transaction pooler set `SUPABASE_DB_LISTEN_URL` to the direct connection or the session pooler (port 5432); the worker logs a warning when the LISTEN URL has port 6543. Without notifications (`listening: false`) it still finds every job by polling every `POLL_INTERVAL_MS` (5 s). Transcription (W1-11): `DEEPGRAM_API_KEY` with `TRANSCRIBE_PROVIDER=deepgram` and `TRANSCRIBE_MODEL=nova-3` (`apps/worker/fly.toml`); in production a missing key never falls back to the fake, every `transcribe_upload` fails (and retries, then `processing_failed` to the office) until it is set. The v1.0 WhatsApp voice notes still use `OPENAI_API_KEY` (whisper-1) until step 22.
8. **Web**: deploy with `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `VITE_APP_URL`, `VITE_WA_DISPLAY_NUMBER`, `VITE_SENTRY_DSN`.
9. **Stripe**: create the $399/month per-unit price (`STRIPE_PRICE_ID_SITE_US`; `api-billing` still reads the old `STRIPE_PRICE_ID_SITE` while the new one is unset, GAP 9.1: set the new secret, deploy, then unset the old), a webhook endpoint pointing at `stripe-webhook` with the events listed in `supabase/functions/README.md`, and the customer portal configuration. W4-10: the price shown and billed is the org's own (`orgs.price_per_site_minor` + `price_currency`, preset by `create_org()` from the `billing_default_prices` table, USD 39900; SiteLog staff change it on `/ops` → _Billing per organisation_, audited). Checkout reads the Stripe price of the org's currency (`STRIPE_PRICE_ID_SITE_<CURRENCY>`, USD `STRIPE_PRICE_ID_SITE_US`) and refuses (409 `price_mismatch`) when its amount differs from the org's, so a pilot price needs its own Stripe price and is set up by SiteLog (spec §19 Q270). Give the worker the same `STRIPE_SECRET_KEY` (Fly secret): its `billing_sync` job retries a quantity sync the panel's call missed. A TR org is billed `manual` (§19 Q236): no Stripe at all; SiteLog invoices it and sets its status on `/ops`.
10. **Smoke test**: `pnpm replay-webhook -- --url https://<ref>.supabase.co/functions/v1/whatsapp-webhook --secret $WA_APP_SECRET fixtures/webhooks/audio-note.json` → a `messages` row and an `inbound_message` job appear; the worker replies on the test phone.

### Automated deploys (`.github/workflows/deploy.yml`)

Order per run: `supabase db push` → `supabase functions deploy` (settings from `supabase/config.toml`) → worker (Fly.io), web panel and field app (two Netlify sites) in parallel. Deploys are manual runs (Actions → Deploy → Run workflow: branch, environment, target). A first `plan` job decides what each run may touch and writes it to the run summary; any target whose settings are missing is skipped with a notice, so the workflow is harmless before the accounts exist.

| Event                                      | Ref                                              | Environment            | What runs                                                                                                                                                                                                          |
| ------------------------------------------ | ------------------------------------------------ | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Pull request                               | the PR                                           | —                      | Panel and field app previews only, Netlify alias `pr-<n>` on each site, built against the `preview` project; while `preview` has none, the panel in demo mode and the field app with no `/api` rule. Never staging |
| Run workflow                               | `claude/focused-newton-5v0u2q` (live branch)     | `staging`/`production` | All targets or one (`supabase`, `worker`, `web` and `field` with `--prod`)                                                                                                                                         |
| Run workflow                               | any other ref                                    | `staging`/`production` | Nothing: the deploy guard skips every job with a notice                                                                                                                                                            |
| Run workflow                               | `spec-v1.2` (the live branch after the cut-over) | `preview`              | The `supabase` target only (migrations + functions to the preview project); `worker`, `web` and `field` are skipped with a notice                                                                                  |
| Run workflow, target `inventory`           | `spec-v1.2` (any ref whose `deploy.yml` has it)  | `staging`              | The read-only staging inventory (below)                                                                                                                                                                            |
| Run workflow, target `preview-worker`      | `spec-v1.2`                                      | `preview`              | The worker in the runner against the preview project for 60 minutes (fake transcription and extraction, console texts and email), for the phone check (below); sets no secret                                      |
| Push to `main` (the branch does not exist) | `main`                                           | —                      | Nothing: skipped by the guard, provided `main` is created from a commit that has this workflow                                                                                                                     |

**Until the cut-over, the live branch runs its own pre-W1-01 `deploy.yml`.** A dispatch runs the workflow file of the selected ref, and `claude/focused-newton-5v0u2q` still has the old one: no guard, no `inventory` target, no `preview` environment. Selecting it with the defaults runs a full, unguarded staging deploy, as before. So dispatch the inventory and preview targets from `spec-v1.2`, and create `main` only from a commit that has this workflow. The table above describes this workflow; it applies to the live branch from the W1-19 merge on.

**Deploy guard (GAP D40).** `db push`, `functions deploy`, the Fly worker and the `--prod` deploys of the panel and the field app run only when the run's ref is the branch `refs/heads/claude/focused-newton-5v0u2q`, the live staging branch (and GitHub's default branch); full refs are compared, so a tag with that name does not pass. The `plan` job decides, and each deploying job repeats the ref check in its own `if:` (`scripts/src/deploy-workflow.test.ts` keeps it that way). The staging project ref (`abuanbyzttuqksdctqcp`) is a constant in the workflow (`STAGING_PROJECT_REF`): a Supabase deploy to any other Environment whose `SUPABASE_PROJECT_REF` resolves to it fails before it links, and a pull-request preview whose Supabase URL contains it builds in demo mode (the panel) or without `/api` (the field app). A dispatch runs the workflow file of the ref you pick, so the guard stops mistakes, not an edited workflow; required reviewers on `production` (below) are the second lock there. `spec-v1.2` reaches staging only by being merged into the live branch at the cut-over (`docs/PLAN_WEEK1.md` W1-19).

GitHub Environments and what each job reads:

| Kind     | Name                                                                                                                          | Environments                       | Used by                                                                                                                                  |
| -------- | ----------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Secret   | `SUPABASE_ACCESS_TOKEN`, `SUPABASE_DB_PASSWORD`                                                                               | `staging`, `production`, `preview` | migrations + functions; the inventory (staging)                                                                                          |
| Variable | `SUPABASE_PROJECT_REF`                                                                                                        | `staging`, `production`, `preview` | migrations + functions; web build (URL derived from it); field build (the `/api` target); the inventory                                  |
| Secret   | `FLY_API_TOKEN`                                                                                                               | `staging`, `production`            | worker                                                                                                                                   |
| Variable | `FLY_APP`                                                                                                                     | `staging`, `production`            | worker (health check at `https://<FLY_APP>.fly.dev/health`)                                                                              |
| Secret   | `NETLIFY_AUTH_TOKEN`                                                                                                          | `staging`, `production`            | web and field; pull-request previews use the `staging` one                                                                               |
| Variable | `NETLIFY_SITE_ID`, `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `VITE_APP_URL`, `VITE_WA_DISPLAY_NUMBER`, `VITE_SENTRY_DSN` | `staging`, `production`            | web build (the anon key is public by design; it is a variable); pull requests read only `NETLIFY_SITE_ID`, the rest are blanked for them |
| Variable | `VITE_SUPABASE_ANON_KEY` (and optionally `VITE_SUPABASE_URL`)                                                                 | `preview`                          | pull-request panel previews                                                                                                              |

Add required reviewers on `production`. `NETLIFY_SITE_ID` is optional: the web job takes the site id from it or from `.github/netlify-sites.json` (per environment; an id survives renaming the site in Netlify, staging is `staging-sitelog.netlify.app`). With neither, it finds or creates a site named `sitelog-<environment>-<github owner>`, deploys there and prints the id to add to that file (the URL is in the run summary). Pull-request previews always use the `staging` key, so they stay `pr-<n>` aliases of the panel site; from `staging` they take only the Netlify token and site (no Supabase settings, WhatsApp number or Sentry DSN). After the first web deploy, set the panel URL in Supabase once: Authentication → URL Configuration (site URL, and `<url>/**` under redirect URLs) and the `APP_URL` edge-function secret, which the `api-*` functions use for CORS.

Runtime secrets are not copied from GitHub: edge-function secrets stay in `supabase secrets set` (step 4) and worker secrets in `fly secrets set` (step 7). The panel is a single-page app; `apps/web/public/_redirects` sends every path to `index.html` (Netlify and Cloudflare Pages both read it). The field app's `_redirects` is written by its build (below).

#### The field app site (GAP D42, D43, W1-04)

The field web recorder is its own Netlify site: its routes (`/settings` among them) cannot share the panel's origin, and its device cookie must stay first-party on its own host. The `field` job deploys it like the panel, with the same `NETLIFY_AUTH_TOKEN` and the same rules: `pr-<n>` aliases for pull requests, `--prod` only from the live branch, nothing for `preview`, a notice and no deploy while the token is missing. In both jobs only the "Netlify site" and "Deploy" steps get the token; `pnpm install` and the build never see it (Check configuration learns only whether it exists).

- **Site.** The job takes the site id from the key `field-<environment>` in `.github/netlify-sites.json` (`field-staging` for pull requests and staging). With no key it finds or creates the site `sitelog-field-<environment>-<github owner>` and prints its id in a notice: add it under `field-staging` so a rename keeps deploys on it. It never reads `NETLIFY_SITE_ID`, the panel's key or the panel's name, and it stops before deploying if the site it resolved is the panel's. The first pull-request run with the token creates `sitelog-field-staging-<owner>`; its previews are `https://pr-<n>--sitelog-field-staging-<owner>.netlify.app` (the run summary has the link, ending in `/today`).
- **How `/api` reaches Supabase.** The app calls `field-api` same-origin at `/api`. Netlify does not build here, so the field build writes `apps/field/dist/_redirects` from the one Supabase URL the job hands it (`apps/field/config/redirects.ts`): `/api/*  {url}/functions/v1/field-api/:splat  200` (a proxy) first, `/*  /index.html  200` second. Pull requests get the `preview` project's URL from the `preview` job (only when `preview` has both its project and `VITE_SUPABASE_ANON_KEY`, as for the panel); a URL on the staging project is dropped with a warning. A deploy from the live branch gets the Environment's `VITE_SUPABASE_URL`, or the URL derived from its `SUPABASE_PROJECT_REF`, and refuses a non-staging Environment that resolves to staging. Refs and hosts are compared without case, trailing dot or port, and a URL whose host is not plain ASCII (a `%`-escape, credentials, Unicode) is not used, since the build's URL parser would turn it into another spelling of the same host. Without a valid URL there is no `/api` rule: the app still loads, and the field app's client treats the HTML it gets for `/api/*` as an error, not an answer. The Build step checks the file against the URL, fails if the `/api` rule's host (read as a browser reads it) is staging's on a pull request or a non-staging deploy, and prints it.
- **Check a preview's `/api`** (needs D41): `curl -i https://pr-<n>--sitelog-field-staging-<owner>.netlify.app/api/resolve` answers from Supabase (a JSON 404 until `field-api` is deployed to the preview project, W1-07); an HTML page means the build had no `/api` rule (see the run summary of the Build step).
- **Owner check on a phone** (W1-04 Done when). Open the preview's `/today` link from the run summary on iOS Safari and on Android Chrome: it loads over HTTPS in the phone's language (EN, ES or TR, else English). Add it to the home screen (iOS: Share → Add to Home Screen; Android: menu → Add to Home screen or Install app), then open it from the icon: it starts full screen on Today with the SiteLog icon. Record the result in PR #1. Without the token (no preview), use a tunnel to `pnpm --filter @sitelog/field preview` (port 4174, with the tunnel's URL in `FIELD_APP_URL`): a plain-http LAN address is not a secure context.
- **Demo phone.** On `*.netlify.app` the panel's Demo phone cannot frame the field app with its cookie (two registrable domains), so open its links in a new tab until both apps have custom domains under one domain (GAP D42, §8 Q7).
- **Cut-over (W1-19).** The ordered steps are in "Cut-over (W1-19), step by step" below. The W1-05 step 11 migration (`20261014000003_renames_billing.sql`) renames `unknown_senders` → `unknown_contacts` and the labels `verified` → `active`, `reporter_reply` → `reporter`, which the deployed pre-v1.2 panel and functions read: push it only in the same Deploy run as this branch's functions and panel (db push → functions → web and field), never alone. Its billing columns need no ordering (the `orgs_billing_ids` trigger keeps `stripe_*` and `billing_*` equal for either generation of writer). The staging field site gets `--prod` from the live branch with `/api` to the staging project. Then set `FIELD_APP_URL` (and `LINK_SHORT_DOMAIN` until `sl.link` exists) on the staging project to the field site's URL, with the owner's approval. The country-pack migration (`20261014000004_country_packs.sql`) stops the push with "orgs outside the country packs" if an org has a country with no pack; on staging this is only a backstop, since staging's v1.0 schema has no `orgs.country` and `20261013000007` gives every existing org 'US' in the same push. After the push, `select code, sms_provider, sms_sender_id, voice_number from countries;` must show every `sms_sender_id` and `voice_number` null (every message goes to `console` until a sender is set, below). That the old panel's `create_org` call still creates a US org is proven in CI (`supabase/db-tests/src/countries.test.ts`, `apps/web/e2e/supabase/fresh-org.spec.ts`), not checked after the push: the same Deploy dispatch replaces that panel.

#### The `preview` project (GAP D41, owner setup)

Pull-request previews and v1.2 migrations go to a second Supabase project, so nothing from `spec-v1.2` reads or writes staging data before the cut-over. Until it exists, PR previews build in demo mode (`VITE_DEMO=true`, the in-memory Kestrel data) and preview dispatches skip with a notice; PR #1 stays green either way.

1. Create a second free Supabase project (for example `sitelog-preview`). Note its project ref, database password and anon (or publishable) key.
2. GitHub → Settings → Environments → **New environment** `preview`. No required reviewers and no deployment-branch restriction: pull-request runs read it. (The first pull-request run after this change creates an empty `preview` Environment if it does not exist yet; then only add the values.)
3. In `preview` itself (a value missing there falls back to a repository or organization one): secrets `SUPABASE_ACCESS_TOKEN` (a Supabase personal access token; it is per account, so the staging one may be reused) and `SUPABASE_DB_PASSWORD` (the preview project's); variable `SUPABASE_PROJECT_REF` (the preview ref). Not `VITE_SUPABASE_ANON_KEY` yet (step 6): without it PR previews stay in demo mode. Do not add Netlify settings: previews deploy with the `staging` token as `pr-<n>` aliases.
4. Never copy staging's project values (ref, database password, URL, anon key) into `preview`; the personal access token may be shared. The workflow checks the project: a `preview` whose `SUPABASE_PROJECT_REF` is staging's makes the Supabase deploy fail before it links, and a PR preview that points at the staging project builds in demo mode with a warning.
5. With the owner's approval for each step: run **Deploy** from `spec-v1.2` with environment `preview` and target `supabase` (migrations and functions to the preview project); `supabase secrets set` on the preview project; add the preview origins (for example `https://pr-1--staging-sitelog.netlify.app/**`) to its Authentication redirect URLs so magic links work on the preview; seed it with the W1-06 apply mode: `SUPABASE_DB_URL='<the preview project's connection string>' FIELD_APP_URL=<the field preview URL> DEMO_OFFICE_PASSWORD='<16+ characters, kept out of the repo>' pnpm seed:demo -- --date today --apply`. It prints the target first (never the password), writes only the two demo orgs in one transaction, drops the jobs that name their rows (finished ones too, since a dedupe key is never reused: D16), refuses an org with a demo id that is not a demo org, refuses the staging project `abuanbyzttuqksdctqcp` unless `--allow-staging` is given, and refuses to run without the field URL (the links in the seeded texts) or the password (set on the demo office users; the committed `sitelog-demo` is for local stacks only). The demo office users are `lena@kestrelbuild.example` (admin of Kestrel Build Group, panel in English), `sam@` and `accounts@kestrelbuild.example`, and, for the TR demo org, `elif@demiryapi.example` (Elif Aydın, admin of Demir Yapı A.Ş. only; the panel opens in Turkish from the org's tr-TR, spec §19 question 18). Neither sign-in route opens the panel as them on the preview: the panel has no password form (it signs in by magic link only, `signInWithOtp`), so the password only keeps the committed one off a hosted project, and a magic link to a reserved `.example` address is never delivered (Supabase's default SMTP also mails only the project's team members). To open the panel as one of them there, mint a sign-in link with the preview project's service role, `auth.admin.generateLink({ type: 'magiclink', email, options: { redirectTo: '<panel preview>/auth/callback' } })` as `apps/web/e2e/supabase/support.ts` does, and open it; that touches a hosted project, so only with the owner's approval. The password reaches the database only as a bind parameter: the SQL it runs carries its bcrypt hash, so a database log of the script holds no password. The script reads no `.env`: give the three values in the shell, as above. "Today" is Chicago's date; run it after 17:00 Chicago (01:00 in Istanbul while Chicago is on daylight time, 02:00 from Nov 1) for §18.1's 17:00 view, Pier 9 filed at 16:58 and five sites awaiting. Run earlier that day, it seeds nothing after the current time: before 16:59 Chicago, Pier 9 is awaiting too, and before 08:30 the sign-offs of 08:30 today have not happened. Run it again to reset the demo between rehearsals.
6. Last, the variable `VITE_SUPABASE_ANON_KEY` (the preview project's anon or publishable key; `VITE_SUPABASE_URL` is optional, it is derived from the ref). This switches PR previews from demo mode to the preview project from the next push, so add it only once the project has its schema and the seed; before that the panel preview would be broken or empty after sign-in.

#### The worker on the preview project for the phone check (`preview-worker`)

The phone checks of W1-13 and W1-15 need a worker on the preview project. Without a developer machine or AI keys (owner-approved per dispatch): Actions → Deploy → Run workflow → branch `spec-v1.2`, environment `preview`, target `preview-worker`. The job runs the worker in the GitHub runner against the preview project for 60 minutes, then stops it and exits green (job timeout 75 minutes; it has its own concurrency group, so `seed` and `phone-setup` dispatches are not held behind it).

- **What it runs with.** The preview Environment's `SUPABASE_ACCESS_TOKEN`, `SUPABASE_DB_PASSWORD` and `SUPABASE_PROJECT_REF` (staging's ref is refused); the database through the session pooler as the `seed` job connects; the service-role key read with `supabase projects api-keys`; `TRANSCRIBE_PROVIDER=fake`, `EXTRACT_PROVIDER=fake`, `EMAIL_PROVIDER=console`, Open-Meteo's free endpoint, `NODE_ENV=development`. No SMS provider credentials: every text is a console text in the panel's **Demo phone**, and every email a console email there.
- **Secrets.** It sets and changes no Supabase secret. The worker gets a random `LINK_SIGNING_SECRET` made in the job: link codes are stored as sha256 hashes and `field-api` resolves them by hash, so the first text to a reporter in a run carries a new personal link (audited `field_link.created`) and the existing links and devices keep working.
- **Before it:** `seed` (today's demo) and `phone-setup` (field-api's `FIELD_APP_URL` and `LINK_SIGNING_SECRET`, and the panel sign-in links), as for the W1-09 check. The run summary says until when (UTC) the worker runs; a heartbeat every 5 minutes prints its health and a log tail, and the last step prints its last 200 log lines, with phone numbers, email addresses, link codes and email previews hidden.
- **The check.** On the phone, open Marco Ruiz's or Dana Whitfield's link and record anything: the fake transcriber answers with the hero note (`fixtures/voice/es-en-riverside-2026-10-09.json`, an EN/ES reporter's language) and the fake extraction with its recorded output, so the question is the Delta crew's headcount ("Quick check: you said 'the Delta guys' were on Level 2. How many, and for how long?", 4 or 5 · full day). Answer "5 · full day"; a report without a photo then gets the photo question (Kestrel requires one: "No photo today", or add a photo with the note) → the draft shows Delta 5 × 8 h = 40 h → **Confirm & send** → Filed with the PDF; the `filed` text and the report email appear in the Demo phone. A Turkish reporter (Demir Yapı, Emre Yıldız) gets the Kartal note and its questions.

- **Models.** With `ANTHROPIC_API_KEY` in the preview Environment the worker extracts with `CLAUDE_MODEL` and runs the fast calls (`parse_answer`, `classify_utterance`) on `CLAUDE_MODEL_FAST`. Both come from the preview Environment's **variables** (Settings → Environments → `preview` → Environment variables), with `claude-sonnet-5-5` and `claude-haiku-5-5` as the workflow's defaults while a variable is unset (eval run 38968116783, 2026-10-16, after the eval fixes: Haiku passes every `answers` and `utterances` case, the two sets the fast model runs; Sonnet and Opus tie on extraction at 24/28, Sonnet at about a third of Opus's cost and half its time). To switch a model, set or change the variable and dispatch `preview-worker` again: no code change, no commit. Compare candidates first with the eval workflow (below).

#### Comparing Claude models on the golden sets (`.github/workflows/eval.yml`)

Scores the four golden sets (spec §10.13) on real models with the preview Environment's `ANTHROPIC_API_KEY`, so nobody handles the key locally. Until the default branch has `eval.yml`, GitHub cannot dispatch it directly (404), so it runs through Deploy: Actions → **Deploy** → Run workflow → branch `spec-v1.2`, environment `preview`, target `eval` (any other ref or environment skips it), with `eval_models` and `eval_sets` as below (empty `eval_models` = the three defaults). Once `eval.yml` is on the default branch, Actions → **Eval** → Run workflow takes the same inputs:

- `models`: comma-separated model ids (default `claude-sonnet-5-5,claude-haiku-5-5,claude-opus-5-5`). Each model runs every chosen set as both `CLAUDE_MODEL` and `CLAUDE_MODEL_FAST`.
- `sets`: `all` (default) or a comma-separated subset of `extraction` (fixtures/transcripts, report extraction v2), `answers` (`parse_answer`, fixtures/answers), `corrections` (`apply_correction`, fixtures/corrections), `utterances` (`classify_utterance`, fixtures/utterances).

The job is read-only (`contents: read`, `ANTHROPIC_API_KEY` its only secret, handed to the eval step only; no database, no other provider; `scripts/src/eval-workflow.test.ts` holds it to that). It costs real API calls: with the defaults, three models × every case (the run summary shows what each set cost, estimated).

**Reading the result.** The run's summary page has one table row per model × set: `Passed` (cases passed / total), `Failed cases` (case ids, the first eight), `Tokens in / out`, `Est. cost` (USD at `apps/worker/src/ai/cost.ts` rates, an estimate; check the console for the bill), `Time` (wall time of the set, sequential calls for the small sets, 3 in parallel for extraction), then one total row per model. Failed cases do not fail the run; a set that ends without its summary (a broken fixture, a crash) does, and its log is in the step's group. The `eval-results` artifact (30 days) holds one JSON per model × set (`EVAL_SUMMARY` fields plus each case's failed check names) and its log, which says what failed and why. Locally the same files come from `pnpm eval -- --set <set> --json <file>` and the table from `pnpm eval -- --summarize <files>`.

Pick the model on pass rate first (every case in a golden set is a behaviour the product needs), then cost and time; then set it in the preview Environment's variables (above) and run the phone check.

#### Staging inventory (read-only, W1-01 step 0)

Actions → Deploy → Run workflow → branch `spec-v1.2`, environment `staging`, target `inventory` (the live branch's own `deploy.yml` has no `inventory` target until the cut-over). It needs the staging `SUPABASE_*` settings above and writes everything to the run summary:

- `supabase migration list --linked` (this ref's migrations against the ones applied on staging);
- `supabase functions list`;
- the edge-function secret **names** (the CLI's digests are never printed);
- counts from `supabase/ops/inventory.sql`, run with `psql` through the session pooler that `supabase link` records (link runs without the database password, through the Management API only), in a `READ ONLY` transaction that is rolled back: orgs (the demo orgs, by `is_demo` where the column exists and otherwise the seeded Kestrel org by its fixed id, a row says which; and the rest; every count below splits the same way), conversations, messages (by type, with or without a conversation), transcripts, unknown contacts (`unknown_contacts`, or `unknown_senders` on a database from before W1-05 step 11), report sources by kind, reports by status, report versions by data schema version, reporters by status, jobs by type and status (and queued `render_pdf` jobs that would notify a reporter), notifications by kind, storage objects per bucket, whether the `sitelog-scheduler-tick` pg_cron job exists and is active, and whether its two Vault secrets exist. Counts and labels only, never row contents. `supabase/db-tests/src/inventory.test.ts` runs the same SQL on PGlite.

It never runs `db push`, `functions deploy` or `secrets set`. Copy the summary into PR #1. At the W1-19 re-run, "Reporters by status" must show no `verified` reporter outside the demo orgs (D19: step 11 renames the label to `active` as it is); otherwise stop and set those reporters to `invited` first. The backup (a `pg_dump` and a copy of the `audio`/`photos` buckets) is taken at the cut-over, right before the first `db push` to staging (W1-19), to a place the owner chooses: it holds personal data, and a dump taken now would be stale by then.

### Cut-over (W1-19), step by step

The v1.2 deploy to staging (`abuanbyzttuqksdctqcp`), in this order. Step 0 is local; **every other step changes or reads a hosted system and needs the owner's approval first, one step at a time.** Each step lists its preconditions, the exact command, how to verify it and how to back out. After step 4 there is no partial rollback: the schema is v1.2 and only this branch's panel and functions read it, so the way back is forward (fix and re-dispatch) or, as the last resort, the step 1 backup restored into a fresh project. `docs/DEMO_NOTES.md` has the URLs, logins and the rehearsal checklist that follows step 7.

Names used below: panel `https://staging-sitelog.netlify.app` (Netlify key `staging`), field site `https://sitelog-field-staging-ertannnc.netlify.app` (key `field-staging`; take the exact URL from the field job's run summary if it differs), the staging session-pooler connection string from Dashboard → Connect → Session pooler (port 5432) as `$STAGING_DB_URL`, kept in the shell only.

**0. Local pre-flight** (no approval needed). On a clean checkout of `spec-v1.2`:

```sh
git fetch origin && git switch spec-v1.2 && git pull --ff-only && pnpm install --frozen-lockfile
pnpm check && pnpm cutover:preflight -- --full-db
```

`cutover:preflight` (`scripts/src/cutover-preflight.ts`) touches nothing remote. It checks the env inventory (every variable the functions, the worker and the bundles read is in `.env.example`; the browser bundles read only public `VITE_*` names; each cut-over setting below is read where it is set), runs `pnpm test:db` including `supabase/db-tests/src/cutover.test.ts` (this whole sequence on a staging-shaped PGlite database: the 16 v1.0 migrations with staging's inventory rows, the D19 check, `supabase/ops/discard-backlog.sql`, every v1.2 migration in one push, the post-push checks, today's demo seed next to the customer org), prints what today's seed would be, builds the panel and the field app with a sentinel in every secret-bearing variable and scans both `dist` folders for the sentinels, the secret values of your local `.env` files, service-role JWTs, key shapes and server-only variable names. All lines `PASS`, else stop. Also needed before step 1: GitHub Actions runners (the Deploy workflow; on 2026-10-15 jobs got no runner), the Anthropic and Deepgram keys, a place for the backup, and a time slot (steps 5–8 after 17:00 Chicago, below).

**1. Inventory re-run and backup** (owner-approved; reads only).

- Run: Actions → Deploy → Run workflow → branch `spec-v1.2`, environment `staging`, target `inventory` (`gh workflow run deploy.yml --ref spec-v1.2 -f environment=staging -f target=inventory`).
- Verify in the run summary: the 16 v1.0 migrations applied and the v1.2 ones pending; "Reporters by status" shows no `verified` reporter outside the demo orgs (D19). If one exists, stop: set those reporters to `invited` (`update reporters set status = 'invited' where status = 'verified' and org_id <> '7a0cfa5d-2a29-43fb-8665-fcd9bed4106d';`, owner-approved) and re-run the inventory. Note the queued jobs (2026-10-13: `send_welcome`, `build_evidence_pack`): step 2 discards them.
- Backup, right after the inventory and before step 2 (from here to the push only steps 2 and 3 write, and step 2 only marks jobs), to the place the owner chose (it holds personal data; the free tier has no point-in-time recovery):

  ```sh
  pg_dump "$STAGING_DB_URL" -Fc --no-owner -n public -n storage -t auth.users -f "sitelog-staging-pre-v1.2-$(date -u +%Y%m%dT%H%MZ).dump"   # pg_dump 17
  supabase link --project-ref abuanbyzttuqksdctqcp
  for b in audio photos logos pdfs exports invoices; do supabase storage cp -r "ss:///$b" "./storage-backup/$b" --experimental; done
  ```

  Verify: `pg_restore -l <file> | grep -c 'TABLE DATA'` lists the tables; the copied object count matches the inventory's "storage objects per bucket" (2026-10-13: one logo). A bucket that does not exist yet is skipped with an error; that is fine.

- Back out: nothing changed.

**2. Discard the WhatsApp-era backlog** (owner-approved). Precondition: no worker runs against staging (none exists: no Fly app). Run `supabase/ops/discard-backlog.sql` in the staging SQL editor (or `psql "$STAGING_DB_URL" -f supabase/ops/discard-backlog.sql`). It marks every job of a v1.0 type (the v1.0 worker's 15) queued for more than an hour (and any stale `running` one) `failed` with `last_error = 'discarded: queued before the v1.2 cut-over (W1-19)'` and writes one `ops.backlog_discarded` audit row with the counts per type. Its first run fixes the cut-over line (one hour before that audit row): running it again never touches a job queued after the first run, so it cannot discard v1.2 work, and records a count of 0. Run it before the push (step 4): run first after it, it would also discard v1.2 jobs of those types older than an hour. Verify: its last select shows the counts the inventory listed. Back out (only if the cut-over is abandoned, and never with a worker running: `send_welcome` would send a WhatsApp template): `update jobs set status = 'queued', last_error = null, finished_at = null where last_error = 'discarded: queued before the v1.2 cut-over (W1-19)';`.

**3. Secrets and settings** (owner-approved). Set them before the deploy, so `field-api` and `sms-webhook` start with them. Generate `LINK_SIGNING_SECRET` once and keep it in the password manager: the worker needs the same value (step 7), and changing it later invalidates every device code in flight.

```sh
supabase secrets list --project-ref abuanbyzttuqksdctqcp          # names only; keep an existing LINK_SIGNING_SECRET
supabase secrets set --project-ref abuanbyzttuqksdctqcp \
  LINK_SIGNING_SECRET="$LINK_SIGNING_SECRET" \
  FIELD_APP_URL=https://sitelog-field-staging-ertannnc.netlify.app \
  APP_URL=https://staging-sitelog.netlify.app
```

- `CORS_EXTRA_ORIGINS`: not needed for the demo (`field-api` takes `FIELD_APP_URL`, the `api-*` functions `APP_URL`); set it only for another origin that must call staging's functions.
- `STRIPE_PRICE_ID_SITE_US`: only together with Stripe on staging (the inventory found no `STRIPE_*` secret, so billing is off there); then set it, deploy, and unset the old `STRIPE_PRICE_ID_SITE` (GAP 9.1).
- `DEEPGRAM_API_KEY` and `ANTHROPIC_API_KEY` are the worker's, not the functions': they go in its `.env` in step 7.
- Web push (W2-14, optional): a VAPID pair (`npx web-push generate-vapid-keys`). `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` and `VAPID_SUBJECT` (`mailto:…`) go in the worker's `.env`; only `VAPID_PUBLIC_KEY` is also a functions secret (field-api serves it to the field app). Without them push stays `console` for demo orgs and off for real orgs (SMS carries every message); the worker's boot line `sms transport per country pack` says which (`push`).
- No pack sender id or voice number (`pnpm countries:set`) before the demo unless the owner approves one: every text stays on `console`.
- `scheduler-tick` reads `LINK_SIGNING_SECRET`, `FIELD_APP_URL` and (optionally) `DAILY_LINK_TTL_HOURS` since W2-06 (the reminder ladder's daily links); the values above serve it. Never set `SCHEDULER_CLOCK_OVERRIDE` on a hosted project: it lets the tick take `?now=` (CI's e2e-supabase only). Its worker twin, `WORKER_CLOCK_OVERRIDE` with `WORKER_CLOCK_START` (the worker's clock starts at that instant and runs on in real time, so jobs a tick claimed on the test clock are judged on it), is CI's too: never in the worker's `.env` on a hosted project; the worker refuses it under `NODE_ENV=production`. The same goes for `SMS_PROVIDER_STUB` with `TWILIO_API_BASE` and `ILETIMERKEZI_API_BASE` (W4-12: the SMS drivers send to the local SMS stand-in, CI only; the worker refuses it in production). `WELCOME_RESEND` (worker, W4-12, §19 Q241) is `auto` by default: one automatic welcome re-send 48 h after the welcome reached the phone with no reaction, in the site's daytime; `off` leaves it to Team's Re-send.
- Supabase Dashboard → Authentication → URL Configuration: Site URL `https://staging-sitelog.netlify.app`, Redirect URLs include `https://staging-sitelog.netlify.app/**`.
- The `staging` GitHub Environment already holds what the panel and field jobs read (`SUPABASE_ACCESS_TOKEN`, `SUPABASE_DB_PASSWORD`, `NETLIFY_AUTH_TOKEN`, `SUPABASE_PROJECT_REF`, `VITE_SUPABASE_ANON_KEY`, `VITE_APP_URL`); check them, since the web job stops on a missing or malformed anon key. `VITE_DEMO_PHONE_ALL_ORGS` is optional (the demo org's admin sees the Demo phone without it).
- Verify: `supabase secrets list` shows the three names. Back out: `supabase secrets unset NAME`.

**4. Merge and deploy, back to back** (owner-approved; one window). The renames in `20261014000003_renames_billing.sql` break the deployed v1.0 panel and functions, so the push ships only with this branch's functions and panel, in one dispatch.

- Precondition: `pnpm check` and `pnpm test:db` green on the commit to merge (CI, or locally while Actions has no runners); steps 1–3 done.
- Merge PR #1 (`spec-v1.2` → `claude/focused-newton-5v0u2q`; a fast-forward on 2026-10-15). From then on the live branch runs this branch's `deploy.yml` (guard, field job).
- Run: Actions → Deploy → Run workflow → branch `claude/focused-newton-5v0u2q`, environment `staging`, target `all` (`gh workflow run deploy.yml --ref claude/focused-newton-5v0u2q -f environment=staging -f target=all`). Expected: "Pending migrations" lists `20261013000006_enums_v1_2.sql` onwards; db push; functions deploy (every function in `supabase/config.toml`, `field-api` and `sms-webhook` among them; `whatsapp-webhook` stays deployed until step 22); the worker job skips with a notice (no `FLY_*`); panel and field app `--prod`, the field `_redirects` with `/api/*` to `https://abuanbyzttuqksdctqcp.supabase.co/functions/v1/field-api/:splat`.
- Verify (the ticket's smoke checks):
  - SQL editor: `select code, sms_provider, sms_sender_id, voice_number from countries;` → every `sms_sender_id` and `voice_number` null. `select name, country, is_demo from orgs;` → the customer org `US`, not a demo org.
  - `curl -si -X POST https://sitelog-field-staging-ertannnc.netlify.app/api/resolve -H 'Origin: https://sitelog-field-staging-ertannnc.netlify.app' -H 'Content-Type: application/json' -d '{"code":"ZZZZZZ"}'` → a JSON answer from `field-api` (an unknown code) with `cache-control: no-store`; an HTML page means the field build had no `/api` rule.
  - The panel signs in (your own account's magic link) and shows the customer org.
  - The W1-07 cookie probe is the device check of step 8: Today loads after the code is accepted only if `Set-Cookie` and `Cookie` pass the Netlify proxy.
- Back out: if the Supabase job fails before `20261014000003` applies, the old panel still works; fix and re-dispatch. After it, fix forward (re-dispatch with the fix; Netlify's "Publish deploy" of an older deploy only brings back a panel that cannot read the schema). Last resort: restore the step 1 dump into a new project.

**5. Demo seed** (owner-approved; after 17:00 Chicago for §18.1's view with Pier 9 filed and five sites awaiting, that is 01:00 Istanbul while Chicago is on daylight time, 02:00 from Nov 1; earlier, the day stops at the clock and all six sites are awaiting). It writes only the `is_demo` orgs (Kestrel, Demir Yapı) in one transaction and never touches the customer org (`cutover.test.ts` proves it):

```sh
SUPABASE_DB_URL="$STAGING_DB_URL" FIELD_APP_URL=https://sitelog-field-staging-ertannnc.netlify.app \
  DEMO_OFFICE_PASSWORD='<16+ characters, not kept>' pnpm seed:demo -- --date today --apply --allow-staging
```

Verify: it prints the staging target and `applied: Kestrel Build Group, Demir Yapı A.Ş.`; `select name, is_demo from orgs;` → three orgs, two demo. Run it again to reset between rehearsals. Back out: `delete from orgs where is_demo;` (cascades to their rows only; owner-approved).

**6. Sign-in links for the demo office users** (owner-approved; uses the staging service-role key from Dashboard → Settings → API, kept in the shell). The panel signs in by magic link only and `.example` addresses get no mail, so mint a one-time link per user, as the `phone-setup` job does on the preview:

```sh
for email in lena@kestrelbuild.example elif@demiryapi.example; do
  curl -fsS "https://abuanbyzttuqksdctqcp.supabase.co/auth/v1/admin/generate_link" \
    -H "apikey: $SERVICE_ROLE_KEY" -H "Authorization: Bearer $SERVICE_ROLE_KEY" -H 'Content-Type: application/json' \
    -d "{\"type\":\"magiclink\",\"email\":\"$email\",\"redirect_to\":\"https://staging-sitelog.netlify.app/auth/callback\"}" \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);console.log(j.action_link||j.properties?.action_link)})'
done
```

Each link works once, for an hour; open it in the browser that runs the demo. Verify: the panel opens as Lena on Kestrel's Overview (as Elif, in Turkish on Demir Yapı).

**7. The worker on the developer machine** (owner-approved; GAP §8 Q9). In `apps/worker/.env` (its values win over the root `.env`; never commit it):

```sh
NODE_ENV=production                                        # refuses EXTRACT_PROVIDER=fake and TRANSCRIBE_PROVIDER=fake at boot
SUPABASE_URL=https://abuanbyzttuqksdctqcp.supabase.co
SUPABASE_SERVICE_ROLE_KEY=<staging service role>
SUPABASE_DB_URL=<$STAGING_DB_URL, the session pooler, port 5432: LISTEN needs session mode>
APP_URL=https://staging-sitelog.netlify.app
FIELD_APP_URL=https://sitelog-field-staging-ertannnc.netlify.app
LINK_SIGNING_SECRET=<the value of step 3>
TRANSCRIBE_PROVIDER=deepgram
TRANSCRIBE_MODEL=nova-3
DEEPGRAM_API_KEY=<key>
EXTRACT_PROVIDER=claude
ANTHROPIC_API_KEY=<key>
CLAUDE_MODEL=<the owner's choice, GAP §8 Q8>
CLAUDE_MODEL_FAST=<the owner's choice>
WEATHER_API_BASE=https://api.open-meteo.com/v1/forecast   # the free endpoint; the default customer-api needs WEATHER_API_KEY
EMAIL_PROVIDER=console                                     # or resend + RESEND_API_KEY + EMAIL_FROM (the demo recipients are .example)
```

- Precondition: `select type, status, created_at from jobs where status in ('queued', 'running') and created_at < (select min(created_at) from audit_log where action = 'ops.backlog_discarded') order by created_at;` returns no rows: every job still queued was created after step 2's first run (the seed's, office edits since), and the worker is meant to run those. Rows here are jobs from before the cut-over that step 2 left alone (queued less than an hour before it, or of a v1.2-only type): look at each and discard it in `/ops` or by hand; running step 2's file again changes nothing. No `ops.backlog_discarded` row at all means step 2 never ran: stop and run it.
- Run: `pnpm dev:worker` (no Twilio or İletimerkezi credentials: every pack has no sender, so every text goes to `console`).
- Verify: `curl -s localhost:8080/health` → `ok: true, listening: true`; the log line `sms transport per country pack` shows `console` for every pack; the boot line `extraction provider` shows `"provider":"claude"` with no `note` (a note `ANTHROPIC_API_KEY is not set` means every extraction will fail: fix `.env` and restart); no `transcription provider` warning (one names the missing `DEEPGRAM_API_KEY`). The fakes answer only when `EXTRACT_PROVIDER=fake` / `TRANSCRIBE_PROVIDER=fake` is set, and with `NODE_ENV=production` the worker refuses to start with either (`… is refused in production`); a missing key never falls back to them. Back out: stop the process; queued jobs wait.

**8. Dress rehearsal** (owner, on a real phone): `docs/DEMO_NOTES.md` "Rehearsal checklist", twice in a row. Reset between runs with step 5. That is the ticket's Done when.

Afterwards (not part of the demo): step 22 removes `whatsapp-webhook`, the `WA_*` secrets and `VITE_WA_DISPLAY_NUMBER`, each owner-approved.

### Voice secrets (W3-03)

`field-api` serves the voice agent's `/voice/*` routes. Set `VOICE_AGENT_TOOL_SECRET` and `VOICE_CALL_TOKEN_SECRET` as functions secrets (`openssl rand -base64 32` each; on a hosted project only with the owner's approval). Give the agent only `VOICE_AGENT_TOOL_SECRET`: the call-token secret stays with `field-api`, so the agent cannot mint a token for another call. Without them the `/voice/*` routes answer 500 "not configured" and the field routes go on.

Optional `VOICE_TOOL_WAIT_MS` (functions secret, default 12000, at most 15000): how long `update_draft` / `record_answer` wait for the worker's `voice_turn` before answering `pending`. The worker must be running for calls to get a draft; a `voice_turn` that fails is never retried by the queue, the agent asks again. A call's `file_report` waits for the worker's `file_report` job (priority 1) within the same wait; a busy queue shows as `pending` on the call (the agent asks again), never as a second filing. After a call-filed report the reporter gets `filed` and then `photos_link` (`notify:photos_link:<report>`).

LiveKit webhooks (W3-04; the whole set-up is "Voice: M7 live on the preview project" below): set the function secrets `LIVEKIT_API_KEY` and `LIVEKIT_API_SECRET` (the project's pair), deploy `voice-events --no-verify-jwt`, register `https://<ref>.supabase.co/functions/v1/voice-events` under LiveKit Settings → Webhooks, and send a test webhook. 200 `{received: true, ignored: true}` (or the call's result) means the signature passed; 401 `invalid_signature` means the key pair differs.

Talk now (W3-13): with the owner's approval, `supabase secrets set LIVEKIT_URL=wss://<project>.livekit.cloud LIVEKIT_AGENT_NAME=sitelog-voice` (and the key pair, already set for `voice-events`). Then `resolve` / `today` answer `talkNow: true` for orgs that are not billing-blocked. Check on a phone: Today → Talk now → microphone → the call screen → End call opens the draft or Filed.

After a call (W3-11): each ended call of a known caller runs one `post_call_reconcile` job. It retries while the recording is not uploaded, for up to an hour (`VOICE_RECORDING_GRACE_S`); after that, a filed call without a recording is marked `call_unreconciled`. `calls.reconcile` shows the outcome (equal, mismatch or unreconciled). A dead post-call job of a filed call adds `call_unreconciled` instead of `processing_failed`. Requeuing it (`requeue_dead_job`) is safe: every step is keyed or settles once. A call whose consent was declined (`calls.consent_declined_at`, W3-14) is skipped and its recording deleted. The worker reads the `calls` bucket with the service role. The reconcile uses `DEEPGRAM_API_KEY` (batch) and `ANTHROPIC_API_KEY` with `CLAUDE_MODEL`.

Special requests on a call (W3-14): an unknown caller's recordings are in the `calls` bucket under `unknown/`; nobody in the office can read them; `retention_cleanup` deletes them with the snippet after 30 days unless the number is linked. `reporters.no_calls_until` holds "not today"; outbound calls honour it from W3-17.

The voice agent (W3-12): LiveKit Cloud's own session recording is off (`record=False`, §19 Q207); call audio lives only in the `calls` bucket. The agent marks each call's disclosure at field-api once the notice has played (`POST /voice/calls/:id/disclosure`, §19 Q205); a call without that mark (an agent that died during the opening) keeps no processed recording (`no_disclosure`). Before the pilot add `livekit-plugins-noise-cancellation` to the agent's lock (§19 Q204) and decide Deepgram's `mip_opt_out` (§19 Q206).

### Voice: M7 live on the preview project (W3-16)

The owner's steps to put the voice agent on LiveKit Cloud against the **preview** project, then run M7's calls and read the latency. Every step that touches LiveKit, a hosted Supabase project, the agent or a number is **owner-approved**, one at a time; the preview project first, staging only after the owner says so. Nothing here runs in CI. Keys go into the places named below (Supabase secrets, LiveKit agent secrets, a local file outside the repo), never into the repo or a chat.

**Before you start.** The preview project has this branch's migrations and functions (Deploy → environment `preview`, target `supabase`), today's demo (`seed`) and the field app pointing at it (`phone-setup`). A worker runs against the preview project with **real** Claude: on a call `update_draft`, `record_answer`, `apply_correction` and `file_report` are worker jobs (`voice_turn`, §19 Q117), so a worker on `EXTRACT_PROVIDER=fake` answers every call with the recorded fixture drafts. Run it from a developer machine with the preview database URL, `ANTHROPIC_API_KEY`, `CLAUDE_MODEL`, `CLAUDE_MODEL_FAST` and `DEEPGRAM_API_KEY` (the post-call reconcile transcribes the recording), and check its boot line `extraction provider` says `"provider":"claude"`. Have the agent's values at hand: `CLAUDE_MODEL_FAST` (the model the preview worker uses for its fast calls), `DEEPGRAM_API_KEY`, `AZURE_SPEECH_KEY` / `AZURE_SPEECH_REGION` (the F0 resource, §5.2 step 3) and `ANTHROPIC_API_KEY`.

1. **LiveKit Cloud project** (§5.2 step 1). Create a project on the free Build plan. From its settings note the URL (`wss://<project>.livekit.cloud`), and create an API key pair (`LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`).
2. **The `lk` CLI.** Install it (LiveKit's docs: Homebrew, the install script or a release binary), then `lk cloud auth` and pick the project; `lk project list` shows it as the default. `pnpm voice:console` uses the same login.
3. **Function secrets on the preview project.** Generate the two voice secrets (`openssl rand -base64 32`, each once) and set, with the preview ref:

   ```sh
   supabase secrets set --project-ref <preview ref> \
     VOICE_AGENT_TOOL_SECRET='<secret 1>' VOICE_CALL_TOKEN_SECRET='<secret 2>' \
     LIVEKIT_URL='wss://<project>.livekit.cloud' LIVEKIT_API_KEY='<key>' LIVEKIT_API_SECRET='<secret>' \
     LIVEKIT_AGENT_NAME=sitelog-voice
   ```

   `VOICE_CALL_TOKEN_SECRET` stays with field-api only; the agent gets `VOICE_AGENT_TOOL_SECRET` (step 5). With the LiveKit trio set, `resolve` / `today` answer `talkNow: true` (§19 Q121) for orgs that are not billing-blocked. Functions read secrets on their next start; no redeploy is needed.

4. **Webhook.** LiveKit project settings → Webhooks → add `https://<preview ref>.supabase.co/functions/v1/voice-events`, signed with the API key of step 1 (the pair `voice-events` checks), and send a test event: a 200 means the signature passed, a 401 `invalid_signature` that the key pair differs from step 3's (Voice secrets, above).
5. **Agent secrets.** In a file outside the repo (for example `~/sitelog-agent-preview.env`, `chmod 600`), one `KEY=value` a line, the names of `apps/voice-agent/src/sitelog_voice/config.py`:

   ```sh
   FIELD_API_URL=https://<preview ref>.supabase.co/functions/v1/field-api
   VOICE_AGENT_TOOL_SECRET=<secret 1 of step 3>
   DEEPGRAM_API_KEY=…
   ANTHROPIC_API_KEY=…
   CLAUDE_MODEL_FAST=<the preview worker's fast model>
   AZURE_SPEECH_KEY=…
   AZURE_SPEECH_REGION=westeurope
   STT_MODEL=nova-3
   TTS_VOICE_EN=aura-2-thalia-en          # until the listening test (step 11) picks
   TTS_VOICE_ES=aura-2-nestor-es
   TTS_VOICE_TR=tr-TR-EmelNeural
   LIVEKIT_AGENT_NAME=sitelog-voice
   NODE_ENV=production
   SENTRY_DSN=…                           # optional
   SENTRY_ENVIRONMENT=preview
   ```

   No `LIVEKIT_URL` / key / secret here: LiveKit Cloud gives a deployed agent its own project's. The agent's name (`sitelog-voice`) is what field-api dispatches to and the dispatch rule names; the agent takes it from `LIVEKIT_AGENT_NAME` or `livekit.toml`'s `[agent] name`.

6. **Create and deploy the agent** (§5.2 step 4). First `pnpm voice:contract -- --check` and `pnpm voice:test` (the contract and copy the image carries are current). Optionally try it locally with `pnpm voice:console` (the laptop microphone; it reads the root `.env`, so put the same values there for that run). Then, in `apps/voice-agent`: `lk agent create --secrets-file ~/sitelog-agent-preview.env`. It builds the `Dockerfile` on LiveKit Cloud and writes `livekit.toml` (its shape is `livekit.toml.example`; it holds no secret, commit it). Later code changes: `lk agent deploy`; secret changes: `lk agent update-secrets --secrets-file …` (check `lk agent --help` for the CLI version at hand); `lk agent status` and `lk agent logs` show it running. The Build plan allows one agent deployment and five concurrent sessions (§5.2).
7. **Talk now first** (no number needed). On a phone, open a demo reporter's link (Marco Ruiz for EN and ES, Emre Yıldız for TR), Today → **Talk now** → allow the microphone → the call. Expect the recording notice in the first 5 s, then report. Check `voice-events` received the room (`select event, room, call_id, event_at from livekit_events order by event_at desc limit 5;` in the preview SQL editor, read only) and the call's row (below).
8. **The free US number.** LiveKit project → Telephony → Phone numbers → get the free US local number. Then a dispatch rule for it: every call to the number starts its own room with the room prefix `sip` and dispatches the agent `sitelog-voice` (the console's Telephony → Dispatch rules, rule type _individual_, or `lk sip dispatch create <rule.json>`; a _callee_ rule with _randomize_ on works the same and keeps the caller's number out of LiveKit's room names, spec §19 Q228). LiveKit names the room itself (`sip_+1…_<random>`); any prefix works, because the agent keys an inbound call by the room's sid (`RM_…`), never its name (spec §19 Q227), and the name goes into no SiteLog row or log line. On the first test call check the call's row: `select id, transport, provider_call_id, status from calls order by created_at desc limit 1;` shows `pstn` and `RM_…` (read only). If the agent log shows `calls/start` refused with 400, the deployed agent predates Q227: `lk agent deploy` from this branch (Talk now is not affected).
9. **The pack's voice number:** `SUPABASE_DB_URL='<preview connection string>' pnpm countries:set -- --code US --voice +1… --yes`. Texts and the field app then offer "or call {number}". A phone call finds only reporters of **real** orgs (§19 Q44): for phone tests add the tester's phone as a reporter of a non-demo org on the preview project (panel → Team; the reporter's consents through their link first), else the call is an unknown caller (F13).
10. **The M7 runs** (W3-16 Done when). The scripts are `fixtures/calls/*.json` with a `simulate` block (11: EN and ES; `start.transport` says phone or Talk now; the reporter's lines are in `reporterTurns`). Say each script's reporter lines on a real call, by phone and by Talk now, EN and ES; one Turkish Talk now call as Emre Yıldız (Demir Yapı) must file Kartal's report in Turkish. After each call note its id and check the filed report in the panel (P7 plays the call). `pnpm simulate:call -- --live` (TTS reporter audio into a room) is not built (§19 Q212): the live runs are by voice. The calls of the run:

```sql
select id, transport, language, outcome, duration_s, metrics->>'latencyP50Ms' as p50, created_at
  from calls order by created_at desc limit 20;
```

**Latency:** `SUPABASE_DB_URL='<preview connection string>' pnpm voice:latency -- --days 1` prints, per transport (`sip` the number, `web` Talk now) and language, the turn latency p50 / p95, barge-in, interruptions and call length, each marked `ok`, `OVER` or `n/a` against F6 (≤ 1.2 s p50, ≤ 2.5 s p95, barge-in ≤ 300 ms, a typical call ≤ 6 min). It only reads: its session and transaction are read-only, so it is safe on any database. `--from 2026-10-19 --to 2026-10-20` for a given day (UTC), `--json` for the numbers, `--check` exits 1 when a measured target is over. Calls ended since §19 Q226 carry every turn's latency and each barge-in's stop time, so the latency is pooled over turns and barge-in is measured; a group with a call from before Q226 is pooled from each call's own p50 / p95, and barge-in reads "not measured" when no call holds a stop time (then judge it by ear: the agent must stop within a breath of being talked over). M7 asks for ≤ 1.2 s p50; record the output and the call ids in W3-16. 11. **Voice listening test** (§9.1, §19 Q1, Q225). With `DEEPGRAM_API_KEY` and `AZURE_SPEECH_KEY` in the shell (or the root `.env`): `pnpm voice:samples` writes `voice-samples/<lang>/<voice>/<line>-24k.wav` and `-8k.wav` (Talk now and a phone line) for the disclosure, two read-backs and the filed goodbye, rendered by code as on a call, plus `voice-samples/lines.txt` with the texts; `--voice <id>` adds a candidate (two more Aura-2 EN and ES voices from Deepgram's catalogue, Q225), `--lang tr` one language, `--dry-run` only prints the lines. Pick by ear on the 8 kHz files first, set `TTS_VOICE_EN/ES/TR` in the agent's secrets file and `lk agent update-secrets`. The Turkish voice is also checked on numbers and company names in a Talk now call (Q1).

**Back out.** Talk now off: `supabase secrets unset --project-ref <preview ref> LIVEKIT_URL` (field-api then answers `talkNow: false`). Phone off: delete the number's dispatch rule, then `pnpm countries:set -- --code US --clear-voice --yes` on that database. The agent: `lk agent delete` (or leave it idle; it costs nothing without calls). Nothing here changes the database schema or another environment.

### Country packs per environment (GAP D47, W1-06a)

Everything country-specific is a row of `countries` (spec §4.6): languages, units, paper, currency, default time zone, message channel order, SMS and WhatsApp provider, SMS sender type, two-way SMS, links in SMS, legal keys. Two kinds of value:

- **Policy values change only by migration** (a new forward migration, with `packages/shared/src/demo/countries.ts` changed in the same commit; `pnpm test:db` fails until the fixture equals the rows). A new country is a new `insert into countries`.
- **Per-environment values** (`sms_sender_id`, `voice_number`, and since W2-15 `whatsapp_sender_id` and `whatsapp_templates`) are null in every migration and set per database with `pnpm countries:set`, which calls the service-only `set_country_endpoints()`, prints the target (never the password) and the pack before and after, and writes one `country.endpoints_set` audit row. No migration writes these two columns, with one exception: a migration that changes a pack's `sms_sender_type` sets its `sms_sender_id` to null in the same update. The table's check rejects a sender id that does not fit its type, so a type change that keeps a set sender fails at push time on that database; set the new sender afterwards with `pnpm countries:set`.

```sh
SUPABASE_DB_URL='<the database>' pnpm countries:set -- --code TR --sms-sender SITELOG           # after the BTK title is approved
SUPABASE_DB_URL='<the database>' pnpm countries:set -- --code US --sms-sender +1888…           # the verified toll-free number
SUPABASE_DB_URL='<the database>' pnpm countries:set -- --code US --voice +1…                   # the LiveKit number, once bought
SUPABASE_DB_URL='<the database>' pnpm countries:set -- --code TR --clear-sms-sender            # back to console
SUPABASE_DB_URL='<the database>' pnpm countries:set -- --code TR --print-whatsapp-templates    # the template bodies to submit (no write)
SUPABASE_DB_URL='<the database>' pnpm countries:set -- --code TR --whatsapp-sender +90… --whatsapp-templates tr-templates.json
```

**WhatsApp (W2-15, spec §4.4, §19 Q39).** The owner's setup, once per pack and environment: (1) a Twilio WhatsApp sender for the pack's number, which needs Meta business verification (lead time days to weeks; the Twilio WhatsApp Sandbox serves a developer's own phone meanwhile); (2) print the template bodies with `--print-whatsapp-templates` (the pack's voice number decides the "or call" clauses: set it first) and submit each key in each of the pack's languages through Twilio's Content Template Builder as a Utility template, keeping its `{{1}}…` numbering; (3) once Meta approves them, write the content sids to a file `{"daily_link": {"en": "HX…", "es": "HX…"}, …}` and set it with the sender; (4) point the sender's incoming-message and status webhooks at `sms-webhook` (the same URL and `/status` as SMS, `X-Twilio-Signature` with the same auth token). Until a sender is set, demo orgs get `console` WhatsApp rows in the Demo phone and real orgs get SMS (§19 Q84); a key without an approved template goes by SMS outside the 24-hour window. `--clear-whatsapp-sender` takes WhatsApp out of every real org's order at once.

A Twilio sender (the US pack) also needs its messaging webhook in the Twilio console: HTTP POST to `{SMS_WEBHOOK_URL}#rp=ct,rt,5xx&rc=3`. The fragment is Twilio's connection override (retry a connection failure, a read timeout or a 5xx up to three times; Twilio's default `rp=ct` retries connection failures only). `sms-webhook` stores the text and enqueues the worker's `sms_inbound` job before it answers, so these retries cover a failure before that point; a retry of a text already stored joins the same job (spec §9.5). Twilio does not send the fragment, so the signature still covers `SMS_WEBHOOK_URL` exactly; after registering, check that the first inbound text is stored (an `sms.received` audit row, no `sms.webhook.bad_signature` in the function logs). Delivery callbacks need no setting: each send names `{SMS_WEBHOOK_URL}/status` (`supabase/functions/README.md`).

Before a real US sender is set (spec §19 Q45, decided 2026-10-15), put the sender on a Messaging Service with **Advanced Opt-Out** and set its STOP and HELP replies to SiteLog's own texts per language (`stop_confirm` and `help` in `packages/shared/src/copy/sms.en.ts` and `sms.es.ts`; the HELP text without the personal link, which Twilio cannot fill: "SiteLog daily reports. Text CALL or TEXT to switch · STOP to opt out. Msg & data rates may apply."). When Twilio recognises STOP, START or HELP it sends `OptOutType` with the text; SiteLog then records the opt-out (or its end) and sends no reply of its own, so the reporter gets one answer. A HELP that Twilio does not recognise (no `OptOutType`) still gets SiteLog's `help` with the link.

A local stack needs no more flags; a hosted database needs the owner's approval and `--yes`, and the staging project also `--allow-staging`. **Never set a sender before its registration is approved** (US toll-free verification, the TR BTK title): from that moment every message of every non-demo org on that pack goes out from it. A pack with no sender keeps real customers on `console`, which reaches no phone: their texts are written `failed` (`console: no SMS sender set for pack <code>`, link codes masked, visible in the staging Demo phone), the welcome leaves the reporter uninvited and tells the office that texts to that country are not live yet, and device codes are not sent at all (spec §4.5, §19 Q48). Demo orgs (`is_demo`) stay on `console` whatever the pack holds, so seeding or re-seeding them never texts anyone.

### Auth email templates (W4-09)

The sign-in (magic link) and invite emails come from Supabase Auth, not the worker. Each is one Go template with an English and a Turkish body, chosen by the user's metadata `ui_locale` (`tr-TR` or `tr` → Turkish; anything else, or none → English; spec §13, §19 Q239): `supabase/templates/magic_link.html` and `supabase/templates/invite.html`, with their subjects in `supabase/config.toml` (`[auth.email.template.magic_link]`, `[auth.email.template.invite]`). `api-invite-office-user` writes `ui_locale` (the admin's choice, else the org's locale) and `invited_org_name` into the invite; the sign-in page sends its EN/TR switch as `ui_locale` with `signInWithOtp`, which GoTrue keeps only when the request creates the user; for an existing user the panel writes the language they choose in the account menu while signed in into their metadata (`auth.updateUser`, §19 Q340), so their next sign-in email follows it (until they choose one, their invite's or sign-up's). The seeded demo users carry their org's `ui_locale`.

- **Local stack:** `supabase start` reads the files from `config.toml`; the emails land in Mailpit at `http://127.0.0.1:54324` (`apps/web/e2e/supabase/auth-email.spec.ts`, `@m11`, reads the Turkish one there). Restart the stack after editing a template.
- **Hosted projects (preview, staging, production): an owner step, with the owner's approval for each project.** `config.toml` is not deployed by `supabase db push` or the Deploy workflow. In the dashboard, Authentication → Emails → Templates: for **Magic Link** and for **Invite user**, paste the subject line from `config.toml` (the text between the quotes, with `\"` as `"`) and the whole HTML file as the body, and save. Send one test magic link to an address on the project's team with the panel's switch on Türkçe (a new address) and check the Turkish body. Supabase's default SMTP only mails the project's team members; real users need the project's own SMTP (Resend) set first.

### TR go-live (W4-13)

The owner's steps to send the TR pack's texts for real, from İletimerkezi with the `SITELOG` title, on the **preview** project first. Every step marked **owner-approved** touches a hosted system (İletimerkezi, a Supabase project, a worker against it, a real phone) and waits for the owner's approval, one step at a time; staging and production only after the owner says so. Nothing here runs in CI. Credentials go into the places named below (Supabase secrets, the worker's env file outside the repo), never into the repo or a chat. Where a step depends on İletimerkezi's own rules or API it says _confirm with İletimerkezi_: this repo has no account, no documentation and no real send (spec §19 Q280), so what it assumes is listed to be checked, not taken as fact. Background: spec §5.2 "Demo setup" step 7, §15.2 TR, §19 Q15, Q20, Q49, Q237, Q280, Q281.

**Before you start.** The preview project has this branch's migrations and functions (Deploy → environment `preview`, target `supabase`) and the field app pointing at it (`phone-setup`). `select code, sms_provider, sms_sender_type, sms_sender_id, two_way_sms from countries where code = 'TR';` (read only) shows `iletimerkezi`, `alphanumeric`, no sender and `false`. Counsel has answered §19 Q49 (the İYS message type), or the owner accepts its recommendation (informational) for the test. The Done when's KVKK link on the Welcome screen also needs the TR legal keys (W4-06's catalogue, this ticket's legal-keys migration with counsel's texts): the texts can go live without it, but the ticket is not done until it is in.

1. **İletimerkezi account** (owner-approved). Open a corporate account at İletimerkezi in the name of the entity that will send (_confirm with İletimerkezi_ the documents they need). New accounts come with test credits (spec §5.2: 100); the `APITEST` sender replaces the text with a fixed message, so it tests the API flow only, not SiteLog's texts.
2. **e-Devlet subscription approval** (owner-approved). Approve the account's subscription in e-Devlet as İletimerkezi asks for a new corporate sender (spec §5.2 step 7); lead time as İletimerkezi states.
3. **The `SITELOG` title (originator)** (owner-approved). Request the alphanumeric title `SITELOG` through the account (spec §5.2: about 1–2 business days). Ask at the same time which İYS message type the account is set up for, and set it to counsel's answer to §19 Q49 (the recommendation: informational, bilgilendirme). If counsel says commercial, stop: the order's İYS fields (§19 Q281) and the İYS consent check are not built for production. **Never set the sender in a database before the title is approved** (step 7): from that moment every non-demo TR org on that database texts from it.
4. **Questions for İletimerkezi** (owner, with the account; the answers go into spec §19 Q15 and Q280):
   - **The delivery report** (§19 Q280): the endpoint, its request and its answer for one order and number (delivered, undelivered, waiting); its status codes and which of them mean the number versus the account; how soon a report is ready and how long it is kept; the rate limit on report reads; whether the account offers a delivery-report push (callback) URL and how it is signed. A push URL is §19 Q280's second option (a new `sms-webhook` route, a developer ticket), not this runbook.
   - **The send request** as the driver assumes it (`createIletimerkeziSmsTransport` in `packages/shared/src/sms/transports.ts`): `POST /v1/send-sms/json` with `request.authentication {key, hash}` and `request.order {sender, sendDateTime, message {text, receipents {number[]}}}` (their spelling "receipents"), the number without `+`, the answer's `response.status.code` (`200` accepted) and `response.order.id`, and status code `450` as an unroutable number (`ILETIMERKEZI_UNDELIVERABLE_CODES`). Is each still current?
   - **The Turkish character table** (§19 Q15): does İletimerkezi send Turkish text with the Turkish national language single shift table (3GPP TS 23.038), so that ç, ğ, Ğ, ı, İ, ş and Ş stay GSM-7 as escape pairs (155 septets in a single segment, 149 per part), or as UCS-2 (70 / 67 characters)? Does it substitute or transliterate any character? The driver sends the text as is, and the TR texts are budgeted with the shift table (`packages/shared/src/sms/segments.ts`, `packages/shared/src/copy/sms-tr-budget.test.ts`: `welcome`, `weather_headsup` and `reminder_2` 2 segments, every other key 1; `reminder_2` is UCS-2 either way for the "â" of "hâlâ"). Without the table, the 1-segment keys that hold Turkish letters cost 2 and `welcome` 3 (§19 Q15's counts for a pack with no voice number). Then check it on step 9's welcome: the credits İletimerkezi charges for it.
5. **The report endpoint** (developer, after step 4; a code change in its own commit, nothing hosted). Fill `ILETIMERKEZI_REPORT_ENDPOINT` in `packages/shared/src/sms/iletimerkezi-report.ts` (`path`, `body(orderId, creds)`, `parse(json)` into `IletimerkeziReport`) from İletimerkezi's answer, with a test for each answer they gave (delivered, undelivered, not ready, unknown) beside the fixture endpoint's; correct the send request and the `450` code in the driver if step 4 says so; record the answers in spec §19 Q280 and Q15 and close README "İletimerkezi status". Until this lands the worker's `sms_status` job reads nothing and live İletimerkezi rows stay `sent`, so the Done when's `delivered` cannot be seen. Deploy it (preview functions and the worker) before step 9.
6. **Credentials as secrets** (owner-approved). Take the API key and hash from the account's API settings. The names are the ones the code reads (`.env.example`, `apps/worker/src/config.ts`, `supabase/functions/_shared/messaging.ts`). The functions send device codes (`field-api`), invites (`api-invite-reporter`), _Text today's link_ (`api-text-daily-link`), _Send me a test message_ (`api-test-message`) and the rest through the same drivers:

   ```sh
   supabase secrets set --project-ref <preview ref> \
     ILETIMERKEZI_API_KEY='<key>' ILETIMERKEZI_API_HASH='<hash>'
   # ILETIMERKEZI_IYS stays unset (= informational, §19 Q49's recommendation) unless counsel says otherwise
   ```

   The worker sends the welcome, the daily link and the reminders and runs the `sms_status` poll. The `preview-worker` Deploy target carries no SMS credentials, so run the worker from a developer machine against the preview project (as in "Voice: M7 live", "Before you start"), with these in its env file outside the repo (or `apps/worker/.env`, never committed):

   ```sh
   ILETIMERKEZI_API_KEY=<key>
   ILETIMERKEZI_API_HASH=<hash>
   ILETIMERKEZI_STATUS=poll        # the default; off leaves every row `sent`
   # ILETIMERKEZI_IYS unset (informational)
   ```

   Never set `SMS_PROVIDER_STUB`, `ILETIMERKEZI_API_BASE` or `TWILIO_API_BASE` on a hosted project or on a worker against one: they point the drivers at the local stand-in (W4-12; the worker refuses `SMS_PROVIDER_STUB` under `NODE_ENV=production`). `ILETIMERKEZI_IYS` takes only empty, `informational` or `commercial`; a typo refuses the driver instead of sending the wrong type. Back out: `supabase secrets unset --project-ref <preview ref> ILETIMERKEZI_API_KEY ILETIMERKEZI_API_HASH` and remove them from the worker's file, after step 7's back-out (with a sender set and no credentials, TR texts fail on a configuration error).

7. **The sender on the preview project** (owner-approved; only after step 3's approval):

   ```sh
   SUPABASE_DB_URL='<preview connection string>' pnpm countries:set -- --code TR --sms-sender SITELOG --yes
   ```

   It prints the target and the pack before and after and writes one `country.endpoints_set` audit row. Restart the worker: its boot line `sms transport per country pack` must show `iletimerkezi` for TR. Demo orgs (Demir Yapı) stay on `console` whatever the pack holds. Back out: `pnpm countries:set -- --code TR --clear-sms-sender --yes` on the same database; real TR orgs are back on `console` (texts written `failed`, nothing sent).

8. **A non-demo TR test org** (owner-approved). On the preview panel, sign up with an address that receives the project's mail (Supabase's default SMTP mails only the project's team members; "Auth email templates" above), run the setup wizard with country **Turkey** (the TR pack: tr-TR, the panel in Turkish, billing `manual` until §19 Q8), add one site, and in Team invite one reporter with the owner's Turkish mobile number. Optionally first Settings → Field channels → _Send me a test message_ to that number (admin, five an hour per org): it goes from `SITELOG` through the functions' driver and proves the functions' secrets alone.
9. **The real phone** (owner-approved; the Done when). On the TR phone:
   - The welcome arrives from `SITELOG`, in Turkish with its letters intact, one-way (the pack's `two_way_sms` is false: a reply reaches no one). Note the credits charged for it (step 4's table: 2 with the shift table).
   - Open the link, verify the device with the code (also from `SITELOG`), give the consent. The Welcome screen links the KVKK notice by its key once the TR legal keys are in.
   - The daily link: wait for the site's daily link time, or Team → _Text today's link_ (once the reporter has consented). It arrives from `SITELOG`.
   - The rows (preview SQL editor, read only):

     ```sql
     select created_at, copy_key, provider, provider_message_id, status, error
       from messages where provider = 'iletimerkezi' order by created_at desc limit 10;
     ```

     Each send is `sent` with `iletimerkezi:<order>`, then `delivered` at a poll (+2 min, +15 min or +2 h after the send; W4-11), once step 5 is in. An `undelivered` row walks to the next channel or tells the office once (`message_failed`). A row still `sent` after +2 h has an `sms.status_unresolved` audit row: compare the order in İletimerkezi's panel with step 5's parser.

   Record the date, the message ids (never the number) and the credits in the ticket report.

10. **Optional: the TR WhatsApp sender and templates** (owner-approved, after step 9). The TR pack's order is `push → whatsapp → sms`, so with a TR WhatsApp sender set, real TR orgs' texts go by WhatsApp first and SMS becomes the fallback: do it only after the SMS check. The steps are "Country packs per environment" → **WhatsApp (W2-15)** above with `--code TR`: a Twilio WhatsApp sender on a Turkish number (Meta business verification, lead time days to weeks); `pnpm countries:set -- --code TR --print-whatsapp-templates`; each key submitted in Turkish and English (the pack's field languages) as a Utility template; once approved, `--whatsapp-sender +90… --whatsapp-templates tr-templates.json --yes`; the sender's webhooks to `sms-webhook`. Counsel's §15.2 review covers the transfer to Meta and Twilio. Back out: `--clear-whatsapp-sender --yes`.

**Staging and production** later repeat steps 6, 7 and (for WhatsApp) 10 per project, each owner-approved; the account, the title and step 5's endpoint are shared.

### Billing (W4-15)

Stripe **test mode** on the **preview** project, then the F23 cycle on a non-demo test org. Every step that touches Stripe or a hosted Supabase project is **owner-approved**, one at a time. Keys go into Supabase secrets and the worker's env file outside the repo, never into the repo or a chat. Test-mode secret keys start `sk_test_`; no live key goes on the preview project. Background: spec F2 step 4, F23, P13, §13 Billing, §19 Q7, Q10, Q234, Q235, Q270; §2 step 9 above; `supabase/functions/README.md`.

What the code does, for reading the run: Checkout subscribes one unit per active site at the Stripe price `STRIPE_PRICE_ID_SITE_US` and keeps the rest of the org's 14-day trial (`trial_end` = the org's `trial_ends_at`); it refuses (409 `price_mismatch`) when that price's amount or currency is not the org's (`orgs.price_per_site_minor` + `price_currency`, USD 39900 from `billing_default_prices`). Adding or resuming a site raises the quantity with proration; pausing or archiving lowers it without a credit, from the next invoice (§19 Q10). The panel syncs the quantity at once, and the worker's `billing_sync` job retries it two minutes later. `stripe-webhook` verifies `Stripe-Signature`, processes each event id once (`stripe_events`) and maps Stripe into `orgs.billing_*`. A `manual` org (TR until §19 Q8) has no Checkout or portal: the run uses a US org.

1. **Stripe account in test mode** (owner-approved). Sign in to the Stripe Dashboard and switch to test mode. Live-mode business details wait for step 9.
2. **Product and price** (owner-approved). Product catalogue → a product (for example "SiteLog site") with one **recurring, monthly, per-unit** price of **USD 399.00** (standard pricing, licensed quantity; not metered, not tiered). Its amount must equal the org's price, 39900 in USD minor units, or Checkout answers 409 `price_mismatch`. The price id (`price_…`) is `STRIPE_PRICE_ID_SITE_US`.
3. **Customer portal** (owner-approved). Settings → Billing → Customer portal (test mode): allow updating the payment method and viewing invoices. Leave quantity changes off: SiteLog sets the quantity from the active sites, and its next sync overwrites a change made in the portal. Whether customers may cancel there is the owner's choice: a cancellation arrives as `customer.subscription.deleted`, the org becomes `canceled`, and reminders and calls stop at once.
4. **Webhook endpoint** (owner-approved). Developers → Webhooks → add the endpoint `https://<preview ref>.supabase.co/functions/v1/stripe-webhook` (deployed by the Deploy workflow's `supabase` target with `verify_jwt = false` from `supabase/config.toml`) with exactly the events the function handles (`HANDLED_EVENTS`, `supabase/functions/stripe-webhook/logic.ts`):
   - `checkout.session.completed`
   - `customer.subscription.created`
   - `customer.subscription.updated`
   - `customer.subscription.deleted`
   - `invoice.payment_failed`
   - `invoice.paid`

   Any other event is answered 200 and ignored (`stripe.webhook.ignored`). The endpoint's signing secret (`whsec_…`) is `STRIPE_WEBHOOK_SECRET`.

5. **Secrets** (owner-approved). On the preview project:

   ```sh
   supabase secrets list --project-ref <preview ref>     # names only: APP_URL must be the panel origin you test from
   supabase secrets set --project-ref <preview ref> \
     STRIPE_SECRET_KEY='sk_test_…' STRIPE_WEBHOOK_SECRET='whsec_…' STRIPE_PRICE_ID_SITE_US='price_…'
   ```

   `api-billing` and `stripe-webhook` read `STRIPE_SECRET_KEY`, `stripe-webhook` also `STRIPE_WEBHOOK_SECRET`, Checkout `STRIPE_PRICE_ID_SITE_US`; `APP_URL` gives Checkout's and the portal's return URLs (`/billing?checkout=success|canceled`, `/billing`) and is the `api-*` functions' CORS origin. If an old `STRIPE_PRICE_ID_SITE` is set, unset it once the new one is in (GAP 9.1). Give the worker the same `STRIPE_SECRET_KEY` in its env file (a worker from a developer machine against the preview project; the `preview-worker` Deploy target has no Stripe key, so its `billing_sync` only logs and the panel's sync is the only one). Then send a test event to the endpoint from the Dashboard: 200 means the signature passed; 400 `Invalid signature` means `STRIPE_WEBHOOK_SECRET` is not this endpoint's. Back out: `supabase secrets unset --project-ref <preview ref> STRIPE_SECRET_KEY STRIPE_WEBHOOK_SECRET STRIPE_PRICE_ID_SITE_US` and disable the endpoint.

6. **A non-demo US test org** (owner-approved). On the preview panel, sign up with an address that receives the project's mail, run the wizard with country **United States** (billing `stripe`, USD 399.00 per site, a 14-day trial) and add one site. Billing shows the trial and one site at $399.00. Note the org id (`select id, name, billing_provider, billing_status, trial_ends_at from orgs where not is_demo order by created_at desc limit 3;`, read only).
7. **Short grace on the test org** (owner-approved, preview SQL editor, this org only; not audited, so note it in the ticket report): `update org_settings set past_due_grace_days = 0 where org_id = '<test org>';` (default 14). Set it back to 14 after the run.
8. **The run** (W4-15 box 2; tick each in the ticket report with the Stripe object ids, never card numbers or email addresses):
   - [ ] **Checkout keeps the trial.** As the org's admin, Billing → _Add payment details_ → Stripe Checkout; pay with Stripe's success test card (Stripe's testing page). Back on Billing, "Subscription started". In Stripe the subscription is `trialing`, quantity 1, its trial ending at the org's `trial_ends_at`; in SiteLog the org is `trialing` with `billing_customer_id` and `billing_subscription_id` set (`checkout.session.completed`, `customer.subscription.created`), audited.
   - [ ] **Add site → quantity +1.** Add a second site. The subscription item's quantity is 2 at once (the panel's sync) or two minutes later (the worker's `billing_sync`, audited `billing.quantity_synced`), with a proration on the upcoming invoice; Billing lists two sites.
   - [ ] **Pause → next cycle.** Billing → _Sites on this plan_ → _Pause_ (admin only; Site detail's _Site settings_ too). Quantity 1, no proration credit: the lower amount applies from the next invoice. Audited `site.paused`; the site's reminders stop.
   - [ ] **Resume.** _Resume_ the site: quantity 2 again, prorated like an added site. Audited `site.resumed`.
   - [ ] **The portal.** Billing → _Update payment method_ opens Stripe's customer portal for this customer: the payment method can be changed and the invoices are listed; its return link comes back to `/billing`.
   - [ ] **Failed card → past due → banner → block.** In the portal, replace the card with Stripe's test card that attaches but is declined on charge (Stripe's testing page, declined payments; take the number from there). End the subscription's trial now from the Dashboard so Stripe invoices at once (confirm the Dashboard's current wording for it). Expect `invoice.payment_failed`: the org goes `past_due` (audited, the event type in the diff), the office gets the "Payment failed" notice (EN/TR), and the admin banner shows on every page. With step 7's zero grace the org is blocked at once: the banner says reminders and calls are paused, scheduler-tick stops the org's reminders, and the field app's Today offers no Talk now. With the default 14 days the block comes after the grace.
   - [ ] **Back to good** (optional). Put the success card back and pay the open invoice in the portal: `invoice.paid` moves the org to `active` and the banner goes.

   Afterwards: every delivery in the Dashboard's webhook log is 200; the function logs show no `stripe.webhook.bad_signature` or `stripe.webhook.org_not_found`; an event resent from the Dashboard answers `duplicate: true`.

9. **Live mode is a separate owner step, before the US pilot.** Not part of this run: Stripe's live-mode activation (the business and bank details Stripe asks for), the live product and USD 399.00 per-unit price, the live portal configuration, a live webhook endpoint on the **production** project with its own `whsec_…`, and the live `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` and `STRIPE_PRICE_ID_SITE_US` as that project's secrets and its worker's, each owner-approved. Test-mode and live-mode objects do not mix: a test price id with a live key (or the reverse) fails Checkout. TR billing waits for §19 Q8 and Q9: TR orgs stay `manual` until then (W4-15 box 3).

### Before the worker runs (typed reports)

Until WhatsApp and the AI keys are live, offices type reports in the panel (Reports → **New report**). `create_office_report()` files them and the panel renders each version's PDF in the browser (`@sitelog/pdf`, the same document as the worker), uploads it to `pdfs/` and records it with `attach_version_pdf()`; nothing is emailed. Office edits still enqueue `render_pdf` jobs (with the report-updated email). Before starting the worker for the first time, discard the backlog so customers do not get weeks-old update emails (at the W1-19 cut-over with `supabase/ops/discard-backlog.sql`, which does the same with an audit row, step 2 above):

```sql
update jobs set status = 'failed', last_error = 'discarded: queued before the worker existed'
where status = 'queued' and created_at < now() - interval '1 hour';
```

## 3. Day-to-day operations

- **Dead jobs**: open `/ops` in the panel (SiteLog operators only, §6): queue health per job type, dead jobs with **Retry** (back to `queued`, 5 fresh attempts, due now) and **Discard** (kept as `failed`, never runs again); both are written to `audit_log` (`ops.job_retried` / `ops.job_discarded`, `org_id` null, actor = the operator). Fix the cause first. The reporter already received `error_retry` once. SQL fallback: `select id, type, payload, last_error from jobs where status = 'dead' order by id desc;` then `update jobs set status = 'queued', attempts = 0, run_after = now() where id = <id>;` (not audited).
- **Cost outliers** (§15 cost guardrail): every filed report gets an AI + WhatsApp estimate in `report_costs.cost_cents` (worker, refreshed after later jobs on the report). A report above 3× the median of its kind over the previous 30 days (once 20 reports exist) logs `report cost outlier` (warn, with `org_id`, `report_id`, `cost_cents`, `median_cents`), sends a Sentry warning when `SENTRY_DSN` is set and is listed on `/ops`. Look at the report's jobs (`select type, attempts, payload->'metrics' from jobs where payload->>'reportId' = '<uuid>';`): retries, a very long voice note or a reminder storm are the usual causes. Rates: `COST_WA_TEMPLATE_USD` (worker env, default 0.004 per v1.0 template), `COST_SMS_USD` (0.0083 per text) and `COST_WHATSAPP_TEMPLATE_USD` (0.009 per Twilio WhatsApp template; W2-15, the report's Notifier messages, `messages.payload.report_id`) and `TRANSCRIPTION_USD_PER_MINUTE` / the Claude rates in `apps/worker/src/ai/cost.ts`.
- **Stuck running jobs** (their worker died mid-job) are reclaimed automatically after 10 minutes (`claim_jobs`; the worker's `STALE_LOCK_MS`). A live worker refreshes `locked_at` of its running jobs every minute, so they are never reclaimed while their handler runs. A job that outlives `JOB_TIMEOUT_MS` (5 min by default) has its AbortSignal aborted (its Claude, transcription, SMS, storage, weather and WhatsApp calls stop) and is failed with `JobTimeoutError` only once the handler has stopped; a handler that ignores the abort for 30 s is reported to Sentry ("still running after its timeout") and keeps its slot until it ends (W1-10). A new job that is due now sends `NOTIFY jobs, '<id>'` from `enqueue_job`; the worker's LISTEN session shows in `pg_stat_activity` as `application_name = 'sitelog-worker-listen'`.
- **Retries and dead jobs** (spec §10.1, GAP D17): a failed attempt waits 30 s, 2 min, 10 min, 30 min, then 2 h; the sixth failure makes the job `dead` (Sentry, `/ops`, audit `job.dead`). A dead message job to or from a reporter puts a `message_failed` notice in the org's panel (ops, admin), a dead report step a `processing_failed` one (admin, pm, ops), spec §19 Q54. Retrying a dead job from `/ops` runs the same row again: a dedupe key belongs to one job for good (D16), so enqueueing the same key again returns the dead job and runs nothing.
- **Web reports: extraction and questions (W1-12)**: a web recorder report runs `transcribe_upload` → `extract_report` (extraction v2 on `CLAUDE_MODEL`; without `ANTHROPIC_API_KEY` the job fails and retries, then dies as `processing_failed`, in every environment: the fixture extractor answers only when `EXTRACT_PROVIDER=fake` is set, which production refuses) → `decide_next` (one question at a time on channel `web`, or the draft). The reporter is texted `question_ready` / `draft_ready` only when none of their devices called `field-api` in the last 30 s (D25; a skip is audited `notify.skipped`, reason `device_active`). A report stuck in `processing` usually has a voice note without transcript or a dead `extract_report`: `select type, status, dedupe_key, last_error from jobs where payload->>'reportId' = '<uuid>' order by id;`. Changing `fixtures/expected` means regenerating the CI replays: `pnpm eval -- --write-recorded`, then `pnpm format`; a keyed `pnpm eval` is the model's real check.
- **Re-render a PDF**: `select enqueue_job('render_pdf', jsonb_build_object('reportId', '<uuid>', 'version', <n>, 'emailRecipients', false));`
- **Reminders not firing**: check `scheduler_state.last_tick`, the pg_cron job (`select * from cron.job_run_details order by start_time desc limit 20;`) and that `site_days` for today exist with the right `deadline_at` (site time zone + DST).
- **A reporter changed phones**: Team → row menu → Disable, then Invite reporter with the new number (messages are matched by number, so Team → Edit only changes name, role, sites and languages).
- **Retention**: the nightly `retention_cleanup` job deletes audio/photos older than `AUDIO_RETENTION_DAYS` (default 730), photos uploaded in the panel that no report attached after a day (`photos/{org}/{site}/office/`, listed by `list_orphan_office_photos()`), and `done` jobs finished more than 30 days ago (dead and discarded jobs stay for `/ops`). Reports and PDFs are kept; a deleted file's transcript goes, and its `uploads` row (`purged_at`) or WhatsApp message (`storage_path` null, `payload.purged_at`) stays, so the report keeps the photo or voice note in its sources and versions, without a file.
- **Backups**: Supabase PITR/daily backups; restore drill = restore to a branch project, run `pnpm test:db` against it, check the latest `reports` row.

## 4. Incident playbooks

| Symptom                                | Likely cause                                 | Action                                                                                                                                                                                                                           |
| -------------------------------------- | -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Webhook returns 401                    | `WA_APP_SECRET` mismatch                     | compare with the Meta app secret; replay a fixture with `--secret`                                                                                                                                                               |
| Messages stored, nothing happens       | worker down or `SUPABASE_DB_URL` wrong       | `/health`, worker logs, `select count(*) from jobs where status='queued'`                                                                                                                                                        |
| Jobs start only every 5 s              | no LISTEN (`/health` `listening: false`)     | `SUPABASE_DB_LISTEN_URL` must be a session-mode connection (not port 6543); worker logs                                                                                                                                          |
| "Writing your report…" never completes | OpenAI/Anthropic outage or quota             | jobs retry with backoff; reporters get `error_retry` once; panel shows Processing delayed                                                                                                                                        |
| Processing never ticks "Transcribed"   | Deepgram key, quota or outage                | `select last_error from jobs where type = 'transcribe_upload' and status <> 'done'`; `DeepgramError 401` is the key; jobs retry with backoff, a dead one tells the office (`processing_failed`) and can be re-queued from `/ops` |
| Template send fails (131047 / 132001)  | outside 24 h window or template not approved | check template status in Meta Business Manager; the worker falls back to templates automatically                                                                                                                                 |
| Reminders fire at the wrong hour       | site `timezone` wrong                        | fix the site; `deadline_at` is recomputed when the next site-day is created                                                                                                                                                      |
| PDF missing fonts                      | font files not in the image                  | rebuild the worker image; fonts live in `apps/worker/src/pdf/fonts`                                                                                                                                                              |
| Billing banner "past due"              | Stripe payment failed                        | customer portal link in Billing; reports keep flowing for `past_due_grace_days`                                                                                                                                                  |

## 5. Security reminders

- Service-role key only in edge functions and the worker. Never in the browser.
- Storage buckets are private; the panel uses 10-minute signed URLs.
- Phone numbers never go to an LLM. Transcripts are data, not instructions (system prompt rule 9).
- Every state change is in `audit_log`; report versions are immutable.

## 6. SiteLog operators (`/ops`)

`/ops` is for SiteLog staff, not for customers: it shows every org's queue, dead jobs and cost outliers. Access comes from the `platform_admins` table (migration `20261012000003_ops.sql`), never from an org role — a customer's org admin gets the "Page not found" page, and every `ops_*` RPC refuses them. The table has RLS with no policies, so it is only managed with the service role (SQL editor or `psql "$SUPABASE_DB_URL"`).

Add an operator (they sign in with a magic link first so `auth.users` has the row; they also need one org membership to get past the setup wizard, e.g. a SiteLog-internal org):

```sql
insert into platform_admins (user_id, note)
select id, 'on-call, added 2026-10-12 by <you>' from auth.users where email = '<operator@sitelog.app>'
on conflict (user_id) do nothing;
```

Remove one: `delete from platform_admins where user_id = (select id from auth.users where email = '<operator@sitelog.app>');` · List: `select u.email, p.note, p.created_at from platform_admins p join auth.users u on u.id = p.user_id;`

The page reloads every 30 s. Dead-job payloads are reduced to ids and enum-like fields and errors are redacted (phone numbers, emails), so no customer message content is shown there; open the job in SQL when the full payload is needed.

**Billing per organisation (W4-10, spec §19 Q234, Q236).** The card lists every org with its provider (`stripe`, or `manual`: SiteLog invoices it, a TR org until §19 Q8), status, price per active site and active sites. _Edit_ sets or clears the price (`ops_set_org_price()`: amount in the currency's main unit plus an ISO code; empty clears it, and the org's Billing page then says SiteLog sets it) and, for a `manual` org only, its billing status (`ops_set_org_billing_status()`: past due starts the org's grace days, then reminders and calls pause; canceled or paused blocks at once). Both are audited (`billing.price_set`, `billing.status_changed` with `via: ops`). A Stripe org's status follows Stripe and is refused here. A Stripe org's new price also needs a Stripe price of that amount (Checkout refuses a mismatch, §19 Q270). The default price of a currency is the `billing_default_prices` table (USD 39900 by migration); a TRY row waits for §19 Q9 and is added by a migration or, on a hosted project, by SQL with the owner's approval.

## 7. Load test (§16.2 M9)

`pnpm loadtest` pushes N voice-note reports (default 500 arriving over 30 min) through the worker the way production runs it: the webhook ingest (`apps/worker/src/integration/webhook.ts`, the decisions of `whatsapp-webhook`), `createRunner().start()` (claim_jobs → handlers), the router, PDF rendering and every SQL statement. Meta, OpenAI, Claude, Storage, the email provider and ffmpeg are fakes that answer from `fixtures/` (the single-voice-note golden cases, round-robin) after a sampled latency. Simulated reporters send a photo 0–40 s after the note, tap the first option of a question (or send a photo when asked for one) and press **OK, file it** 10–45 s after the draft. The same fakes drive the integration test (`src/integration/pipeline.integration.test.ts`, part of `pnpm --filter @sitelog/worker test`).

```sh
pnpm loadtest -- --reports 24 --time-scale 0.05       # smoke run on PGlite, ~30 s
pnpm loadtest                                         # 500 reports, 1 instance × 4 (WORKER_CONCURRENCY default)
pnpm loadtest -- --instances 4 --concurrency 6 --time-scale 0.1 --json /tmp/loadtest.json
DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55432/postgres pnpm loadtest -- --instances 4 --concurrency 6 --time-scale 0.1
```

`-- --help` lists the knobs: latency per service in scale-1 seconds (`--transcribe 8-20` for a 3-min note, `--claude 12-35`, `--claude-fast`, `--wa`, `--media`, `--email`, `--storage`), `--think`, `--photo-delay` / `--no-photo`, `--fail-rate` (transient errors; retries then follow the real `fail_job` backoff, which runs on database time and is not scaled), `--cases`, `--seed`, `--timeout`, `--keep`.

**Reading the output.**

- _Time scale._ Simulated latencies, think time, the arrival window and the poll interval are multiplied by `--time-scale`, and the worker runs on a virtual clock 1/scale times faster than the wall clock, so latencies print in scale-1 seconds. CPU and database time are not scaled, so in virtual time they are stretched by 1/scale: the printed latencies are an upper bound. Use the largest scale you have time for.
- _At scale 1._ Slot-seconds per report = how long a report's jobs hold worker slots (simulated waits at full length + real CPU/DB). Capacity = instances × concurrency × 1800 / slot-seconds; the line says whether 500 reports in 30 min is met and how many slots it needs at 100 % and 70 % busy.
- _Intake races_ counts site-days that got more than one report, reporters told "Got the photos…" after their voice note had arrived, extractions that ran before the transcript existed, and golden cases whose replays closed in different ways (e.g. some `filed`, one `no_work`): each case replays the same transcript, so a mix means a race decided it (known issue below). _Phone numbers sent to Claude_ must be 0.

**Databases.** Without `DATABASE_URL` the run boots PGlite (every migration) in-process: one Postgres session behind one connection on the worker's event loop. That is fine for correctness and the projection, and pessimistic for latency. For timings use a scratch Postgres with `supabase/migrations` applied. Never point it at a database someone is using: it creates its own org (`Load test <id>`, deleted at the end unless `--keep`), but the runner claims every due job in the queue and runs one timeout sweep at start. A throwaway one from the Supabase image (the storage schema normally comes from the storage service, so stub it first):

```sh
docker run -d --name sitelog_loadtest_db -p 127.0.0.1:55432:5432 -e POSTGRES_PASSWORD=postgres supabase/postgres:17.11.0.004
export PGPASSWORD=postgres
until psql -h 127.0.0.1 -p 55432 -U postgres -d postgres -c 'select 1' >/dev/null 2>&1; do sleep 1; done
psql -h 127.0.0.1 -p 55432 -U supabase_admin -d postgres -v ON_ERROR_STOP=1 <<'SQL'
create table if not exists storage.buckets (id text primary key, name text, public boolean default false);
create table if not exists storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text references storage.buckets, name text, owner uuid, metadata jsonb);
create or replace function storage.foldername(name text) returns text[] language sql immutable
  as $$ select (string_to_array(name, '/'))[1:array_length(string_to_array(name, '/'), 1) - 1] $$;
alter table storage.buckets owner to postgres;
alter table storage.objects owner to postgres;
SQL
for f in supabase/migrations/*.sql; do psql -h 127.0.0.1 -p 55432 -U postgres -d postgres -v ON_ERROR_STOP=1 -q -f "$f" || break; done
# afterwards: docker rm -f sitelog_loadtest_db
```

**Results (2026-10-12, golden-case mix, default latencies).**

| Run                                                                | Site-days closed    | Received → question/draft p50 / p95   | OK → PDF p95 | Ack p95 | Slot-s per report | 500 / 30 min         |
| ------------------------------------------------------------------ | ------------------- | ------------------------------------- | ------------ | ------- | ----------------- | -------------------- |
| PGlite, 24 reports, 1 × 4, scale 0.05                              | 24 / 24             | 108 / 123 s (window 5 min, saturated) | 79 s         | 32 s    | 46                | no (≈ 150 / 30 min)  |
| PGlite, 500 reports, 1 × 4, scale 0.02                             | 40 / 500 at timeout | 51 / 80 min                           | 74 min       | 26 min  | 47                | no (≈ 150 / 30 min)  |
| Postgres 17, 500 reports, 4 × 6, scale 0.1                         | 500 / 500           | 61 / 90 s                             | 26 s         | 10 s    | 55                | yes (≈ 790 / 30 min) |
| Postgres 17, 500 reports, 2 × 10, scale 0.1, after the queue fixes | 500 / 500           | 46 / 61 s                             | 7 s          | 4.7 s   | 44                | yes (≈ 830 / 30 min) |

**Sizing.** A report holds a worker slot for ≈ 44 s (transcription, one extraction, the WhatsApp/storage/email calls; ≈ 0.3–1 s of it CPU and database), so one instance at the default `WORKER_CONCURRENCY=4` files ≈ 160 reports per 30 min. 500 in 30 min needs ≥ 13 slots, ≈ 18 to keep queues short. `apps/worker/fly.toml` runs 2 machines × `WORKER_CONCURRENCY=10` (each instance opens concurrency + 2 database connections). The worker is I/O-bound, so raising `WORKER_CONCURRENCY` is cheaper than adding machines until PDF rendering (≈ 0.2–0.35 s of CPU per report, on the event loop) starts to delay the other jobs of that instance.

**Fixed after the first runs** (`20261012000004_queue_fairness.sql` and the worker, 2026-10-12):

- FIFO claiming let acks wait behind transcription and extraction (ack p95 26 min saturated). `claim_jobs()` now claims acks and replies first, then filing, PDF and the report email, then transcription and extraction, then background jobs.
- Intake race: messages of one conversation were routed by two slots at once (two reports for one site-day, a wrong "Got the photos…", an extraction before the transcript whose empty draft looked like a day off). Jobs now carry `lock_key = convo:<id>` (inbound, transcription, reply parsing, extraction, decide_next, filing): one at a time per conversation, in order. At most one live report per site-day (unique index). Extraction waits for every voice note's transcript, and the F10 reroute needs the note to say nobody worked.
- A photo that arrived during extraction triggered a second extraction (≈ 1.5 Claude calls per report). The photo now waits for the extraction and rides along (`syncDraftPhotos`), so a report costs one extraction; a captioned photo arriving mid-extraction is still re-read.

## 8. End-to-end tests against a local Supabase stack

CI runs them in the `e2e-supabase` job (`.github/workflows/ci.yml`). Locally, with Docker running:

```sh
supabase start -x studio,imgproxy,logflare,vector,supavisor,postgres-meta   # applies migrations + seed; keep Mailpit (W4-09)
set -a; eval "$(supabase status -o env)"; set +a
pnpm e2e:supabase      # builds the panel in Supabase mode and signs in a seeded user via generateLink
```

The specs live in `apps/web/e2e/supabase/`; the payroll CSV and EOT pack tests need the edge runtime (`supabase start` serves `supabase/functions`; put dummy values for their env in `supabase/functions/.env`). Where AWS ECR is blocked, prefix `supabase start` with `SUPABASE_INTERNAL_IMAGE_REGISTRY=docker.io`.

The `worker` project (`apps/web/e2e/supabase/worker/`, W1-08: invite → the welcome text in the Demo phone → the personal link resolves at field-api → HELP) needs the worker on the same stack, with the functions' `LINK_SIGNING_SECRET`; without a worker at `WORKER_HEALTH_URL` (default `http://127.0.0.1:8080/health`) it is skipped locally. Run it after the other specs, as CI does, since those expect their jobs to stay queued:

```sh
pnpm --filter @sitelog/web e2e:supabase --project=supabase
SUPABASE_DB_URL="$DB_URL" SUPABASE_URL="$API_URL" SUPABASE_SERVICE_ROLE_KEY="$SERVICE_ROLE_KEY" \
  EMAIL_PROVIDER=console LINK_SIGNING_SECRET=<the value in supabase/functions/.env> \
  FIELD_APP_URL=http://localhost:5174 pnpm dev:worker &
pnpm --filter @sitelog/web e2e:supabase --project=worker
```

The field app's flow (`apps/field/e2e/supabase/`, W1-09: a reporter of its own demo org opens the personal link → device check with the console code → consent → record with Chromium's fake microphone → upload → Processing; `pnpm --filter @sitelog/field e2e:supabase`, also the second half of `pnpm e2e:supabase`) serves the field build on `http://localhost:4176` with `/api` proxied to the stack. `supabase/functions/.env` must list that origin (`CORS_EXTRA_ORIGINS=http://localhost:4174,http://localhost:4176`) and set `STORAGE_PUBLIC_URL=http://127.0.0.1:54321`, so the signed upload URLs name the gateway the browser reaches instead of the Edge Runtime's `http://kong:8000`; restart the stack after editing it. The spec deletes its org afterwards.

**The M6 acceptance suite (W2-17, spec §16.2 M6).** Every spec of an M6 flow is tagged `@m6` and its flow (`@F4` … `@F16`; the map is in `docs/DEMO_NOTES.md`, "The same flows in CI"); `pnpm e2e:m6` runs them, the panel's config then the field app's, both projects each. It needs the whole setup above at once: the stack, `supabase/functions/.env` with CI's values (`SCHEDULER_CLOCK_OVERRIDE=true` for the F11 ticks, `CORS_EXTRA_ORIGINS` with `http://localhost:4176`, `STORAGE_PUBLIC_URL`, `TWILIO_AUTH_TOKEN`), and the worker with CI's environment (`TRANSCRIBE_PROVIDER=fake`, `EXTRACT_PROVIDER=fake`, `EMAIL_PROVIDER=console`, `WORKER_CLOCK_OVERRIDE=true`, `WORKER_CLOCK_START=2026-10-12T22:46:30Z`, the functions' `LINK_SIGNING_SECRET`), then `WORKER_HEALTH_URL=http://127.0.0.1:8080/health pnpm e2e:m6`. The F15 spec signs in a throwaway admin of its fixture org for the Demo phone's STOP and START (`ANON_KEY` from `supabase status -o env`) and deletes it after. Never against a hosted project: the specs write and delete rows with the service role, and the clock overrides must stay off there.

**Self-serve onboarding (W4-12, spec §16.2 M10).** `pnpm e2e:onboarding` runs `apps/web/e2e/supabase/worker/self-serve.spec.ts` (`@m10` US, `@m11` TR): a new user per pack signs up, makes a **real** org, a site and the manager's invite; the welcome and the device code go through the real drivers to the local SMS stand-in; the manager files by link and the next day by Talk now (the agent's `/voice/*` requests); the panel lists both reports. Locally: `pnpm sms:stand-in` (port 4010, all interfaces); `supabase/functions/.env` with `SMS_PROVIDER_STUB=true`, `TWILIO_API_BASE` and `ILETIMERKEZI_API_BASE` at `http://host.docker.internal:4010` (the Edge Runtime container reaches the host there), dummy `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `ILETIMERKEZI_API_KEY`, `ILETIMERKEZI_API_HASH`; the worker with the same at `http://127.0.0.1:4010` plus the M6 environment above; then `pnpm countries:set -- --code US --sms-sender +18885550100` and `-- --code TR --sms-sender SITELOG` on the local stack, and `WORKER_HEALTH_URL=… SMS_STAND_IN_URL=http://127.0.0.1:4010 VOICE_AGENT_TOOL_SECRET=… pnpm e2e:onboarding`. It runs last in CI's e2e-supabase job because the senders make every real org's later texts go to the stand-in. **Never set `SMS_PROVIDER_STUB` on a hosted project** (the worker refuses it under `NODE_ENV=production`); the owner's live run (W4-16) uses the real US sender and a real phone instead.

**The M10 and M11 acceptance suites (W4-16, spec §16.2 M10, M11).** `pnpm e2e:m10` runs every panel spec tagged `@m10` (both projects: Team, Settings and Billing on the seed and a new customer; Call now, Call me now and the US self-serve run with the worker) and `pnpm e2e:m11` every spec tagged `@m11` (the panel's Demir Yapı and Turkish pages, the TR wizard, the Turkish magic link and the TR self-serve run, then the field app's `worker` project: Demir Yapı's link report in Turkish with its PDF read by `pdftotext`, and the Turkish scripted calls through the call simulator). Both need the self-serve setup above (the stand-in, the senders set with `countries:set`, the worker with the M6 environment), Mailpit on the stack (the office-user invite and the magic link), `VOICE_AGENT_TOOL_SECRET`, and `pdftotext` (poppler-utils) for the M11 PDF text; then `WORKER_HEALTH_URL=… SMS_STAND_IN_URL=http://127.0.0.1:4010 VOICE_AGENT_TOOL_SECRET=… pnpm e2e:m10` and the same for `pnpm e2e:m11`. They write to the §18 seed (Kestrel's settings, Marco's channel and devices, Demir Yapı's settings, a typed Ataşehir report on Oct 8, a Kartal report today) and put back what they change, except the reports, which a re-run on the same stack works around; `supabase db reset` starts clean. CI runs them last, after the senders. The owner's run on the preview project is `docs/DEMO_NOTES.md` "Week 4".

`supabase/functions/.env` needs `TWILIO_AUTH_TOKEN` (any value) for `sms-webhook`'s Twilio routes (the signed inbound and status callbacks, which the fixture replays below hit; the Demo phone's `/demo-reply` checks the office JWT instead and never reads it). To replay Twilio payloads against it: `pnpm replay-webhook -- --sms-url http://127.0.0.1:54321/functions/v1/sms-webhook --token <that value> --to <a pack's sender id> fixtures/sms/inbound-help.json` (`fixtures/sms/README.md`); a sender id no pack has in that database is ignored, so set one first with `pnpm countries:set` on the local stack only.
