# SiteLog

**Talk. It's logged.** At the end of the day the site manager taps a text link and records a 3-minute voice report on the phone, or takes a call from SiteLog's voice assistant and talks. SiteLog turns it into an official daily site report (PDF), subcontractor hours and a weather-delay record. The office reviews everything in a web panel. Markets: US and Turkey.

The product and build spec is `docs/SITELOG_SPEC.md` (v1.2) — read it first. This README covers the repository.

**Status: moving from spec v1.0 to v1.2.** The repo was built against v1.0, whose field channel was WhatsApp, and that build is what runs on staging today (https://staging-sitelog.netlify.app). v1.2 replaces WhatsApp with SMS plus a personal link to a mobile web recorder (`apps/field`) and with a voice assistant. The work happens on the `spec-v1.2` branch, ticket by ticket (`docs/PLAN_WEEK1.md`); `docs/GAP_ANALYSIS.md` records what exists, what is missing, what conflicts and the migration plan. Until a piece is migrated, the WhatsApp code keeps working.

## Repository

```
apps/web                 Vite + React office panel (demo mode needs no backend)
apps/field               (planned, W1-04) field web recorder, Vite + React PWA, reached by a text link
apps/voice-agent         (planned, week 2) Python LiveKit Agents voice assistant
apps/worker              Node 22 job runner: transcription, Claude extraction, PDFs, email, weather, SMS (v1.2);
                         today also WhatsApp media and replies
packages/shared          Zod schemas, enums, pure helpers shared by web, worker and edge functions (Node/browser/Deno)
packages/pdf             The §12 report and §F16 evidence pack as react-pdf documents (worker + browser)
supabase/migrations      Postgres schema, RLS, RPCs, job queue, storage/realtime/pg_cron wiring (forward-only)
supabase/functions       Deno edge functions: scheduler-tick, api-*, stripe-webhook, whatsapp-webhook (until
                         WhatsApp is retired); v1.2 adds field-api, sms-webhook, voice-events
supabase/db-tests        Migrations + seed + RLS/RPC tests on PGlite (no Docker needed)
supabase/ops             inventory.sql: the read-only staging inventory the Deploy workflow runs
supabase/seed.sql        Generated §18 demo data (Kestrel Build Group)
fixtures                 Webhook payloads, golden transcripts, expected extractions, recorded tool outputs
scripts                  replay-webhook, seed-demo, db-types-drift
docs                     SITELOG_SPEC.md (v1.2), PLAN_WEEK1.md, GAP_ANALYSIS.md, RUNBOOK.md, AUDIT_BACKLOG.md,
                         design/ (artboards), brand/ (kit SVGs), decisions/
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

**Target (spec v1.2, §4.3).** Built ticket by ticket on `spec-v1.2`; see `docs/PLAN_WEEK1.md`.

1. The worker texts the site manager a personal daily link (SMS). The link opens the field web recorder; `field-api` resolves it to reporter, site and date and verifies the device (the field app never gets a database session).
2. The manager records one or more clips and adds photos. Each file goes straight to Storage with a signed URL; `field-api` records an `uploads` row and enqueues `transcribe_upload`.
3. The worker claims the job (`claim_jobs`, `FOR UPDATE SKIP LOCKED`), transcribes with Deepgram (OpenAI as fallback) and runs the Claude `submit_daily_report` tool with the site context and glossary.
4. Code validates the draft, recomputes every total and either asks one question on the recorder (buttons) or shows the draft.
5. **Confirm & send** files the report: the version is frozen, denormalised rows are written, the PDF is rendered, the office gets it by email, the manager gets an SMS with the PDF link, and the Overview flips to Filed in real time.
6. The voice assistant (week 2) does the same over a phone call, or a **Talk now** call in the browser: it asks questions in the call, reads the report back and files it on a spoken "yes".

**What runs on staging today (spec v1.0, WhatsApp).** Meta posts the voice note to `whatsapp-webhook` (signature verified, de-duplicated on `wa_message_id`), which stores the message and enqueues `inbound_message`. The worker downloads the audio, converts it with ffmpeg, transcribes it with OpenAI, extracts with Claude, asks a question with WhatsApp buttons or sends the draft card, and files on "OK", sending the PDF back on WhatsApp and by email. `scheduler-tick` (pg_cron, every 5 min) creates site-days, pulls weather, runs the reminder ladder and escalates missing reports. Offices can also type a report in the panel (below). `docs/GAP_ANALYSIS.md` lists what is kept, replaced and removed.

## Deliberate deviations from the spec

| Area            | Spec                                       | Here                                                                                                                                                                                                                                                                                                                                                                      | Why                                                                                                                   |
| --------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Node            | Node 20                                    | Node 22 (`.nvmrc`, `engines >=22.12`, CI)                                                                                                                                                                                                                                                                                                                                 | Vitest 5 needs Node ^22.12 and Node 20 reached end of life on 2026-04-30; Node 24 later (GAP D1)                      |
| pnpm            | pnpm 9                                     | pnpm 10.28 (`packageManager`, lockfile)                                                                                                                                                                                                                                                                                                                                   | lockfile and CI use it; corepack picks it (GAP D2)                                                                    |
| React, Vite     | React 18                                   | React 19, React Router 7, Vite 8 (with Tailwind 4, Zod 4, Vitest 5)                                                                                                                                                                                                                                                                                                       | the stack the repo was built and tested on (GAP D3)                                                                   |
| Test runner     | one Vitest workspace file                  | a Vitest config per package, run by `pnpm -r test` (`pnpm test`)                                                                                                                                                                                                                                                                                                          | same result; each package keeps its own environment (jsdom, node, PGlite) (GAP D5)                                    |
| Tailwind        | `tailwind.config.ts`                       | Tailwind v4 CSS-first tokens in `packages/shared/src/tokens.css` (the shared "preset"), imported after Tailwind by `apps/web/src/styles/tokens.css`; the same values in `packages/shared/src/tokens.ts` for the PDF and email                                                                                                                                             | Current Tailwind; same token names; one source for every app (GAP D4)                                                 |
| Org creation    | insert policy on `orgs`                    | `create_org()` RPC                                                                                                                                                                                                                                                                                                                                                        | `INSERT … RETURNING` under RLS cannot see the row before membership exists                                            |
| Aggregate views | `security_invoker`                         | owner-privileged views with an explicit org-membership filter                                                                                                                                                                                                                                                                                                             | lets `accounts` users read hours without a policy on `reports`                                                        |
| "stop" command  | not stored                                 | `site_days.reminders_paused`                                                                                                                                                                                                                                                                                                                                              | reminders must know it; missing escalation still reaches the office                                                   |
| Extra columns   | —                                          | marked `-- +` in `supabase/migrations/20261011000002_tables.sql`                                                                                                                                                                                                                                                                                                          | needed by flows F3/F10/F18/F19 (ladder toggles, PDF settings, `reports.kind`, `notifications`, job dedupe keys)       |
| Timeouts (§7.2) | unspecified owner                          | worker sweeps every 60 s                                                                                                                                                                                                                                                                                                                                                  | keeps the scheduler stateless                                                                                         |
| Seed            | hand-written SQL                           | generated from `packages/shared/src/demo/kestrel.ts`                                                                                                                                                                                                                                                                                                                      | the same dataset powers the web demo mode and the DB tests                                                            |
| DB types        | `supabase gen types`                       | hand-maintained `packages/shared/src/db/types.ts`, compared with `supabase gen types` in CI (`db-types-drift`)                                                                                                                                                                                                                                                            | stricter than generated types (literal unions, non-null view columns); drift fails CI                                 |
| Reporter number | "Edit number" (§F3)                        | Team → Edit changes name, role, sites and languages only; a new number = Disable + Invite reporter                                                                                                                                                                                                                                                                        | messages, conversations and WhatsApp verification are keyed by the number                                             |
| PDF zips        | "Today's PDFs (zip)", "Export PDFs (.zip)" | built in the browser from 10-minute signed URLs (`fflate`, stored), at most 200 reports per export; a report without a stored PDF is rendered first (Browser PDFs)                                                                                                                                                                                                        | no zip worker job; PDFs are already compressed                                                                        |
| `/ops`, cost    | "admin of SiteLog only"; cost per report   | `platform_admins` + `ops_*` RPCs; worker-written `report_costs` table (cents), not a column                                                                                                                                                                                                                                                                               | SiteLog staff are not an org role; cost is internal and must not reach customers through `reports` RLS                |
| Typed reports   | reports arrive by WhatsApp only            | Reports → **New report**: the office types a site's day in the report editor; `create_office_report()` files it as v1 (`office_user`, no reporter, not "confirmed"); a crew company added with **Add new…** (here or in Edit) becomes a confirmed company of the org, linked by id and audited                                                                            | pilots before the WhatsApp number and the AI keys are live; an explicit office action, so nothing is filed by a model |
| Browser PDFs    | the worker renders every PDF               | the panel renders a version's PDF with the same `@sitelog/pdf` document when it has none (typed reports, office edits, the demo; from the report page, the archive row and the zip export), uploads it and calls `attach_version_pdf()`                                                                                                                                   | PDFs without a running worker; the worker still renders and emails once it runs                                       |
| Office photos   | photos arrive by WhatsApp                  | New report / Edit upload to `photos/{org}/{site}/office/`; `p_photos` of `create_office_report()` / `create_report_version()` stores each as a `messages` row (`org_id`, no conversation) + `report_sources` photo; a version shows its `data.photos`; unattached uploads are deleted in a day                                                                            | typed reports need photos; the report page, Photos tab, PDFs, evidence pack and retention read them like WhatsApp's   |
| Report data     | `schemaVersion: 2` (§10.3)                 | `report_versions.data` is v1 or v2 (`StoredReportDataSchema`, `packages/shared/src/schemas/report.ts`); every reader (panel, PDFs, email, evidence pack) reads the v2 view through `readReportData()` / `upgradeV1toV2()`; stored v1 is never rewritten; writers and the Claude tool stay v1 until W1-12 (the office editor saves a version in the shape it is stored in) | the live data is v1 and writers move one at a time (GAP D20; spec §19 question 16 for the v1 values with no v2 form)  |

The running v1.0 build follows the v1.0 spec's §19 recommendations (shared WhatsApp number, worker + ffmpeg, Open-Meteo, 14-day trial, confirm-to-file, 2-year audio retention, imperial units, $399). The v1.2 §19 decisions (LiveKit, Twilio + İletimerkezi, shared numbers per country, device-code link security, …) and the owner's answers are tracked in `docs/GAP_ANALYSIS.md` §6 and §8.

## Scripts

| Command                                           | What                                                                           |
| ------------------------------------------------- | ------------------------------------------------------------------------------ |
| `pnpm dev` / `pnpm dev:worker`                    | Web panel / worker in watch mode                                               |
| `pnpm build`                                      | Build web (Vite) and worker (tsup)                                             |
| `pnpm typecheck` · `pnpm lint` · `pnpm test`      | Across the workspace                                                           |
| `pnpm test:db`                                    | PGlite migration, seed, RLS and RPC tests                                      |
| `pnpm seed:demo`                                  | Regenerate `supabase/seed.sql` from the demo dataset                           |
| `pnpm brand`                                      | Copy the kit SVGs from `docs/brand/` to the panel; render favicons and lockup  |
| `pnpm replay-webhook -- fixtures/webhooks/*.json` | Replay Meta payloads against a local webhook (signs them with `WA_APP_SECRET`) |
| `pnpm eval`                                       | Golden-transcript extraction evals, 26 cases (needs `ANTHROPIC_API_KEY`)       |
| `pnpm eval -- --recorded` / `--case <id>`         | Score the recorded tool outputs offline / run a subset (`--list` shows cases)  |
| `pnpm e2e`                                        | Playwright on the demo build: smoke, screenshots, axe WCAG 2.2 AA + keyboard   |
| `pnpm e2e:supabase`                               | Playwright against a local Supabase stack (`supabase start`, see RUNBOOK §8)   |
| `pnpm loadtest`                                   | N reports through the real job loop on PGlite or `DATABASE_URL` (RUNBOOK §7)   |

## Licences

Fonts: Archivo and IBM Plex Mono under the SIL Open Font License (see `packages/pdf/src/fonts/`). Weather data: Open-Meteo (CC BY 4.0) — attributed on reports and evidence packs.
