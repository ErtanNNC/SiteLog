# SiteLog runbook

Operational guide for staging and production. The product spec is `SITELOG_SPEC.md`.

## 1. Environments

| Piece                                   | Where                                                  | Notes                                                                  |
| --------------------------------------- | ------------------------------------------------------ | ---------------------------------------------------------------------- |
| Postgres, Auth, Storage, Edge Functions | Supabase (staging, preview and prod projects)          | migrations in `supabase/migrations`, functions in `supabase/functions` |
| Worker                                  | Fly.io / Render / Railway container                    | `apps/worker/Dockerfile`; needs ffmpeg (in the image)                  |
| Web panel                               | Vercel / Netlify static                                | `apps/web`, `VITE_*` env vars                                          |
| Field app                               | Netlify static, its own site (GAP D42)                 | `apps/field`; `/api/*` → `field-api` by a build-generated `_redirects` |
| WhatsApp                                | Meta Cloud API                                         | one shared SiteLog number (§19 #1)                                     |
| AI                                      | OpenAI (transcription), Anthropic (extraction)         | model names are env vars                                               |
| Weather                                 | Open-Meteo Standard (commercial)                       | `WEATHER_API_BASE`, `WEATHER_API_KEY`                                  |
| Email                                   | Resend                                                 | `RESEND_API_KEY`, `EMAIL_FROM`                                         |
| Billing                                 | Stripe                                                 | per-site subscription quantity                                         |
| Monitoring                              | Sentry (web + worker), Supabase logs, worker `/health` |                                                                        |

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
5. **Auth**: enable email magic links; set the site URL to `APP_URL` and add `APP_URL/auth/callback` to redirect URLs; style the magic-link email template.
6. **Meta** (§9.1 checklist): verified business, WABA, number registered for Cloud API, display name "SiteLog", profile photo (`apps/web/public/brand/logo-avatar-circle.svg` exported to PNG), system-user token in `WA_ACCESS_TOKEN`, webhook URL `https://<ref>.supabase.co/functions/v1/whatsapp-webhook` with `WA_VERIFY_TOKEN`, subscribed field `messages`. Submit the six templates in §9.2 as **Utility / en** and wait for approval before inviting reporters.
7. **Worker**: set the env vars from `.env.example`, deploy the container, check `GET /health` returns `{ ok: true }` and that `jobs` rows move from `queued` to `done`.
8. **Web**: deploy with `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `VITE_APP_URL`, `VITE_WA_DISPLAY_NUMBER`, `VITE_SENTRY_DSN`.
9. **Stripe**: create the $399/month per-unit price (`STRIPE_PRICE_ID_SITE`), a webhook endpoint pointing at `stripe-webhook` with the events listed in `supabase/functions/README.md`, and the customer portal configuration.
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
- **Cut-over (W1-19).** The staging field site gets `--prod` from the live branch with `/api` to the staging project. Then set `FIELD_APP_URL` (and `LINK_SHORT_DOMAIN` until `sl.link` exists) on the staging project to the field site's URL, with the owner's approval.

#### The `preview` project (GAP D41, owner setup)

Pull-request previews and v1.2 migrations go to a second Supabase project, so nothing from `spec-v1.2` reads or writes staging data before the cut-over. Until it exists, PR previews build in demo mode (`VITE_DEMO=true`, the in-memory Kestrel data) and preview dispatches skip with a notice; PR #1 stays green either way.

1. Create a second free Supabase project (for example `sitelog-preview`). Note its project ref, database password and anon (or publishable) key.
2. GitHub → Settings → Environments → **New environment** `preview`. No required reviewers and no deployment-branch restriction: pull-request runs read it. (The first pull-request run after this change creates an empty `preview` Environment if it does not exist yet; then only add the values.)
3. In `preview` itself (a value missing there falls back to a repository or organization one): secrets `SUPABASE_ACCESS_TOKEN` (a Supabase personal access token; it is per account, so the staging one may be reused) and `SUPABASE_DB_PASSWORD` (the preview project's); variable `SUPABASE_PROJECT_REF` (the preview ref). Not `VITE_SUPABASE_ANON_KEY` yet (step 6): without it PR previews stay in demo mode. Do not add Netlify settings: previews deploy with the `staging` token as `pr-<n>` aliases.
4. Never copy staging's project values (ref, database password, URL, anon key) into `preview`; the personal access token may be shared. The workflow checks the project: a `preview` whose `SUPABASE_PROJECT_REF` is staging's makes the Supabase deploy fail before it links, and a PR preview that points at the staging project builds in demo mode with a warning.
5. With the owner's approval for each step: run **Deploy** from `spec-v1.2` with environment `preview` and target `supabase` (migrations and functions to the preview project); `supabase secrets set` on the preview project; add the preview origins (for example `https://pr-1--staging-sitelog.netlify.app/**`) to its Authentication redirect URLs so magic links work on the preview; seed it with the W1-06 apply mode once that exists.
6. Last, the variable `VITE_SUPABASE_ANON_KEY` (the preview project's anon or publishable key; `VITE_SUPABASE_URL` is optional, it is derived from the ref). This switches PR previews from demo mode to the preview project from the next push, so add it only once the project has its schema and the seed; before that the panel preview would be broken or empty after sign-in.

#### Staging inventory (read-only, W1-01 step 0)

Actions → Deploy → Run workflow → branch `spec-v1.2`, environment `staging`, target `inventory` (the live branch's own `deploy.yml` has no `inventory` target until the cut-over). It needs the staging `SUPABASE_*` settings above and writes everything to the run summary:

- `supabase migration list --linked` (this ref's migrations against the ones applied on staging);
- `supabase functions list`;
- the edge-function secret **names** (the CLI's digests are never printed);
- counts from `supabase/ops/inventory.sql`, run with `psql` through the session pooler that `supabase link` records (link runs without the database password, through the Management API only), in a `READ ONLY` transaction that is rolled back: orgs (the seeded Kestrel demo org by its fixed id, and the rest), conversations, messages (by type, with or without a conversation), transcripts, unknown senders, report sources by kind, reports by status, report versions by data schema version, reporters by status, jobs by type and status (and queued `render_pdf` jobs that would notify a reporter), notifications by kind, storage objects per bucket, whether the `sitelog-scheduler-tick` pg_cron job exists and is active, and whether its two Vault secrets exist. Counts and labels only, never row contents. `supabase/db-tests/src/inventory.test.ts` runs the same SQL on PGlite.

It never runs `db push`, `functions deploy` or `secrets set`. Copy the summary into PR #1. The backup (a `pg_dump` and a copy of the `audio`/`photos` buckets) is taken at the cut-over, right before the first `db push` to staging (W1-19), to a place the owner chooses: it holds personal data, and a dump taken now would be stale by then.

### Before the worker runs (typed reports)

Until WhatsApp and the AI keys are live, offices type reports in the panel (Reports → **New report**). `create_office_report()` files them and the panel renders each version's PDF in the browser (`@sitelog/pdf`, the same document as the worker), uploads it to `pdfs/` and records it with `attach_version_pdf()`; nothing is emailed. Office edits still enqueue `render_pdf` jobs (with the report-updated email). Before starting the worker for the first time, discard the backlog so customers do not get weeks-old update emails:

```sql
update jobs set status = 'failed', last_error = 'discarded: queued before the worker existed'
where status = 'queued' and created_at < now() - interval '1 hour';
```

## 3. Day-to-day operations

- **Dead jobs**: open `/ops` in the panel (SiteLog operators only, §6): queue health per job type, dead jobs with **Retry** (back to `queued`, 5 fresh attempts, due now) and **Discard** (kept as `failed`, never runs again); both are written to `audit_log` (`ops.job_retried` / `ops.job_discarded`, `org_id` null, actor = the operator). Fix the cause first. The reporter already received `error_retry` once. SQL fallback: `select id, type, payload, last_error from jobs where status = 'dead' order by id desc;` then `update jobs set status = 'queued', attempts = 0, run_after = now() where id = <id>;` (not audited).
- **Cost outliers** (§15 cost guardrail): every filed report gets an AI + WhatsApp estimate in `report_costs.cost_cents` (worker, refreshed after later jobs on the report). A report above 3× the median of its kind over the previous 30 days (once 20 reports exist) logs `report cost outlier` (warn, with `org_id`, `report_id`, `cost_cents`, `median_cents`), sends a Sentry warning when `SENTRY_DSN` is set and is listed on `/ops`. Look at the report's jobs (`select type, attempts, payload->'metrics' from jobs where payload->>'reportId' = '<uuid>';`): retries, a very long voice note or a reminder storm are the usual causes. Rates: `COST_WA_TEMPLATE_USD` (worker env, default 0.004 per template) and `TRANSCRIPTION_USD_PER_MINUTE` / the Claude rates in `apps/worker/src/ai/cost.ts`.
- **Stuck running jobs** are reclaimed automatically after 15 minutes (`claim_jobs`).
- **Re-render a PDF**: `select enqueue_job('render_pdf', jsonb_build_object('reportId', '<uuid>', 'version', <n>, 'emailRecipients', false));`
- **Reminders not firing**: check `scheduler_state.last_tick`, the pg_cron job (`select * from cron.job_run_details order by start_time desc limit 20;`) and that `site_days` for today exist with the right `deadline_at` (site time zone + DST).
- **A reporter changed phones**: Team → row menu → Disable, then Invite reporter with the new number (messages are matched by number, so Team → Edit only changes name, role, sites and languages).
- **Retention**: the nightly `retention_cleanup` job deletes audio/photos older than `AUDIO_RETENTION_DAYS` (default 730), photos uploaded in the panel that no report attached after a day (`photos/{org}/{site}/office/`, listed by `list_orphan_office_photos()`), and `done` jobs finished more than 30 days ago (dead and discarded jobs stay for `/ops`). Reports and PDFs are kept.
- **Backups**: Supabase PITR/daily backups; restore drill = restore to a branch project, run `pnpm test:db` against it, check the latest `reports` row.

## 4. Incident playbooks

| Symptom                                | Likely cause                                 | Action                                                                                           |
| -------------------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Webhook returns 401                    | `WA_APP_SECRET` mismatch                     | compare with the Meta app secret; replay a fixture with `--secret`                               |
| Messages stored, nothing happens       | worker down or `SUPABASE_DB_URL` wrong       | `/health`, worker logs, `select count(*) from jobs where status='queued'`                        |
| "Writing your report…" never completes | OpenAI/Anthropic outage or quota             | jobs retry with backoff; reporters get `error_retry` once; panel shows Processing delayed        |
| Template send fails (131047 / 132001)  | outside 24 h window or template not approved | check template status in Meta Business Manager; the worker falls back to templates automatically |
| Reminders fire at the wrong hour       | site `timezone` wrong                        | fix the site; `deadline_at` is recomputed when the next site-day is created                      |
| PDF missing fonts                      | font files not in the image                  | rebuild the worker image; fonts live in `apps/worker/src/pdf/fonts`                              |
| Billing banner "past due"              | Stripe payment failed                        | customer portal link in Billing; reports keep flowing for `past_due_grace_days`                  |

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
supabase start -x studio,imgproxy,logflare,vector,supavisor,postgres-meta,mailpit   # applies migrations + seed
set -a; eval "$(supabase status -o env)"; set +a
pnpm e2e:supabase      # builds the panel in Supabase mode and signs in a seeded user via generateLink
```

The specs live in `apps/web/e2e/supabase/`; the payroll CSV and EOT pack tests need the edge runtime (`supabase start` serves `supabase/functions`; put dummy values for their env in `supabase/functions/.env`). Where AWS ECR is blocked, prefix `supabase start` with `SUPABASE_INTERNAL_IMAGE_REGISTRY=docker.io`.
