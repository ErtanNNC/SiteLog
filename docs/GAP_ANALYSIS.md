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

SMS plus a personal link to a mobile web recorder (`apps/field`, a PWA), and later a phone-call voice assistant; **no WhatsApp** (amended 2026-10-14, D47–D49: everything country-specific is a country pack, and WhatsApp returns in week 2 as an optional message channel through Twilio, not the v1.0 Meta integration). Field users never get a database session: a new `field-api` edge function authenticates them by link code plus device cookie (`docs/SITELOG_SPEC.md:936-945`). Transcription moves to Deepgram, report data moves to `schemaVersion 2`, the schema grows to 30 tables with consents, links, devices, uploads and calls, the panel becomes EN/TR and the field app EN/ES/TR, and a Turkish demo org joins the US one.

### 1.3 Ticket counts (W1-01 … W1-19, W1-06a)

| Status    | Count | Tickets                                                |
| --------- | ----- | ------------------------------------------------------ |
| done      | 0     | —                                                      |
| partial   | 8     | W1-01, W1-03, W1-10, W1-14, W1-16, W1-17, W1-18, W1-19 |
| missing   | 3     | W1-04, W1-07, W1-09                                    |
| conflicts | 8     | W1-02, W1-05, W1-06, W1-08, W1-11, W1-12, W1-13, W1-15 |

**Added 2026-10-14:** W1-06a · Country packs and message channels (owner decision, D47–D49), _conflicts_ (M) at `2597982`: the US/TR check, per-country env and driver-level two-way SMS contradict the decision (its entry in section 3). It is not counted in the table, which describes `cc956dd`.

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

| Ticket | Status    | One line                                                                                                                                                      | Key references                                                              |
| ------ | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| W1-01  | partial   | Tooling and CI green; env merged; brand SVGs and v1.2 README missing; Node 22 not 20 (W1-01: brand files and README done, D10)                                | `package.json:6-9`, `.env.example`                                          |
| W1-02  | conflicts | Shared package exists but is v1.0: enums, report schema v1, WhatsApp copy; no SMS, tokens, i18n                                                               | `packages/shared/src/enums.ts`, `packages/shared/src/schemas/report.ts:240` |
| W1-03  | partial   | Full tested panel shell and magic link; no i18n/TR, no `/dev/phone`, no error boundary, WhatsApp footer                                                       | `apps/web/src/app/routes.tsx:53-90`, `apps/web/src/copy/en.ts:68`           |
| W1-04  | missing   | No `apps/field`, PWA, field routes or `/api` proxy                                                                                                            | `apps/web/public/_redirects:1`                                              |
| W1-05  | conflicts | Complete v1.0 schema, live; 6 tables and 10 enums missing; WhatsApp-keyed tables; RLS defects deferred                                                        | `supabase/migrations/20261011000002_tables.sql:119-169`                     |
| W1-06  | conflicts | Deterministic Kestrel dataset; WhatsApp channel data; no TR org, no `is_demo`, not idempotent, no `--date`                                                    | `scripts/src/seed-demo.ts:97`, `supabase/seed.sql:26`                       |
| W1-06a | conflicts | Added 2026-10-14 (owner): US/TR check on `orgs.country`, per-country SMS env and driver-level two-way SMS instead of country packs; no message channel kinds  | `packages/shared/src/channels.ts`, `20261013000007_schema_expand_v1_2.sql`  |
| W1-07  | missing   | No `field-api`; prerequisites missing from the schema                                                                                                         | `supabase/config.toml:60-112`                                               |
| W1-08  | conflicts | Invite exists but welcomes on WhatsApp; no SMS layer, `sms-webhook` or Demo phone                                                                             | `supabase/functions/api-invite-reporter/index.ts:122-134`                   |
| W1-09  | missing   | No recorder, upload queue or field screens                                                                                                                    | `pnpm-workspace.yaml:1-5`                                                   |
| W1-10  | partial   | Solid job runtime; no LISTEN/NOTIFY, no `send_sms` (W1-06a: the `notify` job, D48), no 100-job test; WhatsApp-tied lock keys (W1-10: built on `w1-10-worker`) | `apps/worker/src/runner.ts:154-210`                                         |
| W1-11  | conflicts | OpenAI transcription of WhatsApp audio; no Deepgram, no `transcribe_upload`                                                                                   | `apps/worker/src/jobs/transcribe_audio.ts:7-72`                             |
| W1-12  | conflicts | Mature extraction and validation on prompt v1 and schema v1; delivers questions on WhatsApp                                                                   | `apps/worker/src/ai/prompts/extraction.ts:3-32`                             |
| W1-13  | conflicts | No screens or routes; the answer mapping and `file_report` that exist are WhatsApp-shaped (reply source, Other… button, "OK" trigger)                         | `packages/shared/src/report/validate.ts:361`, `:481-488`                    |
| W1-14  | partial   | Two-page react-pdf report with embedded static fonts; English, imperial, WhatsApp wording                                                                     | `packages/pdf/src/ReportDocument.tsx:25-89`                                 |
| W1-15  | conflicts | Filing, PDF and email work; "Filed" and the PDF go out on WhatsApp; no SMS                                                                                    | `apps/worker/src/pipeline/file.ts:153-177`                                  |
| W1-16  | partial   | Overview with KPIs, realtime and actions; no channel column, link SMS or undeliverable item                                                                   | `apps/web/src/app/overview/Page.tsx:114-194`                                |
| W1-17  | partial   | Archive and review with versions, seekable audio, sign-off; WhatsApp sources and timeline                                                                     | `apps/web/src/app/report/SourcePanel.tsx:77-304`                            |
| W1-18  | partial   | Sites and Site detail built; no preference icon or channel dots; WhatsApp `wa.me` action                                                                      | `apps/web/src/app/site/Page.tsx:82`, `:112-135`                             |
| W1-19  | partial   | Hosted Supabase and Netlify deploys run; no field host, `/api` rewrite, v1.2 functions, demo notes                                                            | `.github/workflows/deploy.yml:69-81`, `:209-218`                            |

**Week 3 status (M7–M9, `docs/PLAN_WEEK3.md`; W3-18, 2026-10-17).** The table above is the kickoff snapshot of week 1. Week 3 is built on `spec-v1.2` with fakes for every provider; what is left is the owner's live half.

