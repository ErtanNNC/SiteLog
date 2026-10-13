# SiteLog — gap analysis against spec v1.2

Kickoff A, steps 2–3 (`docs/START_HERE.md:57-63`). Written 2026-10-13 on branch `spec-v1.2` at `cc956dd`.

**Later changes.** Line references, the summary (section 1) and the status tables describe `cc956dd`. Notes marked **Done in W1-xx**, **Since W1-xx**, **Split in W1-xx** or "(W1-xx: …)" record what changed after it and supersede the text they annotate.

**How to read this.** References are repo-relative `path:line`. "v1.0" means the WhatsApp build that this repo implements; "v1.2" means `docs/SITELOG_SPEC.md` and `docs/PLAN_WEEK1.md`. GitHub Actions runs are cited by run id. The hosted Supabase project (`abuanbyzttuqksdctqcp`) could not be queried in this read-only audit, so statements about its data are marked "expected" or "not verified".

**Status meanings.** _done_: every Build item and the Done-when are met as v1.2 describes them (a recorded, equivalent deviation still counts). _partial_: a meaningful part exists or is directly reusable. _missing_: essentially nothing exists. _conflicts_: an implementation exists that contradicts the ticket and needs rework or a decision first.

**Effort sizes** are relative: S (a small PR) < M < L < XL (several PR-sized steps).

---

## 1. Summary

### 1.1 What the repo is today

- A pnpm monorepo built to spec v1.0, where site managers report by **WhatsApp** voice note (`README.md:3`, `README.md:39-45`), plus later office-side work: typed reports, office photos, browser-rendered PDFs, PDF zip export, crew hours and invoices, weather and EOT evidence packs, glossary, team, settings, billing and a SiteLog-staff `/ops` page (`README.md:47-64`).
- **Live on staging.** The panel is at https://staging-sitelog.netlify.app (`docs/RUNBOOK.md:52`), deployed by `.github/workflows/deploy.yml` with netlify-cli. The last staging deploy was a manual `workflow_dispatch` from `claude/focused-newton-5v0u2q` at `388fc63` (run 38326562725). Its Supabase job's "Push migrations" and "Deploy edge functions" steps succeeded (`.github/workflows/deploy.yml:75-81`), so all 16 migrations are recorded on the linked project and every function configured in `supabase/config.toml:60-112` (9, including `whatsapp-webhook`) is deployed there. The project ref comes from the `staging` Environment variable `SUPABASE_PROJECT_REF` (`.github/workflows/deploy.yml:45`); it is not in the repo, and per the deployment note it is `abuanbyzttuqksdctqcp`. No hosted worker exists: the Fly.io job ran, but its configuration check skipped every deploy step because `FLY_API_TOKEN`/`FLY_APP` are empty (`.github/workflows/deploy.yml:97-105`).
- **This branch.** `spec-v1.2` adds the v1.2 kit (spec, plan, design artboards, channel decisions, kit env template and brand SVGs under `docs/`) and the merged `CLAUDE.md` (commit `cc956dd`). PR #1 (`spec-v1.2` → `claude/focused-newton-5v0u2q`) is open. CI is green on it (run 38377523610) and it has a panel preview at https://pr-1--staging-sitelog.netlify.app (run 38377523585).

### 1.2 What v1.2 asks

SMS plus a personal link to a mobile web recorder (`apps/field`, a PWA), and later a phone-call voice assistant; **no WhatsApp**. Field users never get a database session: a new `field-api` edge function authenticates them by link code plus device cookie (`docs/SITELOG_SPEC.md:936-945`). Transcription moves to Deepgram, report data moves to `schemaVersion 2`, the schema grows to 30 tables with consents, links, devices, uploads and calls, the panel becomes EN/TR and the field app EN/ES/TR, and a Turkish demo org joins the US one.

### 1.3 Ticket counts (W1-01 … W1-19)

| Status    | Count | Tickets                                                |
| --------- | ----- | ------------------------------------------------------ |
| done      | 0     | —                                                      |
| partial   | 8     | W1-01, W1-03, W1-10, W1-14, W1-16, W1-17, W1-18, W1-19 |
| missing   | 3     | W1-04, W1-07, W1-09                                    |
| conflicts | 8     | W1-02, W1-05, W1-06, W1-08, W1-11, W1-12, W1-13, W1-15 |

No ticket is _done_. W1-01 lacks the env merge, the brand files and the v1.2 README (W1-01: all three since done; see the W1-01 entry and D10); every other ticket depends on at least one of the field channel, the v1.2 schema, report data v2 or i18n. Several _partial_ tickets (W1-01, W1-03, W1-10, W1-14, W1-16, W1-17, W1-18, W1-19) also contain a local conflict (a version, WhatsApp wording, a data path or a deploy rule) that must change; those are listed under their conflicts. A ticket is _conflicts_ when the part that exists is itself the contradiction (W1-13: the only existing pieces, answer mapping and filing, are WhatsApp-shaped).

### 1.4 The biggest gaps and conflicts

1. **No v1.2 field channel at all.** `apps/field`, `field-api`, `sms-webhook`, the SMS drivers and the Demo phone do not exist (W1-04, W1-07, W1-08, W1-09). The only field path is WhatsApp: `supabase/functions/whatsapp-webhook` plus the worker's conversation router (`apps/worker/src/router/`).
2. **The schema is v1.0, WhatsApp-shaped and already live.** 6 of the 30 v1.2 tables are missing, 10 enums are missing and 5 differ, and `messages`, `transcripts`, `report_sources` and `questions` are keyed to WhatsApp messages. The 16 applied migrations cannot be replaced by the plan's "0001…0007, DDL verbatim"; v1.2 has to be reached with forward migrations (W1-05).
3. **Report data is `schemaVersion 1` with WhatsApp sources** (`packages/shared/src/schemas/report.ts:9-22`, `:240`). Stored versions are immutable, so readers must accept v1 and v2 (W1-02, W1-12, W1-14, W1-17).
4. **Delivery is wired to WhatsApp throughout the pipeline**: invite and welcome, questions and drafts, filing, PDF delivery, dead-job notices and the reminder ladder (`apps/worker/src/jobs/send_welcome.ts:26-33`, `apps/worker/src/jobs/decide_next.ts:26-27`, `apps/worker/src/pipeline/file.ts:153-177`, `apps/worker/src/jobs/render_pdf.ts:41-67`, `supabase/functions/scheduler-tick/index.ts:201`) (W1-08, W1-10, W1-12, W1-15).
5. **No i18n.** Panel copy is one English TypeScript object (`apps/web/src/copy/en.ts`, 1,858 lines, 38 lines mention WhatsApp); there is no i18next, no Turkish or Spanish, and the PDF is English and imperial only (W1-02, W1-03, W1-14).
6. **Transcription is OpenAI `whisper-1` on WhatsApp OGG converted to MP3**, not Deepgram Nova-3 on browser uploads (`apps/worker/src/ai/transcribe.ts:18`, `apps/worker/src/config.ts:38-39`) (W1-11).
7. **Deploy model does not match the kit.** There is no `main` branch; staging is deployed by manual dispatch with `--prod` from any ref; PR previews talk to the live staging database; there is no field site and no `/api/*` rewrite (W1-04, W1-19). (W1-01: staging deploys only from the live branch, and PR previews no longer read staging; see section 2.7, D40, D41.)
8. **Confirmed but deferred RLS defects** (`docs/AUDIT_BACKLOG.md:29-41`, `:234-264`) would fail the two-org × role suite that W1-05 asks for.

Plenty is reusable: the toolchain and CI, the panel shell and almost every page, the job queue and runner, extraction and validation, the PDF package, email, weather, the demo dataset's non-channel data, and the PGlite DB-test harness (section 5).

---

## 2. Repo snapshot (kickoff step 2)

### 2.1 Stack and versions

| Layer       | Repo (as built)                                                                                                                                            | v1.2 kit                                                                            |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Node        | 22 (`.nvmrc:1`; engines `>=22.12.0`, `package.json:7-9`; CI `node-version: 22`, `.github/workflows/ci.yml:23`; `node:22-slim`, `apps/worker/Dockerfile:3`) | 20 (`docs/PLAN_WEEK1.md:26`, `docs/SITELOG_SPEC.md:321`)                            |
| pnpm        | 10.28.0 (`package.json:6`), lockfile v9                                                                                                                    | 9 (`docs/START_HERE.md:25`)                                                         |
| TypeScript  | 5.9, strict + `noUncheckedIndexedAccess` (`tsconfig.base.json:8-9`)                                                                                        | 5, strict                                                                           |
| Panel       | Vite 8.3, React 19.3, React Router 7.18, Tailwind 4.3, TanStack Query 5, Zod 4, Sentry 11 (`apps/web/package.json:37-71`)                                  | Vite + React 18, Tailwind config preset, i18next EN/TR (`docs/SITELOG_SPEC.md:317`) |
| Tests       | Vitest 5.0.3 (needs Node `^22.12`, `pnpm-lock.yaml:3604-3606`), Playwright, PGlite                                                                         | Vitest workspace, Playwright                                                        |
| PDF         | `@react-pdf/renderer` 4.9 (`packages/pdf/package.json:16`)                                                                                                 | same                                                                                |
| Edge        | Deno 2, Supabase CLI 2.118.0, Postgres 17 (`supabase/config.toml:18`)                                                                                      | Postgres 15+ (DDL validated on 16)                                                  |
| Worker      | Node 22, postgres.js, OpenAI, Anthropic SDK, ffmpeg; Fly.io config (`apps/worker/fly.toml`)                                                                | Node 20, Deepgram, Twilio, LiveKit SDK                                              |
| Voice agent | none (no Python in the repo)                                                                                                                               | Python 3.11 + LiveKit Agents (week 2)                                               |

### 2.2 Folder layout versus Appendix A (`docs/SITELOG_SPEC.md:2099-2128`)

