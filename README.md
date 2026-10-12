# SiteLog

**Talk. It's logged.** Site managers send one WhatsApp voice note at the end of the day; SiteLog turns it into an official daily site report, subcontractor hours and a weather-delay record. The office reviews everything in a web panel.

The product and build spec is `docs/SITELOG_SPEC.md` — read it first. This README covers the repository.

## Repository

```
apps/web                 Vite + React office panel (demo mode needs no backend)
apps/worker              Node 22 job runner: WhatsApp media, transcription, Claude extraction, PDFs, email, weather
packages/shared          Zod schemas, enums, pure helpers shared by web, worker and edge functions (Node/browser/Deno)
supabase/migrations      Postgres schema, RLS, RPCs, job queue, storage/realtime/pg_cron wiring
supabase/functions       Deno edge functions: whatsapp-webhook, scheduler-tick, api-*, stripe-webhook
supabase/db-tests        Migrations + seed + RLS/RPC tests on PGlite (no Docker needed)
supabase/seed.sql        Generated §18 demo data (Kestrel Build Group)
fixtures                 Webhook payloads, golden transcripts, expected extractions, recorded tool outputs
scripts                  replay-webhook, seed-demo
docs                     SITELOG_SPEC.md, RUNBOOK.md
```

## Quick start

```bash
corepack enable && pnpm install

# Web panel on demo data (no Supabase, no keys)
VITE_DEMO=true pnpm dev            # http://localhost:5173 — sign in with any email

# Everything that runs offline
pnpm check                         # typecheck + lint + unit tests (shared, worker, web, scripts)
pnpm test:db                       # migrations + seed + RLS/RPC tests on PGlite
pnpm --filter @sitelog/worker render-sample-pdf   # writes a sample daily report PDF to apps/worker/tmp/
```

Real environment: copy `.env.example` to `.env`, create a Supabase project, run the migrations (`supabase db push`) and `supabase/seed.sql` if you want the demo org, deploy the edge functions, start the worker (`pnpm dev:worker`) and the web app with `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY`. Step by step in `docs/RUNBOOK.md`.

## How a report flows

1. Meta posts the voice note to `whatsapp-webhook` (signature verified, de-duplicated on `wa_message_id`), which stores the message and enqueues an `inbound_message` job. No AI work in the webhook.
2. The worker claims the job (`claim_jobs`, `FOR UPDATE SKIP LOCKED`), downloads the audio, converts OGG → MP3 with ffmpeg, transcribes it with segment timestamps, and runs the Claude `submit_daily_report` tool with the site context and glossary.
3. Code validates the draft (`validateReport`), recomputes every total, and either asks one question with tap-able buttons or sends the draft card.
4. "OK" files the report: the version is frozen, denormalised rows are written, the PDF is rendered and sent back on WhatsApp and by email, the Overview flips to Filed in real time.
5. `scheduler-tick` (pg_cron, every 5 min) creates site-days, pulls weather, runs the reminder ladder and escalates missing reports to the office.

## Deliberate deviations from the spec

| Area            | Spec                                       | Here                                                                                               | Why                                                                                                             |
| --------------- | ------------------------------------------ | -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Tailwind        | `tailwind.config.ts`                       | Tailwind v4 CSS-first tokens in `apps/web/src/styles/tokens.css`                                   | Current Tailwind; same token names                                                                              |
| Org creation    | insert policy on `orgs`                    | `create_org()` RPC                                                                                 | `INSERT … RETURNING` under RLS cannot see the row before membership exists                                      |
| Aggregate views | `security_invoker`                         | owner-privileged views with an explicit org-membership filter                                      | lets `accounts` users read hours without a policy on `reports`                                                  |
| "stop" command  | not stored                                 | `site_days.reminders_paused`                                                                       | reminders must know it; missing escalation still reaches the office                                             |
| Extra columns   | —                                          | marked `-- +` in `supabase/migrations/20261011000002_tables.sql`                                   | needed by flows F3/F10/F18/F19 (ladder toggles, PDF settings, `reports.kind`, `notifications`, job dedupe keys) |
| Timeouts (§7.2) | unspecified owner                          | worker sweeps every 60 s                                                                           | keeps the scheduler stateless                                                                                   |
| Seed            | hand-written SQL                           | generated from `packages/shared/src/demo/kestrel.ts`                                               | the same dataset powers the web demo mode and the DB tests                                                      |
| DB types        | `supabase gen types`                       | hand-maintained `packages/shared/src/db/types.ts`                                                  | no Supabase CLI in the build sandbox; regenerate when available                                                 |
| Reporter number | "Edit number" (§F3)                        | Team → Edit changes name, role, sites and languages only; a new number = Disable + Invite reporter | messages, conversations and WhatsApp verification are keyed by the number                                       |
| PDF zips        | "Today's PDFs (zip)", "Export PDFs (.zip)" | built in the browser from 10-minute signed URLs (`fflate`, stored), at most 200 reports per export | no zip worker job; PDFs are already compressed                                                                  |
| `/ops`, cost    | "admin of SiteLog only"; cost per report   | `platform_admins` + `ops_*` RPCs; worker-written `report_costs` table (cents), not a column        | SiteLog staff are not an org role; cost is internal and must not reach customers through `reports` RLS          |

Open decisions from §19 are left as the spec recommends (shared WhatsApp number, worker + ffmpeg, Open-Meteo, 14-day trial, confirm-to-file, 2-year audio retention, imperial units, $399).

## Scripts

| Command                                           | What                                                                           |
| ------------------------------------------------- | ------------------------------------------------------------------------------ |
| `pnpm dev` / `pnpm dev:worker`                    | Web panel / worker in watch mode                                               |
| `pnpm build`                                      | Build web (Vite) and worker (tsup)                                             |
| `pnpm typecheck` · `pnpm lint` · `pnpm test`      | Across the workspace                                                           |
| `pnpm test:db`                                    | PGlite migration, seed, RLS and RPC tests                                      |
| `pnpm seed:demo`                                  | Regenerate `supabase/seed.sql` from the demo dataset                           |
| `pnpm replay-webhook -- fixtures/webhooks/*.json` | Replay Meta payloads against a local webhook (signs them with `WA_APP_SECRET`) |
| `pnpm eval`                                       | Golden-transcript extraction evals, 26 cases (needs `ANTHROPIC_API_KEY`)       |
| `pnpm eval -- --recorded` / `--case <id>`         | Score the recorded tool outputs offline / run a subset (`--list` shows cases)  |

## Licences

Fonts: Archivo and IBM Plex Mono under the SIL Open Font License (see `apps/worker/src/pdf/fonts/`). Weather data: Open-Meteo (CC BY 4.0) — attributed on reports and evidence packs.