| Ticket                                                                                | Status                                                                                       | What is left                                                                                                                                |
| ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| W3-01 · W3-02 · W3-03 · W3-05 · W3-06 · W3-07 · W3-08 · W3-09 · W3-10 · W3-14 · W3-15 | done (CI green)                                                                              | nothing                                                                                                                                     |
| W3-04 `voice-events`                                                                  | partial                                                                                      | the live check with the LiveKit project's webhook (W3-16)                                                                                   |
| W3-11 hang-ups, fallback, post-call reconcile                                         | partial                                                                                      | a real call's recording through Deepgram and Claude (W3-16)                                                                                 |
| W3-12 the voice agent                                                                 | partial                                                                                      | `lk agent console` with the real Deepgram and Claude (by hand, keys)                                                                        |
| W3-13 Talk now and the photos screen                                                  | partial                                                                                      | the owner's phone check with LiveKit (W3-16)                                                                                                |
| W3-16 M7 live                                                                         | code half built (RUNBOOK, `voice:latency`, `voice:samples`)                                  | the LiveKit project, the agent deployed, the M7 calls and latency; **inbound phone calls wait on §19 Q227** (the dispatch rule's room name) |
| W3-17 outbound calls                                                                  | partial (console telephony)                                                                  | the Twilio trunk and number, counsel's `auto_call` wording, a real phone's R1 call                                                          |
| W3-18 M7–M9 acceptance                                                                | suites and demo notes built (`pnpm e2e:voice`, `pnpm e2e:m9`, `docs/DEMO_NOTES.md` "Week 3") | their CI run; the owner's phones and the preview run                                                                                        |

Open §19 questions raised in week 3 (Q135–Q227) each shipped a default (summary in `docs/PLAN_WEEK3.md`, "Week 3 open questions").

**Week 4 (M10 setup, team, settings, billing; M11 Turkish market): `docs/PLAN_WEEK4.md`, W4-01 … W4-16 (planned 2026-10-17 at `fa630b2`).** The gap check against M10 and M11 is in that plan ("Where week 3 leaves us" and each ticket's "Already in the repo"). In short: Setup, Team, Settings, Billing and New report still render inside `<EnglishOnly>` and carry v1.0 WhatsApp wording (the welcome preview is the `sitelog_welcome` template, Team's phone column and "Verified" chip, Settings' hints, "$399" in the copy); Settings' Field channels tab is a placeholder; the phone picker is the fixed `PHONE_COUNTRIES` list; the price is a constant in code and a lapsed trial blocks nothing; there is no TR billing provider (§19 Q8, Q9 open), no `/legal/<key>` page (Q50), no İletimerkezi delivery status, no Turkish call fixture or spoken-form rules, no starter glossary for a new org, and the office emails other than the report email are English only. New open questions Q229–Q246 are in spec §19, each with the default the tickets ship.

**Week 4 status (M10–M11, `docs/PLAN_WEEK4.md`; W4-16, 2026-10-17).** Everything in the paragraph above is built on `spec-v1.2` with fakes for every provider (the phone picker from libphonenumber, the wizard, Team, Call now, Settings' Field channels, Billing per org with `manual` for TR, the `/legal/<key>` page, the Turkish spoken forms and call fixtures, the starter glossary, the panel and the office emails in Turkish, İletimerkezi's status poller, self-serve onboarding with the 48 h re-send); what is left is the owner's live half and counsel's texts.

| Ticket                                                          | Status                                                                                      | What is left                                                                                                                             |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| W4-01 · W4-02 · W4-03 · W4-04 · W4-06 · W4-07 · W4-08 · W4-09   | done (CI green)                                                                             | nothing (W4-09: the hosted Auth templates are an owner step, RUNBOOK)                                                                    |
| W4-05 Settings: Field channels                                  | built (the last sub-box, _Call me now_, in 408679e)                                         | its CI run                                                                                                                               |
| W4-10 Billing on v1.2                                           | done on fakes                                                                               | Stripe test mode on the preview project (W4-15)                                                                                          |
| W4-11 İletimerkezi delivery status                              | done on a mocked API                                                                        | the report endpoint (§19 Q280) and a real phone from `SITELOG` (W4-13)                                                                   |
| W4-12 self-serve onboarding                                     | done (CI, the SMS stand-in)                                                                 | the owner's run with the US sender and a real phone (`docs/DEMO_NOTES.md` "Week 4")                                                      |
| W4-13 TR go-live · W4-14 Turkish voice live · W4-15 Stripe live | owner's (accounts, counsel)                                                                 | İletimerkezi and `SITELOG`, counsel's KVKK texts and the legal keys, Azure and the listening test, Stripe test mode; TR billing (Q8, Q9) |
| W4-16 M10–M11 acceptance                                        | suites and demo notes built (`pnpm e2e:m10`, `pnpm e2e:m11`, `docs/DEMO_NOTES.md` "Week 4") | their CI run; the owner's onboarding run, the TR demo and the Billing cycle on the preview project                                       |

Open §19 questions raised in week 4 (Q229–Q246, Q270, Q280, Q281, Q290, Q300, Q330, Q340, Q350) each shipped a default (summary in `docs/PLAN_WEEK4.md`, "Week 4 open questions").

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
- _Channel copy._ Repo: WhatsApp footer, login bullets and meta description (`apps/web/index.html:9`). Spec: texts and calls. Recommend: change the copy; take the number from org settings or `VOICE_NUMBER_US/TR` (W1-06a: the number is the pack's `countries.voice_number`, D47/D48; `VOICE_NUMBER_US/TR` removed).
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

### W1-06a · Country packs and message channels — new (owner decision 2026-10-14) · effort M

Added after this analysis by the owner's decision of 2026-10-14 (D47–D49): SiteLog is a global product, and everything country-specific is a country pack (configuration), not code. Described as the repo stood at `2597982` (the W1-06 Q18 commit), before W1-06a.

**Done (before W1-06a)**

- `orgs.country`, `locale`, `units`, `currency`, `timezone` with US defaults and `check (country in ('US','TR'))` (`supabase/migrations/20261013000007_schema_expand_v1_2.sql`); `create_org(text, text, text, text)` made every org a US org with those defaults.
- `packages/shared/src/channels.ts` (W1-02): `FieldChannel`, `Notifier.text`, `SmsTransport` with a `twoWay` flag per driver, `SMS_DRIVERS_BY_COUNTRY`, and helpers reading `SMS_US_PROVIDER`, `SMS_TR_PROVIDER` and `VOICE_NUMBER_US/TR`; only its own test imported it.
- SMS copy with US-only keys and the reply clause inside the EN and ES `welcome` texts (`packages/shared/src/copy/sms.*.ts`); `unitsFor()` by locale (`packages/shared/src/locale.ts`).
- A setup wizard with no country (`apps/web/src/app/setup/`).

**Missing**

- A `countries` table and the `message_channel` type (`sms`, `whatsapp`, `push`); `reporters.message_channel`, `messages.channel`; `create_org(p_country)` and the paper preset; a way to set each pack's sender id and voice number per environment; the wizard's country select.

**Conflicts**

- _Two-way SMS on the driver._ Repo: `SmsTransport.twoWay` (Twilio true, İletimerkezi false, console true). Owner: two-way SMS and links in SMS come from the country pack. Recommend: D48.
- _Provider per country from env._ Repo: `SMS_DRIVERS_BY_COUNTRY` allowed only Twilio for US and only İletimerkezi for TR, picked by `SMS_*_PROVIDER`. Owner: Twilio by default, overridable per country. Recommend: D47, D48.
- _Steps 22 and 23._ As written they delete the 24 h window logic with `wa/*` and recreate `msg_status` without `read`. WhatsApp returns through Twilio in week 2. Recommend: D49.

**Plan:** step 12a (section 7), four commits: schema; channel layer and SMS copy; setup wizard and `pnpm countries:set`; docs. Week-1 behaviour does not change: both packs order `{sms}`, every sender id and voice number is null (so `console`), `is_demo` orgs stay on `console`, and the deployed v1.0 panel's `create_org` call still creates a US org.

### W1-07 · `field-api` Edge Function — missing · effort L

**Done:** nothing. No function, router, link-code or cookie auth, or rate limiting (`supabase/functions/README.md:8-17`, `supabase/config.toml:60-112`). No signed upload URLs anywhere in the repo.

**Missing**

- `supabase/functions/field-api` with a `[functions.field-api] verify_jwt = false` block (a `_redirects` proxy cannot add a Supabase JWT).
- Auth: link code sha256 → `field_links`; `sl_dev` cookie (httpOnly, Secure, SameSite=Lax, 180 days) → `field_devices.verified_at`; every query scoped to the reporter's sites; rate limits.
- Routes `resolve`, `device/send-code`, `device/verify`, `consent`, `today`, `uploads`, `uploads/:id/complete`, `reports/:id`, `reports/:id/answer`, `reports/:id/confirm`, `day-status`, `history`, `preferences`; `last_seen_at` on each call; audit rows with `actor_type 'reporter'`. _(W2-02 added `GET preferences`, `consent/revoke`, `device/sign-out`, and `consent/grant` (Settings' *Turn on* for texts, spec §19 Q86, `field_grant_consent()`, `20261016000080`); W2-03 added `expired/daily-link` (F16, no device needed, 3 a day per expired link) and `isLate` on `history`, and the device-check lock's office notice through `field_device_verify_locked()`, `20261016000020`; W2-04 added `addTo` on `uploads` (F9 photos after filing, a batch per *Add more photos*), `field_attach_photos()` behind `uploads/:id/complete`, and `addPhotos` / `changeNote` on `reports/:id`, `20261016000030`.)_
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

- `SmsTransport` drivers `console`, `twilio`, `iletimerkezi`; driver per org country from env (W1-06a: from the org's country pack instead, D48); `is_demo` → `console` (needs `orgs.is_demo`/`country`, `supabase/migrations/20261011000002_tables.sql:5-17`).
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
- `send_sms` handler and job type (W1-06a: the `notify` job, D48); `send_welcome` on SMS (`apps/worker/src/jobs/registry.ts:18-34`).
- "100 jobs exactly once with concurrency 4" against a local DB (the load test runs 6 WhatsApp reports, `apps/worker/src/integration/loadtest.test.ts:27-47`).
- Dead reporter-facing jobs notify the office, not a WhatsApp `error_retry` (`apps/worker/src/runner.ts:97-115`).

**Conflicts**

- _Dedupe semantics._ Active-only in the repo (a test asserts a key is free again after `done`, `apps/worker/src/db.pglite.test.ts:1124-1130`); unique in v1.2. Recommend: D16.
- _Lock key and priority._ `job_lock_key` derives `convo:<id>` from WhatsApp tables; `job_priority` ranks WhatsApp job names (`supabase/migrations/20261012000004_queue_fairness.sql:20-58`). Recommend: add a `report:<id>` branch and v1.2 job names before `transcribe_upload` and `extract_report` can run for the same report.
- _Retry count._ The 2 h delay is unreachable (`supabase/migrations/20261011000005_rpcs.sql:76-83`). Recommend: D17.
- _Stale lock._ 15 min (`supabase/migrations/20261012000004_queue_fairness.sql:65`, `:69`) versus 10 min. Recommend: 10 min (D18); safe with the 5 min job timeout.

**Built (W1-10, branch `w1-10-worker`)**

- LISTEN on its own session connection with reconnect (`apps/worker/src/listener.ts`; `SUPABASE_DB_LISTEN_URL` for a transaction-pooler `SUPABASE_DB_URL`), wake-ups kept across a claim, 5 s poll fallback, `/health` `listening`.
- The `notify` job (D48) on the Notifier; dead jobs: Sentry, `message_failed` / `processing_failed` panel notices for reporter-facing ones, `job.dead` audit (spec §19 Q54); no WhatsApp `error_retry`.
- D16 and D17 in `20261015000001_worker_runtime.sql` (clean-up of finished duplicates, `jobs_dedupe_key_key`, `on conflict do nothing`, `requeue_dead_job()`, filing keys per confirm occurrence, all five delays); per-occurrence keys (`jobKeys`) and the key audit test (`scripts/src/job-keys.test.ts`, which reads every `dedupeKey` property and every `enqueue_job()` call and fails on one it cannot resolve). Drafts keep their version until filed, so a filing keyed by version alone would let a finished stale filing swallow every later confirm: the web confirm uses `file:<report>:v<version>` first and `…:c<n>` after a finished one, the WhatsApp confirm `…:m<message>`, the timeouts `…:t<draft sent at>`.
- The timeout race closed: an AbortSignal per job reaching the HTTP clients, `fail_job` only after the handler settles, a `locked_at` heartbeat meanwhile (`docs/AUDIT_BACKLOG.md`); the wait is bounded (`STUCK_JOB_MS`, 5 min after the abort: the heartbeat stops, `/health` answers 503 and the worker exits so the platform restarts it and the stale-lock reclaim re-runs the job).
- `scheduler-tick` without the WhatsApp ladder (`planTickJobs`), until M6. The §7.1 status step is kept: a today site-day past its deadline plus the org's missing offset becomes `missing` (`planMissing`, audited `site_day.status_changed`), so the panel's Overview Missing segment and its attention card still work; the office alert (the `missing_report` panel notice and the `report_missing` email, worded without any reminder) goes with it (spec §19 Q55, decided 2026-10-15). Site-days are no longer marked `reminded` (no reminder is sent). **W2-05 (M6):** the per-reporter decision `remind()` (`packages/shared/src/schedule/remind.ts`, spec §7.4 as built), with spec §19 Q76 and Q77 as parameters on their recommended defaults (decided by the owner 2026-10-16, as built); nothing calls it until W2-06. **W2-06 (M6):** the ladder runs again on the Notifier: `planLadder` (daily link, heads-up, R1, R2 per reporter of the site, through `remind()`), each stage claimed with its `notify` jobs by `claim_site_day_reminder()` (`20261016000040_reminder_ladder.sql`, which also makes `mark_site_day_missing()` skip non-working days and count the reminders), the worker's guard before each send (`ladderGuardVerdict`, `NOTIFY_FALLBACK_GUARDS`), §13's "didn't answer {n} reminders"; `REMINDER_LADDER_RUNS` and `pickReminderTarget` are gone, `reminderJob` waits for step 22. Six reminder-ladder findings of `docs/AUDIT_BACKLOG.md` are closed.
- Tests: worker unit (`runtime.test.ts`), PGlite (`worker-runtime.test.ts`, `db.pglite.test.ts`), Deno (`logic_test.ts`), and `test:stack` (`apps/worker/src/runtime.stack.test.ts`: 100 jobs with two workers of concurrency 4 woken by NOTIFY, the LISTEN reconnect, the poll fallback). CI's worker runs with a 120 s poll, so the W1-08 invite's welcome cannot wait for the poll (NOTIFY, or the wake after another job finishes, claims it).

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

**Built (W1-11, branch `w1-11-transcribe`)**

- `Transcriber` (`apps/worker/src/ai/transcriber.ts`): Deepgram nova-3 over plain fetch (`apps/worker/src/ai/deepgram.ts`: `smart_format`, `utterances`, `language` `multi`/`tr`/`en` from the reporter, one `keyterm` per hint incl. areas, retried without key terms when refused, the job's AbortSignal), OpenAI behind the same interface, and a fake answering with `fixtures/voice` (`TRANSCRIBE_PROVIDER=fake`; also outside production when the provider's key is missing, never in production). `TRANSCRIBE_PROVIDER`, `DEEPGRAM_API_KEY`, `TRANSCRIBE_MODEL` (empty = the provider's default) in the config, `.env.example` and `apps/worker/fly.toml`; the WhatsApp voice notes keep OpenAI whisper-1 until step 22.
- `transcribe_upload`: the file as recorded → ffmpeg duration and 600 peaks → one transaction for the transcript (`upload_id`), `uploads.duration_s`/`peaks` and the `transcript.created` audit → `extract_report` keyed by the report and its latest voice upload once every kept voice note is transcribed (`jobKeys.extractUpload`; spec §19 Q57 for a note that never transcribes). No schema change (the W1-05 columns suffice).
- The integration harness's field-upload entry point (`world.uploadVoiceNote`), `fixtures/voice` (EN, ES + EN hero, TR; expected transcripts, no audio: no microphone or offline TTS here) and `pnpm transcribe:fixture` for the by-hand Deepgram check; the panel's VoicePlayer folds 600 peaks to 64 bars. Decided 2026-10-15: spec §19 Q56 (the language rule for English-only and other-language reporters, as built), Q57.

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

**Built (W1-12, branch `w1-12-extract`)**

- Extraction v2 for the web recorder (`apps/worker/src/jobs/extract_report.ts` → `runReportExtraction`): prompt v2 verbatim (`apps/worker/src/ai/prompts/extract.v2.md`, D24), the source-format note as a second cached block (§19 Q59), the v2 user message (`REPORT_LANGUAGE`, `UNITS`, `REPORTER_LOCALE`, `CHANNEL`, `WORKING_HOURS`, `OBSERVED_WEATHER` in the org's units), `ReportExtractionSchema` as the tool; code sets the v2 envelope, recomputes totals and drops sources that point at no input; `CLAUDE_MODEL` with `tool_choice: auto` + verify/re-prompt on the 5.5 generation (D23, README, §19 Q58); phone numbers redacted from every block of every Claude call (`redactPhones`, AUDIT_BACKLOG closed). The WhatsApp worker keeps prompt v1 and v1 data until step 22.
- v2 writers: the web pipeline, `create_office_report()` (`20261015000002_extraction_v2.sql`; v1 data from an old panel stays v1) and the panel editor (New report; office edits through the v2 view).
- Questions on `web` with `[{id, label, value?}]` options, _Other…_ hidden until M6, D28 (no code-made numbers; a headcount without model options asks for the number), EN/ES/TR fallbacks; `applyAnswer(Source)` with every caller updated; `decide_next` split into a pure plan and one Notifier call under the 30 s device rule (D25, `apps/worker/src/pipeline/web.ts`); answers applied again after a re-extraction (§19 Q60).
- `field-api` `reports/:id/answer` and the service-only `field_answer_question()`; a photo on a draft awaiting confirmation reopens it and re-extracts (§7.2).
- Eval v2: the 26 cases re-keyed, two Turkish cases, the report-language check; the CI replays generated from the expected data (no key; `pnpm eval -- --write-recorded`); load-test target 60 s / 150 s. §19 Q58–Q62 decided by the owner 2026-10-15 (the recommendations; Q59's note is now in spec §10.4, Q62's half day is half the default shift); Q63 waits for a native-speaker review.

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
- Paper from org country (W1-06a: preset into `org_settings.pdf_paper` from the pack, D32 amended by D47); letterhead tax line (`orgs.tax_no` missing).
- v1.2 copy for the footer, source record, sign-off and footnotes; a real mini mark (today a 9 × 9 orange box, `packages/pdf/src/styles.ts:145`).
- A Turkish sample render and a glyph test.
- Re-render on sign-off so "Signed off in SiteLog by {name}" reaches the stored PDF (`docs/AUDIT_BACKLOG.md:388`).

**Conflicts**

- _WhatsApp wording_ (`packages/pdf/src/components.tsx:352-354`, `packages/pdf/src/ReportDocument.tsx:45`, `:79`, `:238`). Recommend: copy driven by `reports.channel`/`confirmed_via`.
- _Paper source._ Manual `org_settings.pdf_paper`, default letter (`supabase/migrations/20261011000002_tables.sql:48`, `apps/worker/src/pdf/render.ts:217-221`). Recommend: D32.
- _WhatsApp delivery in `render_pdf`_ (`apps/worker/src/jobs/render_pdf.ts:41-67`, payload flag `packages/shared/src/schemas/jobs.ts:28`). Recommend: remove; `send_sms(filed)` in W1-15 (W1-06a: `notify(filed)`, D48).
- _File name._ Storage object `{report_no}_v{n}.pdf` (`packages/shared/src/report/numbering.ts:11-19`); email uses the §12 name (`apps/worker/src/jobs/send_email.ts:74`); zip entries `{reportNo}.pdf` (`apps/web/src/lib/pdfZip.ts:33`). Recommend: D33.

### W1-15 · Filing, SMS and email — conflicts · effort L

**Done**

- `fileReport`: freeze, denormalise via `denormalize_report_version` (`supabase/migrations/20261012000002_rpc_fixes.sql:18-56`), `filed_at`, `confirmed_at`, `is_late`, review reasons, site-day status, audit, `render_pdf` with dedupe (`apps/worker/src/pipeline/file.ts:87-151`).
- Email via Resend or console, PDF attached under the §12 name, §13 EN subject (`apps/worker/src/jobs/send_email.ts:55-102`, `apps/worker/src/email/templates.ts:122-126`).
- A second `fileReport` call is a no-op (`apps/worker/src/pipeline/pipeline.test.ts:323-361`).

**Missing**

- `send_sms(filed)` (W1-06a: `notify(filed)`, D48) with the Filed-screen link `/r/{code}/report/{id}`; the Filed screen; `photos_link` after call-filed reports.
- `file_report(report_id, via)` and `reports.confirmed_via`; `report_sources` per v1.2.
- TR subject and body; an email footer without WhatsApp (`apps/worker/src/email/templates.ts:69`); console email visible in the Demo phone.
- "Once each, even if retried": dedupe keys block duplicates only while a job is active (`supabase/migrations/20261011000005_rpcs.sql:36-39`), and a failure after `status = filed` skips the post-filing steps for good (`docs/AUDIT_BACKLOG.md:563-568`; `apps/worker/src/pipeline/file.ts:50-52`).

**Conflicts**

- _Filed notification channel._ WhatsApp "Filed." (`apps/worker/src/pipeline/file.ts:172-178`) and PDF document (`apps/worker/src/jobs/render_pdf.ts:41-56`). Recommend: `send_sms` keyed `filed:{report_id}` through the `Notifier` (W1-06a: the `notify` job keyed `notify:filed:{report_id}`, D48).
- _Conversation coupling._ `fileReport` resets the WhatsApp conversation (`apps/worker/src/pipeline/file.ts:153-171`). Recommend: remove.
- _Trigger._ `confirmMessageId` from a WhatsApp "OK" (`apps/worker/src/pipeline/file.ts:27`, `:126`, `packages/shared/src/schemas/jobs.ts:23`). Recommend: `via` parameter.
- _`report_sources` model_ (`supabase/migrations/20261011000002_tables.sql:226-234`, written at ingest, `apps/worker/src/db.ts:853`). Recommend: migrate in W1-05.

**Built in W1-15** (CI runs the field `e2e:supabase` step first; the phone check is the owner's): `file_report(report_id, via)` and `reports.confirmed_via` (`field_confirm_report()` sends `web`); no WhatsApp "Filed." or PDF; `notify(filed)` keyed `notify:filed:{report_id}` with the Filed-screen link `/r/{code}/report/{id}`; retry-safe post-filing steps (`ensurePostFiling()`); one email per job key (Resend idempotency, `console_emails.dedupe_key`); the EN/TR report email with a channel-free footer; the Filed screen (Field-07) without _Add photos_ and _Past reports_ until M6 (spec §19 Q67). Still missing: `photos_link` after call-filed reports (week 2, calls). **W2-04 (M6):** the Filed screen's _Add more photos_ and _Past reports_ with the edit hint; photos after filing (F9) as a batch of uploads made one new version (`field_attach_photos()`, `20261016000030`), the `_v{n}` PDF and the "Updated" email (to the signer too when the photos reopen a signed-off report, `signerId` as W2-11's change, `20261016000130`); the web-filed window is spec §19 Q89 (decided 2026-10-16 as built).

### W1-16 · Overview (realtime) — partial · effort M

**Done:** KPI tiles (`apps/web/src/app/overview/Page.tsx:278-330`); Sites today with status chip, Late, In at, crew, hours, weather (`:114-194`); Needs attention in F17 order minus undeliverable texts (`apps/web/src/data/assemble.ts:783-790`); actions Call (tel:), Mark no work (RPC, audited, `supabase/migrations/20261011000005_rpcs.sql:192-204`), Review report, Compare hours; realtime invalidation (`apps/web/src/data/supabase/SupabaseSource.ts:1717-1757`, `apps/web/src/data/DataProvider.tsx:48-54`); E2E flips a row after a server-side update (`apps/web/e2e/supabase/panel.spec.ts:44-80`).

**Missing:** channel column and icon; Text today's link (`daily_link` SMS); undeliverable-text item; unknown contacts (callers and texters); `call_mismatch`/`no_photo` reason copy (`apps/web/src/data/assemble.ts:515-531`); v1.2 footer; a phone-driven realtime check; 390 px (screenshots use 375, `apps/web/e2e/screenshots.spec.ts:5`).

**Conflicts**

- _Unknown contact model._ WhatsApp `unknown_senders` with "Link number" (`apps/web/src/data/assemble.ts:760-770`). Recommend: generalise to `unknown_contacts` with a channel; keep the link/ignore flow.
- _Demo "Try it on WhatsApp" card_ (`apps/web/src/app/overview/Page.tsx:232-248`). Recommend: replace with a Demo phone entry (D29).
- The Web-Overview artboard shows no channel column, while P3 and the ticket require one: the spec wins (D35).

**W1-16 (2026-10-15):** built: channel column and `ChannelIcon`, Text today's link (`api-text-daily-link`), undeliverable and unknown-contact items, `call_mismatch`/`no_photo` copy, `api-link-unknown-contact` (D38, the panel switched), the Demo phone card (D29), EN/TR, screenshots at 390 px, a 10 s poll beside realtime; see `docs/PLAN_WEEK1.md` W1-16. Open: the owner's phone check, spec §19 Q55's alert line.

### W1-17 · Reports archive and Report review — partial · effort M

**Done:** archive with URL filters (site, dates, status, weather delay, edited, late, incident, search), flags, PDF column, zip (`apps/web/src/app/reports/Page.tsx:39-81`, `:343-400`); version switcher with change notes (`apps/web/src/app/report/Page.tsx:370-411`); provenance (`:636-664`); clickable sources seeking the player (`apps/web/src/components/sitelog/SourceLink.tsx:18-60`); signed-URL audio with peaks; excerpts and transcript drawer (`apps/web/src/app/report/SourcePanel.tsx:77-194`); activity timeline (`:203-304`); review-reasons banner; PDF open or browser render; Sign off (admin/pm) with 10-minute undo and E2E (`apps/web/e2e/supabase/panel.spec.ts:131-156`; the audit row is not asserted).

**Missing:** Channel filter and icon, No-photo flag (`apps/web/src/data/types.ts:281-296`); v1.2 provenance; timeline of field events instead of WhatsApp bubbles; `MediaPlayer` on `uploads.peaks` for every clip with 1×/1.5× (only the first audio source plays, `apps/web/src/data/assemble.ts:1396-1397`); `voice_note`/`call`/`answer` source links; language line from the org (hard-coded `→ EN`, `apps/web/src/app/report/SourcePanel.tsx:33-38`).

**Conflicts**

- _Sources and audio origin._ WhatsApp message sources; audio and peaks from `messages.payload` (`apps/web/src/data/assemble.ts:1530-1540`). Recommend: move loaders to uploads/questions/calls; keep the UI components.
- _WhatsApp wording in provenance and activity_ (`apps/web/src/copy/en.ts:630-631`, `:762-768`; timeline by `conversation_id`, `apps/web/src/data/assemble.ts:1450-1456`). Recommend: rewrite around audit + SMS + calls.

**Built (W1-17, 2026-10-15):** the missing items and both conflicts, as recommended: loaders on uploads, questions and calls with the message fallback (`reportClips`, `reportActivity` in `apps/web/src/data/assemble.ts`), `MediaPlayer` per clip at 1× / 1.5×, the P7 provenance (`apps/web/src/app/report/provenance.ts`), Activity from the audit log, uploads, questions, texts and calls, the Channel filter and icon and _No photo_ (§19 Q72–Q75), EN and TR for both pages. The call's speaker lanes wait for call recordings (M7). Status and checks: `docs/PLAN_WEEK1.md` W1-17.

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

## 4. Remove (v1.0 Meta WhatsApp Cloud API)

WhatsApp returns in week 2 as a message channel through Twilio (D48, D49). Every item below is the v1.0 Meta integration. Keep the 24 h service-window logic and the reply grammar (section 5) and `msg_status 'read'`.

Remove each item only after its replacement works and its consumers are switched (order in section 7, steps 21–22).

**Edge functions**

- `supabase/functions/whatsapp-webhook/` (the Meta webhook: `index.ts`, `logic.ts`, `logic_test.ts`) and its block `supabase/config.toml:60-64`, in one commit. The worker integration harness imports its `logic.ts` (`apps/worker/src/integration/webhook.ts:14-25`, via `apps/worker/tsconfig.json:7-9`); rewrite that first.
- `supabase/functions/_shared/conversations.ts` after `api-invite-reporter` (`supabase/functions/api-invite-reporter/index.ts:5`, `:122-127`) and `api-link-unknown-sender` (`supabase/functions/api-link-unknown-sender/index.ts:5`, `:123`) stop using it.
- Adapt rather than delete: `api-link-unknown-sender` → `api-link-unknown-contact` (deploy new, switch the panel caller `apps/web/src/data/supabase/SupabaseSource.ts:1519`, delete old).

**Shared package**

- The Meta code `packages/shared/src/wa/buttons.ts`, `wa/templates.ts`, `wa/window.ts` (after its 24 h window logic moves to a channel-neutral module, D49), `webhook/meta.ts`, `copy/whatsapp.ts`, their tests, and the exports at `packages/shared/src/index.ts:16-18`, `:20`, `:24`. Consumers to switch first include `supabase/functions/scheduler-tick/logic.ts:12-21`, `apps/web/src/app/setup/SiteStep.tsx:4`, `scripts/src/replay-webhook.ts:13`, `packages/shared/src/report/progress.ts:1` and many worker files (`apps/worker/src/runner.ts:2`, `apps/worker/src/pipeline/file.ts:2`, `apps/worker/src/jobs/render_pdf.ts:4`, `apps/worker/src/router/*`).
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

- Meta-era schema, each re-confirmed against the week-2 Twilio WhatsApp design before it is dropped (D49): `conversations` and its triggers, `convo_state`, `msg_type`, `unknown_senders` (renamed), the WhatsApp columns of `messages`, `report_versions.author_message_id`, `questions.asked_message_id/answered_message_id`, `reporters.last_invite_error`/`verified_at`, `conversation_org()`/`message_org()`, the `convo:` branch of `job_lock_key`, `wa_templates` in `report_cost_inputs` (`supabase/migrations/20261012000003_ops.sql:51-101`), WhatsApp keys in `ops_payload_summary` (`supabase/migrations/20261012000003_ops.sql:133-144`).

**Fixtures, scripts, CI, env, docs**

- `fixtures/webhooks/*.json` (5 Meta payloads) → `fixtures/sms/`; `scripts/src/replay-webhook.ts` repointed to Twilio.
- `.github/workflows/ci.yml:107-108` (WA dummies), `.github/workflows/deploy.yml:112` (comment), `.github/workflows/deploy.yml:144` (`VITE_WA_DISPLAY_NUMBER`), `apps/worker/fly.toml:3-4`, `:19`; the `(v1.0)` entries of `.env.example` (`VITE_WA_DISPLAY_NUMBER`, the WhatsApp block, `COST_WA_TEMPLATE_USD`).
- `README.md` (`README.md:3`, `:11`, `:15`, `:39-45`, `:59`, `:62`, `:64`, `:66`, `:77`), `docs/RUNBOOK.md` steps 4, 6, 10 and `docs/RUNBOOK.md:50`, `apps/worker/README.md`, `supabase/functions/README.md`, `apps/web/README.md:26`, the `(current)` notes in `CLAUDE.md:27-28`, `:61`, `:78`, `:92`; mark the WhatsApp-only findings obsolete by removal (most of Critical and High, `docs/AUDIT_BACKLOG.md:18-197`, and many Medium items, e.g. `:269`, `:283`, `:297`, `:311`, `:325`); channel-neutral findings stay open, e.g. RLS and billing (`:29-41`, `:234-264`), phone numbers reaching Claude (`:276`); the reminder-ladder guard (`:367`) was closed by W2-06.

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
8. **Drop** in a later migration after a fresh dump; recreate enum types to retire labels confirmed unused (never `msg_status`: `read` stays for WhatsApp receipts, D49) (Postgres cannot drop enum values); clean the `_pending/` and `_unknown/` storage prefixes (`apps/worker/src/jobs/transcribe_audio.ts:27`, `apps/worker/src/router/handlers/unknown.ts:26`).

---

## 5. Keep (valid under v1.2)

**Toolchain and CI:** `pnpm-workspace.yaml`, `tsconfig.base.json`, `eslint.config.mjs`, `.prettierrc`, per-package Vitest, `.github/workflows/ci.yml` jobs, `scripts/src/db-types-drift.ts`, the PGlite harness `supabase/db-tests/src/harness.ts` (add an anon helper; drop the blanket re-grant).

**Shared (channel-agnostic):** `wa/window.ts`'s 24 h service-window logic (extract to a channel-neutral module before step 22, for the week-2 Twilio WhatsApp channel, D49), `report/hours.ts`, `report/patch.ts`, `report/payroll.ts`, `report/day-off.ts`, `report/numbering.ts` (`formatReportNo`, `pdfFileName`, `pdfStoragePath`), `report/validate.ts` (re-key sources), `report/photos.ts` (office-photo limits; re-point its `messages` join to uploads, D14), `status.ts`, `schedule/day.ts`, `schedule/reminders.ts` stage maths, `schemas/ai.ts`, `weather/observed.ts` (add units), the demo dataset's non-channel data (`demo/kestrel.ts`, `hero.ts`, `ids.ts`).

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

Each item: what the repo does, what v1.2 (or the kit `CLAUDE.md`) says, and a recommendation. Items marked **owner** need your answer before the related step; the others are recommendations we will follow unless you object. Numbers (D1–D49) are stable ids for reference from tickets and the plan; they are grouped by topic, so they do not run in order.

**Decided 2026-10-13:** the owner accepted every recommendation in this section, including the **owner** items. Two of them still hang on facts: D19 follows the read-only staging inventory (section 4.1 stage 1; rename if staging holds only demo reporters, otherwise set real ones to `invited`), and D41 needs the owner to create the second free Supabase project and its `preview` GitHub Environment. D23 keeps `CLAUDE_MODEL=claude-sonnet-5-5` for now.

### Stack and tooling

- **D1 · Node 20 vs 22.** Repo Node 22 (`.nvmrc:1`, `package.json:8`); kit Node 20 (`docs/START_HERE.md:25`, `docs/PLAN_WEEK1.md:26`). Node 20 cannot install this repo or run Vitest 5, and reached end-of-life on 2026-04-30. **Recommend:** keep Node 22 (maintenance LTS to 2027-04-30), plan Node 24 later, record it in README.
- **D2 · pnpm 9 vs 10.** **Recommend:** keep 10.28 (lockfile and CI use it; corepack picks it); record it.
- **D3 · React 18 vs 19, Vite 8.** Old §19.1 #18 recorded React 19, RR 7, Vite 8, Tailwind 4, Zod 4, Vitest 5 (`388fc63:docs/SITELOG_SPEC.md:1941`); v1.2 dropped §19.1 and only `CLAUDE.md:34` lists them now. **Recommend:** keep; add README deviation rows.
- **D4 · Tailwind config preset vs Tailwind 4 CSS tokens.** Spec §14.4 shows `tailwind.config.ts`; repo uses a CSS-first `@theme` (`README.md:51`). **Recommend:** keep Tailwind 4; the shared "preset" is `packages/shared/src/tokens.css` imported by both apps, plus `tokens.ts` for PDF and email.
- **D5 · Vitest workspace.** **Recommend:** keep per-package configs run by `pnpm -r test`.
- **D6 · Hono for `field-api`.** **Recommend:** use Hono for `field-api` only (about 14 routes plus voice tool routes later), wrapping the existing `_shared` helpers; leave other functions as they are. **Done in W1-07:** `npm:hono@4.13.12` in `supabase/functions/deno.json`; `field-api/app.ts` builds the app from injected dependencies (store, code sender, secret, clock) so the Deno tests run it on an in-memory store.
- **D7 · Generated `db.types.ts` vs hand-maintained types.** **Recommend:** keep the hand-maintained file with the CI drift check (`README.md:58`); update it in every migration commit.
- **D8 · `seed:demo` semantics.** Repo generates `seed.sql`; plan wants service-role, idempotent seeding with `--date today`. **Recommend:** keep the generator (it also feeds demo mode, DB tests and e2e) and add an apply mode that upserts by the deterministic ids and touches only `is_demo` orgs; default output stays Oct 9 for e2e. **Done in W1-06:** `seed.sql` is one idempotent script (`packages/shared/src/demo/seed-sql.ts`) that `pnpm seed:demo -- --apply` runs over `SUPABASE_DB_URL` in one transaction: it refuses a non-demo org with a demo id, upserts the demo orgs and users by id and replaces the demo orgs' rows, audit rows included with fixed ids, and drops the queued or running jobs that name them; it needs the field app's URL for the seeded links and its own `DEMO_OFFICE_PASSWORD` (seed.sql's password is for local stacks only).

### Copy, i18n and brand

- **D9 · English-only copy vs i18next EN/ES/TR.** The old repo rule (`388fc63:CLAUDE.md:21`) is superseded by the merged `CLAUDE.md:78`. **Recommend:** adopt i18next; serve `apps/web/src/copy/en.ts` as the EN resource behind `t()`, convert shell and login first, then pages incrementally.
- **D10 · Brand SVGs (owner).** The kit's logo mark, inverted and mono files differ from the repo's; three kit files are new. **Recommend:** adopt the kit files (spec §14.5 says copy them) after a look on the preview; keep the repo's PNG favicons, apple-touch icon, lockup and avatar until regenerated from the kit. **Done in W1-01:** `pnpm brand` copies the kit SVGs and regenerates the PNG favicons, the apple-touch icon and the lockup from them; the avatar (WhatsApp profile) and the PDF and email marks (step 19) are unchanged; the owner's look on the preview is still open.

### Schema and data

- **D11 · "DDL §6.3 verbatim" vs a live schema.** **Recommend:** read "verbatim" as end-state equivalence. Reach it with new forward migrations, and add a db-test that applies the §6.2–§6.4 SQL blocks from the spec to a fresh PGlite and diffs columns, enum labels (with order) and constraints against the migrated database, with an explicit allowlist of recorded additions.
- **D12 · Repo-only additions.** `reports.kind`, `notifications`, `org_settings` ladder/PDF columns, `orgs.trial_ends_at`, `site_days.reminders_paused`, `report_costs`, `platform_admins`, `stripe_events`, `scheduler_state`. **Recommend:** keep them as recorded deviations (in the allowlist above).
- **D13 · `channel NOT NULL` for legacy and office rows (owner).** `field_channel` is `web`/`voice`/`sms`; typed reports and WhatsApp-era rows fit none. **Recommend:** add `office` to `field_channel` for typed reports (recorded deviation); leave pre-v1.2 WhatsApp rows with a null channel and enforce non-null for new rows in code and an insert trigger. Alternative: add a legacy `whatsapp` label (it can never be dropped). **Amended by D49:** a null `channel` marks a v1.0 Meta WhatsApp row (`messages.channel` too, until step 23). A live `field_channel 'whatsapp'` label waits for spec §19 Q26.
- **D14 · `uploads.reporter_id NOT NULL` vs office photos (owner).** **Recommend:** make `reporter_id` nullable with an `uploaded_by` user column (recorded deviation), so PDFs, the Photos tab and evidence packs read one photo model.
- **D15 · `messages`: extend in place or new table.** **Recommend:** extend in place now (nullable SMS columns, `undeliverable`; SMS rows already satisfy the conversation-or-org check through `org_id`). After WhatsApp retires, move legacy rows to an archive, re-point foreign keys and enforce the v1.2 `NOT NULL`s and a fresh `msg_status` type. **Amended by D49:** no fresh `msg_status` type; `read` stays for WhatsApp receipts, and `messages` holds every message channel (`messages.channel`, D48).
- **D16 · Job dedupe: active-only vs fully unique.** **Recommend:** adopt v1.2's `UNIQUE` with `on conflict do nothing`, because "once each, even if retried" (W1-15) depends on it. First null keys on finished duplicates, give repeatable jobs per-occurrence keys (e.g. reinvite), and audit the worker's keys. **Built in W1-10** (`20261015000001_worker_runtime.sql`; a taken key answers with its job whatever its status, and a dead job that must run again is re-queued, `requeue_dead_job()`).
- **D19 · `verified` reporters (owner).** **Recommend:** if staging holds only demo data, rename `verified` → `active`; if it holds real reporters, set them to `invited` so they consent on the recorder (TCPA/KVKK), then rename the unused label. **Settled by the inventory (section 8):** no reporter is `verified`, so the label is renamed. **Done in W1-05 step 11:** `20261014000003_renames_billing.sql` renames the label (with `reporter_reply` → `reporter`, `sender_status` → `contact_status`, `unknown_senders` → `unknown_contacts`); the W1-19 inventory re-run checks again that no reporter outside the demo org is `verified` before the push.
- **D20 · Stored v1 report versions.** **Recommend:** never rewrite them; normalise v1 → v2 on read (`audio` → `voice_note`, `reply` → `answer`, `messageId` → `uploadId`, `hoursBasis 'reply'` → `'answer'`).
- **D21 · Deferred RLS defects.** **Recommend:** fix them inside W1-05, since its role-matrix suite would fail on them (`docs/AUDIT_BACKLOG.md:36-41`, `:234-264`).
- **D22 · Accounts role reach (owner).** Accounts users can read sites, the full audit log, all notifications and every storage file (`supabase/migrations/20261011000004_rls.sql:115`, `:166-169`, `supabase/migrations/20261011000006_platform.sql:13`). **Recommend:** tighten to §2.2 (hours and invoices) in the role matrix.
- **D37 · Demo office emails.** **Recommend:** keep `@kestrelbuild.example`; the plan's `lena@kestrel.test` is only an example and e2e depends on the current ones.
- **D46 · Demir Yapı office user (owner; section 8 question 12, spec §19 question 18).** §18.2 as delivered named no office user for the TR demo org. **Decided by the owner on 2026-10-14 (the recommendation):** a separate fictional TR admin, Elif Aydın (`elif@demiryapi.example`, `admin`, title Operasyon), a member of Demir Yapı A.Ş. only; Lena stays in Kestrel only. **Built in W1-06:** `packages/shared/src/demo/demir.ts` seeds her with the same user and membership code as Kestrel's office users: a fixed id (`demoId('user:elif')`), `seed.sql`'s local password, the apply's `DEMO_OFFICE_PASSWORD` (hashed from a bind parameter), the membership upserted (members added later are kept), and no panel language of her own (`ui_locale` null), so the org's tr-TR opens the panel in Turkish. Every seeded membership, hers and Kestrel's three, has a `member.added` audit row in its org's fixed id range (`rows.ts` `memberAudit`). The panel reads `orgs.locale` with the memberships (`fetchOrgs`; before W1-06's review it did not, so the Supabase-mode panel stayed English for a Demir Yapı member). `apps/web/e2e/supabase/demir.spec.ts` signs in as her instead of a temporary user; it is proven only by a green `e2e:supabase` run on PR #1 (the two runs before the review's fixes were red). The panel's demo mode stays Kestrel only (no demo-mode org switcher).

### Pipeline

- **D17 · Backoff count.** "After 5 → dead" with five listed delays; the repo never uses the 2 h step. **Recommend:** use all five delays (dead after the 6th failure) and clarify §10.1. **Built in W1-10** (`fail_job()`, `JOB_MAX_ATTEMPTS` 6; §10.1 clarified).
- **D18 · Stale lock 15 → 10 min.** **Recommend:** 10 min.
- **D23 · Forced `tool_choice` and temperature 0 (owner: model).** The repo's reason is its own note that the 5.5-generation models reject forced `tool_choice` and non-default sampling (`apps/worker/src/ai/claude.ts:11-14`); the switch is per model profile (`:137-141`). **Recommend:** take the model from `CLAUDE_MODEL`; if it is a 5.5-generation model, record "tool_choice auto + verify and re-prompt" as a deviation in README and spec §19. **Done in W1-12:** the model is `CLAUDE_MODEL` (default `claude-sonnet-5-5`), `tool_choice: auto` with an instruction, a check and one re-prompt on the 5.5 generation; README row "Extraction model", spec §19 Q58.
- **D24 · Prompt v2 "verbatim".** **Recommend:** use v2 verbatim; if the extra weather rule is still wanted, add it to spec §10.4 first. Keep the source-format note as a separate cached block and record it. **Done in W1-12:** `apps/worker/src/ai/prompts/extract.v2.md` is the spec text verbatim (a test compares them); the source-format note is a second cached block (README, spec §19 Q59); no extra weather sentence.
- **D25 · The 30 s "device not seen" rule** appears only in `docs/PLAN_WEEK1.md:100`. **Recommend:** keep 30 s and add it to the spec. **Done in W1-12:** `decide_next` texts `question_ready` / `draft_ready` only when no device of the reporter was seen in the last 30 s (`apps/worker/src/pipeline/web.ts`); spec §10.1 as built; §19 Q61 for a reporter who leaves within the 30 s. **W2-07:** the texts are `notify` jobs with a report guard; with the device active the job waits 30 s and sends only if no device was seen since (Q61, decided); the §7.2 web timeouts run as delayed jobs from the channel-neutral `apps/worker/src/pipeline/timeouts.ts`, which the WhatsApp sweep (`router/timeouts.ts`) now calls too (GAP §4 "extract first: the timeout sweep" done for the decisions; the sweep itself goes at step 22).
- **D26 · Rate limit wording** (plan "5 code sends/h", spec "5 code verifications/hour"). **Recommend:** limit both. **Done in W1-07:** `field_rate_limit()` with keys `code_send:<e164>` and `code:<e164>` (5 an hour each) and `dev:<device id>` (30 a minute); spec §6.5 names both.
- **D27 · W1-12 Done-when wording.** It says "crew with missing hours"; the hero fixture and demo script ask a headcount ("Delta — 4 or 5?"). **Recommend:** follow the fixture and fix the plan wording. **Done in W1-12:** the plan names the headcount question; the integration test asks exactly it.
- **D28 · Questions with no options.** **Recommend:** show a number input with "full day" as the default hours, rather than code-generated options, so code never proposes numbers the reporter did not say. **Done in W1-12 (the route; the screen is W1-13):** a headcount question without model options has no options; `reports/:id/answer` takes `{value, hours?}` (`numberAnswer`). **Screen done in W1-13:** the Question screen's number input, "Full day" by default for a headcount (`apps/field/src/screens/report/Question.tsx`).

### Product and UI

- **D29 · `/try` simulator.** **Recommend:** keep demo-only until `/dev/phone` and the field app work, then delete; reuse its recorded transcripts as Demo phone fixtures.
- **D30 · Typed reports (not in v1.2) (owner).** **Recommend:** keep as an office fallback (recorded deviation), with `channel 'office'` (D13).
- **D31 · Office edits notify the reporter.** `create_report_version` enqueues `render_pdf` with `notifyReporter: true` (`supabase/migrations/20261013000005_office_photos.sql:344`), which sends a WhatsApp template (`apps/worker/src/jobs/render_pdf.ts:57-66`); v1.2 §13 texts `edit_applied` only for reporter edits (`docs/SITELOG_SPEC.md:1779`). **Recommend:** stop notifying on office edits. **Done in W1-15:** `create_report_version()` no longer sets `notifyReporter` (`20261015000030_filing.sql`), and `render_pdf` ignores the flag of jobs queued before.
- **D32 · Paper size.** **Recommend:** default from org country (Letter US, A4 TR); keep `org_settings.pdf_paper` as an explicit override; record it. **Amended by D47:** `on_org_created` presets `org_settings.pdf_paper` from the org's country pack (US `letter`, TR `a4`; `20261014000004_country_packs.sql`). The column is now in spec §6.3, so there is no README row. The worker and the panel read `pdf_paper` only, and admins still change it in Settings → PDF.
- **D33 · Report number and PDF file name.** Report numbers already match (`packages/shared/src/report/numbering.ts:2-4`, `supabase/migrations/20261012000002_rpc_fixes.sql:15`). **Recommend:** keep the storage object `{report_no}_v{n}.pdf`; serve downloads, attachments and zip entries with the §12 name `{report_no}_{YYYY-MM-DD}_v{version}.pdf`.
- **D34 · Turkish PDF in week 1 or M11.** **Recommend:** EN/TR labels and a Turkish sample render in week 1 (the fonts already carry the glyphs); metric weather and TR polish in M11.
- **D35 · Artboards without a channel column or filter.** **Recommend:** the spec wins (`CLAUDE.md:20`); add them and note the mismatch.
- **D36 · Oct 9 "awaiting" and `--date today`.** **Recommend:** with `--date today`, history ends yesterday and today's sites start pending/awaiting (the demo script's "five awaiting"); the unshifted Oct 9 output stays the default for e2e. **Done in W1-06:** history moves by whole weeks (weekdays stay weekdays) and ends the working day before; today is §18.1's Oct 9 as of the 17:00 daily link: Pier 9 filed at 16:58, the other five awaiting. Built earlier on the day itself, it stops at the clock (nothing after it, so before 16:59 Pier 9 is awaiting too).
- **D38 · Function names.** **Recommend:** keep `stripe-webhook` (its URL is registered in Stripe); rename `api-link-unknown-sender` → `api-link-unknown-contact` by deploy-new, switch, delete-old.
- **D39 · `field-api` URL shape.** **Recommend:** the field app calls `/api/<route>` (e.g. `/api/resolve`); Hono mounts under `/field-api`; record Appendix B's `/field/…` prefix as a logical grouping. **Done in W1-07:** as recommended, recorded in Appendix B with the `X-Link-Code` header for every route but `resolve`.
- **D45 · `COST_WA_TEMPLATE_USD`.** **Recommend:** drop it with WhatsApp; add an SMS per-segment cost when cost-per-report is reworked (§15.1). **Amended by D49:** the variable still goes at step 22 (it prices Meta templates); a per-channel messaging cost returns with the week-2 Twilio WhatsApp driver.

### Country packs and message channels (owner, 2026-10-14)

- **D47 · Country packs (owner, 2026-10-14).** SiteLog is a global product: everything country-specific is a row of `countries` (spec §4.6), the one source of truth. SQL reads it directly (`create_org`, `on_org_created`), the panel under RLS (every signed-in user, so the wizard can list it before the user has an org), the worker and edge functions with the service role, and the field app only through `field-api resolve` (W1-07). `orgs.country` references it; the US/TR check is gone. Policy values (languages, units, paper, currency, time zone, channel order, providers, sender type, two-way SMS, links in SMS, legal keys) change only by forward migration. `sms_sender_id` and `voice_number` are seeded null and set per database with the service-only, audited `set_country_endpoints()` (`pnpm countries:set`, owner-approved on hosted databases); a null sender is `console`, a null voice number is Talk now only. `packages/shared` holds only `CountryRowSchema`, `CountryPack`, pure helpers and the `DEMO_COUNTRIES` fixture, which a db-test keeps equal to the rows. `create_org(p_country default 'US')` presets locale, units, currency and time zone (the 4-argument function is dropped, so PostgREST resolves the deployed panel's named call to it); `on_org_created` presets `pdf_paper`. A new country is a row when its languages, providers and legal texts exist; otherwise code plus the row. **Built in W1-06a** (step 12a): `20261014000004_country_packs.sql`, `packages/shared/src/countries.ts`, `demo/countries.ts`, the setup wizard's country, `scripts/src/countries-set.ts`.
- **D48 · Message channels and providers (owner, 2026-10-14).** Enum `message_channel` (`sms`, `whatsapp`, `push`), separate from `field_channel` (how a report reached SiteLog; push is never inbound). Columns `reporters.message_channel` (the person's preference; null = the pack's order) and `messages.channel` (`20261014000005_message_channel_columns.sql`). The Notifier's order is the preference if the pack offers it, then the pack's `message_channels`, kept to the channels that are built, consented, not opted out and, for SMS, allowed to carry the key's link (`channels.ts` `messageChannelOrder`, `deliverableChannels`). Twilio is the column default for SMS and WhatsApp, overridable per pack (TR SMS: İletimerkezi, spec §19 #3, Q20). Two-way SMS and links in SMS come from the pack: `SmsTransport.twoWay`, `SMS_DRIVERS_BY_COUNTRY` and the per-country env names (`SMS_US_PROVIDER`, `SMS_TR_PROVIDER`, `SMS_US_FROM`, `SMS_TR_SENDER_TITLE`, `VOICE_NUMBER_US/TR`) are gone. `is_demo` orgs use `console` on every channel. Week 1 builds SMS only and both packs order `{sms}` (spec §19 Q19); the WhatsApp and push transports, consents and storage come with M6. The outbound job is `notify`, priority 0 since `20261014000004` (never `send_message`, the live v1.0 job). **Built in W1-06a**; the Notifier itself is W1-08, the `notify` job W1-10. **W2-01** adds the channel registry (`MessageChannelSpec`, `MessageTransport`, `NotifierDeps.channels`; `pickMessageTransport` for any registered channel, `console` per channel for demo orgs and a pack with no sender of that channel) and the fallback walk of spec §19 Q22 (`notify/walk.ts`: one `messages` row per attempt with `payload.attempt`, `notify.attempt_failed`, the late-callback `notify` job keyed `<dedupe key>:after:<message id>` from sms-webhook's `/status`, `message_channels_failed` when every channel failed); the late fallback covers messages a `notify` job sent (README deviations). **W2-02** lets the reporter set `reporters.message_channel` in the recorder's Settings (`PATCH /field/preferences`, one of the pack's built channels, §19 Q21; the choice shows once a pack has two), and a revoked `sms` consent is the per-channel opt-out of texts (§19 Q40). **W2-14** registers web push: `consent_type 'push'`, `push_subscriptions` written by `field-api` (`push/key`, `push/subscribe`, `push/unsubscribe`), the worker's `push` transport (`web-push`, VAPID from env; `console` for demo orgs; without a key pair a real org's push leaves the order), `PUSH_KEYS` (§19 Q27), a 404/410 revoking the subscription and falling back, `messages` rows with `channel 'push'` and no phone (checked), both packs `{push, sms}` with push never last (§19 Q107), and the field service worker on `injectManifest` with the push handlers. **W2-15** registers WhatsApp through Twilio: `consent_type 'whatsapp'` (Field-02's and Settings' _Message me on WhatsApp_), the pack's per-environment `whatsapp_sender_id` and `whatsapp_templates` set by `set_country_endpoints()` / `pnpm countries:set` (§19 Q39), `packages/shared/src/whatsapp/` (templates outside the 24 h window, free-form inside it, `reachable` per key) on the worker's and the edge functions' Notifier, `console` for demo orgs, and §19 Q84: a channel with no sender here leaves a real org's order. **W2-16** adds inbound WhatsApp (`field_channel 'whatsapp'`; keywords on every pack, STOP / START as the `whatsapp` consent, answers through `whatsapp_answer`, media per §19 Q85) and the real orders (US `{push, sms, whatsapp}`, TR `{push, whatsapp, sms}`).
- **D49 · WhatsApp through Twilio versus step 22 (follows from the owner decision of 2026-10-14; recommendation).** Steps 22 and 23 retire the v1.0 Meta WhatsApp Cloud API integration, not WhatsApp: (1) step 22 moves the 24 h window logic out of `wa/window.ts` to a channel-neutral module before deleting `wa/*`, and extracts the reply grammar as section 5 lists; (2) the Twilio WhatsApp inbound endpoint is never named `whatsapp-webhook` (step 22 deletes that function remotely): it is `sms-webhook` or a name chosen in week 2; (3) step 23 keeps `msg_status 'read'` (spec §6.2 has it again) and does not recreate `msg_status`; it re-confirms `messages.template_name`, `type`/`msg_type`, `convo_state` and `conversations` one by one against the week-2 design before dropping them; (4) `messages.channel` stays nullable until step 23 (null = a Meta or office-photo row), then NOT NULL; (5) `COST_WA_TEMPLATE_USD` still goes in step 22, and a per-channel messaging cost returns with the week-2 WhatsApp driver. _Done in W2-15:_ (1) the window is `packages/shared/src/messaging/window.ts` (the v1.0 worker imports it from the package root); (5) `report_cost_inputs()` counts a report's texts and Twilio WhatsApp templates (`20261016000220`, `COST_SMS_USD`, `COST_WHATSAPP_TEMPLATE_USD`). (2) _Done in W2-16:_ Twilio's inbound WhatsApp messages and status callbacks go to `sms-webhook` (`receive_inbound_message()`); no Twilio endpoint is named `whatsapp-webhook`.

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

**Step 12a · Country packs and message channels** — W1-06a (owner decision 2026-10-14, D47–D49)

- Change: `20261014000004_country_packs.sql` (`message_channel`, `countries` with the US and TR packs, the guard, `orgs.country` → `countries`, `on_org_created` paper, `create_org(p_country)`, `set_country_endpoints()`, `notify` in `job_priority`) and `20261014000005_message_channel_columns.sql` (`reporters.message_channel`, `messages.channel`); shared `countries.ts`, `channels.ts` and the SMS copy read the pack; the wizard's country; `pnpm countries:set`; spec §6 write-back with the allowlist; spec, decisions, env, plan, README, CLAUDE.md, RUNBOOK.
- Verify: `pnpm test:db` (31 tables, 26 enums, the parity and ZZ tests), `supabase db reset`, the drift check, `e2e:supabase` (a TR org through the wizard; the old 4-key `create_org` payload). Nothing reaches staging until step 21.

**Step 13 · `field-api`** — W1-07

- Change: function with `verify_jwt = false`, Hono, routes, transactional report creation (number and insert in one transaction, so field reports never burn a number; the WhatsApp intake race, `apps/worker/src/router/handlers/intake.ts:258-280`, ends with step 22), tests.
- Verify: Deno tests and tests against local Supabase; on the field preview, a probe shows `Set-Cookie` and `Cookie` pass the Netlify proxy and responses carry `no-store`.
- Built (W1-07): `supabase/functions/field-api`, `20261014000006_field_api.sql` (`field_devices.code_hash`/`code_expires_at`; the service-only `field_complete_upload()`, `field_confirm_report()`, `field_set_day_status()`, `field_rate_limit()`; the `audio` bucket's `audio/*` and both upload buckets' 50 MB limits), `transcribe_upload` in `JOB_TYPES`, the optional confirmed `version` in `file_report` (`fileReport` files only that version); open points spec §19 Q41 (what day-status writes), Q42 (guessing link codes through any route) and Q43 (yesterday as the previous working day), and the AUDIT_BACKLOG entries on link codes in `messages.body` (the device-code half closed: console codes for demo orgs only) and on the `photos` bucket's types (step 22).
- **W2-08 (F12, spec §19 Q41):** `day-status` calls `field_report_day_off()` (`20261016000050_day_off_reports.sql`): the site-day status at once (the ladder stops), and for a weather day (a no-work day with `no_work_pdf`) a numbered web report with the details as answered questions, version 1 built in code by the channel-neutral `dayOffReportData` / `weatherDayHours` (`packages/shared/src/report/day-off.ts`, extracted from the WhatsApp `router/handlers/dayoff.ts`, whose `weatherDayData` now uses the same hours) and its `file_report` (trigger `weather_day` / `no_work`). The weather day's photo of the conditions is W2-04's _Add more photos_ on its Filed screen. Spec §19 Q79 (live report) stays the refusal and Q91 (lost hours = the hours stopped) stands: both decided by the owner 2026-10-16, as built. `field_set_day_status()` is kept for a field-api deployed before the migration.
- **W2-09 (F7 _Other…_, §10.7):** `parse_answer` extracted from the WhatsApp worker into a channel-neutral module (`apps/worker/src/ai/answer.ts`, prompt `ai/prompts/answer.ts`; `router/handlers/question.ts` calls it until step 22) and run on the web recorder's spoken answers by the new `parse_answer` job (`apps/worker/src/jobs/parse_answer.ts`). `20261016000060_voice_answers.sql`: `uploads.question_id` (an answer clip, never report material), `questions.voice_answers`, `field_complete_upload()` staging answer clips, the service-only `field_answer_question_voice()` and `field_settle_voice_answer()`, parse_answer under the report's lock key. field-api: `uploads {answerTo}`, `reports/:id/answer {uploadId}`, `question.voice` and `lastVoiceAnswer` on the report view. Code applies a parsed value only at 0.7 or more with every number stated in the answer (`unstatedAnswerNumber`), the answer and the clip as its sources; unclear → asked once more, then flagged `unanswered:<field>`. Golden set `fixtures/answers/` (recorded outputs written without a key), `pnpm eval -- --answers`. Spec §19 Q92 (an answer with no number: asked once more, then left for the office) and Q93 (the panel plays the answer clip from P7's source link) decided by the owner 2026-10-16; Q93's panel side is a follow-up, not built.
- **W2-10 (F8 _Fix by voice_ and the steppers, §10.6):** `apply_correction` v2 for the web draft (`apps/worker/src/jobs/apply_correction.ts`, channel-neutral prompt `ai/prompts/correction.ts`, `parseCorrectionV2`; the WhatsApp handlers keep v1 until step 22); code applies the operations (`packages/shared/src/report/correction.ts`: `applyCorrectionOps`, `applyCrewEdit`, `correctionChanges`, `reapplyCrewFixes`), never a model total, numbers stated in the words, the clip or `reporter_edit` (spec §19 Q80) as the source. `20261016000100_draft_corrections.sql`: `uploads.correction_report_id` (a correction clip, never report material), `draft_corrections` (service only), `field_complete_upload()` staging correction clips, the service-only `field_request_correction()`, `field_settle_correction()`, `field_apply_correction()` (Save change at the preview's revision, else `draft_changed`) and `field_edit_draft()`, apply_correction under the report's lock key. field-api: `uploads {fixTo}`, `reports/:id/correction`, `…/:cid`, `…/:cid/apply`, `reports/:id/edit`, `ReportView.correction`. Golden set `fixtures/corrections/` (recorded outputs written without a key), `pnpm eval -- --corrections`. Open: spec §19 Q96 (a fix through a re-extraction), Q97 (the clock while a fix waits).
- **W2-11 (F10 _Change something_ on the web):** `20261016000110_filed_edits.sql`: `draft_corrections.after_filing` and `version_created`, `report_versions.author_reporter_id` (spec §19 Q81: each version names its author), the service-only `field_request_filed_correction()` (14 days, site time; `report_locked`), `field_save_filed_correction()` (version n+1 from the preview's version only, photos kept, re-denormalised, signed-off → filed with the `report_edited` notice, audited, `render_pdf` with `signerId` and `editApplied`) and `field_report_changeable()`; `field_settle_correction()` previews a change after filing on the filed report. Worker: `apply_correction` on a filed report, `render_pdf` → the "Updated" email to the recipients and the signer and `edit_applied` (`jobKeys.editApplied`). field-api: the correction routes take a filed report (`fixTo`, `ReportView.change`, the change note and text from `correctionNote`, `packages/shared/src/report/correction-note.ts`). Field app: _Change something_ on `/history/:id`. Panel: the version's author. Open: spec §19 Q98–Q101 (built on their recommended defaults).
- **W2-12 (§9.5 report keywords on two-way packs; F10 and F12 by SMS):** the reply grammar moved to `packages/shared/src/sms/replies.ts` (`wa/replies.ts` re-exports it until step 22; TR weekdays in `resolveDayReference`); OK, NO WORK, WEATHER and EDIT in EN, ES and TR (`SMS_REPORT_KEYWORD_WORDS`, `SMS_EDIT_WORDS`, spec §19 Q105), named by `planInboundSms` and answered by the worker's new `sms_keyword` job (`apps/worker/src/jobs/sms_keyword.ts`): OK the draft link (Q82), NO WORK / WEATHER the day sheet's daily link per open site (Q104), EDIT through `classify_utterance` (`ai/utterance.ts`, golden set `fixtures/utterances`) and `sms_request_filed_correction()` (`20261016000140_sms_keywords.sql`, `draft_corrections.message_id`), then the preview's text `edit_preview` with the `/r/{code}/history/{id}` confirm link, or `edit_unclear` (Q102); copy keys `day_off_link`, `edit_preview`, `edit_unclear` (EN/ES/TR, Q83). The panel's in-memory demo (`VITE_DEMO`) stores these texts without answering (README deviation).
- **W2-13 (F4 step 3, spec §19 Q52):** the test recording on first open. `20261016000070_test_clips.sql`: `test_clips` (service only, RLS on, no grant), `field_test_clip_create()` (needs the recording consent; audits; queues the 10-minute `delete_test_clip`), `field_test_clip_complete()` (queues `transcribe_test_clip`), `field_test_clip_read()` (the snippet once, then deleted). field-api `POST /test-clip`, `POST /test-clip/:id/complete`, `GET /test-clip/:id` (3 an hour per device); worker `jobs/test_clip.ts` (the file deleted once transcribed) and the retention backstop; the field app's `WelcomeTest` after the consents, first open only. Test clips in `fixtures/voice` (kind `test`, EN, ES + EN, TR) for the fake transcriber.
- **W2-17 (M6 acceptance, spec §16.2 M6):** no new schema. The `e2e:supabase` specs of the M6 flows carry `@m6` and a flow tag (`@F4` … `@F16`); new ones for F12 (`apps/field/e2e/supabase/worker/day-off.spec.ts`), F14 (`two-sites.spec.ts`), F15 (`settings.spec.ts`, STOP and START through `sms-webhook/demo-reply` as a throwaway admin of the fixture org) and F16 (`new-phone.spec.ts`, the lock), and added cases for F5 (offline), F7 (_Other_ typed), F4 (from a new phone, with the preference) and F11 (R2 and `missing` on a second site, `apps/web/e2e/supabase/worker/ladder.spec.ts`). `pnpm e2e:m6` runs them; CI's `e2e-supabase` runs it as its own step after the other specs (which take `--grep-invert @m6`). Found on the way and fixed: the site switcher's current row left Today blank (`Today.tsx`). The real-phone script is `docs/DEMO_NOTES.md` "Week 2" (demo orgs on console and fake AI, then a real test org for the deliveries, spec §19 Q116). The new specs have not run here (no Supabase CLI or Docker): CI is their first run.

**Step 14 · SMS layer, invite, Demo phone** — W1-08

- Change: drivers from the pack (default `twilio`, the TR override, `console` for demo orgs and packs with no sender id), the Notifier with `messages` logging (`channel`), invite with `locale`/`contactPref` (request contract stays compatible; the phone parsed with the org's pack), `send_welcome` by SMS, `sms-webhook` (keywords on two-way packs; the pack found by `To`, with a partial unique index on `countries.sms_sender_id` in a new migration, spec §4.6), Twilio fixtures and replay, `/dev/phone` with an Email tab.
- Verify: Done-when (inviting Marco shows the welcome text with a working link in the Demo phone); mocked-HTTP tests; existing invite tests green.
- Built (W1-08): `packages/shared/src/sms/` (drivers, Twilio signatures, keywords) and `notify/notifier.ts` (one Notifier for the worker and the edge functions; `messages` rows masked except `console` on demo orgs, which closes the AUDIT_BACKLOG link-code half; dedupe in `payload.dedupe_key`), derived personal link codes (`links.ts` `deriveLinkCode`, `ensurePersonalLink`), `20261014000007_sms_layer.sql` (`countries_sms_sender_id_key`, the widened `messages_conversation_or_org`, `console_emails`), `supabase/functions/sms-webhook` (the Twilio text stored and handed to the worker's `sms_inbound` job, since Twilio never retries a 5xx; status callbacks, which flag a welcome that never arrived; `/demo-reply` handled inline inside the caller's org), `field-api`'s codes through the Notifier, the invite's personal link and its locale from the "Speaks" languages, `send_welcome` by SMS, `/dev/phone` with Texts and Email, `fixtures/sms/` and the Twilio replay mode, and the worker running in CI's `e2e-supabase` for the `worker` Playwright project. The review follow-up closed its 20 findings: every STOP sticks (`sms_opt_outs` per pack, also for a number with no reporter and a disabled one; Twilio 21610 recorded as an opt-out), the office hears about opt-outs and late delivery failures (§13), the Notifier writes a real org's text on `console` as `failed` and never leaves a row `queued` on a configuration error, `send_welcome` tells a bad number from a provider fault, the Demo phone keeps 44 px tabs at 390 px with focus, scroll and live-region handling, and `supabase/db-tests/stack/api-invite-reporter.test.ts` covers the invite orchestration on the stack. A third review closed 15 more: `20261014000008_sms_inbound.sql` stores a text, its audit and its job in one transaction (`receive_sms_inbound()`) and runs one phone's texts one at a time (`sms:<phone>` lock key); each keyword change commits with its audit and notice; an F13 auto-reply survives a retry; a late Twilio failure blames the number only for 30003–30006 (an account fault tells the office once an hour); a replayed 21610 stays an opt-out; a console reply for a real org is `failed`; Team shows "Opted out of texts"; the Demo phone gets a live region per thread and a 44 px reply box (the panel-wide 41.25 px controls are in `docs/AUDIT_BACKLOG.md`). Open points: spec §19 Q44 (whose is an inbound text on a shared sender), Q45 (Twilio's own STOP/HELP handling), Q46 (no confirmation for START/CALL/TEXT), Q47 (rotating `LINK_SIGNING_SECRET`), Q48 (no device code for a real org on `console`), Q49 (İYS).

**Step 15 · Worker runtime** — W1-10

- Change: LISTEN on a dedicated connection, the `notify` job (D48), office notice for dead jobs, D16 and D17.
- Verify: 100 jobs exactly once with concurrency 4 on the CI Supabase stack; `pnpm dev:worker` sends the welcome SMS.
- Built (W1-10): as the W1-10 entry above lists. Checked against a scratch Postgres 16 with the migrations and seed (no Supabase stack here): the worker (`src/index.ts`, 120 s poll) reported `listening: true` and ran a `send_welcome` enqueued by SQL within two seconds, its console text in `messages`. The by-hand check on a local stack (invite in the panel, the text in the Demo phone) is the owner's or CI's.

**Step 16 · Transcription** — W1-11

- Change: `Transcriber`, Deepgram default, OpenAI fallback, `transcribe_upload`, about 600 peaks on `uploads`; EN, ES+EN and TR fixtures.
- Verify: a fixture upload produces a transcript with segments and peaks (fake provider without `DEEPGRAM_API_KEY`).
- Built (W1-11): as the W1-11 entry above lists; verified on PGlite through the integration harness (`apps/worker/src/integration/upload.integration.test.ts`); the Deepgram run with a real key and a recording is the by-hand check (`pnpm transcribe:fixture`).

**Step 17 · Extraction v2** — W1-12

- Change: `extract.v2.md`, new user-message variables, v2 writers everywhere: the worker (`apps/worker/src/ai/extract.ts:141`), a migration that replaces `create_office_report` (it stamps `schemaVersion 1` in SQL, `supabase/migrations/20261013000005_office_photos.sql:203`) and the panel editor; `questions.channel 'web'`; channel-neutral question options `[{id,label}]` and `applyAnswer` taking a `Source` (`{type:'answer', questionId}`), with D28 for questions without options; EN/ES/TR fallback question prompts; `decide_next` split with the 30 s rule; weather units; the model profile per D23; eval re-keyed with Turkish cases and a report-language check.
- Verify: `pnpm eval -- --recorded`; ES+EN fixture → draft and one question; timing logged.
- Built (W1-12): as the W1-12 entry above lists; verified on PGlite (`apps/worker/src/integration/web.integration.test.ts`: the ES + EN fixture → fake transcriber → replayed tool output → a v2 draft and one question, the Delta headcount, with no text while the device was seen in the last 30 s; the upload-to-decision time is logged), `pnpm eval -- --recorded` 28/28, and the race tests on a scratch Postgres 16. The keyed `pnpm eval` and the Deepgram + Claude timing (≤ 60 s p50) are the by-hand checks.

**Step 18 · Field screens** — W1-09, W1-13

- Change: device check, consent, Today, Recording with the offline queue, Processing, Question, Draft, Confirm & send.
- Verify: on a real iPhone and Android phone via the HTTPS preview: 2 minutes + 2 photos uploaded, airplane-mode queue, "5 · full day" → 40 h → filing.
- Built (W1-09, first half): `apps/field` link check (resolve → device check → welcome and consent), Today, Recording (`recorder/`), Processing (polls every 2 s, then less often) and the IndexedDB upload queue (`queue/`) with the offline banner; the `field` copy in EN/ES/TR; `resolve` returns the org's name; `STORAGE_PUBLIC_URL` for local stacks; `e2e/screens.spec.ts` on a fake field-api and `e2e/supabase/record.spec.ts` on the stack (CI). Open: spec §19 Q50–Q53 (privacy notice page, automated-call consent, test recording, a clip that arrives after its day); the PWA update prompt W1-04 left for this step (not in W1-09's Build list and not built: a new build still waits until every window of the installed app is closed, `apps/field/config/pwa.ts`); the real-phone checks.

**Step 19 · Filing, PDF, email** — W1-14, W1-15

- Change: remove WhatsApp delivery from filing and `render_pdf` (this also ends the office-edit WhatsApp notice, D31); `notify(filed)`; `confirmed_via`; retry-safe post-filing steps; EN/TR PDF labels and v1.2 copy; paper preset from the pack (D32 amended by D47); the brand mark in the PDF footer; Turkish sample; §12 names for downloads and zips (D33); TR email subject and body, email footer without WhatsApp; optionally re-render on sign-off (`docs/AUDIT_BACKLOG.md:388`).
- Verify: confirming the fixture report gives one PDF, one `filed` text and one email even when the job is retried; sample PDFs checked against the artboards.

**Step 20 · Panel core** — W1-16, W1-17, W1-18

- Change: channel column, icon, filter and dots; No-photo flag; Text today's link; undeliverable and unknown-contact items; `call_mismatch`/`no_photo` reason copy; `MediaPlayer` on uploads with 1×/1.5×; language line from the org; v1.2 provenance and timeline; "CONFIRMED BY ANSWER" badge; Sites and Site detail actions and subtitle; TR copy for every page this step touches (`CLAUDE.md:101`).
- Verify: artboards at 1440 and 390 px; filing from a phone flips the Overview row within about 2 s; sign-off writes the audit row.

**Step 21 · Cut-over and dress rehearsal** — W1-19 (owner-approved)

- Change: re-run the read-only inventory and take the backup of section 4.1 stage 1 (`pg_dump` and the `audio`/`photos` buckets, stored where you choose) right before the first `db push`; stop the WhatsApp reminder ladder before any worker runs: `scheduler-tick` enqueues `send_template` reminders (`supabase/functions/scheduler-tick/index.ts:201`), week 1 has no ladder (`docs/PLAN_WEEK1.md:7`), and the ladder returns on SMS in M6 (this pulls the scheduler part of section 4.1 stage 5 forward); discard the queued WhatsApp-era backlog; merge `spec-v1.2` into the agreed branch; dispatch Deploy (db push → functions → web and field `--prod`); set v1.2 secrets, Auth site and redirect URLs, `CORS_EXTRA_ORIGINS`, `APP_URL`, `FIELD_APP_URL`; `seed:demo --date today` on the `is_demo` orgs; worker on the developer machine; write `docs/DEMO_NOTES.md`. Staging's v1.0 schema has no `orgs.country`; `20261013000007` gives every existing org 'US' in the same push, so the `20261014000004` guard is only a backstop. The deployed v1.0 panel's `create_org` call still creating a US org is proven in CI (`supabase/db-tests/src/countries.test.ts`, `apps/web/e2e/supabase/fresh-org.spec.ts`), not after the push: the same Deploy dispatch replaces that panel. After the push, `select code, sms_provider, sms_sender_id, voice_number from countries` shows every sender id and voice number null, and every `sms_sender_id` stays null through the demo unless the owner approves one.
- Verify: the demo script passes twice in a row on a real phone.

**Step 22 · Retire the Meta WhatsApp integration** — cleanup after the demo

- Change: first D49 (1) and (2): move the 24 h window logic out of `wa/window.ts` and the reply grammar out of `wa/replies.ts`, and never reuse the name `whatsapp-webhook`. Then section 4.1 stages 5–7, in code order: web (`/try`, footer, `wa.me`, unknown-sender UI) → worker harness → worker (`router/`, `wa/`, WhatsApp jobs) → edge (`whatsapp-webhook` + its config block, `_shared/conversations.ts`) → shared (`wa/*`, `webhook/meta.ts`, `copy/whatsapp.ts`) → fixtures, env, CI, docs. `COST_WA_TEMPLATE_USD` goes (D49 (5)). Then, one approved step each: `supabase functions delete whatsapp-webhook` (later `api-link-unknown-sender`), unset `WA_*` secrets, delete `VITE_WA_DISPLAY_NUMBER`.
- Verify: `pnpm check`, `pnpm test:db`, Deno check and e2e green at every commit.

**Step 23 · Contract** — later release

- Change: drop legacy tables and columns after a fresh dump and at least one stable release (for `orgs.stripe_*`, first `drop trigger orgs_billing_ids on orgs; drop function sync_org_billing_ids();`, since the trigger's `UPDATE OF` list depends on both columns and `drop column` fails without it, then `alter table orgs drop column stripe_customer_id, drop column stripe_subscription_id`; never `CASCADE`, which would leave the function behind); keep `msg_status` (`read`) and make `messages.channel` NOT NULL after the legacy rows are archived; re-confirm the WhatsApp columns against the week-2 design (D49); recreate the other enum types to retire labels confirmed unused; enforce the `transcripts` XOR check and `report_sources.kind source_kind`; clean storage prefixes.
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
11. Should deleting an org, site, site-day or company keep cascading to its reports, versions and invoices (and an org to its unknown contacts) as built, or refuse the delete as §6.3 does (spec §19 question 17)? Until you answer, the end-state allowlist keeps the repo's 17 `ON DELETE` actions as `repo-on-delete`; besides the cascades, deleting a company, reporter, user or report leaves a null link, and deleting a message leaves an unknown contact with a null `message_id`. **Answered 2026-10-15 ("go with your recommendations"; spec §19 Q17):** keep the actions as built; the allowlist entry stays as `repo-on-delete`.
12. Who signs in to the TR demo org Demir Yapı A.Ş.? §18.2 as delivered named no office user (spec §19 question 18). Options: a separate fictional TR admin (e.g. a `@demiryapi.example` user with panel language TR), Lena as a member of both orgs with the org switcher, or both. Recommendation: a separate TR admin, so the Kestrel e2e is unaffected. **Answered 2026-10-14 (the recommendation, D46):** a separate fictional TR admin, Elif Aydın (`elif@demiryapi.example`, `admin`), a member of Demir Yapı only; W1-06 seeds her, and the `e2e:supabase` TR test signs in as her.
13. Country packs and message channels (owner decision 2026-10-14, D47–D49): spec §19 questions 19–40. Blocking: Q19 (pack channel orders), Q22 (fallback between channels), Q25 (first contact, WhatsApp consent, the device code; with Q24 for a pack without links in SMS), Q26 (inbound WhatsApp), Q27 (web push), Q39 (the WhatsApp sender and template ids) and Q40 (per-channel opt-out) before M6; Q28 (legal text keys) before go-live; Q30 (billing outside the pack) before M10. The rest carry recommendations, followed unless you object. **Answered 2026-10-15: "go with your recommendations"** for every §19 question; spec §19 records each decision. Still open for facts only the owner has: Q2 (TR SIP provider), Q8 and Q9 (TR billing entity and price), Q49 (counsel on İYS), Q63 (a native-speaker review); Q28, Q40 and Q50 are decided but need counsel's texts or answer. Q15–Q17, which had no recommendation, took the ones written for them: GSM-7 punctuation in the SMS copy (Q15; İletimerkezi's support of the Turkish shift table still to confirm), v1 data seen as built (Q16, D20), the `ON DELETE` actions as built (Q17).

---

## 9. Appendix

### 9.1 Environment variables: merge table

Columns: root `.env.example` line · kit `docs/env.example` line (both at `cc956dd`, before the merge) · who reads it in code · action, now applied in the merged root `.env.example`.

| Variable                                                                                                                                                                                                                                                        | Root                      | Kit             | Read by                                                                                       | Action                                                                                                                                                                                       |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- | --------------- | --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SUPABASE_URL`                                                                                                                                                                                                                                                  | :2                        | :6              | worker `apps/worker/src/config.ts:27`; functions (platform-injected)                          | keep; local default `http://127.0.0.1:54321`                                                                                                                                                 |
| `SUPABASE_ANON_KEY`                                                                                                                                                                                                                                             | :3                        | :7              | functions                                                                                     | keep                                                                                                                                                                                         |
| `SUPABASE_SERVICE_ROLE_KEY`                                                                                                                                                                                                                                     | :4                        | :8              | worker `apps/worker/src/config.ts:28`; functions                                              | keep                                                                                                                                                                                         |
| `SUPABASE_DB_URL`                                                                                                                                                                                                                                               | :5                        | :9              | worker (required, `apps/worker/src/config.ts:29`)                                             | keep                                                                                                                                                                                         |
| `VITE_SUPABASE_URL`                                                                                                                                                                                                                                             | :8                        | :12             | `apps/web/src/lib/env.ts:13`; deploy derives it (`.github/workflows/deploy.yml:150-156`)      | keep; field app needs it at build time for `_redirects`                                                                                                                                      |
| `VITE_SUPABASE_ANON_KEY`                                                                                                                                                                                                                                        | :9                        | :13             | `apps/web/src/lib/env.ts:14`                                                                  | keep (panel only)                                                                                                                                                                            |
| `VITE_APP_URL`                                                                                                                                                                                                                                                  | :10                       | —               | `apps/web/src/lib/env.ts:15-17`                                                               | keep (repo-only)                                                                                                                                                                             |
| `VITE_WA_DISPLAY_NUMBER`                                                                                                                                                                                                                                        | :11                       | —               | `apps/web/src/lib/env.ts:18`; `.github/workflows/deploy.yml:144`                              | remove with the WhatsApp footer                                                                                                                                                              |
| `VITE_DEMO`                                                                                                                                                                                                                                                     | :12                       | —               | `apps/web/src/lib/env.ts:20`                                                                  | keep (repo-only)                                                                                                                                                                             |
| `VITE_SENTRY_DSN`                                                                                                                                                                                                                                               | :13                       | —               | `apps/web/src/lib/env.ts:19`                                                                  | keep; field app reuses it                                                                                                                                                                    |
| `VITE_FIELD_API_URL`                                                                                                                                                                                                                                            | —                         | :14             | nothing yet                                                                                   | add (`/api`)                                                                                                                                                                                 |
| `VITE_FEATURE_TALK_NOW`                                                                                                                                                                                                                                         | —                         | :15             | nothing yet                                                                                   | add (`false`); **removed (W3-13)**: field-api's `talkNow` in `resolve` / `today` (§19 Q121)                                                                                                  |
| `VITE_ROUTER`, `VITE_BASE`, `VITE_SOURCEMAP`, `VITE_OUT_DIR`                                                                                                                                                                                                    | —                         | —               | `apps/web/vite.config.ts:8`, `:16-17`; `apps/web/src/App.tsx:16`                              | build-only; leave out                                                                                                                                                                        |
| `WA_PHONE_NUMBER_ID`, `WA_BUSINESS_ACCOUNT_ID`, `WA_ACCESS_TOKEN`, `WA_DISPLAY_NUMBER`, `WA_GRAPH_VERSION` (+ code-only `WA_GRAPH_BASE`)                                                                                                                        | :16-18, :21-22            | —               | worker `apps/worker/src/config.ts:31-36`                                                      | remove with `apps/worker/src/wa`                                                                                                                                                             |
| `WA_APP_SECRET`, `WA_VERIFY_TOKEN`                                                                                                                                                                                                                              | :19-20                    | —               | `whatsapp-webhook`; `scripts/src/replay-webhook.ts:26`; `.github/workflows/ci.yml:107-108`    | remove                                                                                                                                                                                       |
| `APP_URL`                                                                                                                                                                                                                                                       | :46                       | :18             | worker `apps/worker/src/config.ts:51`; functions CORS `supabase/functions/_shared/http.ts:29` | keep; local `http://localhost:5173`                                                                                                                                                          |
| `CORS_EXTRA_ORIGINS`                                                                                                                                                                                                                                            | —                         | —               | `supabase/functions/_shared/http.ts:30`, `:45-47`                                             | add (exact origins, no wildcard)                                                                                                                                                             |
| `FIELD_APP_URL`, `FIELD_API_URL`, `LINK_SHORT_DOMAIN`, `LINK_SIGNING_SECRET`, `DAILY_LINK_TTL_HOURS`                                                                                                                                                            | —                         | :19-23          | nothing yet                                                                                   | add [W1]                                                                                                                                                                                     |
| `SMS_US_PROVIDER`, `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `SMS_US_FROM`                                                                                                                                                                                     | —                         | :26-29          | nothing yet                                                                                   | add [W1, console] (W1-06a: `SMS_US_PROVIDER` and `SMS_US_FROM` moved to the country pack, D47; the `TWILIO_*` credentials stay)                                                              |
| `SMS_TR_PROVIDER`, `ILETIMERKEZI_API_KEY`, `ILETIMERKEZI_API_HASH`, `SMS_TR_SENDER_TITLE`                                                                                                                                                                       | —                         | :30-33          | nothing yet                                                                                   | add [W1, console] (W1-06a: `SMS_TR_PROVIDER` and `SMS_TR_SENDER_TITLE` moved to the country pack, D47; the `ILETIMERKEZI_*` credentials stay)                                                |
| `ANTHROPIC_API_KEY`                                                                                                                                                                                                                                             | :27                       | :36             | worker `apps/worker/src/config.ts:40`; CI eval (repository secret)                            | keep                                                                                                                                                                                         |
| `CLAUDE_MODEL`                                                                                                                                                                                                                                                  | :28 (`claude-sonnet-5-5`) | :37 (empty)     | `apps/worker/src/config.ts:41` (same default); `apps/worker/fly.toml:21`                      | keep; value per D23                                                                                                                                                                          |
| `CLAUDE_MODEL_FAST`                                                                                                                                                                                                                                             | :29                       | :38             | `apps/worker/src/config.ts:42`, falls back to `CLAUDE_MODEL` (`:83`)                          | keep                                                                                                                                                                                         |
| `DEEPGRAM_API_KEY`, `TRANSCRIBE_PROVIDER`                                                                                                                                                                                                                       | —                         | :39-40          | `apps/worker/src/config.ts` (W1-11)                                                           | added (W1-11; `fake` too)                                                                                                                                                                    |
| `TRANSCRIBE_MODEL`                                                                                                                                                                                                                                              | :26 (`whisper-1`)         | :41 (`nova-3`)  | `apps/worker/src/config.ts:39`; `apps/worker/fly.toml:20`                                     | change to `nova-3` with W1-11 (done: `.env.example` and `fly.toml`; empty = the provider's default)                                                                                          |
| `OPENAI_API_KEY`                                                                                                                                                                                                                                                | :25                       | :42             | `apps/worker/src/config.ts:38`                                                                | keep (fallback only)                                                                                                                                                                         |
| `WEATHER_API_BASE`                                                                                                                                                                                                                                              | :32 (customer API)        | :45 (free API)  | `apps/worker/src/config.ts:44`                                                                | keep; dev value = free endpoint                                                                                                                                                              |
| `WEATHER_API_KEY`                                                                                                                                                                                                                                               | :33                       | :46             | `apps/worker/src/config.ts:45`                                                                | keep                                                                                                                                                                                         |
| `EMAIL_PROVIDER`                                                                                                                                                                                                                                                | :36 (`resend`)            | :49 (`console`) | `apps/worker/src/config.ts:47`; console without a key (`:85`)                                 | keep; default `console`                                                                                                                                                                      |
| `RESEND_API_KEY`                                                                                                                                                                                                                                                | :37                       | :50             | `apps/worker/src/config.ts:48`                                                                | keep                                                                                                                                                                                         |
| `EMAIL_FROM`                                                                                                                                                                                                                                                    | :38                       | :51             | `apps/worker/src/config.ts:49`                                                                | keep; dev sender per kit                                                                                                                                                                     |
| `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`, `LIVEKIT_AGENT_NAME`, `VOICE_NUMBER_US`, `VOICE_NUMBER_TR`, `LIVEKIT_SIP_OUTBOUND_TRUNK_US/TR`, `VOICE_AGENT_TOOL_SECRET`, `STT_MODEL`, `TTS_VOICE_EN/ES/TR`, `AZURE_SPEECH_KEY`, `AZURE_SPEECH_REGION` | —                         | :54-68          | nothing yet                                                                                   | add, commented [W2+] (W1-06a: `VOICE_NUMBER_US/TR` → `countries.voice_number`; `LIVEKIT_SIP_OUTBOUND_TRUNK_US/TR` → `LIVEKIT_SIP_OUTBOUND_TRUNKS`, spec §19 Q38; `VAPID_*` added [W2+], D48) |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`                                                                                                                                                                                                                    | :41-42                    | :71-72          | `stripe-webhook`, `api-billing`                                                               | keep                                                                                                                                                                                         |
| `STRIPE_PRICE_ID_SITE` → `STRIPE_PRICE_ID_SITE_US`                                                                                                                                                                                                              | :43                       | :73             | `supabase/functions/api-billing/index.ts:150`; `.github/workflows/ci.yml:112`                 | rename: set new secret, read new with fallback, unset old                                                                                                                                    |
| `TR_BILLING_PROVIDER`                                                                                                                                                                                                                                           | —                         | :74             | nothing yet                                                                                   | add [W4]                                                                                                                                                                                     |
| `WORKER_CONCURRENCY`                                                                                                                                                                                                                                            | :47                       | :77             | `apps/worker/src/config.ts:52`                                                                | keep                                                                                                                                                                                         |
| `WORKER_PORT`                                                                                                                                                                                                                                                   | :48                       | —               | `apps/worker/src/config.ts:53`                                                                | keep (repo-only)                                                                                                                                                                             |
| `AUDIO_RETENTION_DAYS`                                                                                                                                                                                                                                          | :49                       | :78             | `apps/worker/src/config.ts:58`                                                                | keep                                                                                                                                                                                         |
| `SENTRY_DSN`                                                                                                                                                                                                                                                    | :50                       | :79             | `apps/worker/src/config.ts:59`                                                                | keep                                                                                                                                                                                         |
| `COST_WA_TEMPLATE_USD`                                                                                                                                                                                                                                          | :51                       | —               | `apps/worker/src/config.ts:64-68`                                                             | remove (D45)                                                                                                                                                                                 |
| `SCHEDULER_SECRET`                                                                                                                                                                                                                                              | :52                       | —               | `supabase/functions/scheduler-tick/index.ts:65`                                               | keep (repo-only)                                                                                                                                                                             |
| `LOG_LEVEL`                                                                                                                                                                                                                                                     | :53                       | —               | `apps/worker/src/config.ts:25`                                                                | keep (repo-only)                                                                                                                                                                             |
| `NODE_ENV`, `WORKER_ID`, `JOB_TIMEOUT_MS`, `POLL_INTERVAL_MS`, `SWEEP_INTERVAL_MS`, `FFMPEG_PATH`, `WORKER_DRY_RUN`                                                                                                                                             | —                         | —               | `apps/worker/src/config.ts:24`, `:54-57`, `:69-71`                                            | optional tunables; leave out                                                                                                                                                                 |
| `WEBHOOK_URL`, `REPLAY_PHONE`, `DATABASE_URL`, `API_URL`, `ANON_KEY`, `SERVICE_ROLE_KEY`, `PW_*`                                                                                                                                                                | —                         | —               | scripts, load test, e2e                                                                       | dev/test only; leave out                                                                                                                                                                     |

Also: add the v1.2 function variables (`TWILIO_AUTH_TOKEN`, `LINK_SIGNING_SECRET`, `FIELD_APP_URL`, `CORS_EXTRA_ORIGINS`) to the CI heredoc for `supabase/functions/.env` (`.github/workflows/ci.yml:105-113`) when those functions land.

### 9.2 Schema: table-by-table diff (v1.2 §6.3 vs repo)

Status: _same_ (same columns; repo may be stricter), _extras_ (all v1.2 columns plus repo additions), _adapt_ (columns missing or different), _conflict_ (WhatsApp-keyed shape), _add_ (missing), _rename_.

| v1.2 table         | Repo                                                                  | Status    | Notes                                                                                                                                                                                                                                                                         |
| ------------------ | --------------------------------------------------------------------- | --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `orgs`             | `supabase/migrations/20261011000002_tables.sql:5`                     | adapt     | Missing `country`, `locale`, `units`, `currency`, `tax_no`, `billing_provider`, `is_demo`; `stripe_*` instead of `billing_*`; extra `trial_ends_at`. Lock `is_demo`/billing against admin writes. (W1-06a: `country` references `countries` instead of the US/TR check, D47.) |
| `countries`        | —                                                                     | add       | New (D47), step 12a (W1-06a): one row per country pack; done in `20261014000004_country_packs.sql`.                                                                                                                                                                           |
| `org_members`      | `:19`                                                                 | adapt     | Missing `ui_locale`; extra `created_at`.                                                                                                                                                                                                                                      |
| `org_settings`     | `:29`, `supabase/migrations/20261012000001_web_gaps.sql:12`           | adapt     | Missing `daily_link_time`, `auto_call_enabled`, `second_call_enabled`, `call_window_start/end`; repo extras (ladder toggles, PDF settings, payroll columns) are recorded deviations. (W1-06a: `pdf_paper` is in spec §6.3 now, preset from the pack, D32 amended.)            |
| `sites`            | `:59`                                                                 | extras    | Extra `paused_at`.                                                                                                                                                                                                                                                            |
| `reporters`        | `:78`                                                                 | adapt     | Missing `locale`, `contact_pref`, `activated_at`, `opted_out_at`; status `verified`; `last_invite_error` is WhatsApp's "Not on WhatsApp". (W1-06a: + `message_channel`, D48.)                                                                                                 |
| `consents`         | —                                                                     | add       | Needs `consent_type`. Field-side.                                                                                                                                                                                                                                             |
| `site_reporters`   | `:93`                                                                 | same      | Cross-org write defect (`supabase/migrations/20261011000004_rls.sql:123`).                                                                                                                                                                                                    |
| `site_recipients`  | `:100`                                                                | same      | —                                                                                                                                                                                                                                                                             |
| `companies`        | `:106`                                                                | extras    | Extra `created_at`.                                                                                                                                                                                                                                                           |
| `field_links`      | —                                                                     | add       | Needs `link_kind`; index `(reporter_id, kind)`. Field-side.                                                                                                                                                                                                                   |
| `field_devices`    | —                                                                     | add       | Field-side; revocation by RPC for admin/ops.                                                                                                                                                                                                                                  |
| `messages`         | `:132`, `supabase/migrations/20261013000005_office_photos.sql:28-31`  | conflict  | WhatsApp log plus office-photo rows; v1.2 holds messages on every channel (D15, D48). (W1-06a: + `channel`, nullable until step 23, D49.)                                                                                                                                     |
| `site_days`        | `:172`                                                                | extras    | Extra `reminders_paused`, timestamps.                                                                                                                                                                                                                                         |
| `reports`          | `:188`                                                                | adapt     | Missing `channel`, `language`, `confirmed_via`; status lacks `processing`; extra `kind`; `report_archive` view selects `r.*`.                                                                                                                                                 |
| `uploads`          | —                                                                     | add       | Needs `upload_kind`; index `(report_id)`; backfill target for media; `reporter_id` decision (D14).                                                                                                                                                                            |
| `calls`            | —                                                                     | add       | Needs the four `call_*` enums, index, `calls` bucket.                                                                                                                                                                                                                         |
| `transcripts`      | `:150`                                                                | conflict  | `message_id NOT NULL UNIQUE`; v1.2 `upload_id`/`call_id` with XOR check. GIN index uses the `english` config.                                                                                                                                                                 |
| `report_versions`  | `:212`                                                                | adapt     | Missing `via`; author `reporter_reply`; extra `author_message_id`.                                                                                                                                                                                                            |
| `report_sources`   | `:226`                                                                | conflict  | `message_id NOT NULL`, text `kind` audio/photo/text/reply, `caption`/`taken_at`; v1.2 `source_kind` + upload/call/message/question ids.                                                                                                                                       |
| `manpower_entries` | `:237`                                                                | extras    | Extra `company_name`, `hours_basis`.                                                                                                                                                                                                                                          |
| `work_items`       | `:254`                                                                | extras    | Extra `quantity`.                                                                                                                                                                                                                                                             |
| `weather_events`   | `:267`                                                                | same      | `denormalize_report_version` only reads `audio` sources (`supabase/migrations/20261012000002_rpc_fixes.sql:53`).                                                                                                                                                              |
| `questions`        | `:287`                                                                | adapt     | Missing `channel`, `call_id`, `answer_source`; extra WhatsApp message ids.                                                                                                                                                                                                    |
| `unknown_contacts` | `unknown_senders`, `:160`                                             | rename    | Add `channel`, `call_id`; `first_message_id` → `message_id`; keep `guessed_site_id`.                                                                                                                                                                                          |
| `glossary_terms`   | `:303`                                                                | same      | —                                                                                                                                                                                                                                                                             |
| `sub_invoices`     | `:319`                                                                | extras    | Extra `queried_at`, `resolved_at`, status check.                                                                                                                                                                                                                              |
| `evidence_packs`   | `:335`                                                                | extras    | Extra `sections`, `error`, `ready_at`; forged-insert defect (`supabase/migrations/20261011000004_rls.sql:161`).                                                                                                                                                               |
| `jobs`             | `:351`                                                                | adapt     | `dedupe_key` not unique (D16); extras `locked_by`, `finished_at`, `lock_key`.                                                                                                                                                                                                 |
| `rate_limits`      | —                                                                     | add       | PK `(key, window_start)`. Field-side.                                                                                                                                                                                                                                         |
| `audit_log`        | `:366`                                                                | same      | Extra `actor_type` check; readable by accounts (D22).                                                                                                                                                                                                                         |
| —                  | `conversations` (`:119`)                                              | repo-only | WhatsApp state machine; remove (section 4).                                                                                                                                                                                                                                   |
| —                  | `notifications` (`:379`)                                              | repo-only | Backs §13 panel notifications; keep; add v1.2 kinds.                                                                                                                                                                                                                          |
| —                  | `scheduler_state`, `stripe_events`, `platform_admins`, `report_costs` | repo-only | Keep (D12); `report_cost_inputs()` counts WhatsApp templates.                                                                                                                                                                                                                 |

### 9.3 Enums (v1.2 §6.2 vs repo)

| Enum                                                                                                                                                          | Repo                                                | Status                                                                        |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- | ----------------------------------------------------------------------------- |
| `member_role`, `site_status`, `reporter_role`, `company_status`, `msg_direction`, `site_day_status`, `term_status`, `term_kind`, `job_status`, `pack_status`  | `supabase/migrations/20261011000001_enums.sql:6-23` | same labels and order                                                         |
| `reporter_status`                                                                                                                                             | `invited, verified, disabled`                       | rename `verified` → `active`; add `opted_out` before `disabled`               |
| `msg_status`                                                                                                                                                  | has `read`, lacks `undeliverable`                   | add `undeliverable`; `read` kept for WhatsApp receipts (D49), no new type     |
| `report_status`                                                                                                                                               | lacks `processing`                                  | add after `collecting` (own migration)                                        |
| `version_author`                                                                                                                                              | `reporter_reply`                                    | rename → `reporter`                                                           |
| `contact_status`                                                                                                                                              | `sender_status` (same labels)                       | rename type                                                                   |
| `contact_pref`, `consent_type`, `field_channel`, `link_kind`, `upload_kind`, `call_direction`, `call_transport`, `call_status`, `call_outcome`, `source_kind` | —                                                   | add                                                                           |
| `message_channel`                                                                                                                                             | —                                                   | add (new, D48), step 12a (W1-06a): done in `20261014000004_country_packs.sql` |
| `msg_type`, `convo_state`                                                                                                                                     | WhatsApp only                                       | remove in the contract phase                                                  |