| Appendix A                                            | Repo                                                                                                                                                                                                                                     |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/web`                                            | Present.                                                                                                                                                                                                                                 |
| `apps/field`                                          | **Missing** (`ls apps` → `web`, `worker`).                                                                                                                                                                                               |
| `apps/worker/src/{jobs,ai,sms,voice,pdf}`             | `jobs/`, `ai/`, `pdf/` exist; also `wa/`, `router/`, `pipeline/`, `media/`, `email/`, `integration/`. No `sms/`, `voice/`.                                                                                                               |
| `apps/voice-agent`                                    | Missing (week 2).                                                                                                                                                                                                                        |
| `supabase/migrations`, `seed.sql`                     | 16 migrations; `seed.sql` is generated from `packages/shared/src/demo/kestrel.ts`.                                                                                                                                                       |
| `supabase/functions`                                  | Missing: `field-api`, `sms-webhook`, `voice-events`, `api-link-unknown-contact`, `billing-webhook`. Extra: `whatsapp-webhook`, `api-link-unknown-sender`, `api-invite-office-user`, `stripe-webhook` (plays the `billing-webhook` role). |
| `packages/shared`                                     | Present, with WhatsApp modules (`wa/`, `webhook/meta.ts`, `copy/whatsapp.ts`).                                                                                                                                                           |
| (not in Appendix A)                                   | `packages/pdf` (shared react-pdf documents) and `supabase/db-tests` (PGlite) — keep as layout deviations.                                                                                                                                |
| `fixtures/{voice,calls,transcripts,expected,sms}`     | `voice/` holds only a README; `webhooks/` holds 5 Meta payloads; `transcripts/`, `expected/`, `tool-outputs/` hold 26 golden cases; no `calls/`, `sms/`.                                                                                 |
| `scripts/{seed-demo,simulate-call,replay-webhook}.ts` | `scripts/src/seed-demo.ts`, `replay-webhook.ts` (Meta), `db-types-drift.ts`; no `simulate-call.ts`.                                                                                                                                      |

### 2.3 Panel pages that exist

Routes in `apps/web/src/app/routes.tsx:53-90`:

- Match §11.1: `/login`, `/auth/callback`, `/setup`, `/setup/:step`, `/` (Overview), `/sites`, `/sites/:siteId`, `/reports`, `/reports/:reportId`, `/hours`, `/weather`, `/team`, `/glossary`, `/settings/:section`, `/billing`, `*`. Settings sections are `reports`, `pdf`, `recipients`, `payroll` (`apps/web/src/app/settings/Page.tsx:23`).
- Extra (recorded deviations): `/reports/new` typed reports (`README.md:62`), `/ops` (`README.md:61`).
- Extra (WhatsApp): `/try` "Try it on WhatsApp" simulator, demo-only in the nav (`apps/web/src/components/shell/nav.ts:52-59`).
- Missing: `/dev/phone` (Demo phone, `docs/SITELOG_SPEC.md:1667`) and `/settings/channels` (`docs/SITELOG_SPEC.md:1665`).

All existing pages are real pages, not placeholders; `apps/web/src/app/ComingNext.tsx:7-8` is an unused placeholder component.

### 2.4 Backend

- **Supabase Edge Functions** (Deno), configured in `supabase/config.toml:60-112`: `whatsapp-webhook` (Meta, public), `scheduler-tick` (pg_cron, bearer secret), `stripe-webhook` (public), and JWT-verified `api-invite-reporter`, `api-link-unknown-sender`, `api-export-payroll`, `api-evidence-pack`, `api-billing`, `api-invite-office-user`. Shared helpers in `supabase/functions/_shared/` (error mapping, Zod parsing, audit, typed `enqueue_job`, CORS for the panel origin, `supabase/functions/_shared/http.ts:26-63`).
- **Worker** (`apps/worker`): Node job runner with 15 job types (`apps/worker/src/jobs/registry.ts:18-34`), a WhatsApp conversation router, OpenAI transcription, Claude extraction, PDF rendering, Resend email and Open-Meteo weather.
- **No Netlify Functions.** Git tracks no `netlify.toml` and no `netlify/` directory; the CLI deploy passes `--dir apps/web/dist` and no `--functions` (`.github/workflows/deploy.yml:217`).
- **Scheduling:** pg_cron calls `scheduler-tick` every 5 minutes via Vault secrets (`supabase/migrations/20261011000006_platform.sql:31-55`).

### 2.5 Database schema and migrations

- **16 migration files**, `20261011000001_enums.sql` … `20261013000005_office_photos.sql`. All are applied on `abuanbyzttuqksdctqcp`: `.github/workflows/deploy.yml:77` runs `supabase db push --linked`, and the Supabase job of run 38326562725 succeeded. They are forward-only history now (`CLAUDE.md:51`).
- **Tables:** 30 in `public` (26 in `20261011000002_tables.sql` plus `scheduler_state`, `stripe_events`, `platform_admins`, `report_costs`). Against the 30 tables of v1.2 §6.3: 23 share a name, `unknown_senders` is the WhatsApp form of `unknown_contacts`, 6 are missing (`consents`, `field_links`, `field_devices`, `uploads`, `calls`, `rate_limits`) and 6 are repo-only (`conversations`, `notifications`, `scheduler_state`, `stripe_events`, `platform_admins`, `report_costs`). Only 12 of the 30 v1.2 tables already match v1.2 (same columns, or the same plus repo additions); `jobs` also has every column but lacks the `UNIQUE` on `dedupe_key`. Full diff in Appendix 9.2.
- **Enums:** 17 in the repo (`supabase/migrations/20261011000001_enums.sql:6-23`) versus 25 in §6.2 (`docs/SITELOG_SPEC.md:500-525`). Appendix 9.3.
- **RLS** is enabled on every table (asserted by `supabase/db-tests/src/migrations.test.ts:35`), with `is_member`/`has_role` helpers (`supabase/migrations/20261011000004_rls.sql:6-16`). Confirmed, deferred defects are listed under W1-05.
- **Storage:** private buckets `audio`, `photos`, `pdfs`, `exports`, `logos`, `invoices`; no `calls` (`supabase/migrations/20261011000006_platform.sql:8-10`).
- **Realtime:** `site_days`, `reports`, `notifications`, `unknown_senders`, `evidence_packs`; no `messages` (`supabase/migrations/20261011000006_platform.sql:27`).
- **Job queue:** `enqueue_job` selects then inserts and dedupes only active jobs; no `pg_notify` (`supabase/migrations/20261011000005_rpcs.sql:31-45`, `supabase/migrations/20261011000003_indexes_views.sql:13`).
- **DB types** are hand-maintained in `packages/shared/src/db/types.ts` and compared with `supabase gen types` in CI (`.github/workflows/ci.yml:117-120`; deviation `README.md:58`).
- **Live data — not verified.** `supabase/seed.sql` (88 report versions, all `schemaVersion 1`) is applied only by a local `supabase start`/`db reset` (`supabase/config.toml:20-22`), not by `db push` (`README.md:37`). Whether staging holds the demo org, real customer orgs, office photos or WhatsApp traffic is an open question (section 8). `docs/RUNBOOK.md:58-63` suggests staging has run typed reports without a worker.

### 2.6 Netlify configuration

- **No `netlify.toml`.** The only Netlify files in git are `.github/netlify-sites.json` (one key, `staging`, `:2`) and `apps/web/public/_redirects` (one line: `/*  /index.html  200`).
- **Netlify does not build.** GitHub Actions builds the panel (`pnpm --filter @sitelog/web build`, `.github/workflows/deploy.yml:180`) and uploads `apps/web/dist` with `netlify-cli@27.10.2` (`.github/workflows/deploy.yml:217`). Base directory, build command and publish directory live in the workflow.
- **Site id:** `NETLIFY_SITE_ID` (empty in staging), else the environment's key in `.github/netlify-sites.json` (`.github/workflows/deploy.yml:190-193`), else find-or-create by name `sitelog-<environment>-<owner>` (`.github/workflows/deploy.yml:196-205`).
- **Redirects and functions:** only the SPA fallback; no `/api/*` rewrite to `field-api`; no functions directory.
- **Git-connected builds:** not visible from the repo. PR #1's head has no Netlify commit status, only Actions check runs, so its preview came from Actions.
- **Since W1-04 (step 7, D42, D43):** the field app deploys to a second site by the `field` job of `deploy.yml`, keyed `field-<environment>` in `.github/netlify-sites.json` (no key yet: the first run finds or creates `sitelog-field-<environment>-<owner>` with the same token and prints the id to add), never the panel's id, key or name. Still no `netlify.toml`: the field build writes `apps/field/dist/_redirects` with the `/api/*` proxy to `{project}/functions/v1/field-api/:splat` first and the SPA fallback second, and no `/api` rule without a Supabase URL (`apps/field/config/redirects.ts`; README deviation).

### 2.7 What a push triggers

| Event                                               | CI (`.github/workflows/ci.yml:3-7`)                   | Deploy (`.github/workflows/deploy.yml:11-15`)                                                                                                                       |
| --------------------------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Push to `spec-v1.2`, no PR                          | nothing                                               | nothing                                                                                                                                                             |
| Push to `spec-v1.2` while PR #1 is open             | 5 jobs (eval skipped, `.github/workflows/ci.yml:155`) | web job only: `--alias pr-1` preview built against **staging** Supabase (`.github/workflows/deploy.yml:38`, `:87`, `:133`, `:212-213`); no migrations, no functions |
| Push to `claude/**`                                 | all jobs except eval                                  | nothing                                                                                                                                                             |
| Push to `main`                                      | all jobs + eval                                       | staging, all targets, `--prod` — but `main` does not exist; creating it fires this                                                                                  |
| Manual dispatch (each workflow on its own), any ref | CI: all jobs + eval                                   | Deploy: staging or production, `db push` + functions + web `--prod` (or one target); no branch guard                                                                |

The `staging` GitHub Environment accepted the PR run from `spec-v1.2`, so nothing stops a dispatch from this branch replacing the live staging site.

**Deploy previews, as they work here.** The kickoff assumes Netlify builds every branch as a deploy preview (`docs/START_HERE.md:50-51`). Here a preview exists only while a PR is open, only for the panel, and it is built by Actions with the `staging` Environment's variables, so it reads and writes the live staging database (`.github/workflows/deploy.yml:9`, `:133-145`, `:212-213`). A push to `spec-v1.2` without an open PR gets no CI and no preview. PR #1 is that vehicle today (D41, D44).

**Since W1-01** (`.github/workflows/deploy.yml`, `docs/RUNBOOK.md` §2): a `plan` job runs first; staging and production deploys run only from the branch `claude/focused-newton-5v0u2q`, compared as a full ref so a tag of that name does not pass (D40); a Supabase deploy to any other Environment that resolves to the staging project ref fails before it links; the PR preview takes only the Netlify token and site from `staging` and its Supabase settings from the `preview` Environment, and builds in demo mode without them, never against staging (D41); a dispatch with environment `preview` runs the Supabase target only, from `spec-v1.2`; a dispatch with target `inventory` runs the read-only staging inventory from `spec-v1.2`. Until the cut-over the live branch runs its own pre-W1-01 `deploy.yml` (no guard, no `inventory` or `preview`), so those targets are dispatched from `spec-v1.2`, a dispatch on the live branch is still an unguarded staging deploy, and `main` may be created only from a commit that has the new file. The CI triggers are unchanged (D44).

**Since W1-04** (step 7): the pull-request run also deploys the field app's `pr-<n>` alias on its own Netlify site, with `/api` to the `preview` project or no `/api` rule while it has none, never to staging; the `field` job is planned and guarded like the panel's (`--prod` only from the live branch, skipped for `preview`, a notice while `NETLIFY_AUTH_TOKEN` is missing).

### 2.8 Environment variables the code expects

- At `cc956dd` the root `.env.example` was still the v1.0 template (`VITE_WA_DISPLAY_NUMBER` at `:11`, a `WA_*` block at `:15-22`, `COST_WA_TEMPLATE_USD` at `:51`) and the kit template sat unmerged at `docs/env.example:1-79`. The kickoff's step 4 merged them in the commit before this document, following Appendix 9.1: the kit's layout and `[W1]`/`[W2+]` markers, every variable the code reads today (WhatsApp ones marked `(v1.0)`), `CORS_EXTRA_ORIGINS` added, and values that keep the current code working (`TRANSCRIBE_MODEL=whisper-1` until W1-11, a non-empty `CLAUDE_MODEL`, `STRIPE_PRICE_ID_SITE` until its rename). `docs/env.example` was removed after the merge; line numbers below refer to both files at `cc956dd`.
- `dotenv.config()` with no path reads `<cwd>/.env` (`apps/worker/src/index.ts:17-23`), and `pnpm --filter` runs in the package directory, so `pnpm dev:worker` reads `apps/worker/.env`, not the root `.env` that `apps/worker/README.md:10` describes. The merged `.env.example` header and `CLAUDE.md` (Environment) now say so; making the worker read the root file is a step-2 code change. **Done in W1-01:** outside production the worker and `pnpm eval` load `<cwd>/.env`, then the repository root's `.env` (`apps/worker/src/dotenv.ts`, tested in `dotenv.test.ts`).
- Local edge functions read `supabase/functions/.env` (`supabase/functions/README.md:58-59`); CI writes it with WhatsApp dummies (`.github/workflows/ci.yml:103-113`).
- `CORS_EXTRA_ORIGINS` is read (`supabase/functions/_shared/http.ts:30`, `:45-47`) but is in neither template.

### 2.9 Tests and CI

- **CI jobs** (`.github/workflows/ci.yml:13-169`): `check` (install, typecheck, lint, format:check, test, build), `db` (PGlite), `edge-functions` (deno lint/check/test), `e2e` (Playwright demo mode + axe), `e2e-supabase` (local Supabase stack, DB-type drift), `eval` (only on push to `main` or dispatch, `.github/workflows/ci.yml:155`). All but `eval` passed on `cc956dd` (run 38377523610).
- **Counts** (test declarations, counted with rg): Vitest — shared 17 files / 93, worker 18 / 163, web 42 / 295, scripts 3 / 5, db-tests 10 / 81; `packages/pdf` has none (`packages/pdf/package.json:12-14`). Deno — 9 files / 52. Playwright — demo smoke 7, a11y 16 (looped over routes), screenshots 2; Supabase stack 9.
- **Missing for v1.2:** field-app E2E, a two-org × role RLS matrix, an anon-role test, a concurrency test for report numbering, Turkish fixtures, voice fixtures.

### 2.10 WhatsApp-specific code (summary; full list in section 4)

One edge function and its helper; five shared modules plus the WhatsApp copy; the worker's `wa/` client, `router/` (8 files, 12 handlers) and three WhatsApp-only jobs; the panel's `/try` simulator, sidebar number, `wa.me` button and unknown-sender UI; the `conversations` table, the WhatsApp shape of `messages`, `unknown_senders` and the `msg_type`/`convo_state` enums; `WA_*` env and CI dummies; 5 Meta fixtures and the Meta replay script; README/RUNBOOK sections.

---

## 3. Ticket status

| Ticket | Status    | One line                                                                                                                              | Key references                                                              |
| ------ | --------- | ------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| W1-01  | partial   | Tooling and CI green; env merged; brand SVGs and v1.2 README missing; Node 22 not 20 (W1-01: brand files and README done, D10)        | `package.json:6-9`, `.env.example`                                          |
| W1-02  | conflicts | Shared package exists but is v1.0: enums, report schema v1, WhatsApp copy; no SMS, tokens, i18n                                       | `packages/shared/src/enums.ts`, `packages/shared/src/schemas/report.ts:240` |
| W1-03  | partial   | Full tested panel shell and magic link; no i18n/TR, no `/dev/phone`, no error boundary, WhatsApp footer                               | `apps/web/src/app/routes.tsx:53-90`, `apps/web/src/copy/en.ts:68`           |
| W1-04  | missing   | No `apps/field`, PWA, field routes or `/api` proxy                                                                                    | `apps/web/public/_redirects:1`                                              |
| W1-05  | conflicts | Complete v1.0 schema, live; 6 tables and 10 enums missing; WhatsApp-keyed tables; RLS defects deferred                                | `supabase/migrations/20261011000002_tables.sql:119-169`                     |
| W1-06  | conflicts | Deterministic Kestrel dataset; WhatsApp channel data; no TR org, no `is_demo`, not idempotent, no `--date`                            | `scripts/src/seed-demo.ts:97`, `supabase/seed.sql:26`                       |
| W1-07  | missing   | No `field-api`; prerequisites missing from the schema                                                                                 | `supabase/config.toml:60-112`                                               |
| W1-08  | conflicts | Invite exists but welcomes on WhatsApp; no SMS layer, `sms-webhook` or Demo phone                                                     | `supabase/functions/api-invite-reporter/index.ts:122-134`                   |
| W1-09  | missing   | No recorder, upload queue or field screens                                                                                            | `pnpm-workspace.yaml:1-5`                                                   |
| W1-10  | partial   | Solid job runtime; no LISTEN/NOTIFY, no `send_sms`, no 100-job test; WhatsApp-tied lock keys                                          | `apps/worker/src/runner.ts:154-210`                                         |
| W1-11  | conflicts | OpenAI transcription of WhatsApp audio; no Deepgram, no `transcribe_upload`                                                           | `apps/worker/src/jobs/transcribe_audio.ts:7-72`                             |
| W1-12  | conflicts | Mature extraction and validation on prompt v1 and schema v1; delivers questions on WhatsApp                                           | `apps/worker/src/ai/prompts/extraction.ts:3-32`                             |
| W1-13  | conflicts | No screens or routes; the answer mapping and `file_report` that exist are WhatsApp-shaped (reply source, Other… button, "OK" trigger) | `packages/shared/src/report/validate.ts:361`, `:481-488`                    |
| W1-14  | partial   | Two-page react-pdf report with embedded static fonts; English, imperial, WhatsApp wording                                             | `packages/pdf/src/ReportDocument.tsx:25-89`                                 |
| W1-15  | conflicts | Filing, PDF and email work; "Filed" and the PDF go out on WhatsApp; no SMS                                                            | `apps/worker/src/pipeline/file.ts:153-177`                                  |
| W1-16  | partial   | Overview with KPIs, realtime and actions; no channel column, link SMS or undeliverable item                                           | `apps/web/src/app/overview/Page.tsx:114-194`                                |
| W1-17  | partial   | Archive and review with versions, seekable audio, sign-off; WhatsApp sources and timeline                                             | `apps/web/src/app/report/SourcePanel.tsx:77-304`                            |
| W1-18  | partial   | Sites and Site detail built; no preference icon or channel dots; WhatsApp `wa.me` action                                              | `apps/web/src/app/site/Page.tsx:82`, `:112-135`                             |
| W1-19  | partial   | Hosted Supabase and Netlify deploys run; no field host, `/api` rewrite, v1.2 functions, demo notes                                    | `.github/workflows/deploy.yml:69-81`, `:209-218`                            |

### W1-01 · Monorepo and tooling — partial · effort S

**Done**

- pnpm workspaces `apps/*`, `packages/*`, `supabase/db-tests`, `scripts` (`pnpm-workspace.yaml:1-5`); `apps/field` will be picked up automatically.
- TypeScript 5.9 strict base (`tsconfig.base.json:8-9`); ESLint flat config + Prettier (`eslint.config.mjs:9-50`, `.prettierrc:1-8`).
- Vitest in every package that has tests (`packages/shared/vitest.config.ts:1-8`, `apps/worker/vitest.config.ts`, `supabase/db-tests/vitest.config.ts`, `apps/web/vite.config.ts:21-28`).
- Root scripts `dev`, `build`, `typecheck`, `lint`, `test`, `format`, `seed:demo`, plus `check`, `test:db`, `e2e`, `eval` (`package.json:10-27`); `.gitignore`; README quickstart (`README.md:23-37`).
- CI install → typecheck → lint → format:check → test → build (`.github/workflows/ci.yml:25-31`). The Done-when holds in CI from a fresh checkout with a frozen lockfile (run 38377523610 on `cc956dd`); a local fresh-clone run was not repeated in this audit.
- Spec, plan, artboards and channel decisions committed; kit `CLAUDE.md` merged into `CLAUDE.md` (`cc956dd`). `docs/CLAUDE.v1.2.md` is not in the tree because it was merged. `docs/SITELOG_SPEC.md`, `docs/PLAN_WEEK1.md`, `docs/START_HERE.md`, `docs/env.example` (removed after the merge), `docs/decisions/channel-options.md`, the 16 `docs/design/*.dc.html` and the 6 `docs/brand/*.svg` are byte-identical to the uploaded kit zip (checked with `cmp`), and `.prettierignore:11-16` keeps them that way.
- **`CLAUDE.md` merge notes.** `docs/CLAUDE.v1.2.md` was never committed on its own, so the merge can only be reviewed against the zip. The merge keeps every kit rule. It replaces the kit's stack and commands with the repo's: React 19, Node 22, Tailwind 4 (`CLAUDE.md:34`); `pnpm dev:worker` and hand-maintained DB types instead of `pnpm --filter worker dev` and `supabase gen types > db.types.ts` (`CLAUDE.md:38-40`). It marks v1.0 rules _(current)_ (`CLAUDE.md:27-28`, `:61`, `:78`, `:92`), adds forward-only migrations and the branch rule (`CLAUDE.md:51-52`), and allows feature flags in `VITE_*` (`CLAUDE.md:60`). The Environment section was corrected after this audit: the worker reads `.env` from its working directory (section 2.8) (W1-01: it now reads the root `.env` too, section 2.8). `CLAUDE.md:16` says the brand files are not copied yet (D10) (W1-01: copied by `pnpm brand`, and the row updated, D10).

**Missing**

- ~~Merge `docs/env.example` into the root `.env.example`~~ — done in the commit before this document (Appendix 9.1).
- ~~Brand SVGs in `apps/web/public/brand/`: the kit's `logo-mark.svg`, `logo-mark-inverted.svg` and `logo-mono.svg` differ from the repo's copies (`cmp`); `logo-app-icon.svg`, `favicon-16.svg`, `favicon-32.svg` are new.~~ Done in W1-01 (`pnpm brand`, D10). `apps/field/public/brand/` waits for W1-04.
- ~~README for v1.2: pitch (`README.md:3`), repository table (`:11`, `:15`), report flow (`:39-45`); root description (`package.json:5`); deviation rows for Node 22, pnpm 10, React 19, Vite 8 (only Tailwind 4 is recorded, `README.md:51`).~~ Done in W1-01.
- No root Vitest workspace file; `pnpm -r --if-present test` (`package.json:18`) is functionally equivalent (D5).

**Conflicts**

- _Node version._ Repo: Node 22 everywhere. Spec: Node 20. Node 20 cannot work here: `pnpm install` refuses the root engines field (`package.json:8`) and Vitest 5 needs Node `^22.12` (`pnpm-lock.yaml:3606`). Recommend: keep Node 22 (D1).
- _pnpm major._ Repo 10.28 (`package.json:6`); kit 9. Recommend: keep 10 (D2).
- _`seed:demo` meaning._ See W1-06 (D8).

### W1-02 · `packages/shared` — conflicts · effort L

**Done**

- `@sitelog/shared` is imported by web, worker, pdf, scripts, db-tests and the edge functions through the Deno import map (`supabase/functions/deno.json:3-4`).
- Totals computed in code: `recomputeManpowerTotals` and `deriveTotals` (`packages/shared/src/report/hours.ts:20-50`, `:64-95`), tested (`packages/shared/src/report/hours.test.ts:24-105`).
- `formatReportNo` → `RL-2041-0187` and `pdfFileName` → `{report_no}_{YYYY-MM-DD}_v{version}.pdf` (`packages/shared/src/report/numbering.ts:2-9`).
- Zod report schema with JSON-schema derivation for the Claude tool, v1 shape (`packages/shared/src/schemas/report.ts:273-285`).
- Enum ↔ DB sync test, including label order (`supabase/db-tests/src/migrations.test.ts:22-33`).

**Missing**

- `enums.ts` as zod enums for every §6.2 enum: 10 missing (`contact_pref`, `consent_type`, `field_channel`, `link_kind`, `upload_kind`, `call_direction`, `call_transport`, `call_status`, `call_outcome`, `source_kind`), 5 differing, 2 WhatsApp-only (`msg_type`, `convo_state`). `JOB_TYPES` is the v1.0 list (`packages/shared/src/enums.ts:98-114`).
- `DailyReportData` `schemaVersion 2` exactly as §10.3 (`docs/SITELOG_SPEC.md:1508-1557`), plus a v1→v2 read upgrade.
- An exported `computeTotals()` (can wrap the two existing functions).
- `copy/sms.{en,es,tr}.ts` and `renderSms(...)`; `sms/segments.ts`; `channels.ts` (`Notifier`, `SmsTransport`, `SmsDriver`, `FieldChannel`). None exist; `rg` finds them only in `CLAUDE.md`.
- `format.ts` on `libphonenumber-js` with locale-aware dates, hours (h/sa) and units. Today it is en-US only (`packages/shared/src/format.ts:1`), and `formatPhone` groups Turkish numbers wrongly (`:154-161`). Dependencies are only date-fns, date-fns-tz and zod (`packages/shared/package.json:16-20`).
- `tokens.ts` + `tokens.css` + a Tailwind theme both apps consume.
- `copy/ui.{en,tr,es}.json` i18next skeleton (`common`, `panel`, `field`).
- Tests: `renderSms` EN/ES/TR with and without a number; Turkish segment counts; a direct report-numbering test; a `schemaVersion 2` round-trip of the hero report.

**Conflicts**

- _Enums._ Repo: v1.0 `as const` arrays mirrored in `20261011000001_enums.sql`. Spec: §6.2 (`docs/SITELOG_SPEC.md:500-525`). Recommend: change them only together with forward migrations (W1-05); build `z.enum` from the same arrays so `PG_ENUMS` keeps working.
- _Report data._ Repo: `schemaVersion: z.literal(1)`, sources `audio`/`text`/`reply` keyed by WhatsApp `messageId`, imperial-only observed weather (`packages/shared/src/schemas/report.ts:9-22`, `:27-34`, `:239-247`); 40 non-test files reference `DailyReportData` alone (rg). Spec: v2 with `voice_note`/`call`/`answer`, `reportLanguage`, `units`, `photos[].uploadId`, `newTerms[].heardLanguage`, `hoursBasis: 'answer'`. Writers stamp v1 in two places: the worker (`apps/worker/src/ai/extract.ts:141`) and, in SQL, `create_office_report` (`supabase/migrations/20261013000005_office_photos.sql:203`), so switching writers to v2 needs a new migration as well as code. Recommend: add v2 and a pure `upgradeV1toV2()` applied on read; never rewrite stored versions (D20).
- _SMS vs WhatsApp copy._ Repo: `packages/shared/src/copy/whatsapp.ts:3-6`, `wa/templates.ts`. Recommend: add the SMS catalogue beside it and delete the WhatsApp copy after its consumers switch (section 4).
- _Locale and copy rule._ Repo: English-only formatting and panel copy in a TS object (`apps/web/src/copy/en.ts:1-9`). The old "English only" rule (`388fc63:CLAUDE.md:21`) is already superseded by the merged `CLAUDE.md:78`. Recommend: adopt i18next (D9).
- _Token location._ Repo: Tailwind 4 `@theme` in `apps/web/src/styles/tokens.css:4-77`, duplicated as constants in `packages/pdf/src/styles.ts:9` and `apps/worker/src/email/templates.ts:16`. Spec: tokens and a preset exported from shared. Recommend: move the `@theme` block to `packages/shared/src/tokens.css` (the Tailwind 4 "preset" is an `@import`), add `tokens.ts`, point the PDF and email code at it (D4).

### W1-03 · Panel shell and sign-in — partial · effort M

**Done**

- Vite + React + TS with the §14 tokens in Tailwind; Archivo (width axis) and IBM Plex Mono from Google Fonts with the exact §14.2 URL (`apps/web/index.html:18-21`).
- Restyled shadcn-style kit: Button primary/secondary/ghost/destructive (`apps/web/src/components/ui/Button.tsx:11-32`), Input, Dialog, Table, Tabs, Badge, status chips; lucide icons at stroke 2.
- Shell: 240 px sidebar, top bar with search and notifications, drawer below 768 px (`apps/web/src/components/shell/AppShell.tsx:13-48`, `apps/web/src/components/shell/TopBar.tsx:25-36`); org switcher (`apps/web/src/components/shell/Sidebar.tsx:103-132`); TanStack Query (`apps/web/src/lib/query.ts:3`).
- Magic link with 60 s resend, 1-hour validity copy, SSO "Coming soon", expired banner (`apps/web/src/auth/AuthProvider.tsx:267-269`, `apps/web/src/app/login/Page.tsx:28`, `:162-165`); `/auth/callback` sends members home, accounts users to `/hours` and users without an org to `/setup` (`apps/web/src/app/auth/CallbackPage.tsx:17-43`, `apps/web/src/app/routes.tsx:42-47`).
- Role guard per §2.2 (`apps/web/src/auth/guards.tsx:69-108`); optional Sentry (`apps/web/src/lib/sentry.ts:7-15`); inline `ErrorState` reports query errors (`apps/web/src/components/sitelog/States.tsx:45-62`).
- E2E: magic-link sign-in on the local stack (`apps/web/e2e/supabase/support.ts:60-65`); axe and keyboard at 1440 and 375 px; no sideways scroll at 320/360/390 px on `/try` and the Overview (`apps/web/e2e/a11y.spec.ts:390-404`).

**Missing**

- i18next EN/TR, a persisted language switch on `/login` and a Language item in the user menu that keeps the route (§11.2 `docs/SITELOG_SPEC.md:1674-1679`, F1 `:1071`).
- `/dev/phone` and `/settings/channels` (placeholders are enough this week).
- A React error boundary: the provider tree has none (`apps/web/src/App.tsx:20-35`).
- Footer "Agent ready · texts & calls" with the SiteLog number(s); today `'Agent listening on WhatsApp'` and `VITE_WA_DISPLAY_NUMBER` (`apps/web/src/copy/en.ts:68`, `apps/web/src/components/shell/Sidebar.tsx:148-157`, `apps/web/src/lib/env.ts:18`).
- Login copy per P1 and the Web-Login artboard: "Sign in to the office panel" and text-link/phone-call bullets instead of WhatsApp (`apps/web/src/copy/en.ts:286`, `:291`, `:301`).
- Theme consumed from shared (W1-02).
- Manual checks: magic link through the local mail catcher (CI excludes mailpit, `.github/workflows/ci.yml:115`) and the whole shell at 390 px.

**Conflicts**

- _React 18 / Tailwind preset._ Repo: React 19.3, Vite 8, Tailwind 4 CSS-first (`apps/web/package.json:48`, `:68`, `:70`). Spec: React 18 + shared preset (`docs/PLAN_WEEK1.md:45`). Recommend: keep (D3, D4).
- _Channel copy._ Repo: WhatsApp footer, login bullets and meta description (`apps/web/index.html:9`). Spec: texts and calls. Recommend: change the copy; take the number from org settings or `VOICE_NUMBER_US/TR`.
- _English-only copy._ Recommend: i18next behind a `t()` that first serves `en.ts` as the EN resource (D9).
- _/try simulator._ Not in §11.1. Recommend: keep demo-only until `/dev/phone` and `apps/field` work, then remove (D29).
- _Extra routes_ `/reports/new`, `/ops`: keep as recorded deviations (`README.md:61-62`).

### W1-04 · Field app shell (PWA) — missing · effort M

**Done:** nothing. `apps/` has only `web` and `worker`; the lockfile has no `vite-plugin-pwa`, Workbox or i18next; the only Vite config has no proxy (`apps/web/vite.config.ts:13-14`); `_redirects` is the panel's SPA fallback (`apps/web/public/_redirects:1`).

**Missing**

- `@sitelog/field`: Vite + React + TS, `vite-plugin-pwa`, manifest (SiteLog, standalone, `#16181B`, 192/512 icons from `logo-app-icon.svg`, `docs/SITELOG_SPEC.md:1879`), routes `/r/:code`, `/today`, `/record`, `/report/:id`, `/history`, `/settings`, `/expired`.
- Shared tokens and fonts; EN/ES/TR via shared i18next resources.
- Vite `server.proxy` and `preview.proxy`: `/api/*` → `{SUPABASE_URL}/functions/v1/field-api/*`; port 5174 with `--host`.
- `apps/field/public/brand/`; root `pnpm dev` starting web and field (`CLAUDE.md:42`); ESLint browser/React block (`eslint.config.mjs:41`), e2e ignore (`:18`) and Prettier brand ignore (`.prettierignore:9`) extended to `apps/field`.
- Hosting and a deploy job (W1-19, D42, D43).

**Constraints found**

- `vite-plugin-pwa` 2.0.0 lists Vite `^8.0.0` as a peer (checked 2026-10-13), so Vite 8 does not block it. `.npmrc:2` (`strict-peer-dependencies=false`) would hide a mismatch, so check peers when adding plugins.
- A phone opening a plain-http LAN URL is not in a secure context: service-worker registration, `getUserMedia` (W1-09) and a `Secure` cookie all fail. The Done-when needs a tunnel or the HTTPS Netlify preview.
- The field route `/settings` collides with the panel's `/settings` (`apps/web/src/app/routes.tsx:82-84`), so the two apps cannot share one origin root (D42).

**Reuse:** `apps/web/vite.config.ts` pattern, `apps/web/index.html:6`, `:16-21` (theme colour and fonts), token values, `docs/brand/logo-app-icon.svg`, `apps/web/playwright.config.ts:44-52` preview-server pattern.

### W1-05 · Database: migrations, RLS, RPCs, storage — conflicts · effort XL

**Done**

- `supabase init` (`supabase/config.toml:20-22` seed config); RLS on every table; `is_member`/`has_role` (`supabase/migrations/20261011000004_rls.sql:6-16`).
- `next_report_no` → `{project_code}-{seq:0000}` with a row lock on `sites.report_seq` (`supabase/migrations/20261012000002_rpc_fixes.sql:9-16`); security definer and service-only (`supabase/migrations/20261011000005_rpcs.sql:321`), no role check and no audit row. Gap-free only when the caller inserts in the same transaction, as `create_office_report` does.
- `sign_off_report` (`supabase/migrations/20261011000005_rpcs.sql:164`) and `create_report_version` (`supabase/migrations/20261013000005_office_photos.sql:256`): security definer, role-checked, audited.
- Part of the §6.4 indexes plus `current_manpower`/`current_weather` views (`supabase/migrations/20261011000003_indexes_views.sql:3-44`); private buckets; realtime on `site_days` and `reports`.
- 12 of 30 v1.2 tables match v1.2 as they are, and `jobs` has every column but not its `UNIQUE` (Appendix 9.2).
- PGlite suite runs every migration in CI (`.github/workflows/ci.yml:33-45`); `supabase start` with migrations + seed passes in CI (`.github/workflows/ci.yml:114`).

**Missing**

- Tables `consents`, `field_links`, `field_devices`, `uploads`, `calls`, `rate_limits` with RLS (field-side ones without client policies); `unknown_contacts`.
- The 10 missing enums; label changes in `reporter_status`, `msg_status`, `report_status`, `version_author`; `sender_status` → `contact_status` (Appendix 9.3).
- Columns: `orgs.country/locale/units/currency/tax_no/billing_provider/billing_customer_id/billing_subscription_id/is_demo`; `org_members.ui_locale`; `org_settings` link/call columns; `reporters.locale/contact_pref/activated_at/opted_out_at`; `reports.channel/language/confirmed_via`; `report_versions.via`; `questions.channel/call_id/answer_source`; v1.2 shapes of `messages`, `transcripts`, `report_sources`.
- §6.4 indexes on `uploads`, `calls`, `messages(reporter_id, …)`, `field_links`.
- `jobs.dedupe_key` UNIQUE and `enqueue_job` with `on conflict do nothing` + `pg_notify('jobs')`.
- `calls` bucket; `messages` in the realtime publication.
- Column lockdown on `orgs`: `orgs_update` lets any admin write every column (`supabase/migrations/20261011000004_rls.sql:72`; `docs/AUDIT_BACKLOG.md:36-41`), which would include `is_demo` and `billing_*`.
- Fixes for confirmed, deferred defects: cross-org `site_reporters` links (`supabase/migrations/20261011000004_rls.sql:123`), forged `evidence_packs` inserts (`supabase/migrations/20261011000004_rls.sql:161`), an org left with no admin (`supabase/migrations/20261011000004_rls.sql:106`), accounts reading `notifications`/`audit_log` (`supabase/migrations/20261011000004_rls.sql:166-169`), cross-org `messages`/`transcripts` leak (`supabase/migrations/20261011000004_rls.sql:132-134`) (`docs/AUDIT_BACKLOG.md:29-34`, `:234-264`).
- Gap-free numbering for every caller: the worker numbers in its own statement before inserting (`apps/worker/src/db.ts:809-813`, `apps/worker/src/router/handlers/intake.ts:258`), so a race on `reports_one_live_per_site_day` burns a number (`apps/worker/src/router/handlers/intake.ts:278-280`; also `apps/worker/src/router/handlers/dayoff.ts:48`).
- Tests: two orgs × admin/pm/ops/accounts × select/insert/update/delete per table; anon reads nothing (and cannot run the lookup helpers granted to anon at `supabase/migrations/20261011000004_rls.sql:49-51`); `next_report_no` under concurrency on real Postgres (PGlite is single-session, `supabase/db-tests/src/harness.ts:59`). The harness re-grants all privileges after migrations (`supabase/db-tests/src/harness.ts:71`), which would hide a column revoke.

**Conflicts**

- _Migration layout._ Repo: 16 applied timestamped files. Spec: fresh `0001_enums` … `0007_storage` with "DDL §6.3 verbatim". Recommend: treat 0001–0007 as a content checklist; add new timestamped files after `20261013000005`; prove end-state equality with a test (D11). A `0001_*` file would sort before applied versions and `db push` would refuse it.
- _`messages` shape._ Repo: WhatsApp log (`supabase/migrations/20261011000002_tables.sql:132-148`), `conversation_id` nullable with `org_id` since office photos (`supabase/migrations/20261013000005_office_photos.sql:28-31`), read by the deployed panel (`apps/web/src/data/supabase/SupabaseSource.ts:597`, `:839-859`). Spec: SMS-only log (`docs/SITELOG_SPEC.md:669-681`). Recommend: D15.
- _`transcripts`, `report_sources`, `questions` keyed to WhatsApp messages_ (`supabase/migrations/20261011000002_tables.sql:150-158`, `:226-234`, `:287-300`). Spec: upload/call/question keys (`docs/SITELOG_SPEC.md:754`, `:779`, `:823`). Recommend: add columns, backfill via a message→upload mapping (same UUID), add the XOR check `NOT VALID` then validate; map `audio`→`voice_note`, `reply`→`answer` (if it answered a question) else `text`.
- _Enum labels_ (`supabase/migrations/20261011000001_enums.sql:9-21`, mirrored in `packages/shared/src/enums.ts:15`, `:36`, `:63`, `:73`). Recommend: `RENAME VALUE` for `verified`→`active` and `reporter_reply`→`reporter`, `ADD VALUE … BEFORE/AFTER` to keep spec order, a new type for `msg_status`; ship code that accepts both names first (rg, outside migrations and docs: 21 files contain `'verified'`, 19 contain `reporter_reply`).
- _Job dedupe._ Repo: partial unique index on active jobs (`supabase/migrations/20261011000003_indexes_views.sql:13`); the worker matches that index by name (`apps/worker/src/db.ts:944`); the reinvite key is reused on purpose (`supabase/functions/api-invite-reporter/index.ts:185`). Spec: `dedupe_key unique` (`docs/SITELOG_SPEC.md:885`). Recommend: D16; keep one 4-argument `enqueue_job` (no 3-argument overload, which would make PostgREST named-arg calls ambiguous).
- _Office photos._ Repo: stored as `messages` rows (`supabase/migrations/20261013000005_office_photos.sql:137-143`); office-typed reports have no reporter. Spec: `uploads.reporter_id NOT NULL` (`docs/SITELOG_SPEC.md:718-722`). Recommend: D14.
- _`channel` NOT NULL._ Spec `field_channel ('web','voice','sms')` on `reports`, `questions`, `unknown_contacts` (`docs/SITELOG_SPEC.md:704`, `:826`, `:840`); no value fits WhatsApp or typed reports. Recommend: D13.
- _Billing columns and `is_demo` writes._ Repo `stripe_*` (11 code files). Recommend: expand/contract to `billing_*`; revoke `UPDATE` on `orgs` and re-grant profile columns only; stop `supabase/db-tests/src/harness.ts:71` masking it.

### W1-06 · Seed data and types — conflicts · effort L

**Done**

- Deterministic §18.1 Kestrel dataset (`packages/shared/src/demo/kestrel.ts`, ids from `demo/ids.ts`): 3 office users, settings, 6 sites, 7 reporters (backup Jorge invited), companies and aliases (Ridgeway unconfirmed), glossary.
- Oct 9 states: ES missing, HS weather day, NG/OM/P9/RL filed, OM needs review (`supabase/db-tests/src/seed.test.ts:68-89`); hero 23/184 → 24/192 (`packages/shared/src/demo/kestrel.test.ts:65`); week 1,804 h (`packages/shared/src/demo/kestrel.test.ts:62`); weather 10 site-days / 36.5 h / 7 claim-ready.
- `pnpm seed:demo` regenerates byte-identical SQL; the seeded admin signs in and sees the seeded sites (`apps/web/e2e/supabase/panel.spec.ts:30`; green in CI).
- Typed DB definitions with a CI drift check (deviation `README.md:58`).

**Missing**

- TR demo org Demir Yapı A.Ş. (§18.2, `docs/SITELOG_SPEC.md:2061-2075`); "Demir" appears nowhere outside `docs/`.
- `orgs.is_demo = true` on both orgs (column missing, W1-05).
- Seeding a database with the service role; idempotency (a second apply fails on `insert into orgs`, `supabase/seed.sql:26`; `audit_log` rows have no ids, `scripts/src/seed-demo.ts:92`); `--date today`.
- An "awaiting" Oct 9 state (the plan lists one; §18.1 has none, D36).
- Reporter `contact_pref` and `locale` (Northgate and Hillcrest prefer Call); v1.2 channel data (uploads, calls, SMS, consents, field links, unknown caller); hero v2 by `reporter` via `web`; `schemaVersion 2`.
- DB types for the v1.2 schema.

**Conflicts**

- _Seed mechanism._ Repo: a generator writing `supabase/seed.sql` (`scripts/src/seed-demo.ts:97-107`), recorded as a deviation (`README.md:57`). Spec: a service-role, idempotent script with `--date today` (`docs/PLAN_WEEK1.md:63`). Recommend: D8.
- _Channel data._ Repo: WhatsApp conversations and messages, `DEMO_WA_NUMBER`, `reporter_reply` versions (`packages/shared/src/demo/kestrel.ts:43`, `:869`, `:1071`). Recommend: rebuild only the channel layer after W1-05; keep everything else; keep the number's value (+15550142290 equals §18.1's SiteLog number) under a new constant name.
- _DB types file._ Repo hand-maintained `packages/shared/src/db/types.ts`; spec generated `db.types.ts`. Recommend: keep (D7).

### W1-07 · `field-api` Edge Function — missing · effort L

**Done:** nothing. No function, router, link-code or cookie auth, or rate limiting (`supabase/functions/README.md:8-17`, `supabase/config.toml:60-112`). No signed upload URLs anywhere in the repo.

**Missing**

- `supabase/functions/field-api` with a `[functions.field-api] verify_jwt = false` block (a `_redirects` proxy cannot add a Supabase JWT).
- Auth: link code sha256 → `field_links`; `sl_dev` cookie (httpOnly, Secure, SameSite=Lax, 180 days) → `field_devices.verified_at`; every query scoped to the reporter's sites; rate limits.
- Routes `resolve`, `device/send-code`, `device/verify`, `consent`, `today`, `uploads`, `uploads/:id/complete`, `reports/:id`, `reports/:id/answer`, `reports/:id/confirm`, `day-status`, `history`, `preferences`; `last_seen_at` on each call; audit rows with `actor_type 'reporter'`.
- Report creation and numbering in one transaction (ideally one RPC like `create_office_report`).
- Tests per the plan.
- Prerequisites from W1-05: the field tables, reporter and report status values, `reports.channel/language/confirmed_via`, `report_sources.upload_id/question_id`.

**Conflicts / decisions**

- _Router._ Repo functions use `Deno.serve(withHandler(...))` without a router; `deno.json` has no Hono (`supabase/functions/deno.json:2-11`). Plan: Hono. Recommend: D6.
- _Status enums._ Repo `reporter_status` has `verified`, `report_status` lacks `processing` (`supabase/migrations/20261011000001_enums.sql:9`, `:17`). Recommend: fix in W1-05 first (D19).

**Reuse:** `_shared/http.ts` (`HttpError`, `parseWith`, `timingSafeEqual` at `:142`, `withHandler` at `:159`), `_shared/audit.ts`, `_shared/jobs.ts`, `_shared/supabase.ts`; the one-live-report index (`supabase/migrations/20261012000004_queue_fairness.sql:86`); storage path helpers (`packages/shared/src/report/numbering.ts:21-40`, with upload UUIDs).

### W1-08 · SMS layer, invite and Demo phone — conflicts · effort L

**Done**

- Channel-agnostic invite core in `api-invite-reporter`: admin/ops check, E.164, site ownership, reuse of a same-phone reporter, primary-site link, audit, dedupe-keyed `send_welcome`, re-send after 48 h, disable (`supabase/functions/api-invite-reporter/index.ts:54-219`).

**Missing**

- `SmsTransport` drivers `console`, `twilio`, `iletimerkezi`; driver per org country from env; `is_demo` → `console` (needs `orgs.is_demo`/`country`, `supabase/migrations/20261011000002_tables.sql:5-17`).
- An SMS send function with `messages` logging (`copy_key`, provider ids, `undeliverable`).
- Invite with `locale` and `contactPref`, status `invited`, a personal `field_links` row, and `send_welcome` as SMS with the link (today: schema at `supabase/functions/api-invite-reporter/index.ts:26-34`, WhatsApp attach at `:122-134`).
- `sms-webhook` with `X-Twilio-Signature` and STOP/HELP/START/CALL/TEXT; Twilio fixtures; `scripts/replay-webhook.ts` for it (today it signs Meta payloads, `scripts/src/replay-webhook.ts:1-26`).
- Panel `/dev/phone`: reporter list, realtime thread on `messages`, field app in a 390 × 844 frame or a new tab, reply box through the `sms-webhook` handler, Email tab (the console email provider only logs, `apps/worker/src/email/provider.ts:54-68`).
- Mocked-HTTP tests for Twilio and the webhook.

**Conflicts**

- _Welcome channel._ Repo: WhatsApp template `sitelog_welcome` via the conversation (`apps/worker/src/jobs/send_welcome.ts:26-33`); panel button "Send WhatsApp welcome" on Team and Setup (`apps/web/src/copy/en.ts:1109`, `:1112`, `:1454`). Spec: welcome SMS with the personal link (F3, §9.2). Recommend: create the `field_links` row instead of attaching a conversation; rewrite `send_welcome` on the SMS function; drop the template path when the field flow works.
- _`messages` table._ See D15.
- _Inbound webhook and replay._ Recommend: keep the verify → store → enqueue → fast-ack structure of `whatsapp-webhook`; replace the Meta parser with Twilio form parsing; repoint `replay-webhook`.

### W1-09 · Field screens: device check → Today → Recording — missing · effort XL

**Done:** nothing. No `MediaRecorder`, Wake Lock, `AnalyserNode`, IndexedDB queue, one-time-code input, consent, Today or Recording screen. The only field-side UI is the WhatsApp chat simulator (`apps/web/src/app/try/Page.tsx:1-6`).

**Missing:** everything in the Build list: `/r/:code` → device check → Welcome & consent → Today → Recording (mime detection, timer, level meter, wake lock, pause/resume, photo capture, 15 min per clip) → Processing (poll every 2 s) → offline queue with banner; real-device checks on iOS Safari and Android Chrome. Depends on W1-04 and W1-07.

**Reuse:** tokens, brand, `formatDuration`/`formatTimeInTz` (`packages/shared/src/format.ts:95`, `:145`), progress-step phrases (`packages/shared/src/report/progress.ts:18-30`, copy to be moved), artboards `docs/design/Field-01…04`, `Field-10`.

### W1-10 · Worker runtime — partial · effort M

**Done**

- `apps/worker` on Node with `tsx watch` (`apps/worker/package.json:9-17`); Node 22 is a recorded stack choice (`CLAUDE.md:34`).
- Direct Postgres via `SUPABASE_DB_URL` (`apps/worker/src/config.ts:29`, `apps/worker/src/db.ts:450-455`).
- `FOR UPDATE SKIP LOCKED` claim inside `claim_jobs()` (`supabase/migrations/20261012000004_queue_fairness.sql:60-81`); handler registry with Zod payloads and per-job timeout.
- Backoff 30 s / 2 min / 10 min / 30 min, dead after 5 attempts, Sentry (`supabase/migrations/20261011000005_rpcs.sql:69-84`); stale-lock reclaim; `/health` (`apps/worker/src/index.ts:91-113`); graceful shutdown (`:122-134`); `WORKER_CONCURRENCY` (`apps/worker/src/config.ts:52`).
- Tests for backoff and dedupe (`apps/worker/src/db.pglite.test.ts:1077-1167`, `supabase/db-tests/src/migrations.test.ts:115-157`).

**Missing**

- `LISTEN jobs` on a dedicated session connection, `pg_notify` in `enqueue_job`, 5 s poll fallback (today: 1 s polling, `apps/worker/src/config.ts:56`, `apps/worker/src/runner.ts:154-210`). The pool uses `prepare: false` for poolers; the transaction pooler does not deliver LISTEN.
- `send_sms` handler and job type; `send_welcome` on SMS (`apps/worker/src/jobs/registry.ts:18-34`).
- "100 jobs exactly once with concurrency 4" against a local DB (the load test runs 6 WhatsApp reports, `apps/worker/src/integration/loadtest.test.ts:27-47`).
- Dead reporter-facing jobs notify the office, not a WhatsApp `error_retry` (`apps/worker/src/runner.ts:97-115`).

**Conflicts**

- _Dedupe semantics._ Active-only in the repo (a test asserts a key is free again after `done`, `apps/worker/src/db.pglite.test.ts:1124-1130`); unique in v1.2. Recommend: D16.
- _Lock key and priority._ `job_lock_key` derives `convo:<id>` from WhatsApp tables; `job_priority` ranks WhatsApp job names (`supabase/migrations/20261012000004_queue_fairness.sql:20-58`). Recommend: add a `report:<id>` branch and v1.2 job names before `transcribe_upload` and `extract_report` can run for the same report.
- _Retry count._ The 2 h delay is unreachable (`supabase/migrations/20261011000005_rpcs.sql:76-83`). Recommend: D17.
- _Stale lock._ 15 min (`supabase/migrations/20261012000004_queue_fairness.sql:65`, `:69`) versus 10 min. Recommend: 10 min (D18); safe with the 5 min job timeout.

### W1-11 · Transcription (Deepgram) — conflicts · effort M

**Done**

- A result shape close to the spec's `Transcriber` output with segments (`apps/worker/src/ai/transcribe.ts:26-34`), a tested OpenAI implementation usable as the fallback, a vocabulary-hint builder from site, companies, aliases and the top-50 glossary (`apps/worker/src/ai/transcribe.ts:58-79`; the job does not pass areas, `apps/worker/src/jobs/transcribe_audio.ts:33-37`), split above 15 min, latency and audio-seconds metrics (`apps/worker/src/runner.ts:62`, `:78-95`), dedupe-keyed `extract_report` enqueue (`apps/worker/src/router/continue.ts:71-76`), a signed-URL helper (`apps/worker/src/storage.ts:57`).

**Missing**

- `Transcriber` interface with Deepgram `nova-3` (smart_format, utterances, word timestamps; `multi`/`tr`/`en`; key terms) and `DEEPGRAM_API_KEY`/`TRANSCRIBE_PROVIDER` config.
- `transcribe_upload(upload_id)`: signed download → `transcripts(upload_id)` → about 600 peaks and duration into `uploads` → `extract_report`.
- Browser webm/mp4 sent as-is (no conversion).
- Voice fixtures: EN, ES+EN with a crew gap, TR, with expected transcripts. `fixtures/voice/README.md` has no audio and describes WhatsApp `.ogg` exports; the 26 transcript fixtures are EN, ES and mixed, none Turkish.

**Conflicts**

- _Provider._ OpenAI `whisper-1` only (`apps/worker/src/config.ts:38-39`). Recommend: OpenAI becomes the fallback behind the interface, Deepgram the default.
- _Input and job._ `transcribe_audio` on WhatsApp messages, downloads from Graph, converts to MP3 (`apps/worker/src/ai/transcribe.ts:153`). Recommend: new job; ffmpeg only for duration, peaks and call recordings.
- _Storage._ `transcripts.message_id NOT NULL UNIQUE` (`supabase/migrations/20261011000002_tables.sql:150-158`); 64 peaks in `messages.payload` (`apps/worker/src/media/ffmpeg.ts:27`, `apps/worker/src/router/media.ts:87-97`). Recommend: add `upload_id`/`call_id`; store peaks on `uploads`; the panel reads both until WhatsApp data retires.

### W1-12 · Extraction, validation, questions, weather — conflicts · effort L

**Done**

- `submit_daily_report` tool from Zod via `z.toJSONSchema` (Zod 4; `packages/shared/src/schemas/report.ts:273-285`); prompt caching on the system prompt and the org/glossary block; one retry with Zod issues (`apps/worker/src/ai/extract.ts:47-62`, `apps/worker/src/ai/claude.ts:224-245`).
- Totals recomputed in code, model disagreements reported (`apps/worker/src/ai/extract.ts:134-141`); required fields, confidence < 0.7, question priority and max (`packages/shared/src/report/validate.ts:6-16`, `:196-211`).
- Draft stored as version by `agent` (`apps/worker/src/pipeline/draft.ts:21-37`); one open question at a time; `awaiting_answer`/`awaiting_confirmation` (set inside WhatsApp send functions).
- `fetch_weather` from Open-Meteo into `site_days.weather`, three times a day (`apps/worker/src/weather.ts:28-69`, `supabase/functions/scheduler-tick/index.ts:215-230`).
- `pnpm eval` with 26 golden cases, offline `--recorded` mode (`apps/worker/src/ai/eval.ts:27-48`).

**Missing**

- System prompt v2 verbatim in `apps/worker/src/ai/prompts/extract.v2.md`; user message with `REPORT_LANGUAGE`, `UNITS`, `REPORTER_LOCALE`, `CHANNEL=web`, `WORKING_HOURS` (today `apps/worker/src/ai/prompts/extraction.ts:119-131`).
- Writing `schemaVersion 2`; `processing` status; `questions` rows with `channel 'web'`; answers sourced `{type:'answer', questionId}`.
- Fallback question prompts in EN/ES/TR (today English, `packages/shared/src/report/validate.ts:247-284`).
- `decide_next` texting `question_ready`/`draft_ready` only if the device was not seen in 30 s.
- Weather in org units; eval report-language check, Turkish cases, regenerated recorded outputs.
- Done-when: ES+EN fixture → draft + one question, ≤ 60 s p50 from upload (the load-test target still quotes v1.0's 90 s, `apps/worker/src/integration/loadtest.ts:1-3`).

**Conflicts**

- _Prompt._ v1 text plus an extra weather sentence and an appended source-format note (`apps/worker/src/ai/prompts/extraction.ts:3-38`). Recommend: D24.
- _Schema._ v1 (above). Recommend: D20.
- _Delivery._ `decide_next` requires a WhatsApp conversation and sends buttons/cards (`apps/worker/src/jobs/decide_next.ts:26-27`, `apps/worker/src/router/handlers/question.ts:43`, `apps/worker/src/pipeline/draft.ts:98-104`). Recommend: split pure state changes from a `Notifier` call gated on `field_devices.last_seen_at`.
- _Forced tool choice, temperature 0._ With the default `claude-sonnet-5-5`, the code sends `tool_choice: auto` and no temperature (`apps/worker/src/ai/claude.ts:11-14`, `:29-48`, `:137-141`; `apps/worker/src/config.ts:41`); not recorded in README. Recommend: D23.
- _Weather units._ Inch/°F/mph hard-coded (`packages/shared/src/weather/observed.ts:31-38`, `:55-57`). Recommend: units from `orgs.units`.

### W1-13 · Field screens: Question → Draft → Confirm — conflicts · effort M

The ticket is three screens and their routes; none exist. What exists is shared answer logic and the filing job, both WhatsApp-shaped (options, source, trigger), and the ticket's Done-when ("answer 5 · full day") needs a decision on questions without options (D28). Hence _conflicts_, not _partial_.

**Done (reusable after rework)**

- Code-only mapping of a button answer: `parseQuickAnswer('manpower.workers', '5 · full day')` (`packages/shared/src/report/validate.ts:361`; test `packages/shared/src/report/validate.test.ts:212`) and `applyAnswer` → 5 × 8 h = 40 h with totals recomputed (`packages/shared/src/report/validate.ts:481-488`; test `packages/shared/src/report/validate.test.ts:258-286`).
- Idempotent `file_report` job a confirm route can enqueue (`apps/worker/src/jobs/file_report.ts:4-13`, `apps/worker/src/pipeline/file.ts:16-21`).

**Missing:** Question screen (≤ 2 buttons ≥ 56 px, Other… hidden), Draft screen with read-only steppers, sticky Confirm & send, the `answer` and `confirm` routes (W1-07), `confirmed_via 'web'`, the phone Done-when.

**Conflicts**

- _Questions without options._ With no model proposal, a `manpower.workers` question has no buttons (`packages/shared/src/report/validate.ts:251`); WhatsApp allowed free text. The field screen has no free-text input this week (_Other…_ is M6), so such a question cannot be answered there. Recommend: D28.
- _Confirm trigger._ `file_report` is triggered by a WhatsApp "OK" (`confirmMessageId`, `apps/worker/src/pipeline/file.ts:27`, `packages/shared/src/schemas/jobs.ts:23`); the ticket's `confirm` route needs a `via` parameter (see W1-15).
- _Option and source shape._ Options are WhatsApp `Button` objects with an always-present "Other…" (`packages/shared/src/wa/buttons.ts:125-131`); the answer source is `{type:'reply', messageId}` (`packages/shared/src/report/validate.ts:488`). Spec: `[{id,label}]`, Other… hidden until M6, `{type:'answer', questionId}`. Recommend: channel-neutral options; `applyAnswer` takes a `Source`.

### W1-14 · PDF daily report — partial · effort M

**Done**

- `@react-pdf/renderer` `ReportDocument` in `packages/pdf`, used by the worker and the browser: 2 pages, sections 01–09, meta grid, letterhead, running header.
- Embedded static TTFs (Archivo 400–800, Archivo Expanded 700/800, IBM Plex Mono 400–600, `packages/pdf/src/fonts.ts:13-24`) whose charset includes ğ ş ı İ (fc-query U+00A0–017F).
- Letter or A4 (`packages/pdf/src/ReportDocument.tsx:99`); 0.75 in margins (`packages/pdf/src/styles.ts:10-17`); ≤ 4 photos by setting (`packages/pdf/src/ReportDocument.tsx:51`); Page x of y and Open-Meteo attribution (`packages/pdf/src/components.tsx:341-364`).
- `render_pdf` → `pdfs` bucket → `report_versions.pdf_path`, audit, dedupe key (`apps/worker/src/jobs/render_pdf.ts:13-35`); hero v2 sample render, Letter and A4 (`apps/worker/src/pdf/render-sample.ts:6-18`); smoke tests (`apps/worker/src/pdf/pdf.test.ts:11-26`).

**Missing**

- EN/TR labels and badge (`packages/pdf/src/ReportDocument.tsx:25-30`, `:141-153`), Turkish dates (`packages/pdf/src/components.tsx:128-135`, `:176-182`), metric weather (`packages/pdf/src/components.tsx:212-214`).
- Paper from org country; letterhead tax line (`orgs.tax_no` missing).
- v1.2 copy for the footer, source record, sign-off and footnotes; a real mini mark (today a 9 × 9 orange box, `packages/pdf/src/styles.ts:145`).
- A Turkish sample render and a glyph test.
- Re-render on sign-off so "Signed off in SiteLog by {name}" reaches the stored PDF (`docs/AUDIT_BACKLOG.md:388`).

**Conflicts**

- _WhatsApp wording_ (`packages/pdf/src/components.tsx:352-354`, `packages/pdf/src/ReportDocument.tsx:45`, `:79`, `:238`). Recommend: copy driven by `reports.channel`/`confirmed_via`.
- _Paper source._ Manual `org_settings.pdf_paper`, default letter (`supabase/migrations/20261011000002_tables.sql:48`, `apps/worker/src/pdf/render.ts:217-221`). Recommend: D32.
- _WhatsApp delivery in `render_pdf`_ (`apps/worker/src/jobs/render_pdf.ts:41-67`, payload flag `packages/shared/src/schemas/jobs.ts:28`). Recommend: remove; `send_sms(filed)` in W1-15.
- _File name._ Storage object `{report_no}_v{n}.pdf` (`packages/shared/src/report/numbering.ts:11-19`); email uses the §12 name (`apps/worker/src/jobs/send_email.ts:74`); zip entries `{reportNo}.pdf` (`apps/web/src/lib/pdfZip.ts:33`). Recommend: D33.

### W1-15 · Filing, SMS and email — conflicts · effort L

**Done**

- `fileReport`: freeze, denormalise via `denormalize_report_version` (`supabase/migrations/20261012000002_rpc_fixes.sql:18-56`), `filed_at`, `confirmed_at`, `is_late`, review reasons, site-day status, audit, `render_pdf` with dedupe (`apps/worker/src/pipeline/file.ts:87-151`).
- Email via Resend or console, PDF attached under the §12 name, §13 EN subject (`apps/worker/src/jobs/send_email.ts:55-102`, `apps/worker/src/email/templates.ts:122-126`).
- A second `fileReport` call is a no-op (`apps/worker/src/pipeline/pipeline.test.ts:323-361`).

**Missing**

- `send_sms(filed)` with the Filed-screen link `/r/{code}/report/{id}`; the Filed screen; `photos_link` after call-filed reports.
- `file_report(report_id, via)` and `reports.confirmed_via`; `report_sources` per v1.2.
- TR subject and body; an email footer without WhatsApp (`apps/worker/src/email/templates.ts:69`); console email visible in the Demo phone.
- "Once each, even if retried": dedupe keys block duplicates only while a job is active (`supabase/migrations/20261011000005_rpcs.sql:36-39`), and a failure after `status = filed` skips the post-filing steps for good (`docs/AUDIT_BACKLOG.md:563-568`; `apps/worker/src/pipeline/file.ts:50-52`).

**Conflicts**

- _Filed notification channel._ WhatsApp "Filed." (`apps/worker/src/pipeline/file.ts:172-178`) and PDF document (`apps/worker/src/jobs/render_pdf.ts:41-56`). Recommend: `send_sms` keyed `filed:{report_id}` through the `Notifier`.
- _Conversation coupling._ `fileReport` resets the WhatsApp conversation (`apps/worker/src/pipeline/file.ts:153-171`). Recommend: remove.
- _Trigger._ `confirmMessageId` from a WhatsApp "OK" (`apps/worker/src/pipeline/file.ts:27`, `:126`, `packages/shared/src/schemas/jobs.ts:23`). Recommend: `via` parameter.
- _`report_sources` model_ (`supabase/migrations/20261011000002_tables.sql:226-234`, written at ingest, `apps/worker/src/db.ts:853`). Recommend: migrate in W1-05.

### W1-16 · Overview (realtime) — partial · effort M

**Done:** KPI tiles (`apps/web/src/app/overview/Page.tsx:278-330`); Sites today with status chip, Late, In at, crew, hours, weather (`:114-194`); Needs attention in F17 order minus undeliverable texts (`apps/web/src/data/assemble.ts:783-790`); actions Call (tel:), Mark no work (RPC, audited, `supabase/migrations/20261011000005_rpcs.sql:192-204`), Review report, Compare hours; realtime invalidation (`apps/web/src/data/supabase/SupabaseSource.ts:1717-1757`, `apps/web/src/data/DataProvider.tsx:48-54`); E2E flips a row after a server-side update (`apps/web/e2e/supabase/panel.spec.ts:44-80`).

**Missing:** channel column and icon; Text today's link (`daily_link` SMS); undeliverable-text item; unknown contacts (callers and texters); `call_mismatch`/`no_photo` reason copy (`apps/web/src/data/assemble.ts:515-531`); v1.2 footer; a phone-driven realtime check; 390 px (screenshots use 375, `apps/web/e2e/screenshots.spec.ts:5`).

**Conflicts**

- _Unknown contact model._ WhatsApp `unknown_senders` with "Link number" (`apps/web/src/data/assemble.ts:760-770`). Recommend: generalise to `unknown_contacts` with a channel; keep the link/ignore flow.
- _Demo "Try it on WhatsApp" card_ (`apps/web/src/app/overview/Page.tsx:232-248`). Recommend: replace with a Demo phone entry (D29).
- The Web-Overview artboard shows no channel column, while P3 and the ticket require one: the spec wins (D35).

### W1-17 · Reports archive and Report review — partial · effort M

**Done:** archive with URL filters (site, dates, status, weather delay, edited, late, incident, search), flags, PDF column, zip (`apps/web/src/app/reports/Page.tsx:39-81`, `:343-400`); version switcher with change notes (`apps/web/src/app/report/Page.tsx:370-411`); provenance (`:636-664`); clickable sources seeking the player (`apps/web/src/components/sitelog/SourceLink.tsx:18-60`); signed-URL audio with peaks; excerpts and transcript drawer (`apps/web/src/app/report/SourcePanel.tsx:77-194`); activity timeline (`:203-304`); review-reasons banner; PDF open or browser render; Sign off (admin/pm) with 10-minute undo and E2E (`apps/web/e2e/supabase/panel.spec.ts:131-156`; the audit row is not asserted).

**Missing:** Channel filter and icon, No-photo flag (`apps/web/src/data/types.ts:281-296`); v1.2 provenance; timeline of field events instead of WhatsApp bubbles; `MediaPlayer` on `uploads.peaks` for every clip with 1×/1.5× (only the first audio source plays, `apps/web/src/data/assemble.ts:1396-1397`); `voice_note`/`call`/`answer` source links; language line from the org (hard-coded `→ EN`, `apps/web/src/app/report/SourcePanel.tsx:33-38`).

**Conflicts**

- _Sources and audio origin._ WhatsApp message sources; audio and peaks from `messages.payload` (`apps/web/src/data/assemble.ts:1530-1540`). Recommend: move loaders to uploads/questions/calls; keep the UI components.
- _WhatsApp wording in provenance and activity_ (`apps/web/src/copy/en.ts:630-631`, `:762-768`; timeline by `conversation_id`, `apps/web/src/data/assemble.ts:1450-1456`). Recommend: rewrite around audit + SMS + calls.

### W1-18 · Sites and Site detail — partial · effort M

**Done:** site cards with chip, 14-day streak, reporter with `tel:` phone, crew today, weather days (`apps/web/src/app/sites/Page.tsx:139-206`); dashed "Connect another site" card with "$399 / month · no setup fee", matching the US artboard (`:114-130`, `apps/web/src/copy/en.ts:422-423`); Site detail calendar, latest report, "This month so far", crew-by-company table with badges (`apps/web/src/app/site/Page.tsx:233-327`); Crew, Weather and Photos tabs implemented (`:138-166`).

**Missing:** preference icon and "Prefers text link" (needs `reporters.contact_pref`); header actions Text today's link and Call {first}; calendar channel dots (`apps/web/src/components/sitelog/CalendarMonth.tsx:30`); "CONFIRMED BY ANSWER" (`apps/web/src/data/assemble.ts:930-943`); subtitle "by text link or call" (`apps/web/src/copy/en.ts:415`); country price for non-US orgs; 390 px check.

**Conflicts**

- _Primary contact action._ "Message {first}" opens `wa.me` (`apps/web/src/app/site/Page.tsx:82`, `:112-135`). Spec P5: Text today's link · Call {first} · Site settings. Recommend: replace; keep "New report" while typed reports stay (D30).

### W1-19 · Demo deploy and dress rehearsal — partial · effort M

**Done:** hosted Supabase link, `db push`, `functions deploy` automated (`.github/workflows/deploy.yml:69-81`, run 38326562725); panel on Netlify by CLI with SPA fallback; PR previews (`pr-1`, run 38377523585); Fly.io worker deploy with health check scripted (`.github/workflows/deploy.yml:83-125`) but never run (secrets empty); RUNBOOK §2 (`docs/RUNBOOK.md:19-63`).

**Missing:** field app host with the `/api/*` proxy; `field-api` and `sms-webhook` deployed; v1.2 secrets (`FIELD_APP_URL`, `LINK_SIGNING_SECRET`, SMS, Deepgram) and Auth/CORS URLs; `pnpm seed:demo --date today` against the hosted project; a worker against the hosted DB after discarding the queued backlog (`docs/RUNBOOK.md:58-63`); `docs/DEMO_NOTES.md`; `orgs.is_demo`; WhatsApp config out of deploy and RUNBOOK; the demo script twice on a real phone.

**Conflicts**

- _Production branch._ No `main`; staging deploys by dispatch with `--prod` from any ref (`.github/workflows/deploy.yml:11-15`, `:211-216`). Kickoff: "production stays on main" (`docs/START_HERE.md:50-52`). Recommend: D40. (W1-01: the guard limits staging deploys to the live branch; see section 2.7 and D40.)
- _Deployed backend channel._ `whatsapp-webhook` is deployed on `abuanbyzttuqksdctqcp` (run 38326562725 log). Recommend: add v1.2 functions first; delete `whatsapp-webhook` last with `supabase functions delete` (deploy never deletes, `.github/workflows/deploy.yml:81`).
- _Rewrite location._ Kickoff names `netlify.toml` (`docs/START_HERE.md:62-63`); the repo deploys a prebuilt directory whose `_redirects` Netlify honours. Recommend: D43.

---

## 4. Remove (WhatsApp)

Remove each item only after its replacement works and its consumers are switched (order in section 7, steps 21–22).

**Edge functions**

- `supabase/functions/whatsapp-webhook/` (`index.ts`, `logic.ts`, `logic_test.ts`) and its block `supabase/config.toml:60-64`, in one commit. The worker integration harness imports its `logic.ts` (`apps/worker/src/integration/webhook.ts:14-25`, via `apps/worker/tsconfig.json:7-9`); rewrite that first.
- `supabase/functions/_shared/conversations.ts` after `api-invite-reporter` (`supabase/functions/api-invite-reporter/index.ts:5`, `:122-127`) and `api-link-unknown-sender` (`supabase/functions/api-link-unknown-sender/index.ts:5`, `:123`) stop using it.
- Adapt rather than delete: `api-link-unknown-sender` → `api-link-unknown-contact` (deploy new, switch the panel caller `apps/web/src/data/supabase/SupabaseSource.ts:1519`, delete old).

**Shared package**

- `packages/shared/src/wa/buttons.ts`, `wa/templates.ts`, `wa/window.ts`, `webhook/meta.ts`, `copy/whatsapp.ts`, their tests, and the exports at `packages/shared/src/index.ts:16-18`, `:20`, `:24`. Consumers to switch first include `supabase/functions/scheduler-tick/logic.ts:12-21`, `apps/web/src/app/setup/SiteStep.tsx:4`, `scripts/src/replay-webhook.ts:13`, `packages/shared/src/report/progress.ts:1` and many worker files (`apps/worker/src/runner.ts:2`, `apps/worker/src/pipeline/file.ts:2`, `apps/worker/src/jobs/render_pdf.ts:4`, `apps/worker/src/router/*`).
- `wa/replies.ts`: move the reply grammar (`quickClassify`, `quickDayOff`) to an SMS-keyword module first; STOP becomes opt-out (`docs/SITELOG_SPEC.md:1457`), add TR words, START, CALL/TEXT, WEATHER; drop the `language xx` command.
- `report/draft-card.ts`, `report/progress.ts`: keep the phrase helpers, drop the WhatsApp card and bubble.
- `packages/shared/src/enums.ts`: `msg_type`, `convo_state`, WhatsApp `JOB_TYPES` (`packages/shared/src/enums.ts:24-50`, `:98-114`) after the queue is drained.

**Worker**

- `apps/worker/src/wa/` (`client.ts`, `send.ts`, `client.test.ts`) and its wiring (`apps/worker/src/context.ts:8`, `:55`; `apps/worker/src/index.ts:13`, `:36-48`; `apps/worker/src/config.ts:31-36`).
- `apps/worker/src/router/` (index, inbound, session, context, media, continue, handlers welcome/test/unknown/site-select/reminder/commands/reply/question/draft). Extract first: day-off logic (`handlers/dayoff.ts`), edit after filing (`handlers/edit.ts`), intake merge rules (`handlers/intake.ts`), the timeout sweep (`router/timeouts.ts`), and the `sendQuestion`/`rerouteDayOff` dependencies of `decide_next` (`apps/worker/src/jobs/decide_next.ts:4-5`).
- Jobs `inbound_message`, `parse_reply`, `send_template` (incl. `send_message`) and their registry entries (`apps/worker/src/jobs/registry.ts:6-7`, `:11`, `:19`, `:23`, `:29-30`); `pipeline/progress.ts`.
- `COST_WA_TEMPLATE_USD` (`apps/worker/src/config.ts:64-68`) and the WhatsApp template cost (`apps/worker/src/cost.ts:6-22`).

**Panel**

- `/try`: `apps/web/src/app/try/` (engine, Page, ChatBubble, ScenarioSheet, adapter, controller, scenarios, notes, recorded, sample-photo, tests), route `apps/web/src/app/routes.tsx:31`, `:76`, nav `apps/web/src/components/shell/nav.ts:53-55`, Overview card `apps/web/src/app/overview/Page.tsx:232-248`, copy `apps/web/src/copy/en.ts:27`, `:1634-1837`, demo store `apps/web/src/data/demo/store.ts:1652-2260`, `store.field.test.ts`, e2e uses (`apps/web/e2e/smoke.spec.ts:83-103`, `apps/web/e2e/a11y.spec.ts:88`, `:205-220`, `:367-396`; move the narrow-width test to another page).
- Sidebar WhatsApp footer and `VITE_WA_DISPLAY_NUMBER` (`apps/web/src/components/shell/Sidebar.tsx:148-158`, `apps/web/src/lib/env.ts:18`, `apps/web/src/vite-env.d.ts:7`); `wa.me` button (`apps/web/src/app/site/Page.tsx:82`); `LinkSenderDialog.tsx` (rebuilt for unknown contacts); setup's WhatsApp welcome preview (`apps/web/src/app/setup/SiteStep.tsx:4`, `:124`, `:394-396`).

**Database (later migrations; never edit applied files)**

- `conversations` and its triggers, `convo_state`, `msg_type`, `unknown_senders` (renamed), the WhatsApp columns of `messages`, `report_versions.author_message_id`, `questions.asked_message_id/answered_message_id`, `reporters.last_invite_error`/`verified_at`, `conversation_org()`/`message_org()`, the `convo:` branch of `job_lock_key`, `wa_templates` in `report_cost_inputs` (`supabase/migrations/20261012000003_ops.sql:51-101`), WhatsApp keys in `ops_payload_summary` (`supabase/migrations/20261012000003_ops.sql:133-144`).

**Fixtures, scripts, CI, env, docs**

- `fixtures/webhooks/*.json` (5 Meta payloads) → `fixtures/sms/`; `scripts/src/replay-webhook.ts` repointed to Twilio.
- `.github/workflows/ci.yml:107-108` (WA dummies), `.github/workflows/deploy.yml:112` (comment), `.github/workflows/deploy.yml:144` (`VITE_WA_DISPLAY_NUMBER`), `apps/worker/fly.toml:3-4`, `:19`; the `(v1.0)` entries of `.env.example` (`VITE_WA_DISPLAY_NUMBER`, the WhatsApp block, `COST_WA_TEMPLATE_USD`).
- `README.md` (`README.md:3`, `:11`, `:15`, `:39-45`, `:59`, `:62`, `:64`, `:66`, `:77`), `docs/RUNBOOK.md` steps 4, 6, 10 and `docs/RUNBOOK.md:50`, `apps/worker/README.md`, `supabase/functions/README.md`, `apps/web/README.md:26`, the `(current)` notes in `CLAUDE.md:27-28`, `:61`, `:78`, `:92`; mark the WhatsApp-only findings obsolete by removal (most of Critical and High, `docs/AUDIT_BACKLOG.md:18-197`, and many Medium items, e.g. `:269`, `:283`, `:297`, `:311`, `:325`); channel-neutral findings stay open, e.g. RLS and billing (`:29-41`, `:234-264`), phone numbers reaching Claude (`:276`) and the reminder-ladder guard (`:367`).

**Remote state outside the repo** (each removal needs explicit owner approval)

- Deployed functions `whatsapp-webhook` (seen in run 38326562725) and `api-link-unknown-sender`.
- Supabase secrets `WA_APP_SECRET`, `WA_VERIFY_TOKEN` (documented in `docs/RUNBOOK.md:29`; values not visible).
- GitHub Environment variable `VITE_WA_DISPLAY_NUMBER` (empty in staging, so the panel shows the hard-coded `+15550142290`).
- Possibly a Meta app webhook subscription. No Fly app exists, so there are no Fly secrets to unset.

### 4.1 Retiring live WhatsApp data safely (staged)

1. **Inventory and back up** (owner-approved, read-only): `supabase migration list --linked`; row counts of `conversations`, `messages` (by `conversation_id` null or not, and by type), `transcripts`, `unknown_senders`, `report_sources` by kind, `reporters` by status, `jobs` by type and status (including queued `render_pdf` with `notifyReporter`), `notifications` by kind; `supabase functions list`; `supabase secrets list`; a `pg_dump` of these tables and the `audio`/`photos` buckets. The free tier has no point-in-time recovery. **Split in W1-01:** the inventory is the Deploy workflow's `inventory` target (names and counts only, `supabase/ops/inventory.sql` in a read-only transaction, `docs/RUNBOOK.md` §2), run now; the backup is taken at the cut-over (W1-19, step 21), right before the first `db push`, because a dump taken now would be stale and it holds personal data that needs a storage place the owner chooses.
2. **Expand**: add v1.2 tables and nullable columns beside the old ones; nothing dropped or renamed.
3. **Backfill**: `uploads` rows from `messages` media with the **same UUID**, so immutable `data.photos[].messageId` and `Source.messageId` resolve; `report_sources.upload_id`/`question_id`; `transcripts.upload_id`. Prove it on a frozen copy of the v1.0 seed (`git show 388fc63:supabase/seed.sql`) plus office-photo rows.
4. **Switch readers** (panel, PDF, evidence pack, retention, cost inputs) to uploads with a fallback, then **switch writers** (`attach_office_photos`, `create_office_report`, `create_report_version`, `list_orphan_office_photos`, `supabase/migrations/20261013000005_office_photos.sql:65-376`).
5. **Stop intake**: switch `scheduler-tick` off `send_template` first (`supabase/functions/scheduler-tick/index.ts:201`; this part ships at step 21, before the worker runs); turn off any Meta subscription; mark queued WhatsApp jobs `failed` with a `last_error`, following `docs/RUNBOOK.md:61-62` (`ops_discard_job` only accepts `dead` jobs, `supabase/migrations/20261012000003_ops.sql:214-226`).
6. **Remove code**, then delete remote functions and unset secrets, one approved step each.
7. **Deprecate** for one release: revoke client `select` on `conversations`/legacy tables, remove `unknown_senders` from realtime, comment the tables. Keep the data; keep panel mappings for legacy notification kinds `unknown_sender` and `reporter_invite_failed`.
8. **Drop** in a later migration after a fresh dump; recreate enum types to retire labels (Postgres cannot drop enum values); clean the `_pending/` and `_unknown/` storage prefixes (`apps/worker/src/jobs/transcribe_audio.ts:27`, `apps/worker/src/router/handlers/unknown.ts:26`).

---

## 5. Keep (valid under v1.2)

**Toolchain and CI:** `pnpm-workspace.yaml`, `tsconfig.base.json`, `eslint.config.mjs`, `.prettierrc`, per-package Vitest, `.github/workflows/ci.yml` jobs, `scripts/src/db-types-drift.ts`, the PGlite harness `supabase/db-tests/src/harness.ts` (add an anon helper; drop the blanket re-grant).

**Shared (channel-agnostic):** `report/hours.ts`, `report/patch.ts`, `report/payroll.ts`, `report/day-off.ts`, `report/numbering.ts` (`formatReportNo`, `pdfFileName`, `pdfStoragePath`), `report/validate.ts` (re-key sources), `report/photos.ts` (office-photo limits; re-point its `messages` join to uploads, D14), `status.ts`, `schedule/day.ts`, `schedule/reminders.ts` stage maths, `schemas/ai.ts`, `weather/observed.ts` (add units), the demo dataset's non-channel data (`demo/kestrel.ts`, `hero.ts`, `ids.ts`).

**PDF:** `packages/pdf` (ReportDocument, EvidencePack, components, static fonts), `apps/worker/src/pdf/render.ts`, `apps/web/src/lib/reportPdf.ts`, `apps/web/src/data/pdfInput.ts`.

**Database core:** RLS helpers (`supabase/migrations/20261011000004_rls.sql:6-33`, `:44-48`), `create_org` (deviation `README.md:52`), `log_audit`, `notify_org`, the queue functions (adapt), `next_report_no`, `denormalize_report_version` (accept v2 sources), `sign_off_report`, `undo_sign_off`, `mark_no_work`, `resolve_unknown_company`, `review_glossary_term`, `invoice_gaps`, `set_org_logo`, `update_org`/`update_reporter` (add locale fields), `attach_version_pdf`, `link_typed_companies`; views `current_manpower`, `current_weather`, `report_archive` (recreate after new `reports` columns, it selects `r.*`); buckets and pg_cron; `notifications`, `scheduler_state`, `stripe_events`, `platform_admins`, `report_costs`.

**Edge functions:** `stripe-webhook`, `api-billing` (rename the price env var), `api-export-payroll`, `api-evidence-pack`, `api-invite-office-user`; adapt `scheduler-tick` (keep site-day creation, stage claim, escalation, weather slots, digest, retention, billing; replace the WhatsApp ladder in M6) and `api-invite-reporter`; `_shared/*` except `conversations.ts`.

**Worker:** runner, claim loop, backoff, `/health`, metrics, shutdown; `storage.ts`; `ai/claude.ts`, `ai/extract.ts`, `ai/cost.ts`; `pipeline/validate.ts`, `pipeline/glossary.ts`, `pipeline/versions.ts`, `pipeline/compose.ts` (re-key on uploads); `extract_report` (minus the progress bubble), `fetch_weather`, `build_evidence_pack`, `weekly_digest`, `retention_cleanup` (walk uploads/calls), `send_email`, email templates and providers; `media/ffmpeg.ts` (peaks, duration); `ai/answer.ts`, `ai/correction.ts`, `ai/classify.ts` for M6.

**Panel (week 1 and beyond):** shell, auth, guards, UI kit, domain components (`VoicePlayer` → `MediaPlayer`, `SourceLink`, `TranscriptExcerpt`, `CalendarMonth`, `DataTable`, `KpiTile`, `StatusChip`), the data layer (adapt), and these pages:

- Overview, Sites, Site detail, Reports archive, Report review and the office editor (F18 keeps edit → new version).
- **Typed reports** (`apps/web/src/app/new-report/`, `create_office_report`, `README.md:62`) as an office fallback (D30).
- **Office photos** (`apps/web/src/app/report/PhotoPicker.tsx`, `README.md:64`), re-pointed to `uploads` (D14).
- **Browser PDFs and zip export** (`README.md:60`, `:63`).
- **Crew hours, invoices, payroll CSV** (P8/F19, M9): `apps/web/src/app/hours/`, `api-export-payroll`.
- **Weather and EOT evidence packs** (P9/F20, M9): `apps/web/src/app/weather/`, `api-evidence-pack`, `build_evidence_pack`.
- **Glossary** (P11, M9): `apps/web/src/app/glossary/`, `pipeline/glossary.ts` (add Turkish tab, STT key-term feed).
- **Team & numbers** (P10, M10): `apps/web/src/app/team/` (adapt statuses, preference, unknown contacts).
- **Settings** (P12): add the Field channels tab; **Billing** (P13): Stripe for US, TR provider open (§19 #8); **Setup** (P2): add preferred channel and SMS welcome preview.
- **`/ops`** (`README.md:61`; v1.2 M12 has an ops page, `docs/SITELOG_SPEC.md:2016`).

**Fixtures:** the 26 golden transcripts, expected extractions and recorded tool outputs (re-key `messageId` → `uploadId`, `schemaVersion 2`).

**Docs:** README deviations table, `docs/RUNBOOK.md`, `docs/AUDIT_BACKLOG.md`.

---

## 6. Conflicts and decisions for the owner

Each item: what the repo does, what v1.2 (or the kit `CLAUDE.md`) says, and a recommendation. Items marked **owner** need your answer before the related step; the others are recommendations we will follow unless you object. Numbers (D1–D45) are stable ids for reference from tickets and the plan; they are grouped by topic, so they do not run in order.

**Decided 2026-10-13:** the owner accepted every recommendation in this section, including the **owner** items. Two of them still hang on facts: D19 follows the read-only staging inventory (section 4.1 stage 1; rename if staging holds only demo reporters, otherwise set real ones to `invited`), and D41 needs the owner to create the second free Supabase project and its `preview` GitHub Environment. D23 keeps `CLAUDE_MODEL=claude-sonnet-5-5` for now.

### Stack and tooling

- **D1 · Node 20 vs 22.** Repo Node 22 (`.nvmrc:1`, `package.json:8`); kit Node 20 (`docs/START_HERE.md:25`, `docs/PLAN_WEEK1.md:26`). Node 20 cannot install this repo or run Vitest 5, and reached end-of-life on 2026-04-30. **Recommend:** keep Node 22 (maintenance LTS to 2027-04-30), plan Node 24 later, record it in README.
- **D2 · pnpm 9 vs 10.** **Recommend:** keep 10.28 (lockfile and CI use it; corepack picks it); record it.
- **D3 · React 18 vs 19, Vite 8.** Old §19.1 #18 recorded React 19, RR 7, Vite 8, Tailwind 4, Zod 4, Vitest 5 (`388fc63:docs/SITELOG_SPEC.md:1941`); v1.2 dropped §19.1 and only `CLAUDE.md:34` lists them now. **Recommend:** keep; add README deviation rows.
- **D4 · Tailwind config preset vs Tailwind 4 CSS tokens.** Spec §14.4 shows `tailwind.config.ts`; repo uses a CSS-first `@theme` (`README.md:51`). **Recommend:** keep Tailwind 4; the shared "preset" is `packages/shared/src/tokens.css` imported by both apps, plus `tokens.ts` for PDF and email.
- **D5 · Vitest workspace.** **Recommend:** keep per-package configs run by `pnpm -r test`.
- **D6 · Hono for `field-api`.** **Recommend:** use Hono for `field-api` only (about 14 routes plus voice tool routes later), wrapping the existing `_shared` helpers; leave other functions as they are.
- **D7 · Generated `db.types.ts` vs hand-maintained types.** **Recommend:** keep the hand-maintained file with the CI drift check (`README.md:58`); update it in every migration commit.
- **D8 · `seed:demo` semantics.** Repo generates `seed.sql`; plan wants service-role, idempotent seeding with `--date today`. **Recommend:** keep the generator (it also feeds demo mode, DB tests and e2e) and add an apply mode that upserts by the deterministic ids and touches only `is_demo` orgs; default output stays Oct 9 for e2e.

### Copy, i18n and brand

- **D9 · English-only copy vs i18next EN/ES/TR.** The old repo rule (`388fc63:CLAUDE.md:21`) is superseded by the merged `CLAUDE.md:78`. **Recommend:** adopt i18next; serve `apps/web/src/copy/en.ts` as the EN resource behind `t()`, convert shell and login first, then pages incrementally.
- **D10 · Brand SVGs (owner).** The kit's logo mark, inverted and mono files differ from the repo's; three kit files are new. **Recommend:** adopt the kit files (spec §14.5 says copy them) after a look on the preview; keep the repo's PNG favicons, apple-touch icon, lockup and avatar until regenerated from the kit. **Done in W1-01:** `pnpm brand` copies the kit SVGs and regenerates the PNG favicons, the apple-touch icon and the lockup from them; the avatar (WhatsApp profile) and the PDF and email marks (step 19) are unchanged; the owner's look on the preview is still open.

### Schema and data

- **D11 · "DDL §6.3 verbatim" vs a live schema.** **Recommend:** read "verbatim" as end-state equivalence. Reach it with new forward migrations, and add a db-test that applies the §6.2–§6.4 SQL blocks from the spec to a fresh PGlite and diffs columns, enum labels (with order) and constraints against the migrated database, with an explicit allowlist of recorded additions.
- **D12 · Repo-only additions.** `reports.kind`, `notifications`, `org_settings` ladder/PDF columns, `orgs.trial_ends_at`, `site_days.reminders_paused`, `report_costs`, `platform_admins`, `stripe_events`, `scheduler_state`. **Recommend:** keep them as recorded deviations (in the allowlist above).
- **D13 · `channel NOT NULL` for legacy and office rows (owner).** `field_channel` is `web`/`voice`/`sms`; typed reports and WhatsApp-era rows fit none. **Recommend:** add `office` to `field_channel` for typed reports (recorded deviation); leave pre-v1.2 WhatsApp rows with a null channel and enforce non-null for new rows in code and an insert trigger. Alternative: add a legacy `whatsapp` label (it can never be dropped).
- **D14 · `uploads.reporter_id NOT NULL` vs office photos (owner).** **Recommend:** make `reporter_id` nullable with an `uploaded_by` user column (recorded deviation), so PDFs, the Photos tab and evidence packs read one photo model.
- **D15 · `messages`: extend in place or new table.** **Recommend:** extend in place now (nullable SMS columns, `undeliverable`; SMS rows already satisfy the conversation-or-org check through `org_id`). After WhatsApp retires, move legacy rows to an archive, re-point foreign keys and enforce the v1.2 `NOT NULL`s and a fresh `msg_status` type.
- **D16 · Job dedupe: active-only vs fully unique.** **Recommend:** adopt v1.2's `UNIQUE` with `on conflict do nothing`, because "once each, even if retried" (W1-15) depends on it. First null keys on finished duplicates, give repeatable jobs per-occurrence keys (e.g. reinvite), and audit the worker's keys.
- **D19 · `verified` reporters (owner).** **Recommend:** if staging holds only demo data, rename `verified` → `active`; if it holds real reporters, set them to `invited` so they consent on the recorder (TCPA/KVKK), then rename the unused label. **Settled by the inventory (section 8):** no reporter is `verified`, so the label is renamed.
- **D20 · Stored v1 report versions.** **Recommend:** never rewrite them; normalise v1 → v2 on read (`audio` → `voice_note`, `reply` → `answer`, `messageId` → `uploadId`, `hoursBasis 'reply'` → `'answer'`).
- **D21 · Deferred RLS defects.** **Recommend:** fix them inside W1-05, since its role-matrix suite would fail on them (`docs/AUDIT_BACKLOG.md:36-41`, `:234-264`).
- **D22 · Accounts role reach (owner).** Accounts users can read sites, the full audit log, all notifications and every storage file (`supabase/migrations/20261011000004_rls.sql:115`, `:166-169`, `supabase/migrations/20261011000006_platform.sql:13`). **Recommend:** tighten to §2.2 (hours and invoices) in the role matrix.
- **D37 · Demo office emails.** **Recommend:** keep `@kestrelbuild.example`; the plan's `lena@kestrel.test` is only an example and e2e depends on the current ones.

### Pipeline

- **D17 · Backoff count.** "After 5 → dead" with five listed delays; the repo never uses the 2 h step. **Recommend:** use all five delays (dead after the 6th failure) and clarify §10.1.
- **D18 · Stale lock 15 → 10 min.** **Recommend:** 10 min.
- **D23 · Forced `tool_choice` and temperature 0 (owner: model).** The repo's reason is its own note that the 5.5-generation models reject forced `tool_choice` and non-default sampling (`apps/worker/src/ai/claude.ts:11-14`); the switch is per model profile (`:137-141`). **Recommend:** take the model from `CLAUDE_MODEL`; if it is a 5.5-generation model, record "tool_choice auto + verify and re-prompt" as a deviation in README and spec §19.
- **D24 · Prompt v2 "verbatim".** **Recommend:** use v2 verbatim; if the extra weather rule is still wanted, add it to spec §10.4 first. Keep the source-format note as a separate cached block and record it.
- **D25 · The 30 s "device not seen" rule** appears only in `docs/PLAN_WEEK1.md:100`. **Recommend:** keep 30 s and add it to the spec.
- **D26 · Rate limit wording** (plan "5 code sends/h", spec "5 code verifications/hour"). **Recommend:** limit both.
- **D27 · W1-12 Done-when wording.** It says "crew with missing hours"; the hero fixture and demo script ask a headcount ("Delta — 4 or 5?"). **Recommend:** follow the fixture and fix the plan wording.
- **D28 · Questions with no options.** **Recommend:** show a number input with "full day" as the default hours, rather than code-generated options, so code never proposes numbers the reporter did not say.

### Product and UI

- **D29 · `/try` simulator.** **Recommend:** keep demo-only until `/dev/phone` and the field app work, then delete; reuse its recorded transcripts as Demo phone fixtures.
- **D30 · Typed reports (not in v1.2) (owner).** **Recommend:** keep as an office fallback (recorded deviation), with `channel 'office'` (D13).
- **D31 · Office edits notify the reporter.** `create_report_version` enqueues `render_pdf` with `notifyReporter: true` (`supabase/migrations/20261013000005_office_photos.sql:344`), which sends a WhatsApp template (`apps/worker/src/jobs/render_pdf.ts:57-66`); v1.2 §13 texts `edit_applied` only for reporter edits (`docs/SITELOG_SPEC.md:1779`). **Recommend:** stop notifying on office edits.
- **D32 · Paper size.** **Recommend:** default from org country (Letter US, A4 TR); keep `org_settings.pdf_paper` as an explicit override; record it.
- **D33 · Report number and PDF file name.** Report numbers already match (`packages/shared/src/report/numbering.ts:2-4`, `supabase/migrations/20261012000002_rpc_fixes.sql:15`). **Recommend:** keep the storage object `{report_no}_v{n}.pdf`; serve downloads, attachments and zip entries with the §12 name `{report_no}_{YYYY-MM-DD}_v{version}.pdf`.
- **D34 · Turkish PDF in week 1 or M11.** **Recommend:** EN/TR labels and a Turkish sample render in week 1 (the fonts already carry the glyphs); metric weather and TR polish in M11.
- **D35 · Artboards without a channel column or filter.** **Recommend:** the spec wins (`CLAUDE.md:20`); add them and note the mismatch.
- **D36 · Oct 9 "awaiting" and `--date today`.** **Recommend:** with `--date today`, history ends yesterday and today's sites start pending/awaiting (the demo script's "five awaiting"); the unshifted Oct 9 output stays the default for e2e.
- **D38 · Function names.** **Recommend:** keep `stripe-webhook` (its URL is registered in Stripe); rename `api-link-unknown-sender` → `api-link-unknown-contact` by deploy-new, switch, delete-old.
- **D39 · `field-api` URL shape.** **Recommend:** the field app calls `/api/<route>` (e.g. `/api/resolve`); Hono mounts under `/field-api`; record Appendix B's `/field/…` prefix as a logical grouping.
- **D45 · `COST_WA_TEMPLATE_USD`.** **Recommend:** drop it with WhatsApp; add an SMS per-segment cost when cost-per-report is reworked (§15.1).

### Deploy

- **D40 · Production branch (owner).** There is no `main`; kickoff says "production stays on main" (`docs/START_HERE.md:51`). The remote has two branches, `claude/focused-newton-5v0u2q` and `spec-v1.2`, and GitHub's default branch is `claude/focused-newton-5v0u2q` (repository settings, read with the GitHub REST API on 2026-10-13), so PRs target it by default and the deploy workflow's `push: [main]` trigger (`.github/workflows/deploy.yml:12-13`) never fires. **Recommend:** treat `claude/focused-newton-5v0u2q` as the live staging branch for now and add a guard so `--prod` and `db push` run only from it; merge `spec-v1.2` into it at cut-over; create `main` only when you want a production environment (creating it fires the push-to-main deploy). **Done in W1-01:** the guard; with it, a push to `main` is skipped as well until the guard names a production branch, provided `main` is created from a commit that has the new workflow (the live branch keeps the old, unguarded one until the cut-over).
- **D41 · Preview backend (owner).** PR previews read and write live staging data and get no migrations. **Recommend:** a second free Supabase project with a `preview` GitHub Environment for `spec-v1.2`, so v1.2 migrations never touch staging before cut-over. **Done in W1-01 (workflow side):** the PR panel preview takes only the Netlify token and site from `staging` (the WhatsApp number and Sentry DSN are blanked too) and its Supabase settings from `preview`, else demo mode; the dispatch accepts `preview` for the Supabase target only, and refuses to deploy if `preview` resolves to the staging project. The owner still creates the project and the Environment (`docs/RUNBOOK.md` §2).
- **D42 · Field app hosting (owner).** **Recommend:** a second Netlify site (e.g. `staging-sitelog-field`) with its own key in `.github/netlify-sites.json`. Note: on `*.netlify.app` the Demo phone cannot frame the field app with its cookie, so open links in a new tab until custom domains under one registrable domain exist.
- **D43 · `/api/*` rewrite location.** **Recommend:** generate `apps/field/dist/_redirects` at build time from `VITE_SUPABASE_URL` (`/api/*` proxy first, SPA fallback second) instead of a `netlify.toml`; record it.
- **D44 · CI on `spec-v1.2`.** **Recommend:** keep PR #1 open as the CI and preview vehicle; optionally add `spec-v1.2` to the CI push branches. **Decided in W1-01:** not needed while PR #1 is open (a push trigger would run CI twice per push); `ci.yml` is unchanged.

---

## 7. Migration plan

Every step is one PR-sized change on `spec-v1.2`, pushed while PR #1 is open so CI and the panel preview run. "Verify" lists what must be true before the next step. Nothing reaches the live staging site until step 21, which needs your approval. This assumes a separate preview Supabase project (D41). Without one, the schema steps 8–11 would have to be pushed to staging early (each with your approval), the deployed panel must tolerate them, and from then on every staging deploy must come from `spec-v1.2`, because `db push` from a branch without those migration files fails. The renames of step 11 cannot be tolerated by the deployed panel (it reads `unknown_senders` and the old labels, `supabase/migrations/20261011000006_platform.sql:27`), so without D41 they wait for the cut-over in step 21.

**"Green" at every step** means, on the PR head: the five CI jobs (`.github/workflows/ci.yml:13-150`) and the Deploy workflow's panel job (and, from step 7, the field job) succeed. A step that adds a deploy target follows the existing pattern: the job skips with a notice until its secrets or site exist (`.github/workflows/deploy.yml:47-62`, `:147-166`), so a missing Netlify site or Supabase project never turns the PR red. After you approve this plan, `docs/PLAN_WEEK1.md` is rewritten for this repo (kickoff step 5, `docs/START_HERE.md:68-71`) with these steps as its order.

**Step 0 · Decisions and pre-flight** — all tickets

- Change: none in code. You answer the **owner** items in section 6 and the questions in section 8. With your approval, a read-only inventory of `abuanbyzttuqksdctqcp` (section 4.1, stage 1): the Deploy workflow's `inventory` target, added in W1-01. The backup moves to step 21, right before the first `db push`.
- Verify: numbers recorded in the PR; nothing on staging changed.

**Step 1 · Deploy safety** — W1-01, W1-19

- Change: guard in `deploy.yml` so `--prod` and the `supabase` job run only from the agreed branch (D40); optional `preview` Environment and second Supabase project (D41); optional `spec-v1.2` CI push trigger (D44: not needed while PR #1 is open).
- Verify: CI green; `pr-1` preview still builds; the guard condition reviewed, and the first guarded dispatch from another ref is seen to skip.

**Step 2 · Docs, env, brand** — W1-01

- Change: (the `.env.example` merge is already done, Appendix 9.1); make the worker read the root `.env` (the working-directory issue in section 2.8); README pitch, flow and deviation rows (Node 22, pnpm 10, React 19, Vite 8); `package.json:5`; brand SVGs after D10.
- Verify: `pnpm check`, `format:check`; logos look right on the preview.

**Step 3 · Shared, additive** — W1-02

- Change: `channels.ts`, `sms/segments.ts`, `copy/sms.{en,es,tr}.ts` + `renderSms`, `libphonenumber-js` helpers (existing `formatPhone` delegates), `computeTotals`, a numbering test, `copy/ui.*.json` skeleton, `tokens.css`/`tokens.ts` moved to shared and imported by `apps/web`, `packages/pdf/src/styles.ts` and the email templates.
- Verify: unit tests; Playwright screenshots unchanged; lockfile updated in the same commit (`--frozen-lockfile`).

**Step 4 · Report data v2 with read-compat** — W1-02 (prepares W1-12, W1-14, W1-17)

- Change: v2 schema, a union on `schemaVersion`, `upgradeV1toV2()`; panel, PDF input builders, worker render and evidence pack read through it; writers still write v1.
- Verify: v1 and v2 hero round-trips; sample PDF for v1 unchanged; `pnpm eval -- --recorded` and e2e green.

**Step 5 · Panel i18n and shell** — W1-03

- Change: i18next with `en.ts` as the EN resource; TR for shell and login; language switch on `/login` (persisted) and in the user menu; error boundary; `/dev/phone` and `/settings/channels` placeholders (`ComingNext.tsx`); v1.2 footer and login copy.
- Verify: unit, e2e, axe; EN ⇄ TR by hand; shell at 390 px.

**Step 6 · `apps/field` skeleton** — W1-04

- Change: `@sitelog/field` (PWA, manifest, icons, placeholder routes, EN/ES/TR, dev and preview proxy for `/api`, port 5174 `--host`); ESLint/Prettier scopes; root `dev` runs both apps.
- Verify: CI builds and tests it with no env set; loads on iOS Safari and Android Chrome through a tunnel and can be added to the home screen.

**Step 7 · Field hosting** — W1-04, W1-19

- Change: second Netlify site; a `field` job in `deploy.yml` with its own site key (never the panel's id) and its own find-or-create name (the panel job's fallback name `sitelog-<environment>-<owner>`, `.github/workflows/deploy.yml:196-205`, must not be reused); with no `field-<environment>` key the job finds or creates `sitelog-field-<environment>-<owner>` with the existing `NETLIFY_AUTH_TOKEN` (owner-approved, D42) and prints its id to add to `.github/netlify-sites.json`; it skips with a notice only while `NETLIFY_AUTH_TOKEN` is missing, and for `--prod` while the Environment has no Supabase project; build-generated `_redirects` (D43); `--alias pr-<n>` for PRs, as the panel does (`:212-213`).
- Verify: the PR deploys a field preview over HTTPS; the panel preview is unchanged; `/api/*` reaches Supabase (404 until `field-api` exists).

**Step 8 · Schema expand A1: enums** — W1-05

- Change: one migration with only `CREATE TYPE` for the 10 new enums and `ADD VALUE` for `report_status 'processing' AFTER 'collecting'`, `reporter_status 'opted_out' BEFORE 'disabled'`, `msg_status 'undeliverable'` (do not add `active`; step 11 renames `verified`). Update `enums.ts` and `db/types.ts`.
- Verify: `pnpm test:db` (label order), `supabase db reset`, the CI drift check.

**Step 9 · Schema expand A2: tables, columns, RLS** — W1-05 (may be split in two PRs)

- Change: the 6 new tables with RLS (field-side ones without client policies); nullable new columns; `orgs` column lockdown; `is_demo` on the seeded Kestrel org if present; §6.4 indexes; `calls` bucket; SMS columns, policy and realtime on `messages` (D15); `pg_notify` in `enqueue_job` (same signature); `report:<id>` lock key and v1.2 job priorities; 10 min stale lock; fixes for the deferred RLS defects; recreate `report_archive`. Tests: the two-org × role matrix, anon, the spec-DDL end-state diff (D11). Harness: no blanket re-grant.
- Verify: `pnpm test:db`, `db reset`, e2e-supabase, drift check; a concurrent numbering test on the CI Supabase stack; with approval, `db push` to the preview project (D41).

**Step 10 · Backfill and compat code** — W1-05

- Change: data migration from `messages` media to `uploads` (same UUIDs), `report_sources`/`transcripts` keys, `activated_at`, `reports.language = 'en'` then `NOT NULL`; code that accepts both old and new labels; office-photo RPCs write `uploads` (needs D13, D14).
- Verify: a backfill test on the frozen v1.0 seed plus office photos (row counts, mappings); panel reads uploads with fallback; e2e green.

**Step 11 · Renames** — W1-05

- Change: `verified` → `active` (or D19), `reporter_reply` → `reporter`, `sender_status` → `contact_status`, `unknown_senders` → `unknown_contacts` (+ `channel`, `call_id`), `stripe_*` → `billing_*` by expand/contract.
- Verify: `pnpm test:db`; `rg` finds old labels only in legacy readers; e2e-supabase.

**Step 12 · Seed v1.2** — W1-06

- Change: rebuild the channel layer of the Kestrel dataset; add Demir Yapı; `is_demo`, `contact_pref`, `locale`; hero v2 by `reporter` via `web`; `--date today`; apply mode; idempotency.
- Verify: applying twice gives the same rows (new test); e2e with the Oct 9 default; TR org renders.

**Step 13 · `field-api`** — W1-07

- Change: function with `verify_jwt = false`, Hono, routes, transactional report creation (number and insert in one transaction, so field reports never burn a number; the WhatsApp intake race, `apps/worker/src/router/handlers/intake.ts:258-280`, ends with step 22), tests.
- Verify: Deno tests and tests against local Supabase; on the field preview, a probe shows `Set-Cookie` and `Cookie` pass the Netlify proxy and responses carry `no-store`.

**Step 14 · SMS layer, invite, Demo phone** — W1-08

- Change: drivers, send function with `messages` logging, invite with `locale`/`contactPref` (request contract stays compatible), `send_welcome` by SMS, `sms-webhook`, Twilio fixtures and replay, `/dev/phone` with an Email tab.
- Verify: Done-when (inviting Marco shows the welcome text with a working link in the Demo phone); mocked-HTTP tests; existing invite tests green.

**Step 15 · Worker runtime** — W1-10

- Change: LISTEN on a dedicated connection, `send_sms`, office notice for dead jobs, D16 and D17.
- Verify: 100 jobs exactly once with concurrency 4 on the CI Supabase stack; `pnpm dev:worker` sends the welcome SMS.

**Step 16 · Transcription** — W1-11

- Change: `Transcriber`, Deepgram default, OpenAI fallback, `transcribe_upload`, about 600 peaks on `uploads`; EN, ES+EN and TR fixtures.
- Verify: a fixture upload produces a transcript with segments and peaks (fake provider without `DEEPGRAM_API_KEY`).

**Step 17 · Extraction v2** — W1-12

- Change: `extract.v2.md`, new user-message variables, v2 writers everywhere: the worker (`apps/worker/src/ai/extract.ts:141`), a migration that replaces `create_office_report` (it stamps `schemaVersion 1` in SQL, `supabase/migrations/20261013000005_office_photos.sql:203`) and the panel editor; `questions.channel 'web'`; channel-neutral question options `[{id,label}]` and `applyAnswer` taking a `Source` (`{type:'answer', questionId}`), with D28 for questions without options; EN/ES/TR fallback question prompts; `decide_next` split with the 30 s rule; weather units; the model profile per D23; eval re-keyed with Turkish cases and a report-language check.
- Verify: `pnpm eval -- --recorded`; ES+EN fixture → draft and one question; timing logged.

**Step 18 · Field screens** — W1-09, W1-13

- Change: device check, consent, Today, Recording with the offline queue, Processing, Question, Draft, Confirm & send.
- Verify: on a real iPhone and Android phone via the HTTPS preview: 2 minutes + 2 photos uploaded, airplane-mode queue, "5 · full day" → 40 h → filing.

**Step 19 · Filing, PDF, email** — W1-14, W1-15

- Change: remove WhatsApp delivery from filing and `render_pdf` (this also ends the office-edit WhatsApp notice, D31); `send_sms(filed)`; `confirmed_via`; retry-safe post-filing steps; EN/TR PDF labels and v1.2 copy; paper from org country (D32); the brand mark in the PDF footer; Turkish sample; §12 names for downloads and zips (D33); TR email subject and body, email footer without WhatsApp; optionally re-render on sign-off (`docs/AUDIT_BACKLOG.md:388`).
- Verify: confirming the fixture report gives one PDF, one `filed` text and one email even when the job is retried; sample PDFs checked against the artboards.

**Step 20 · Panel core** — W1-16, W1-17, W1-18

- Change: channel column, icon, filter and dots; No-photo flag; Text today's link; undeliverable and unknown-contact items; `call_mismatch`/`no_photo` reason copy; `MediaPlayer` on uploads with 1×/1.5×; language line from the org; v1.2 provenance and timeline; "CONFIRMED BY ANSWER" badge; Sites and Site detail actions and subtitle; TR copy for every page this step touches (`CLAUDE.md:101`).
- Verify: artboards at 1440 and 390 px; filing from a phone flips the Overview row within about 2 s; sign-off writes the audit row.

**Step 21 · Cut-over and dress rehearsal** — W1-19 (owner-approved)

- Change: re-run the read-only inventory and take the backup of section 4.1 stage 1 (`pg_dump` and the `audio`/`photos` buckets, stored where you choose) right before the first `db push`; stop the WhatsApp reminder ladder before any worker runs: `scheduler-tick` enqueues `send_template` reminders (`supabase/functions/scheduler-tick/index.ts:201`), week 1 has no ladder (`docs/PLAN_WEEK1.md:7`), and the ladder returns on SMS in M6 (this pulls the scheduler part of section 4.1 stage 5 forward); discard the queued WhatsApp-era backlog; merge `spec-v1.2` into the agreed branch; dispatch Deploy (db push → functions → web and field `--prod`); set v1.2 secrets, Auth site and redirect URLs, `CORS_EXTRA_ORIGINS`, `APP_URL`, `FIELD_APP_URL`; `seed:demo --date today` on the `is_demo` orgs; worker on the developer machine; write `docs/DEMO_NOTES.md`.
- Verify: the demo script passes twice in a row on a real phone.

**Step 22 · Retire WhatsApp** — cleanup after the demo

- Change: section 4.1 stages 5–7, in code order: web (`/try`, footer, `wa.me`, unknown-sender UI) → worker harness → worker (`router/`, `wa/`, WhatsApp jobs) → edge (`whatsapp-webhook` + its config block, `_shared/conversations.ts`) → shared (`wa/*`, `webhook/meta.ts`, `copy/whatsapp.ts`) → fixtures, env, CI, docs. Then, one approved step each: `supabase functions delete whatsapp-webhook` (later `api-link-unknown-sender`), unset `WA_*` secrets, delete `VITE_WA_DISPLAY_NUMBER`.
- Verify: `pnpm check`, `pnpm test:db`, Deno check and e2e green at every commit.

**Step 23 · Contract** — later release

- Change: drop legacy tables and columns after a fresh dump and at least one stable release; recreate enum types; enforce the `transcripts` XOR check and `report_sources.kind source_kind`; clean storage prefixes.
- Verify: `pnpm test:db`; staging smoke test; restore tested from the dump.

---

## 8. Open questions for the owner

**Inventory of `abuanbyzttuqksdctqcp`, 2026-10-13** (read-only, Deploy run 38414734882 from `spec-v1.2` at `50b7632`; answers Q1–Q3 and settles D19):

- All 16 migrations are applied; the deployed functions are the 9 of `supabase/config.toml`, including `whatsapp-webhook`.
- Edge function secrets: only `APP_URL` and the platform's `SUPABASE_*` values. No `WA_*`, `SCHEDULER_SECRET` or `STRIPE_*`, so no Meta app can reach the webhook (Q2: no).
- Data: 1 org (not the demo org), 1 conversation (state `new`), 1 reporter (`invited`), 0 messages, transcripts, unknown senders, reports, versions and notifications; storage holds 1 logo. No reporter is `verified`, so D19 is a plain rename `verified` → `active` (Q1: no customer reports, no WhatsApp traffic).
- Queue: 2 queued jobs (`send_welcome`, `build_evidence_pack`) and no `render_pdf` with `notifyReporter`. pg_cron's `sitelog-scheduler-tick` is active, but the Vault secrets `scheduler_secret` and `scheduler_tick_url` are missing, so `scheduler-tick` has never run and queued nothing (Q3). The queued `send_welcome` would send a WhatsApp template if a worker ran; it is discarded at the cut-over with the rest of the backlog (W1-19).

1. Does `abuanbyzttuqksdctqcp` hold only demo data, or real customer orgs with typed reports and office photos? Has it ever received real WhatsApp traffic?
2. Is a Meta app or WhatsApp number connected to the deployed `whatsapp-webhook`, and are `WA_*` secrets set there?
3. Is pg_cron with the Vault secrets active on staging? If so, `scheduler-tick` has been queuing WhatsApp `send_template` jobs with no worker; may we discard that backlog before a worker runs?
4. Is the Netlify site Git-connected? If yes, should Netlify-side builds stay off so only Actions deploys?
5. Are preview origins (e.g. `https://pr-1--staging-sitelog.netlify.app`) in the staging Supabase Auth redirect URLs, and is `CORS_EXTRA_ORIGINS` set?
6. Does a production GitHub Environment or Supabase project exist? Spec M0 asks for staging and prod (`docs/SITELOG_SPEC.md:1943`); only staging is evidenced.
7. Are custom domains planned (panel, field app, the `sl.link` short domain)? They decide cookie scope and whether the Demo phone can frame the field app.
8. Which `CLAUDE_MODEL` should v1.2 use (D23)?
9. For W1-19, should the worker run on a developer machine, or should we create the Fly app now?
10. Please confirm or change the **owner** items in section 6: D10, D13, D14, D19, D22, D23, D30, D40, D41, D42.
11. Should deleting an org, site, site-day or company keep cascading to its reports, versions and invoices as built, or refuse the delete as §6.3 does (spec §19 question 17)? Until you answer, the end-state allowlist keeps the repo's 15 `ON DELETE` actions as `repo-on-delete`.

---

## 9. Appendix

### 9.1 Environment variables: merge table

Columns: root `.env.example` line · kit `docs/env.example` line (both at `cc956dd`, before the merge) · who reads it in code · action, now applied in the merged root `.env.example`.

| Variable                                                                                                                                                                                                                                                        | Root                      | Kit             | Read by                                                                                       | Action                                                    |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- | --------------- | --------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| `SUPABASE_URL`                                                                                                                                                                                                                                                  | :2                        | :6              | worker `apps/worker/src/config.ts:27`; functions (platform-injected)                          | keep; local default `http://127.0.0.1:54321`              |
| `SUPABASE_ANON_KEY`                                                                                                                                                                                                                                             | :3                        | :7              | functions                                                                                     | keep                                                      |
| `SUPABASE_SERVICE_ROLE_KEY`                                                                                                                                                                                                                                     | :4                        | :8              | worker `apps/worker/src/config.ts:28`; functions                                              | keep                                                      |
| `SUPABASE_DB_URL`                                                                                                                                                                                                                                               | :5                        | :9              | worker (required, `apps/worker/src/config.ts:29`)                                             | keep                                                      |
| `VITE_SUPABASE_URL`                                                                                                                                                                                                                                             | :8                        | :12             | `apps/web/src/lib/env.ts:13`; deploy derives it (`.github/workflows/deploy.yml:150-156`)      | keep; field app needs it at build time for `_redirects`   |
| `VITE_SUPABASE_ANON_KEY`                                                                                                                                                                                                                                        | :9                        | :13             | `apps/web/src/lib/env.ts:14`                                                                  | keep (panel only)                                         |
| `VITE_APP_URL`                                                                                                                                                                                                                                                  | :10                       | —               | `apps/web/src/lib/env.ts:15-17`                                                               | keep (repo-only)                                          |
| `VITE_WA_DISPLAY_NUMBER`                                                                                                                                                                                                                                        | :11                       | —               | `apps/web/src/lib/env.ts:18`; `.github/workflows/deploy.yml:144`                              | remove with the WhatsApp footer                           |
| `VITE_DEMO`                                                                                                                                                                                                                                                     | :12                       | —               | `apps/web/src/lib/env.ts:20`                                                                  | keep (repo-only)                                          |
| `VITE_SENTRY_DSN`                                                                                                                                                                                                                                               | :13                       | —               | `apps/web/src/lib/env.ts:19`                                                                  | keep; field app reuses it                                 |
| `VITE_FIELD_API_URL`                                                                                                                                                                                                                                            | —                         | :14             | nothing yet                                                                                   | add (`/api`)                                              |
| `VITE_FEATURE_TALK_NOW`                                                                                                                                                                                                                                         | —                         | :15             | nothing yet                                                                                   | add (`false`)                                             |
| `VITE_ROUTER`, `VITE_BASE`, `VITE_SOURCEMAP`, `VITE_OUT_DIR`                                                                                                                                                                                                    | —                         | —               | `apps/web/vite.config.ts:8`, `:16-17`; `apps/web/src/App.tsx:16`                              | build-only; leave out                                     |
| `WA_PHONE_NUMBER_ID`, `WA_BUSINESS_ACCOUNT_ID`, `WA_ACCESS_TOKEN`, `WA_DISPLAY_NUMBER`, `WA_GRAPH_VERSION` (+ code-only `WA_GRAPH_BASE`)                                                                                                                        | :16-18, :21-22            | —               | worker `apps/worker/src/config.ts:31-36`                                                      | remove with `apps/worker/src/wa`                          |
| `WA_APP_SECRET`, `WA_VERIFY_TOKEN`                                                                                                                                                                                                                              | :19-20                    | —               | `whatsapp-webhook`; `scripts/src/replay-webhook.ts:26`; `.github/workflows/ci.yml:107-108`    | remove                                                    |
| `APP_URL`                                                                                                                                                                                                                                                       | :46                       | :18             | worker `apps/worker/src/config.ts:51`; functions CORS `supabase/functions/_shared/http.ts:29` | keep; local `http://localhost:5173`                       |
| `CORS_EXTRA_ORIGINS`                                                                                                                                                                                                                                            | —                         | —               | `supabase/functions/_shared/http.ts:30`, `:45-47`                                             | add (exact origins, no wildcard)                          |
| `FIELD_APP_URL`, `FIELD_API_URL`, `LINK_SHORT_DOMAIN`, `LINK_SIGNING_SECRET`, `DAILY_LINK_TTL_HOURS`                                                                                                                                                            | —                         | :19-23          | nothing yet                                                                                   | add [W1]                                                  |
| `SMS_US_PROVIDER`, `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `SMS_US_FROM`                                                                                                                                                                                     | —                         | :26-29          | nothing yet                                                                                   | add [W1, console]                                         |
| `SMS_TR_PROVIDER`, `ILETIMERKEZI_API_KEY`, `ILETIMERKEZI_API_HASH`, `SMS_TR_SENDER_TITLE`                                                                                                                                                                       | —                         | :30-33          | nothing yet                                                                                   | add [W1, console]                                         |
| `ANTHROPIC_API_KEY`                                                                                                                                                                                                                                             | :27                       | :36             | worker `apps/worker/src/config.ts:40`; CI eval (repository secret)                            | keep                                                      |
| `CLAUDE_MODEL`                                                                                                                                                                                                                                                  | :28 (`claude-sonnet-5-5`) | :37 (empty)     | `apps/worker/src/config.ts:41` (same default); `apps/worker/fly.toml:21`                      | keep; value per D23                                       |
| `CLAUDE_MODEL_FAST`                                                                                                                                                                                                                                             | :29                       | :38             | `apps/worker/src/config.ts:42`, falls back to `CLAUDE_MODEL` (`:83`)                          | keep                                                      |
| `DEEPGRAM_API_KEY`, `TRANSCRIBE_PROVIDER`                                                                                                                                                                                                                       | —                         | :39-40          | nothing yet                                                                                   | add [W1-11]                                               |
| `TRANSCRIBE_MODEL`                                                                                                                                                                                                                                              | :26 (`whisper-1`)         | :41 (`nova-3`)  | `apps/worker/src/config.ts:39`; `apps/worker/fly.toml:20`                                     | change to `nova-3` with W1-11                             |
| `OPENAI_API_KEY`                                                                                                                                                                                                                                                | :25                       | :42             | `apps/worker/src/config.ts:38`                                                                | keep (fallback only)                                      |
| `WEATHER_API_BASE`                                                                                                                                                                                                                                              | :32 (customer API)        | :45 (free API)  | `apps/worker/src/config.ts:44`                                                                | keep; dev value = free endpoint                           |
| `WEATHER_API_KEY`                                                                                                                                                                                                                                               | :33                       | :46             | `apps/worker/src/config.ts:45`                                                                | keep                                                      |
| `EMAIL_PROVIDER`                                                                                                                                                                                                                                                | :36 (`resend`)            | :49 (`console`) | `apps/worker/src/config.ts:47`; console without a key (`:85`)                                 | keep; default `console`                                   |
| `RESEND_API_KEY`                                                                                                                                                                                                                                                | :37                       | :50             | `apps/worker/src/config.ts:48`                                                                | keep                                                      |
| `EMAIL_FROM`                                                                                                                                                                                                                                                    | :38                       | :51             | `apps/worker/src/config.ts:49`                                                                | keep; dev sender per kit                                  |
| `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`, `LIVEKIT_AGENT_NAME`, `VOICE_NUMBER_US`, `VOICE_NUMBER_TR`, `LIVEKIT_SIP_OUTBOUND_TRUNK_US/TR`, `VOICE_AGENT_TOOL_SECRET`, `STT_MODEL`, `TTS_VOICE_EN/ES/TR`, `AZURE_SPEECH_KEY`, `AZURE_SPEECH_REGION` | —                         | :54-68          | nothing yet                                                                                   | add, commented [W2+]                                      |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`                                                                                                                                                                                                                    | :41-42                    | :71-72          | `stripe-webhook`, `api-billing`                                                               | keep                                                      |
| `STRIPE_PRICE_ID_SITE` → `STRIPE_PRICE_ID_SITE_US`                                                                                                                                                                                                              | :43                       | :73             | `supabase/functions/api-billing/index.ts:150`; `.github/workflows/ci.yml:112`                 | rename: set new secret, read new with fallback, unset old |
| `TR_BILLING_PROVIDER`                                                                                                                                                                                                                                           | —                         | :74             | nothing yet                                                                                   | add [W4]                                                  |
| `WORKER_CONCURRENCY`                                                                                                                                                                                                                                            | :47                       | :77             | `apps/worker/src/config.ts:52`                                                                | keep                                                      |
| `WORKER_PORT`                                                                                                                                                                                                                                                   | :48                       | —               | `apps/worker/src/config.ts:53`                                                                | keep (repo-only)                                          |
| `AUDIO_RETENTION_DAYS`                                                                                                                                                                                                                                          | :49                       | :78             | `apps/worker/src/config.ts:58`                                                                | keep                                                      |
| `SENTRY_DSN`                                                                                                                                                                                                                                                    | :50                       | :79             | `apps/worker/src/config.ts:59`                                                                | keep                                                      |
| `COST_WA_TEMPLATE_USD`                                                                                                                                                                                                                                          | :51                       | —               | `apps/worker/src/config.ts:64-68`                                                             | remove (D45)                                              |
| `SCHEDULER_SECRET`                                                                                                                                                                                                                                              | :52                       | —               | `supabase/functions/scheduler-tick/index.ts:65`                                               | keep (repo-only)                                          |
| `LOG_LEVEL`                                                                                                                                                                                                                                                     | :53                       | —               | `apps/worker/src/config.ts:25`                                                                | keep (repo-only)                                          |
| `NODE_ENV`, `WORKER_ID`, `JOB_TIMEOUT_MS`, `POLL_INTERVAL_MS`, `SWEEP_INTERVAL_MS`, `FFMPEG_PATH`, `WORKER_DRY_RUN`                                                                                                                                             | —                         | —               | `apps/worker/src/config.ts:24`, `:54-57`, `:69-71`                                            | optional tunables; leave out                              |
| `WEBHOOK_URL`, `REPLAY_PHONE`, `DATABASE_URL`, `API_URL`, `ANON_KEY`, `SERVICE_ROLE_KEY`, `PW_*`                                                                                                                                                                | —                         | —               | scripts, load test, e2e                                                                       | dev/test only; leave out                                  |

Also: add the v1.2 function variables (`TWILIO_AUTH_TOKEN`, `LINK_SIGNING_SECRET`, `FIELD_APP_URL`, `CORS_EXTRA_ORIGINS`) to the CI heredoc for `supabase/functions/.env` (`.github/workflows/ci.yml:105-113`) when those functions land.

### 9.2 Schema: table-by-table diff (v1.2 §6.3 vs repo)

Status: _same_ (same columns; repo may be stricter), _extras_ (all v1.2 columns plus repo additions), _adapt_ (columns missing or different), _conflict_ (WhatsApp-keyed shape), _add_ (missing), _rename_.

| v1.2 table         | Repo                                                                  | Status    | Notes                                                                                                                                                                                             |
| ------------------ | --------------------------------------------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `orgs`             | `supabase/migrations/20261011000002_tables.sql:5`                     | adapt     | Missing `country`, `locale`, `units`, `currency`, `tax_no`, `billing_provider`, `is_demo`; `stripe_*` instead of `billing_*`; extra `trial_ends_at`. Lock `is_demo`/billing against admin writes. |
| `org_members`      | `:19`                                                                 | adapt     | Missing `ui_locale`; extra `created_at`.                                                                                                                                                          |
| `org_settings`     | `:29`, `supabase/migrations/20261012000001_web_gaps.sql:12`           | adapt     | Missing `daily_link_time`, `auto_call_enabled`, `second_call_enabled`, `call_window_start/end`; repo extras (ladder toggles, PDF settings, payroll columns) are recorded deviations.              |
| `sites`            | `:59`                                                                 | extras    | Extra `paused_at`.                                                                                                                                                                                |
| `reporters`        | `:78`                                                                 | adapt     | Missing `locale`, `contact_pref`, `activated_at`, `opted_out_at`; status `verified`; `last_invite_error` is WhatsApp's "Not on WhatsApp".                                                         |
| `consents`         | —                                                                     | add       | Needs `consent_type`. Field-side.                                                                                                                                                                 |
| `site_reporters`   | `:93`                                                                 | same      | Cross-org write defect (`supabase/migrations/20261011000004_rls.sql:123`).                                                                                                                        |
| `site_recipients`  | `:100`                                                                | same      | —                                                                                                                                                                                                 |
| `companies`        | `:106`                                                                | extras    | Extra `created_at`.                                                                                                                                                                               |
| `field_links`      | —                                                                     | add       | Needs `link_kind`; index `(reporter_id, kind)`. Field-side.                                                                                                                                       |
| `field_devices`    | —                                                                     | add       | Field-side; revocation by RPC for admin/ops.                                                                                                                                                      |
| `messages`         | `:132`, `supabase/migrations/20261013000005_office_photos.sql:28-31`  | conflict  | WhatsApp log plus office-photo rows; v1.2 is SMS-only (D15).                                                                                                                                      |
| `site_days`        | `:172`                                                                | extras    | Extra `reminders_paused`, timestamps.                                                                                                                                                             |
| `reports`          | `:188`                                                                | adapt     | Missing `channel`, `language`, `confirmed_via`; status lacks `processing`; extra `kind`; `report_archive` view selects `r.*`.                                                                     |
| `uploads`          | —                                                                     | add       | Needs `upload_kind`; index `(report_id)`; backfill target for media; `reporter_id` decision (D14).                                                                                                |
| `calls`            | —                                                                     | add       | Needs the four `call_*` enums, index, `calls` bucket.                                                                                                                                             |
| `transcripts`      | `:150`                                                                | conflict  | `message_id NOT NULL UNIQUE`; v1.2 `upload_id`/`call_id` with XOR check. GIN index uses the `english` config.                                                                                     |
| `report_versions`  | `:212`                                                                | adapt     | Missing `via`; author `reporter_reply`; extra `author_message_id`.                                                                                                                                |
| `report_sources`   | `:226`                                                                | conflict  | `message_id NOT NULL`, text `kind` audio/photo/text/reply, `caption`/`taken_at`; v1.2 `source_kind` + upload/call/message/question ids.                                                           |
| `manpower_entries` | `:237`                                                                | extras    | Extra `company_name`, `hours_basis`.                                                                                                                                                              |
| `work_items`       | `:254`                                                                | extras    | Extra `quantity`.                                                                                                                                                                                 |
| `weather_events`   | `:267`                                                                | same      | `denormalize_report_version` only reads `audio` sources (`supabase/migrations/20261012000002_rpc_fixes.sql:53`).                                                                                  |
| `questions`        | `:287`                                                                | adapt     | Missing `channel`, `call_id`, `answer_source`; extra WhatsApp message ids.                                                                                                                        |
| `unknown_contacts` | `unknown_senders`, `:160`                                             | rename    | Add `channel`, `call_id`; `first_message_id` → `message_id`; keep `guessed_site_id`.                                                                                                              |
| `glossary_terms`   | `:303`                                                                | same      | —                                                                                                                                                                                                 |
| `sub_invoices`     | `:319`                                                                | extras    | Extra `queried_at`, `resolved_at`, status check.                                                                                                                                                  |
| `evidence_packs`   | `:335`                                                                | extras    | Extra `sections`, `error`, `ready_at`; forged-insert defect (`supabase/migrations/20261011000004_rls.sql:161`).                                                                                   |
| `jobs`             | `:351`                                                                | adapt     | `dedupe_key` not unique (D16); extras `locked_by`, `finished_at`, `lock_key`.                                                                                                                     |
| `rate_limits`      | —                                                                     | add       | PK `(key, window_start)`. Field-side.                                                                                                                                                             |
| `audit_log`        | `:366`                                                                | same      | Extra `actor_type` check; readable by accounts (D22).                                                                                                                                             |
| —                  | `conversations` (`:119`)                                              | repo-only | WhatsApp state machine; remove (section 4).                                                                                                                                                       |
| —                  | `notifications` (`:379`)                                              | repo-only | Backs §13 panel notifications; keep; add v1.2 kinds.                                                                                                                                              |
| —                  | `scheduler_state`, `stripe_events`, `platform_admins`, `report_costs` | repo-only | Keep (D12); `report_cost_inputs()` counts WhatsApp templates.                                                                                                                                     |

### 9.3 Enums (v1.2 §6.2 vs repo)

| Enum                                                                                                                                                          | Repo                                                | Status                                                          |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- | --------------------------------------------------------------- |
| `member_role`, `site_status`, `reporter_role`, `company_status`, `msg_direction`, `site_day_status`, `term_status`, `term_kind`, `job_status`, `pack_status`  | `supabase/migrations/20261011000001_enums.sql:6-23` | same labels and order                                           |
| `reporter_status`                                                                                                                                             | `invited, verified, disabled`                       | rename `verified` → `active`; add `opted_out` before `disabled` |
| `msg_status`                                                                                                                                                  | has `read`, lacks `undeliverable`                   | add `undeliverable`; new type in the contract phase             |
| `report_status`                                                                                                                                               | lacks `processing`                                  | add after `collecting` (own migration)                          |
| `version_author`                                                                                                                                              | `reporter_reply`                                    | rename → `reporter`                                             |
| `contact_status`                                                                                                                                              | `sender_status` (same labels)                       | rename type                                                     |
| `contact_pref`, `consent_type`, `field_channel`, `link_kind`, `upload_kind`, `call_direction`, `call_transport`, `call_status`, `call_outcome`, `source_kind` | —                                                   | add                                                             |
| `msg_type`, `convo_state`                                                                                                                                     | WhatsApp only                                       | remove in the contract phase                                    |
