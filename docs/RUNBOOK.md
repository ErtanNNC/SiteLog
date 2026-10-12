# SiteLog runbook

Operational guide for staging and production. The product spec is `SITELOG_SPEC.md`.

## 1. Environments

| Piece                                   | Where                                                  | Notes                                                                  |
| --------------------------------------- | ------------------------------------------------------ | ---------------------------------------------------------------------- |
| Postgres, Auth, Storage, Edge Functions | Supabase (staging + prod projects)                     | migrations in `supabase/migrations`, functions in `supabase/functions` |
| Worker                                  | Fly.io / Render / Railway container                    | `apps/worker/Dockerfile`; needs ffmpeg (in the image)                  |
| Web panel                               | Vercel / Netlify static                                | `apps/web`, `VITE_*` env vars                                          |
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

## 3. Day-to-day operations

- **Dead jobs**: `select id, type, payload, last_error from jobs where status = 'dead' order by id desc;` Fix the cause, then `update jobs set status = 'queued', attempts = 0, run_after = now() where id = <id>;`. The reporter already received `error_retry` once.
- **Stuck running jobs** are reclaimed automatically after 15 minutes (`claim_jobs`).
- **Re-render a PDF**: `select enqueue_job('render_pdf', jsonb_build_object('reportId', '<uuid>', 'version', <n>, 'emailRecipients', false));`
- **Reminders not firing**: check `scheduler_state.last_tick`, the pg_cron job (`select * from cron.job_run_details order by start_time desc limit 20;`) and that `site_days` for today exist with the right `deadline_at` (site time zone + DST).
- **A reporter changed phones**: Team → row menu → Disable, then Invite reporter with the new number (messages are matched by number, so Team → Edit only changes name, role, sites and languages).
- **Retention**: the nightly `retention_cleanup` job deletes audio/photos older than `AUDIO_RETENTION_DAYS` (default 730). Reports and PDFs are kept.
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
