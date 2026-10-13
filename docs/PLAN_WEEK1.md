# SiteLog — Week 1 build plan (M0–M5 → live demo)

Goal: by the end of week 1, run the **demo script** (bottom of this file) end-to-end on a real phone: text link → record → one question → draft → confirm → PDF by SMS + email → the Overview flips to _Filed_ live → open the report, play the audio, sign off.

Rules: `CLAUDE.md`. Spec: `docs/SITELOG_SPEC.md` (v1.2). Designs: `docs/design/`. Audit: `docs/GAP_ANALYSIS.md` ("GAP" below). "D12" is decision 12 in GAP §6; "step 9" is step 9 of the migration plan in GAP §7.

## What changed from the kit plan, and why

The kit plan was written for an empty folder. This repo is the spec v1.0 build (WhatsApp field channel) and it is live: the panel at https://staging-sitelog.netlify.app and the hosted Supabase project `abuanbyzttuqksdctqcp` with 16 applied migrations, deployed from `claude/focused-newton-5v0u2q` by `.github/workflows/deploy.yml`. The owner approved every recommendation in GAP §6 on 2026-10-13, and this plan was rewritten for the repo (kickoff A, step 5). As a result:

- **Nothing is scaffolded or rebuilt.** Every ticket says what is already in the repo and lists only the remaining work, using the real layout: `packages/pdf`, `supabase/db-tests` (PGlite), the hand-maintained `packages/shared/src/db/types.ts` (D7), the `seed.sql` generator (D8) and `pnpm dev:worker`.
- **The stack stays as built:** Node 22, pnpm 10, React 19, Vite 8, Tailwind 4 with CSS-first tokens shared from `packages/shared`, and per-package Vitest (D1–D5). README records these deviations.
- **The schema moves forward only.** Applied migrations are never edited. "DDL verbatim" means the end state must be equal, and a test proves it (D11). Stored v1 report data is never rewritten; readers upgrade it (D20).
- **The order follows GAP §7, steps 0–21,** so the build stays green and staging keeps working at every step. Each ticket names its steps. Steps 22–23 (retire WhatsApp, contract the schema) come after the demo.
- **WhatsApp keeps working on staging until the cut-over (W1-19).** On this branch, each WhatsApp delivery is replaced in the commit that lands its v1.2 replacement (welcome in W1-08, filed text and PDF in W1-15); the WhatsApp reminder ladder is stopped in W1-10 with no week-1 replacement. Everything else is removed after the demo.
- **Work moved between tickets** where the dependency order needs it:
  - W1-19 → W1-01: the read-only staging inventory (step 0), the deploy guard (D40) and preview Environment support (D41). They must be in place before any v1.2 schema exists. The backup (`pg_dump` and bucket copy) stays in W1-19, right before the first `db push` to staging. The CI trigger (D44) needs no change while PR #1 is open.
  - W1-19 → W1-04: field hosting (step 7: second Netlify site D42, field deploy job, build-generated `_redirects` D43). The W1-04 phone check needs HTTPS.
  - W1-02 → W1-05: the §6.2 enums in `enums.ts` and every DB-facing change. Enums change only together with their migrations.
  - W1-10 → W1-05: the queue SQL that rides on the schema step (`pg_notify` in `enqueue_job`, the `report:<id>` lock key, v1.2 job priorities, the 10-minute stale lock D18).
  - W1-14 / W1-17 → W1-05: photos move to `uploads`, writers and readers, together with the backfill (D14, step 10).
  - W1-15 → W1-05: the SQL readers of `report_versions.data` (`denormalize_report_version`, the office-photo RPCs) accept v2 in step 10, because W1-06 seeds `schemaVersion 2` data.
  - W1-05 → step 22: the D13 insert trigger that rejects a null `channel`. The WhatsApp writers have no `channel` value and run until step 22, so the trigger would break them and their tests.
  - W1-10 → W1-08: `send_welcome` by SMS (step 14). W1-10 keeps the generic `send_sms` job, LISTEN and the dedupe change.
  - W1-07 → W1-12: the `reports/:id/answer` route. It needs `applyAnswer(Source)` and the v2 writers, and web questions exist only from W1-12.
  - W1-13 → W1-12: channel-neutral question options and `applyAnswer(Source)` (step 17).
  - W1-14 → W1-15: removing WhatsApp delivery from `render_pdf` (and with it D31), so the `filed` SMS replaces it in the same commit.
  - GAP §4.1 stage 5 → W1-10: stopping the WhatsApp reminder ladder in `scheduler-tick`. It ships before the worker first runs against a hosted database (the preview project, for the phone checks from W1-13), not only before the cut-over.
  - Step 18 is split. Its recorder half (W1-09) runs before the worker steps, because it needs only `field-api` and SMS. Its question and draft half (W1-13) runs after extraction.

## How each ticket runs in this repo

1. One ticket at a time, in order: take the next unticked ticket. Read its spec sections and artboards, its entry in GAP §3 and its steps in GAP §7.
2. Build only the unticked items, with tests. For SQL, add a new timestamped migration after the last applied one and update `packages/shared/src/db/types.ts` in the same commit (D7).
3. Run locally: `pnpm check` (typecheck + lint + unit tests) and `pnpm format:check`. Also `pnpm test:db` when SQL changed (plus `supabase db reset` if a local stack is available), `pnpm e2e` when UI changed, `pnpm e2e:supabase` and `pnpm test:stack` (from W1-05) when a Supabase data path changed (both need the local stack; CI runs them anyway), and `pnpm eval -- --recorded` when extraction changed.
4. Tick the boxes, commit `W1-xx: <summary>` and push to `spec-v1.2`. PR #1 (→ `claude/focused-newton-5v0u2q`) runs the five CI jobs and the `pr-1` Netlify preview (panel; field app from W1-04). Both must be green before the next ticket. A large ticket may land as several commits, one per migration step, each green and each starting with the ticket id. Tick the ticket after the last one.
5. Report in three lines against **Done when**. Checks marked _(owner)_ need a real phone or an owner action: ask for them and put the result in the report. Checks marked _(by hand)_ are made by the developer against the artboards or a local stack, with screenshots or renders attached to PR #1. Everything else runs in CI on PR #1.
6. Stop at the end of each milestone for the owner's review.

**Never without the owner's approval:** dispatch the Deploy workflow, merge into `claude/focused-newton-5v0u2q`, create `main`, run `supabase db push`, `functions deploy` or `secrets set` against any hosted project (staging or preview), run the worker, a seed or any SQL against a hosted database, or change Netlify settings. A new deploy target follows the existing pattern: its job skips with a notice until its secrets or site exist, so a missing account never turns PR #1 red.

**Keys the developer provides** (in the root `.env`, which the worker and `pnpm eval` read from W1-01 on, and `supabase/functions/.env`; never in the chat): Docker and the Supabase CLI for a local stack (CI runs one anyway); `ANTHROPIC_API_KEY` from W1-12 (recorded tool outputs without it); `DEEPGRAM_API_KEY` from W1-11 (fake transcriber without it). Optional: `RESEND_API_KEY` (W1-15; console otherwise), Twilio and İletimerkezi (W1-08; `console` driver and Demo phone otherwise), `OPENAI_API_KEY` (transcription fallback). A ticket that hits a missing key builds the fake, says which key it needs, and moves on.

**Owner actions:** answer GAP §8, approve and dispatch the read-only staging inventory, and create the preview Supabase project and the `preview` Environment with its Supabase settings (W1-01, D41, `docs/RUNBOOK.md` §2); the second Netlify site (W1-04, D42); approve each push, `secrets set` (`LINK_SIGNING_SECRET`, `FIELD_APP_URL`, `APP_URL`, `CORS_EXTRA_ORIGINS`, console SMS drivers) and Auth redirect URL change on the preview project; approve seeding it with the W1-06 apply mode before the first phone check; approve running the worker on the developer machine against it for the phone checks from W1-13 (with the Anthropic and Deepgram keys); real-phone checks (W1-04, W1-07, W1-09, W1-13, W1-15, W1-16, W1-19); every remote step of the cut-over (W1-19). Start now because of lead time, though neither blocks the demo: the İletimerkezi `SITELOG` sender title and Twilio toll-free verification (spec §5.2).

**Without the preview project (D41)** nothing v1.2 reaches a hosted database before the cut-over: schema work is proven in CI and on local stacks, the phone checks run through a tunnel to a local stack (W1-04), and the probes marked "needs D41" wait for the W1-19 smoke checks.

| Milestone            | Tickets       | GAP §7 steps            | Effort (GAP sizes) |
| -------------------- | ------------- | ----------------------- | ------------------ |
| M0 Foundations       | W1-01 … W1-04 | 0–7                     | S, L, M, M         |
| M1 Data model & seed | W1-05, W1-06  | 8–12                    | XL, L              |
| M2 Field app + SMS   | W1-07 … W1-09 | 13, 14, 18 (first half) | L, L, XL           |
| M3 Pipeline v1       | W1-10 … W1-13 | 15, 16, 17, 18 (rest)   | M, M, L, M         |
| M4 PDF & email       | W1-14, W1-15  | 19                      | M, L               |
| M5 Panel core → demo | W1-16 … W1-19 | 20, 21                  | M, M, M, M         |

## Not in week 1

- **Voice (week 2, M7–M8):** `apps/voice-agent`, Talk now (keep the button behind `VITE_FEATURE_TALK_NOW=false`), `voice-events`, the `field-api` voice routes, writing `calls` rows (the table exists from W1-05), the `photos_link` SMS, post-call reconcile and outbound calls.
- **Reminder ladder on SMS (M6):** `scheduler-tick` daily link, heads-up, R1/R2 and the missing alert, and the §9.5 SMS keywords that answer them (OK, NO WORK, WEATHER, EDIT …; W1-08 builds STOP, HELP, START, CALL and TEXT). The WhatsApp ladder is stopped on this branch in W1-10 and nothing replaces it in week 1; _Text today's link_ (W1-16) is the manual path. The ladder-guard finding (`docs/AUDIT_BACKLOG.md:367`) is fixed with the SMS ladder.
- **M6 field work:** _Other…_ answers and `parse_answer`, Fix by voice, editable Draft steppers, edits after filing, the §7.2 web timeouts, and real `/history`, `/settings` and `/expired` screens with the multi-site switcher, new phone and opt-out (F14–F16). Their routes exist as placeholders from W1-04.
- **Panel pages that already exist and keep working:** Hours, Weather & EOT, Glossary (M9); Setup with preferred channel and SMS welcome preview, Team with statuses, preferences, unknown contacts and device revocation, the Settings _Field channels_ tab, TR billing (M10). They get TR copy then.
- **Turkish polish (M11):** TR copy on panel pages week 1 does not touch, metric weather in the PDF (D34), İletimerkezi live, TR glossary seeds, KVKK notices.
- **Decided for later:** Node 24 (D1); an SMS per-segment cost when cost per report is reworked (§15.1, D45); `main` and a production environment when the owner wants one (D40).
- **Not decided yet:** the `sl.link` short-link domain and custom domains (GAP §8 Q7; links use the field host until then), whether a production Environment or project exists (GAP §8 Q6), a hosted worker on Fly.io (GAP §8 Q9; W1-19 assumes the developer machine).

---

## M0 · Foundations

### W1-01 · Monorepo, tooling and deploy safety

- [ ] **W1-01 done** · today _partial_ (S) · steps 0, 1, 2
- **Spec:** §5, Appendix A, Appendix D; `docs/START_HERE.md` kickoff A.
- **Already in the repo:** pnpm workspaces, TS 5.9 strict, ESLint flat config and Prettier, per-package Vitest, root scripts and five CI jobs (`pnpm-workspace.yaml`, `package.json:10-27`, `.github/workflows/ci.yml`); kit docs, merged `CLAUDE.md` and `.env.example`, GAP (commits `cc956dd` … `ea0c356`).
- **Moved in from W1-19:** the read-only inventory of step 0 and the deploy safety of step 1. The backup stays in W1-19.
- **Build (this repo):**
  - [x] Step 0 _(owner-approved, read-only)_: a dispatch-only `inventory` target in `deploy.yml` (environment `staging`, dispatched from `spec-v1.2`: until the cut-over the live branch runs its own pre-W1-01 `deploy.yml`, which has no `inventory`) for `abuanbyzttuqksdctqcp` per GAP §4.1 stage 1: `supabase link` without the database password, `supabase migration list --linked`, `functions list`, secret names only, and counts and labels from `supabase/ops/inventory.sql` in a rolled-back `READ ONLY` transaction (tested on PGlite by `supabase/db-tests/src/inventory.test.ts`), all in the run summary. It never runs `db push`, `functions deploy` or `secrets set` (`docs/RUNBOOK.md` §2). No backup now: a dump taken now would be stale at the cut-over and holds personal data that needs a storage place the owner chooses, so the `pg_dump` and bucket copy move to W1-19, right before the first `db push`.
  - [ ] _(owner)_ Dispatch Deploy from `spec-v1.2` with environment `staging` and target `inventory`; record the run summary and the answers to GAP §8 in PR #1. D19 (W1-05) depends on them.
  - [x] Step 1 / D40: guard in `deploy.yml` so every staging deploy step (`db push`, `functions deploy`, the Fly worker, `--prod`) runs only from the branch `claude/focused-newton-5v0u2q`; any other ref skips with a notice. The guard compares full refs (`refs/heads/…`), so a tag with the branch's name does not pass. A `plan` job decides and explains; each deploying job repeats the ref check literally in its `if:`; `scripts/src/deploy-workflow.test.ts` fails if a deploying job lacks it. The staging project ref is a workflow constant (`STAGING_PROJECT_REF`): a Supabase deploy to any other Environment that resolves to it (for example from a repository-level value while `preview` is empty) fails before it links. The guard covers this workflow file only: until the cut-over the live branch keeps its pre-W1-01 `deploy.yml`, and `main` must be created from a commit that has this one (`docs/RUNBOOK.md` §2). The pull-request `pr-<n>` path is unchanged.
  - [x] Step 1 / D41: the PR panel job keeps the `staging` Environment only for the Netlify token and site id; its Supabase build settings come from a `preview` GitHub Environment (second free Supabase project, created by the owner), read by a small `preview` job that passes the non-secret variables on. While `preview` has none, the panel preview builds in demo mode (`VITE_DEMO=true`, and the readiness check accepts that), so a v1.2 preview never reads or writes staging; a `preview` that points at the staging project also builds in demo mode, with a warning (checked against `STAGING_PROJECT_REF`, so it holds even without staging's own variables). Every other `staging` variable is blanked for pull requests, including `VITE_WA_DISPLAY_NUMBER` (the demo shows its fictional number, so nobody texts staging's real one from a preview) and `VITE_SENTRY_DSN` (previews do not report to Sentry). Previews stay `pr-<n>` aliases on the existing panel site: the Netlify site lookup keeps the panel's `staging` key, so the `preview` Environment never find-or-creates a site. The Deploy dispatch accepts `preview` for the Supabase job only (migrations and functions to the preview project, never `--prod`, never the web or worker targets), from `spec-v1.2` (and from the live branch after the cut-over). Owner setup: `docs/RUNBOOK.md` §2, in order: Supabase secrets and ref, the approved dispatch, Auth URLs and seed, and the anon key last (it switches previews out of demo mode).
  - [x] Step 1 / D44: not needed while PR #1 is open, so `ci.yml` is unchanged: with `spec-v1.2` in the push branches every push would run CI twice (push and `pull_request`). PR #1 stays the CI and preview vehicle; revisit only if it is closed before the cut-over.
  - [x] Step 2: the worker reads the root `.env` (GAP §2.8): outside production it loads `<cwd>/.env` and then the repository root's `.env`, cwd values winning and the shell over both (`apps/worker/src/dotenv.ts`); the `pnpm eval` entry loads it the same way (`pnpm loadtest` does not: it needs no key, and a `DATABASE_URL` read from a file could point its job-claiming runner at a real database); `CLAUDE.md` (Environment), `apps/worker/README.md` and the `.env.example` header aligned.
  - [x] Step 2: README pitch, repository table and report flow for v1.2 (v1.2 as the target, the WhatsApp build as what runs on staging today, pointing to GAP); `package.json:5`; deviation rows for Node 22 (D1), pnpm 10 (D2), React 19 and Vite 8 (D3) and per-package Vitest (D5).
  - [x] Step 2 / D10: copy the kit SVGs from `docs/brand/` to `apps/web/public/brand/` (replace `logo-mark`, `logo-mark-inverted`, `logo-mono`; add `logo-app-icon`, `favicon-16`, `favicon-32`) with `pnpm brand` (`apps/web/scripts/build-brand.mjs`), which also regenerates the PNG favicons (16 from `favicon-16.svg`, 32 from `favicon-32.svg`, 48 from `logo-mark.svg`), the 180 px apple-touch icon (from `logo-app-icon.svg`, full bleed) and `logo-lockup.svg` (kit mark + "SiteLog" in Archivo 800, stretch 125%, outlined). `index.html` lists only the PNG favicons by size (16, 32, 48) and the apple-touch icon: browsers that support SVG icons prefer one over sized PNGs, so with `favicon-32.svg` listed they would scale it down to 16 px and never show the simplified 16 px design (the old `favicon.svg` is gone). The sidebar, login and `/try` marks and the demo artifact build read `logo-mark.svg`, so they show the kit mark (the `/try` header puts its circle on a wrapper, so the mark is not clipped). The visual-review screenshots (`apps/web/e2e/__screenshots__`) are regenerated with the kit mark, so W1-02 compares against them. `logo-avatar-circle.svg` (WhatsApp profile, removed after the demo) and the PDF and email marks (W1-14, step 19) are untouched. `CLAUDE.md` brand row updated.
- **Tests:** a worker config test for the `.env` path, including the `pnpm eval` entry (`apps/worker/src/dotenv.test.ts`); the inventory SQL on PGlite (`supabase/db-tests/src/inventory.test.ts`); static checks of the guard (full refs), the staging-project refusal, the PR preview settings (nothing from `staging` but the Netlify token and site) and the read-only inventory (`scripts/src/deploy-workflow.test.ts`); `pnpm check`, `pnpm format:check`, `pnpm test:db`, actionlint (with shellcheck) on `.github/workflows/*.yml`.
- **Done when:** CI on PR #1 is green; the `pr-1` panel preview builds in demo mode or against the preview project, never staging (it takes only the Netlify token and site from `staging`; until `preview` has its anon key (the last owner step) it builds in demo mode and PR #1 stays green); the worker config test shows `pnpm dev:worker` reads the root `.env`; _(owner)_ the guard is reviewed, and the first guarded dispatch from another ref is seen to skip; _(owner)_ the logos look right on the preview; _(owner-approved)_ the inventory numbers and GAP §8 answers are in PR #1.
- **Needs:** owner approval and dispatch of the inventory; the preview project and `preview` Environment (D41, `docs/RUNBOOK.md` §2). Without D41, see "Without the preview project" above.

### W1-02 · `packages/shared`

- [ ] **W1-02 done** · today _conflicts_ (L) · steps 3, 4
- **Spec:** §4.5, §9.2, §10.3, §14.1, §14.4, Conventions.
- **Already in the repo:** `@sitelog/shared`, imported by web, worker, pdf, scripts, db-tests and the edge functions (`supabase/functions/deno.json:3-4`); totals in code (`packages/shared/src/report/hours.ts:20-95`); `formatReportNo` and `pdfFileName` (`packages/shared/src/report/numbering.ts:2-9`); Zod report schema v1 with the tool's JSON schema (`packages/shared/src/schemas/report.ts:273-285`).
- **Moved out:** the §6.2 enums go to W1-05; `JOB_TYPES` changes with the ticket that adds each job.
- **Build (this repo):**
  - [x] Step 3: `channels.ts` with `FieldChannel`, `Notifier`, `SmsTransport`, `SmsDriver` (§4.5).
  - [x] Step 3: `copy/sms.{en,es,tr}.ts` with every §9.2 key; `renderSms(key, locale, vars, { hasVoiceNumber })` drops the "or call {number}" clauses when there is no number.
  - [x] Step 3: `sms/segments.ts`, a GSM-7 / UCS-2 segment counter that returns both counts for Turkish text.
  - [x] Step 3: `format.ts` on `libphonenumber-js` (E.164 parse and format; the existing `formatPhone` delegates and stops misgrouping Turkish numbers, `format.ts:154-161`), plus locale-aware dates, hours (h / sa) and units.
  - [x] Step 3: an exported `computeTotals()` wrapping `recomputeManpowerTotals` and `deriveTotals`.
  - [x] Step 3 / D4: move the `@theme` block from `apps/web/src/styles/tokens.css` to `packages/shared/src/tokens.css` and import it in `apps/web`; add `tokens.ts`; point `packages/pdf/src/styles.ts:9` and `apps/worker/src/email/templates.ts:16` at it.
  - [x] Step 3 / D9: i18next resources `copy/ui/*` with namespaces `common` and `field` (EN, ES, TR) and `panel` (TR only). The panel's EN resource stays `apps/web/src/copy/en.ts` (W1-03), so new panel strings go there and `panel` holds only their Turkish, keyed by `en.ts` paths (`apps/web/src/copy/tr-keys.test.ts` checks every key).
  - [x] Step 4 / D20: `DailyReportData` v2 exactly as §10.3, a union on `schemaVersion` and a pure `upgradeV1toV2()` (`audio` → `voice_note`, `reply` → `answer`, `messageId` → `uploadId`, `hoursBasis 'reply'` → `'answer'`). The panel views, PDF input builders (`apps/web/src/data/pdfInput.ts`), worker render and evidence pack read through it. Writers keep writing v1 until W1-12: the office editor keeps sending the stored version's own shape to `create_report_version` (only its display reads the upgrade), so the RPC input does not change in this step.
- **Tests:** `renderSms` in EN/ES/TR with and without a number; Turkish segment counts; a direct report-numbering test; `computeTotals`; v1 and v2 round-trips of the hero report (§18.1) and the upgrade; a test that `tokens.ts` matches `tokens.css` and that the moved `@theme` keeps every token name and value; a snapshot of the v1 hero sample PDF's text and page count.
- **Done when:** unit tests green, including the recorded golden set (`apps/worker/src/ai/eval.test.ts`, the same check as `pnpm eval -- --recorded`); web, worker, pdf and the edge functions (`deno check` in CI) import the new modules; e2e and `e2e:supabase` green (the office edit → v2 path unchanged); the v1 sample PDF snapshot is unchanged; the lockfile changes in the same commit; _(by hand)_ the committed screenshots (`apps/web/e2e/__screenshots__`, not run in CI) show no change after the token move.
- **Needs:** nothing.

### W1-03 · Panel shell and sign-in

- [ ] **W1-03 done** · today _partial_ (M) · step 5
- **Spec:** §11.1, §11.2, §11.5, F1, P1, §14. **Design:** `Web-Login`, `Web-Overview` (sidebar and top bar only).
- **Already in the repo:** the full tested shell (Vite + React 19, tokens, Archivo and IBM Plex Mono, restyled UI kit, sidebar, top bar, drawer, org switcher, TanStack Query), magic link and `/auth/callback`, role guard, optional Sentry, e2e and axe (`apps/web/src/app/routes.tsx:53-90`, `apps/web/src/components/shell/`, `apps/web/src/auth/`).
- **Build (this repo):**
  - [x] D9: i18next in `apps/web` behind `t()`, with `apps/web/src/copy/en.ts` as the EN resource; TR for the shell and login. Other pages get TR when a ticket touches them (W1-16 … W1-18). `src/i18n`: namespace `panel` is `en.ts` in English and `UI_RESOURCES.tr.panel` in Turkish, `common` the shared UI copy; `useCopy().t()` is typed from `en.ts` (keys, `{{name}}` variables, `key_one`/`key_other` read with `{ count }`), a key without Turkish falls back to English, and `translate()` serves code outside React. Converted: sidebar, top bar, drawer, account menu, footer, `/login`, `/auth/callback`, not found, no access, the sign-in error screen, offline banner, skeleton labels, `ErrorState`, `ComingNext`. Every other page renders in English inside `<EnglishOnly>` (`apps/web/src/app/routes.tsx`, `lang="en"`), so a Turkish shell never shows a raw key; `apps/web/src/copy/tr-keys.test.ts` checks that every Turkish key names an `en.ts` string with the same variables and that the converted parts have all their Turkish.
  - [x] A persisted language switch on `/login` and a Language item in the user menu that keeps the route (§11.2, F1). The viewer's choice (saved by `rememberLanguage` in `localStorage['sitelog.language']`), else the org's locale once known (§6.3 `ui_locale` null → org locale; `OrgSummary.locale`, the demo org is `en-US`), else, before an org is known (`/login`, `/auth/callback`), the browser's language when it is EN or TR, else English; `<html lang>` follows. `AuthProvider` applies the org default as the memberships load, before the shell mounts, so the shell never paints in the wrong language first; `AppShell` follows later org switches. `rememberLanguage` is the one place a choice is saved, so W1-05 adds `org_members.ui_locale` there.
  - [x] A React error boundary around the provider tree (`apps/web/src/App.tsx:20-35`) that reports to Sentry. `AppErrorBoundary` reports through `captureError` (a no-op without `VITE_SENTRY_DSN`) and shows a token-styled page in EN/TR with the event ID, Retry (re-mounts the app, or reloads the page when a lazy page's chunk failed to load, since `React.lazy` keeps the rejected import) and Sign out (`clearSession`, then `/login`).
  - [x] `/dev/phone` (admin) and `/settings/channels` as placeholders on `apps/web/src/app/ComingNext.tsx`. The §11.1 gate "staging or `is_demo` orgs" comes with the real page in W1-08, after W1-05 adds `orgs.is_demo`. Demo phone is the last SETUP item for admins; Field channels is the second Settings tab (P12 order).
  - [x] Footer "Agent ready · texts & calls" with the SiteLog number(s) when one exists, instead of the WhatsApp line (`apps/web/src/copy/en.ts:68`, `apps/web/src/components/shell/Sidebar.tsx:148-157`); login copy per P1 and the artboard ("Sign in to the office panel", text-link and phone-call bullets, `en.ts:286-301`); meta description (`apps/web/index.html:9`). `/try` stays demo-only until after the demo (D29). The numbers come from `OrgSummary.sitelogNumbers` (the demo org's §18.1 number; none in Supabase mode until an org's numbers are exposed); the panel no longer reads `VITE_WA_DISPLAY_NUMBER`. Below 768 px a page's controls render into a second top-bar slot, a row of its own after the search, so the shell has no sideways scroll at 390 px and the Tab order is the visual order (menu, bell, search, controls); `AppShell` picks the slot with `useMediaQuery('(min-width: 768px)')`. Top-bar copy from Web-Overview: search placeholder "Search reports, sites, subcontractors", bell "Notifications, 3 new".
- **Tests:** unit tests for the switch and the error boundary; e2e for EN ⇄ TR keeping the route; axe on `/login` in both languages; the no-sideways-scroll test extended to the shell at 390 px.
- **Done when:** e2e and axe green; the EN ⇄ TR switch works and keeps the route (e2e); the shell is correct at 1440 and 390 px (e2e, plus _(by hand)_ screenshots); magic-link sign-in green in `e2e:supabase`, and _(by hand)_ once through the local mail catcher (`supabase status`) when a local stack is available.
- **Needs:** nothing.

### W1-04 · Field app shell (PWA) and field hosting

- [ ] **W1-04 done** · today _missing_ (M) · steps 6, 7
- **Spec:** §9.3, §14.6, §6.5 (same-origin `/api/*`), §5 (field app row). **Design:** `Field-03-Today` (header), `Field-10-Today-TR`.
- **Already in the repo:** no `apps/field`. Reuse `apps/web/vite.config.ts`, `apps/web/index.html:6`, `:16-21` (theme colour, fonts), the shared tokens (W1-02), `docs/brand/logo-app-icon.svg`, the Playwright preview-server pattern (`apps/web/playwright.config.ts:44-52`) and the panel deploy job (`.github/workflows/deploy.yml`, job `web`).
- **Moved in from W1-19:** field hosting (step 7).
- **Build (this repo):**
  - [x] Step 6: `@sitelog/field` (Vite + React 19 + TS) with `vite-plugin-pwa` (check peers by hand; `.npmrc` hides mismatches), manifest (name "SiteLog", `display: standalone`, theme `#16181B`, 192/512 icons from `logo-app-icon.svg`) and `apps/field/public/brand/` from `docs/brand/`. `vite-plugin-pwa` 2.0.0 (peer `vite ^8.0.0`; its `workbox-build`/`workbox-window` peers are its own dependencies). `apps/field/config/pwa.ts`: `id`/`start_url`/`scope` `/`, short name "SiteLog", background Chalk, no `description` (one language, three in the app), icons `pwa-192`, `pwa-512` and `pwa-maskable-512` (the mark at 80 % on full-bleed Signal); `generateSW` precaches the built shell, the brand files and the fonts only, no runtime caching, the navigation fallback skips `/api`, `registerSW.js` with `clientsClaim` and no `skipWaiting` (a new version waits until the app's windows are closed, so an open page never loses its build's lazy chunks; an update prompt is W1-09's). The fonts are bundled (`apps/field/src/fonts.css`, `@fontsource-variable/archivo` with the width axis and `@fontsource/ibm-plex-mono` 400/500/600, latin and latin-ext) instead of the §14.2 Google Fonts stylesheet, which blocked the first paint of the precached shell on a stalled connection (README deviation). `pnpm --filter @sitelog/field brand` (in `pnpm brand`) copies the kit SVGs and renders the PNGs with Chromium; the PNGs are committed.
  - [x] Step 6: routes `/r/:code`, `/today`, `/record`, `/report/:id`, `/history`, `/settings`, `/expired` as placeholders; shared tokens and fonts; i18next EN/ES/TR (`field` namespace). No web push. `/` opens `/today`; any other path shows a not-found screen (`field.notFound`, new copy in EN/ES/TR) whose one action, "Go to Today", is the way out of an installed app with no URL bar. Top bar per Field-03 (mark, "SiteLog" until a link names the site, as on Field-02; the gear on Today only, 56 px) and the date line under it in `todayEyebrow` style; `<title>` per route; `<html lang>` follows the language, which is the first of the phone's languages the app speaks, else English (`resolveFieldLanguage` takes the reporter's locale first once W1-07 resolves the link). `src/api/client.ts`: a typed `field-api` client at `VITE_FIELD_API_URL` (default `/api`, same-origin cookie), not called yet; a 2xx answer that is not JSON (the host's `index.html` when the build has no `/api` rule, a captive portal) is an error (`FieldApiError`, reason `not_json`), never a result.
  - [x] Step 6 / D39: Vite `server.proxy` and `preview.proxy` `/api/*` → `{SUPABASE_URL}/functions/v1/field-api/*`; port 5174 with `--host`; `VITE_FIELD_API_URL=/api`. `apps/field/config/server.ts`: `SUPABASE_URL` (else `VITE_SUPABASE_URL`) from the shell, `apps/field/.env*` or the root `.env`; no rule when unset or not an http(s) URL; `changeOrigin`; `/apiary` is not proxied. Dev 5174 and preview 4174, both `host: true` and `strictPort`; the host of `FIELD_APP_URL` (a tunnel) is added to `allowedHosts`.
  - [x] Step 6: root `pnpm dev` starts web (5173) and field (5174); root `pnpm e2e` also runs the field smoke test, and the CI `e2e` job gets a field step; ESLint browser/React block, e2e ignore and Prettier brand ignore extended to `apps/field` (`eslint.config.mjs:18`, `:41`, `.prettierignore`); `CLAUDE.md` commands updated. Also `pnpm dev:web` and `pnpm dev:field`; `pnpm build`, `typecheck` and `test` pick the app up through the workspace; README and `.env.example` updated.
  - [x] Step 7 / D42: a `field` job in `deploy.yml` with its own key in `.github/netlify-sites.json` and its own find-or-create name (never the panel's site id or fallback name `sitelog-<environment>-<owner>`: `deploy.yml`, job `web`, step "Netlify site"), finding or creating `sitelog-field-<environment>-<owner>` while there is no `field-<environment>` key (owner-approved, D42) and printing its id to add to `.github/netlify-sites.json`; `--alias pr-<n>` for PRs. The `plan` job plans it like the panel (`field` output and dispatch target; pull requests → `pr-<n>`; staging or production → `--prod` from the live branch only; `preview` → skipped with a notice); its `if:` repeats the live-branch guard. Key `field-<environment>` (`field-staging` for PRs), else find-or-create `sitelog-field-<environment>-<owner>` with the existing `NETLIFY_AUTH_TOKEN`; it never reads `NETLIFY_SITE_ID` and stops if the site resolves to the panel's (key, variable or name). It skips with a notice only while `NETLIFY_AUTH_TOKEN` is missing (and, for `--prod`, while the Environment has no Supabase project). Only its "Netlify site" and "Deploy" steps get the token (the panel job likewise), so `pnpm install` and the build never see it. On PRs the build gets only the `preview` job's Supabase URL, dropped if it is on the staging project (the panel's guard; refs and hosts compared without case, trailing dot or port, and a host that is not plain ASCII refused), else no `/api` rule; every other staging variable is blanked. The Build step then checks the host the generated `/api` rule forwards to (as a URL parser reads it) and fails on staging's for a PR or a non-staging deploy. `scripts/src/deploy-workflow.test.ts` checks the guard, the alias, the key and name separation and the blanking, and runs the `plan` step and the field job's steps under bash with stand-ins for curl, pnpm and npx. `docs/RUNBOOK.md` §2 "The field app site". The site id goes under `field-staging` after the first PR run creates the site.
  - [x] Step 7 / D43: a build-generated `apps/field/dist/_redirects` from `VITE_SUPABASE_URL`, with the `/api/*` proxy first and the SPA fallback second (no `/api/*` rule without a Supabase URL); README deviation row. `apps/field/config/redirects.ts`, a Vite plugin (build only) on the same URL as the dev and preview proxy (`SUPABASE_URL`, else `VITE_SUPABASE_URL`; the deploy job sets both): `/api/*  {url}/functions/v1/field-api/:splat  200`, then `/*  /index.html  200`. The URL shape is checked (https, or http to localhost; no credentials, query, fragment, placeholders, `:`/`*` in the path or a function URL); a bad one gives a build warning and no `/api` rule, and the deploy job's Build step fails if the file does not match the URL it was given. Unit tests in `redirects.test.ts`.
- **Tests:** a unit test for the `_redirects` generator; a Playwright smoke test that every placeholder route renders in EN/ES/TR at 390 px; CI builds and tests the app with no env set.
- **Done when:** CI green (the field Playwright smoke test runs in the `e2e` job); PR #1 deploys a field preview over HTTPS and the panel preview is unchanged; _(needs D41)_ `/api/*` on the preview reaches the preview project (404 until `field-api` exists); _(owner)_ the preview loads on iOS Safari and Android Chrome and can be added to the home screen. A plain-http LAN URL is not a secure context, so use the preview or a tunnel.
- **Needs:** owner: the second Netlify site (D42). The `field` job finds or creates `sitelog-field-staging-<owner>` with the staging `NETLIFY_AUTH_TOKEN` on the first PR run after the step-7 push; then add its id under `field-staging` in `.github/netlify-sites.json`. Without the token the field job skips with a notice and the phone check uses a tunnel to `pnpm --filter @sitelog/field preview`.

## M1 · Data model & seed

### W1-05 · Database: migrations, RLS, RPCs, storage

- [ ] **W1-05 done** · today _conflicts_ (XL) · steps 8, 9, 10, 11 (at least one commit each)
- **Spec:** §6.2–§6.5, §2.2, §7. GAP Appendix 9.2 (tables) and 9.3 (enums).
- **Already in the repo:** 16 applied migrations `20261011000001` … `20261013000005` (30 tables, RLS on all, `is_member`/`has_role`), `next_report_no` with a row lock, `sign_off_report`, `create_report_version`, views, private buckets, realtime on `site_days`/`reports`, the job queue (`claim_jobs`, backoff); PGlite suite in `supabase/db-tests`; `supabase start` with seed and the DB-type drift check in CI.
- **Moved in:** the §6.2 enums (from W1-02), queue SQL (from W1-10), photos to `uploads` (from W1-14 and W1-17). The fully unique dedupe (D16) lands with W1-10.
- **Build (new timestamped files after `20261013000005`, D11):**
  - [x] Step 8: one migration with only `CREATE TYPE` for the 10 new enums (`field_channel` with `office`, D13) and `ADD VALUE` for `report_status 'processing' AFTER 'collecting'`, `reporter_status 'opted_out' BEFORE 'disabled'` and `msg_status 'undeliverable'` (no `active`: step 11 renames `verified`). `packages/shared/src/enums.ts` gets `z.enum`s built from the same arrays, so `PG_ENUMS` keeps working. _Done: `20261013000006_enums_v1_2.sql` (uses none of the labels it adds, so it is safe in the one transaction the Supabase CLI runs per file), every enum with a `…Schema` in `PG_ENUM_SCHEMAS`, `db/types.ts`; `channels.ts` re-exports `FieldChannel` from `enums.ts`._
  - [ ] Step 9: the 6 new tables with RLS: `consents`, `field_links`, `field_devices`, `uploads` with a nullable `reporter_id` and `uploaded_by` (D14), `calls`, `rate_limits`. The field-side tables get no client policies. The new columns from GAP W1-05 "Missing": as in §6.3 when they have a default (`orgs.country`, `locale`, `units`, `currency`, `is_demo`), nullable otherwise (`reports.language` until step 10, `channel` per D13), including `transcripts.upload_id/call_id` and the v1.2 keys of `report_sources`. §6.4 indexes; the `calls` bucket. _The `step9-*` entries of `supabase/db-tests/src/schema-allowlist.ts` list every table, column, key and index this step owes (also the `questions.asked_at` default); new tables need their row in the role matrix._
  - [ ] Step 9: relax the WhatsApp-only constraints that would block v1.2 writers: `transcripts.message_id` and `report_sources.message_id` drop `NOT NULL`, `report_sources.kind` also accepts the `source_kind` labels, and `messages.type` drops `NOT NULL` for SMS rows. On `transcripts`, add only `num_nonnulls(upload_id, call_id) <= 1` now: the spec's exact XOR is added in step 23, because `NOT VALID` still checks new rows and the WhatsApp `transcribe_audio` path writes transcripts with neither key until step 22.
  - [ ] Step 9 / D13: `channel` stays nullable; every v1.2 writer sets it (`field-api` `web`, the office RPCs `office`, `sms-webhook` unknown contacts `sms`, W1-12 `questions` `web`), each with a test in its ticket. The insert trigger that rejects a null `channel` waits for step 22, because the WhatsApp writers (`apps/worker/src/db.ts:769`, `:867`) have no value and keep running until then.
  - [ ] Step 9 / D15: SMS columns on `messages`, their policy, and `messages` in the realtime publication.
  - [ ] Step 9: column lockdown on `orgs` (revoke `UPDATE`, re-grant profile columns; `is_demo` and billing columns service-only); `is_demo = true` on the Kestrel org if present; recreate `report_archive` (it selects `r.*`).
  - [ ] Step 9 (from W1-10): `pg_notify('jobs')` in `enqueue_job` (same 4-argument signature); a `report:<id>` branch in `job_lock_key` and v1.2 job names in `job_priority`; stale lock 10 min (D18).
  - [ ] Step 9 / D21, D22: fix the deferred RLS defects (cross-org `site_reporters`, forged `evidence_packs` inserts, an org left without an admin, cross-org `messages`/`transcripts`) and tighten the accounts role to §2.2 (hours and invoices). _The role matrix expects today's results for these (`KNOWN_DEFECTS` and the probes' `defect` in `supabase/db-tests/src/fixtures/role-matrix.ts`: accounts reading sites, audit_log, notifications and every storage bucket but `invoices` ("members read org files", `20261011000006_platform.sql:13`), the §13 audiences of the `missing_report`, `invoice_gap`, `needs_review`, `unknown_sender` and `billing` notifications (the probes also require accounts to keep invoice gaps, pm needs review, and a user's own rows to stay its own), the four defects above, `orgs` billing columns); each fix removes its entry. The no-last-admin guard may refuse with 42501 or P0001 and must let the admin's writes to other members through. Also revoke from `public, anon` every function anon can execute today, the lookup helpers and the RPCs (`ANON_GAPS` in `src/anon.test.ts`, which also fails on a new function that forgets its revoke)._
  - [x] Step 9: the PGlite harness without the blanket re-grant (`supabase/db-tests/src/harness.ts:71`) and with an anon helper. _Done with step 8 as the test base: Supabase's default privileges only (`asAnon`, `probeAs`) and a storage stub (`bootDatabase({ storage: true })`, so the migrations' storage policies apply); the role matrix (`src/role-matrix.test.ts`, `src/fixtures/role-matrix.ts`: tables, views, buckets and the sign-off and edit RPCs, on fixture rows the test checks exist) and the anon test (`src/anon.test.ts`) run against today's schema and list the deferred defects and anon gaps with the step that fixes them._
  - [x] Step 9: a `test:stack` Vitest suite that runs against `SUPABASE_DB_URL` of a running stack, a root `pnpm test:stack` script listed in `CLAUDE.md`, and its step in the `e2e-supabase` CI job. W1-10 and later tickets add their real-Postgres tests to it. _Done with step 8: `supabase/db-tests/stack` (first test: `next_report_no` under concurrency, with rollbacks)._
  - [ ] Step 10: backfill `uploads` from `messages` media with the same UUIDs; `report_sources.upload_id/question_id` with `kind` mapped (`audio` → `voice_note`, `reply` → `answer` when it answered a question, else `text`) and `transcripts.upload_id`; `reporters.activated_at`; `reports.language` from the org locale (`en` for every existing org), then `NOT NULL`, with every report writer setting it in the same commit (the worker's `insertReport`, `apps/worker/src/db.ts:769`, and the office RPCs).
  - [ ] Step 10 / D13, D14: the office-photo RPCs (`attach_office_photos`, `create_office_report` with `channel 'office'`, `create_report_version`, `list_orphan_office_photos`) write `uploads`. Media readers (panel photos, `report/photos.ts`, PDF input, evidence pack, `retention_cleanup`, `report_cost_inputs`) read `uploads` with a `messages` fallback. Code accepts both old and new enum labels.
  - [ ] Step 10 / D20 (from W1-15): the SQL readers of `report_versions.data` accept v1 and v2, because W1-06 seeds v2 and W1-12 writes it: `denormalize_report_version` reads `audio`/`voice_note` and `reply`/`answer` sources (today only `audio`, `20261012000002_rpc_fixes.sql:53`) and writes `report_sources` with the v1.2 keys; `create_report_version` reads `photos[].uploadId` as well as `messageId` (office edits of a seeded v2 version send v2).
  - [ ] Step 11 / D19: `verified` → `active` if the W1-01 inventory shows only demo reporters; otherwise set real ones to `invited` first. Also `reporter_reply` → `reporter`, `sender_status` → `contact_status`, and `unknown_senders` → `unknown_contacts` (+ `channel`, `call_id`, `first_message_id` → `message_id`), updating every reader and writer in the same step (panel, `api-link-unknown-sender`, the worker's `apps/worker/src/db.ts`, `scripts/src/seed-demo.ts`, the demo store, `db/types.ts`).
  - [ ] Step 11: `stripe_*` → `billing_*` by expand/contract (the contract waits for step 23); code reads `STRIPE_PRICE_ID_SITE_US` before `STRIPE_PRICE_ID_SITE` (GAP 9.1).
  - [ ] D12: the allowlist for the end-state diff, each entry with its reason: the recorded repo additions (D12), `channel` nullable (D13), `uploads.reporter_id` nullable (D14), and the expand-phase gaps with the step that closes them (`jobs.dedupe_key` not yet unique → W1-10; the `transcripts` XOR, `report_sources.kind` as text, the `messages` `NOT NULL`s and the legacy tables and columns → step 23). README deviation rows for D12, D13 and D14. _Allowlist and end-state test done with step 8 (`supabase/db-tests/src/schema-allowlist.ts`, `schema-end-state.test.ts`; D13 and D14 recorded as `pending` until their columns exist, each with the difference that must last until then); README rows for D12 and D13 done; the D14 row lands with `uploads` in step 9. The repo's `ON DELETE` actions are listed until the owner answers spec §19 question 17 (GAP §8 question 11)._
- **Tests:** two orgs × admin/pm/ops/accounts × select/insert/update/delete per table (§2.2); anon reads nothing and cannot call the lookup helpers; the end-state diff (D11: apply the §6.2–§6.4 SQL to a fresh PGlite, compare columns, enum labels in order and constraints, with the allowlist); a backfill test on the frozen v1.0 seed (`git show 388fc63:supabase/seed.sql`) plus office-photo rows; `denormalize_report_version` and `create_report_version` on v1 and v2 data; enum ↔ DB sync; the WhatsApp worker tests stay green (`apps/worker/src/db.pglite.test.ts`, `apps/worker/src/integration/`); `next_report_no` under concurrency in `test:stack` (PGlite is single-session).
- **Done when:** `pnpm test:db` green with all of the above; `supabase db reset`, `test:stack`, `e2e:supabase` and the DB-type drift check green in CI; e2e green with the panel reading `uploads`; `rg` finds old labels only in legacy readers; _(owner-approved, needs D41)_ `db push` to the preview project succeeds. Staging is untouched until W1-19.
- **Needs:** the W1-01 inventory (D19); the preview project for the push (D41; without it the push waits for the cut-over).

### W1-06 · Seed data and types

- [ ] **W1-06 done** · today _conflicts_ (L) · step 12
- **Spec:** §18.1, §18.2.
- **Already in the repo:** the deterministic Kestrel dataset (`packages/shared/src/demo/kestrel.ts`, `ids.ts`, `hero.ts`) with office users, 6 sites, 7 reporters, companies and aliases, glossary, the Oct 9 states, hero RL-2041-0187 (23/184 → 24/192), the week's 1,804 h and the weather numbers; `pnpm seed:demo` regenerates `supabase/seed.sql` byte for byte; the seeded admin signs in (`apps/web/e2e/supabase/panel.spec.ts:30`). DB types follow each W1-05 migration (D7).
- **Build (this repo):**
  - [ ] Rebuild only the channel layer of Kestrel: uploads, SMS `messages` (welcome, daily links, Elm St.'s two reminders and `missed_call`), consents, field links, questions on `web`, `calls` rows for the §18.1 call states (Northgate filed via call, Hillcrest's missed R1 and call-back, the unknown caller) and the unknown caller in `unknown_contacts`; hero v2 by `reporter` via `web` (`schemaVersion 2`). Seed rows only: writing `calls` at runtime is week 2. Rename `DEMO_WA_NUMBER` and keep its value (+15550142290 is the §18.1 SiteLog number). Keep the WhatsApp data the `/try` simulator needs until it is removed (D29).
  - [ ] `is_demo = true` on both orgs; reporter `contact_pref` and `locale` (Northgate and Hillcrest prefer Call).
  - [ ] The TR demo org Demir Yapı A.Ş. (§18.2).
  - [ ] D8: an apply mode with the service role that upserts by the deterministic ids, touches only `is_demo` orgs and gives `audit_log` rows ids; the default output stays Oct 9 for e2e.
  - [ ] D36: `--date today` ends history yesterday and starts today's sites as awaiting (the demo's "five awaiting").
  - [ ] D37: office emails stay `@kestrelbuild.example`.
- **Tests:** applying twice gives the same rows (`test:stack`, or PGlite for the SQL); seed tests for both orgs; the Oct 9 numbers unchanged; the `--date` shift.
- **Done when:** `pnpm seed:demo` output is deterministic and applying it twice gives the same rows (CI); e2e (Oct 9 default) and `e2e:supabase` green; `lena@kestrelbuild.example` signs in and sees "Kestrel Build Group" (`e2e:supabase`); an `e2e:supabase` test shows the Demir Yapı org's sites with the shell in TR (its pages get TR copy in W1-16 … W1-18).
- **Needs:** the owner's answer to who signs in to Demir Yapı (§18.2 names no office user; add it to spec §19 and ask before seeding one); _(owner-approved)_ the apply mode on the preview project before the first phone check (D41).

## M2 · Field app + SMS

### W1-07 · `field-api` Edge Function

- [ ] **W1-07 done** · today _missing_ (L) · step 13
- **Spec:** §6.5, Appendix B (field routes), F4, F5, §7.1–§7.2.
- **Already in the repo:** no function. Reuse `supabase/functions/_shared/http.ts` (`HttpError`, `parseWith`, `timingSafeEqual`, `withHandler`), `_shared/audit.ts`, `_shared/jobs.ts`, `_shared/supabase.ts`, the one-live-report index (`20261012000004_queue_fairness.sql:86`), the storage path helpers (`packages/shared/src/report/numbering.ts:21-40`), and the W1-05 schema.
- **Build (this repo):**
  - [ ] `supabase/functions/field-api` with `[functions.field-api] verify_jwt = false`; Hono for this function only (D6), mounted under `/field-api`; the field app calls `/api/<route>` (D39).
  - [ ] Auth: link code sha256 → `field_links` (not revoked, not expired); cookie `sl_dev` (httpOnly, Secure, SameSite=Lax, 180 days) → `field_devices.verified_at`; every query scoped to the reporter's sites; `Cache-Control: no-store`.
  - [ ] Rate limits on `rate_limits`: 30 requests/min per device; 5 code sends and 5 verifications per hour per phone (D26).
  - [ ] Routes `resolve`, `device/send-code` (6 digits, hashed, 10 min), `device/verify`, `consent` (`consents` with `text_version`, `contact_pref`, locale → reporter `active`), `today`, `uploads` (signed upload URL for 10 min, path `{org}/{site}/{date}/{uuid}.{ext}`, `uploads` row), `uploads/:id/complete`, `reports/:id`, `day-status`, `history`, `preferences`.
  - [ ] `uploads/:id/complete` creates `site_days`/`reports` on the first upload, numbering and inserting in one transaction (one RPC, like `create_office_report`), with `channel 'web'`, `language` from the org, status `processing`, and enqueues `transcribe_upload` (job type added to `JOB_TYPES` here, handler in W1-11). The WhatsApp intake and day-off paths still number before inserting (`apps/worker/src/router/handlers/intake.ts:258-280`, `dayoff.ts:48`); that race ends when they are removed in step 22.
  - [ ] `reports/:id/confirm` checks the state and enqueues `file_report` with trigger `confirm` (`confirmMessageId` is already optional; `via` arrives in W1-15). The `reports/:id/answer` route moves to W1-12.
  - [ ] `device/send-code` sends through an injected `SmsTransport` (W1-02). Tests use a fake; W1-08 wires the real drivers.
  - [ ] `last_seen_at` on each call; every state change → `audit_log` with `actor_type 'reporter'`.
  - [ ] `LINK_SIGNING_SECRET`, `FIELD_APP_URL` and `CORS_EXTRA_ORIGINS` in the CI heredoc for `supabase/functions/.env` (`.github/workflows/ci.yml:105-113`).
- **Tests:** expired and revoked links, unverified device, cross-reporter access denied, rate limits, and the happy path resolve → verify → upload → complete creating the report and the job: Deno unit tests in the `edge-functions` job, and stack tests against `field-api` served by `supabase start` in a new `e2e-supabase` step (warm the function up first, as the job does for the others).
- **Done when:** both test sets pass in CI; _(owner-approved deploy to the preview project, needs D41)_ a probe through the field preview shows that `Set-Cookie` and `Cookie` pass the Netlify proxy and that responses carry `no-store`.
- **Needs:** any random `LINK_SIGNING_SECRET` locally; the preview project (D41) for the probe, which otherwise waits for the W1-19 smoke checks.

### W1-08 · SMS layer, invite and Demo phone

- [ ] **W1-08 done** · today _conflicts_ (L) · step 14
- **Spec:** §4.5, §9.2, §9.5, F3, §11.1 (`/dev/phone`), §5.2.
- **Already in the repo:** the channel-agnostic core of `api-invite-reporter` (admin/ops check, E.164, site ownership, same-phone reuse, audit, dedupe-keyed `send_welcome`, re-send after 48 h, disable; `supabase/functions/api-invite-reporter/index.ts:54-219`); the verify → store → enqueue → fast-ack structure of `whatsapp-webhook`; `scripts/src/replay-webhook.ts` (Meta).
- **Moved in from W1-10:** `send_welcome` by SMS.
- **Build (this repo):**
  - [ ] `SmsTransport` drivers `console` (writes `messages`, status `delivered`), `twilio` (REST + status callback) and `iletimerkezi` (REST, one-way), usable from the worker and the edge functions. Driver per org country from `SMS_US_PROVIDER`/`SMS_TR_PROVIDER`; `is_demo` orgs always use `console`.
  - [ ] One send function: `renderSms`, consent and opt-out checks, `messages` logging (`copy_key`, provider ids, `undeliverable`), audit. `field-api`'s `device/send-code` uses it.
  - [ ] `api-invite-reporter`: `locale` and `contactPref` with a compatible request contract, reporter `invited`, and a personal `field_links` row instead of a WhatsApp conversation.
  - [ ] `send_welcome` (`apps/worker/src/jobs/send_welcome.ts`) sends the `welcome` SMS with the personal link instead of the WhatsApp template; the Team and Setup buttons say "welcome text" (`apps/web/src/copy/en.ts:1109`, `:1112`, `:1454`).
  - [ ] `sms-webhook` (`verify_jwt = false`): `X-Twilio-Signature`, form parsing, store → enqueue → fast ack, status callbacks → `messages.status`, and the §9.5 keywords STOP (opt-out), START, HELP, CALL and TEXT in an SMS keyword module beside `wa/replies.ts` (which keeps serving WhatsApp until step 22). §9.5 keywords are US-only because İletimerkezi is one-way; the rest come with the M6 ladder. A text from an unknown number gets the F13 auto-reply and an `unknown_contacts` row with `channel 'sms'` (W1-16 lists it). `TWILIO_AUTH_TOKEN` in the CI functions `.env` heredoc.
  - [ ] `fixtures/sms/` with Twilio payloads; `scripts/src/replay-webhook.ts` signs Twilio payloads (Meta mode stays until step 22).
  - [ ] Panel `/dev/phone` (admin; staging or `is_demo` orgs): reporter list → thread (realtime on `messages`), links open the field app in a new tab (a 390 × 844 frame works only locally, D42), a reply box through the `sms-webhook` handler logic, an _Email_ tab; EN/TR copy.
  - [ ] The console email provider stores what it would send so the _Email_ tab can show it (today it only logs, `apps/worker/src/email/provider.ts:54-68`).
  - [ ] The `e2e-supabase` CI job starts the worker in the background against its stack (keyless: console SMS and email, `SUPABASE_DB_URL` from `supabase status`), so flows that need a job to run are tested end to end in CI from here on.
- **Tests:** Twilio driver and webhook with mocked HTTP and signature vectors; the keywords and case-insensitive matching; the console driver writes `messages`; `is_demo` forces `console`; invite tests (existing ones plus locale, preference and `field_links`); Demo phone component tests; the replay script.
- **Done when:** an `e2e:supabase` test, with the worker running in CI: inviting Marco shows the welcome text in the Demo phone with a working personal link (and _(by hand)_ the same on a local stack with `pnpm dev:worker`, when one is available); the Twilio driver and webhook tests pass with mocked HTTP; the existing invite tests stay green.
- **Needs:** optional `TWILIO_*`, `SMS_US_FROM`, `ILETIMERKEZI_*`, `SMS_TR_SENDER_TITLE` (long lead, owner); without them, `console` and the Demo phone.

### W1-09 · Field screens: device check → Today → Recording

- [ ] **W1-09 done** · today _missing_ (XL) · step 18 (first half)
- **Spec:** §9.3, §14.6, F4, F5, F12 (buttons). **Design:** `Field-01-SMS`, `Field-02-Welcome`, `Field-03-Today`, `Field-04-Recording`, `Field-10-Today-TR`.
- **Already in the repo:** nothing. Reuse `formatDuration`/`formatTimeInTz` (`packages/shared/src/format.ts:95`, `:145`) and the progress phrases (`packages/shared/src/report/progress.ts:18-30`, copy moves to the `field` namespace).
- **Build (this repo):**
  - [ ] `/r/:code` → `resolve` → device check ("Is this Marco Ruiz's phone?", code by SMS → Demo phone, `autocomplete="one-time-code"`) → Welcome & consent on first open (consents with `text_version`, preference, language) → Today.
  - [ ] Today: site, date, deadline, status, prompts, Record ≥ 120 px, Add photos, _No work_ / _Weather_ on `day-status`, Talk now behind `VITE_FEATURE_TALK_NOW=false`, _Call {number}_ only if the country has a number (none in week 1).
  - [ ] Recording: `MediaRecorder` mime detection (`audio/webm;codecs=opus` or `audio/mp4`), timer, level meter (`AnalyserNode`), Screen Wake Lock, pause and resume, Stop & send, photo capture, 15 min per clip; upload by signed URL, then `complete`.
  - [ ] Processing: poll `GET /api/reports/:id` every 2 s (no database session).
  - [ ] Offline: an IndexedDB queue of blobs and metadata, retry with backoff, resume after reload, an offline banner with the queued count.
  - [ ] All copy in EN/ES/TR; targets ≥ 56 px; every screen works at 390 px.
- **Tests:** unit tests for mime detection, the queue (fake IndexedDB) and backoff; a field `e2e:supabase` Playwright config (Chromium with a fake media stream, the field preview server proxying `/api` to the stack) and its step in the `e2e-supabase` CI job: resolve → verify (code read from the console `messages` row) → consent → record → upload creates the report and the `transcribe_upload` job; axe on each screen.
- **Done when:** the Playwright flow and unit tests pass in CI; _(owner)_ on a real iPhone (Safari) and Android phone (Chrome) through the HTTPS field preview: record 2 min + 2 photos → files in Storage and `uploads` rows; in airplane mode the clip queues and uploads when back online.
- **Needs:** `field-api` deployed to the preview project and a reporter there with a personal link (owner-approved, D41; invite from the panel preview or the W1-06 apply mode); real phones. Without D41, a tunnel to a local stack.

## M3 · Pipeline v1

### W1-10 · Worker runtime

- [ ] **W1-10 done** · today _partial_ (M) · step 15
- **Spec:** §10.1, §15.1.
- **Already in the repo:** `apps/worker` on Node 22 with `tsx watch`, direct Postgres, `claim_jobs()` with `FOR UPDATE SKIP LOCKED`, a handler registry with Zod payloads and timeouts, backoff, dead + Sentry, stale-lock reclaim, `/health`, graceful shutdown, `WORKER_CONCURRENCY` (`apps/worker/src/runner.ts`, `apps/worker/src/index.ts:91-134`). `pg_notify`, the lock key, priorities and the 10-minute stale lock land in W1-05; `send_welcome` by SMS and the worker in the `e2e-supabase` CI job in W1-08.
- **Moved in from W1-19:** stopping the WhatsApp reminder ladder.
- **Build (this repo):**
  - [ ] Stop the WhatsApp reminder ladder in `scheduler-tick` (`supabase/functions/scheduler-tick/index.ts:201`) before the worker first runs against a hosted database; keep site-day creation, weather slots, digest, retention and billing. The ladder returns on SMS in M6. Staging keeps its ladder until the cut-over deploys this branch.
  - [ ] `LISTEN jobs` on a dedicated session connection (the pool uses `prepare: false`, and a transaction pooler does not deliver LISTEN), with a 5 s poll fallback instead of 1 s polling (`apps/worker/src/config.ts:56`).
  - [ ] Job type and handler `send_sms(reporter_id, key, vars)` on the W1-08 send function; `JOB_TYPES` updated.
  - [ ] Dead reporter-facing jobs notify the office instead of sending a WhatsApp `error_retry` (`apps/worker/src/runner.ts:97-115`).
  - [ ] D16: `jobs.dedupe_key` fully `UNIQUE` and `enqueue_job` with `on conflict (dedupe_key) do nothing` (one 4-argument function, no overload). First null the keys of finished duplicates, give repeatable jobs per-occurrence keys (reinvite, `supabase/functions/api-invite-reporter/index.ts:185`), and audit the worker's keys and its index-name match (`apps/worker/src/db.ts:944`). Remove the `jobs.dedupe_key` entry from the W1-05 end-state allowlist.
  - [ ] D17: use all five delays (30 s · 2 min · 10 min · 30 min · 2 h), so a job is dead after the sixth failure; clarify §10.1 in the spec.
- **Tests:** the backoff schedule; dedupe keys never reusable (update `apps/worker/src/db.pglite.test.ts:1124-1130`); 100 jobs processed exactly once with concurrency 4 and the LISTEN wake-up, both in `test:stack`; the poll fallback; a `scheduler-tick` logic test that no WhatsApp reminder is enqueued; the D16 key audit (no caller reuses a key it needs again).
- **Done when:** the tests pass in CI; the W1-08 `e2e:supabase` invite test stays green with the CI worker woken by NOTIFY; _(by hand)_ on a local stack, `pnpm dev:worker` wakes on NOTIFY and sends the welcome text to the Demo phone.
- **Needs:** nothing.

### W1-11 · Transcription (Deepgram)

- [ ] **W1-11 done** · today _conflicts_ (M) · step 16
- **Spec:** §10.2, §5.2.
- **Already in the repo:** a result shape with segments (`apps/worker/src/ai/transcribe.ts:26-34`), a tested OpenAI implementation (it becomes the fallback), vocabulary hints from site, companies, aliases and the top-50 glossary (`:58-79`), splitting above 15 min, latency and audio-seconds metrics (`apps/worker/src/runner.ts:62`, `:78-95`), a signed-URL helper (`apps/worker/src/storage.ts:57`), ffmpeg peaks (`apps/worker/src/media/ffmpeg.ts`).
- **Build (this repo):**
  - [ ] A `Transcriber` interface → `{ text, language, segments[{start,end,text}], durationS, model }`. Deepgram `nova-3` is the default (`smart_format`, `utterances`, word timestamps; `multi` for EN/ES reporters, `tr` for Turkish, else `en`; key terms including areas); OpenAI sits behind the same interface. Config `TRANSCRIBE_PROVIDER`, `DEEPGRAM_API_KEY`; `TRANSCRIBE_MODEL=nova-3` in `.env.example`.
  - [ ] `transcribe_upload(upload_id)`: signed download (browser webm/mp4 sent as is) → `transcripts(upload_id)` → about 600 peaks and the duration into `uploads` → `extract_report` (dedupe per report and latest upload). The WhatsApp `transcribe_audio` path stays until step 22.
  - [ ] A fake transcriber that returns the fixture transcript, for tests and keyless development (also the default for the CI worker in `e2e-supabase`).
  - [ ] The worker integration harness (`apps/worker/src/integration/`) gets a field-upload entry point (an `uploads` row, then `transcribe_upload`) beside its WhatsApp webhook replay; W1-12 and W1-15 build on it.
  - [ ] `fixtures/voice/`: EN; ES + EN with a crew whose headcount is unclear (the hero's Delta, D27); TR. Recorded or TTS, with expected transcripts. Replace the WhatsApp `.ogg` README.
- **Tests:** Deepgram request and response mapping with mocked HTTP; language choice; `transcribe_upload` with the fake on PGlite (the worker integration harness, `apps/worker/src/integration/`); the peak count.
- **Done when:** in CI, a fixture upload produces a transcript with segments and peaks in the database through the fake provider, and latency and audio seconds are logged; _(by hand, with the key)_ the same fixture through Deepgram.
- **Needs:** `DEEPGRAM_API_KEY` (fake without it); `OPENAI_API_KEY` optional.

### W1-12 · Extraction, validation, questions, weather

- [ ] **W1-12 done** · today _conflicts_ (L) · step 17
- **Spec:** §10.3–§10.5, §10.10–§10.12.
- **Already in the repo:** the `submit_daily_report` tool from Zod, prompt caching, one retry with Zod issues (`apps/worker/src/ai/extract.ts:47-62`, `apps/worker/src/ai/claude.ts:224-245`); totals recomputed, required fields, confidence < 0.7, question priority and max (`packages/shared/src/report/validate.ts`); agent versions and one open question at a time; `fetch_weather` from Open-Meteo; `pnpm eval` with 26 golden cases and `--recorded`.
- **Moved in:** channel-neutral options and `applyAnswer(Source)` (from W1-13); the `field-api` `reports/:id/answer` route (from W1-07).
- **Build (this repo):**
  - [ ] D24: system prompt v2 verbatim in `apps/worker/src/ai/prompts/extract.v2.md`; the source-format note as a separate cached block (recorded); the extra weather sentence only if it is added to spec §10.4 first.
  - [ ] User message with `REPORT_LANGUAGE`, `UNITS`, `REPORTER_LOCALE`, `CHANNEL=web`, `WORKING_HOURS`, `DEFAULT_SHIFT_HOURS` and `OBSERVED_WEATHER` in org units (`packages/shared/src/weather/observed.ts:31-57`).
  - [ ] Phone numbers redacted from every user-message block before Claude (`CLAUDE.md` rule; open finding `docs/AUDIT_BACKLOG.md:276`).
  - [ ] D23: the model comes from `CLAUDE_MODEL` (`claude-sonnet-5-5`); its profile keeps `tool_choice: auto` with verify and re-prompt; record the deviation in README and spec §19.
  - [ ] `schemaVersion 2` writers everywhere: the worker (`apps/worker/src/ai/extract.ts:141`), a migration replacing `create_office_report` (it stamps v1 in SQL, `20261013000005_office_photos.sql:203`), and the panel editor.
  - [ ] Questions: `questions.channel 'web'`; options `[{id,label}]` with _Other…_ hidden until M6; `applyAnswer` takes a `Source` (`{type:'answer', questionId}`), with every caller updated; D28: a question with no options asks for a number, so code never proposes numbers; fallback question prompts in EN/ES/TR (`packages/shared/src/report/validate.ts:247-284`).
  - [ ] `field-api` `reports/:id/answer`: scoped like the other routes, checks that the question is open and belongs to the report, maps the option or number in code with `parseQuickAnswer`/`applyAnswer` from `@sitelog/shared`, updates the draft and the question (`answer`, `answer_source`, `answered_at`) as the WhatsApp question handler does (`apps/worker/src/router/handlers/question.ts:168-190`), audits, and enqueues `decide_next`. Deno and stack tests as in W1-07.
  - [ ] `decide_next` split into pure state changes and a `Notifier` call: `send_sms(question_ready | draft_ready)` only if the reporter's device was not seen in the last 30 s (D25; add it to the spec).
  - [ ] Eval: fixtures re-keyed (`messageId` → `uploadId`, `schemaVersion 2`), Turkish cases, a report-language check, regenerated recorded outputs; the load-test target becomes 60 s (`apps/worker/src/integration/loadtest.ts:1-3`).
- **Tests:** the user-message builder, redaction, options and `applyAnswer`, the 30 s rule and units as unit tests; the recorded golden set (`apps/worker/src/ai/eval.test.ts`); an integration test on PGlite (`apps/worker/src/integration/`): the ES + EN voice fixture → fake transcriber → recorded tool output → draft.
- **Done when:** in CI, the recorded golden set is green and the ES + EN fixture yields a draft and exactly one question, the headcount one ("Delta — 4 or 5?", D27), with no SMS sent while the device was seen in the last 30 s; _(by hand, with keys)_ `pnpm eval` is green (or a dispatched CI `eval` run) and the same fixture through Deepgram and Claude logs ≤ 60 s p50 from upload to draft on a dev machine.
- **Needs:** `ANTHROPIC_API_KEY` (recorded outputs without it); `DEEPGRAM_API_KEY` for the live timing (fake transcriber without it).

### W1-13 · Field screens: Question → Draft → Confirm

- [ ] **W1-13 done** · today _conflicts_ (M) · step 18 (second half)
- **Spec:** §9.3, F7 (buttons only), F8. **Design:** `Field-05-Question`, `Field-06-Draft`.
- **Already in the repo:** code-only answer mapping (5 × 8 h = 40 h, `packages/shared/src/report/validate.ts:361`, `:481-488`), re-keyed in W1-12; the idempotent `file_report` job (`apps/worker/src/jobs/file_report.ts`); the `confirm` route (W1-07) and the `answer` route (W1-12).
- **Build (this repo):**
  - [ ] Question: one per screen, ≤ 2 option buttons ≥ 56 px; a number input with "full day" as the default hours for questions without options (D28); _Other…_ hidden until M6; after an answer, the F7 confirmation line, then the next question or the draft.
  - [ ] Draft: sections with numbers per the artboard; steppers shown read-only (editing comes in M6); a sticky **Confirm & send** → `confirm`.
  - [ ] Processing between answer and draft reuses the W1-09 poll; EN/ES/TR copy; 390 px.
- **Tests:** component tests for both screens; the field `e2e:supabase` Playwright flow (W1-09) from a seeded open question, with the CI worker running `decide_next`: answer → draft → Confirm & send enqueues `file_report`.
- **Done when:** the Playwright flow passes in CI; _(owner)_ on a phone through the preview, with the worker running against the preview project: record → answer "5 · full day" → the draft shows the crew with 40 h → Confirm & send moves the report to filing.
- **Needs:** the W1-12 keys for the live run (recorded outputs and the fake transcriber in CI); _(owner-approved)_ the worker on the developer machine against the preview project; a real phone.

## M4 · PDF & email

### W1-14 · PDF daily report

- [ ] **W1-14 done** · today _partial_ (M) · step 19 (PDF part)
- **Spec:** §12, §10.10. **Design:** `Report-P1`, `Report-P2`.
- **Already in the repo:** `ReportDocument` in `packages/pdf` (two pages, sections 01–09, letterhead, running header), used by the worker and the browser; static TTFs that carry ğ ş ı İ (`packages/pdf/src/fonts.ts:13-24`); Letter or A4; ≤ 4 photos; Page x of y and the Open-Meteo attribution; `render_pdf` → `pdfs` → `report_versions.pdf_path` with dedupe (`apps/worker/src/jobs/render_pdf.ts:13-35`); a hero sample render (`apps/worker/src/pdf/render-sample.ts`).
- **Moved out to W1-15:** removing WhatsApp delivery from `render_pdf`.
- **Build (this repo):**
  - [ ] D34: EN/TR labels and badge, dates in the report language (`packages/pdf/src/ReportDocument.tsx:25-30`, `:141-153`, `packages/pdf/src/components.tsx:128-135`, `:176-182`). Metric weather waits for M11.
  - [ ] v1.2 copy for the footer, source record, sign-off and footnotes, driven by `reports.channel` and `confirmed_via` instead of WhatsApp (`components.tsx:352-354`, `ReportDocument.tsx:45`, `:79`, `:238`).
  - [ ] D32: paper from the org country (Letter US, A4 TR), with `org_settings.pdf_paper` as an explicit override (`apps/worker/src/pdf/render.ts:217-221`); README deviation row.
  - [ ] Letterhead tax line from `orgs.tax_no`; the kit mark in the footer instead of the 9 × 9 box (`packages/pdf/src/styles.ts:145`).
  - [ ] D33: keep the storage object `{report_no}_v{n}.pdf`; serve downloads, attachments and zip entries as `{report_no}_{YYYY-MM-DD}_v{version}.pdf` (`apps/web/src/lib/pdfZip.ts:33` and the panel download).
  - [ ] A Turkish sample render (Demir Yapı) beside the hero sample.
  - [ ] Optional (GAP step 19): re-render on sign-off so "Signed off in SiteLog by {name}" reaches the stored PDF (`docs/AUDIT_BACKLOG.md:388`). If it is not done here, the finding stays open in the backlog with a note; it does not block the demo.
- **Tests:** the first tests in `packages/pdf` (labels by locale, paper by country, file names); a glyph test that the Turkish sample's text contains ğ ş ı İ; v1 and v2 versions render; the worker smoke tests.
- **Done when:** the tests pass in CI; _(by hand)_ the hero sample render matches `Report-P1` and `Report-P2` in structure and copy, and the Turkish sample shows ğ ş ı İ correctly (both renders attached to PR #1).
- **Needs:** nothing.

### W1-15 · Filing, SMS and email

- [ ] **W1-15 done** · today _conflicts_ (L) · step 19 (filing part)
- **Spec:** §10.1 `file_report`, §13, F8. **Design:** `Field-07-Filed`.
- **Already in the repo:** `fileReport` freezes the version, runs `denormalize_report_version`, sets `filed_at`, `confirmed_at`, `is_late`, review reasons and the site-day status, writes audit rows and enqueues `render_pdf` (`apps/worker/src/pipeline/file.ts:87-151`); a second call is a no-op; email by Resend or console with the PDF under the §12 name and the §13 EN subject (`apps/worker/src/jobs/send_email.ts:55-102`).
- **Moved in from W1-14:** WhatsApp delivery out of `render_pdf`.
- **Build (this repo):**
  - [ ] `file_report(report_id, via)`; the `confirm` route passes `via: 'web'`; `reports.confirmed_via`. `confirmMessageId` stays optional for the WhatsApp path until step 22.
  - [ ] Remove WhatsApp delivery from filing (conversation reset and "Filed.", `apps/worker/src/pipeline/file.ts:153-178`) and from `render_pdf` (`apps/worker/src/jobs/render_pdf.ts:41-67`, `sendToWhatsApp`, `notifyReporter`; the payload schema still accepts and ignores both flags, `packages/shared/src/schemas/jobs.ts:28-31`, so queued jobs parse); a migration drops `notifyReporter` from `create_report_version`, which ends the office-edit notice (D31).
  - [ ] In its place, `send_sms(filed)` keyed `filed:{report_id}` through the `Notifier`, with the Filed-screen link `/r/{personal code}/report/{id}` (opens the PDF through a fresh signed URL), then `send_email` with the TR subject and body per §13 and a footer without WhatsApp (`apps/worker/src/email/templates.ts:69`).
  - [ ] Retry-safe post-filing steps: a failure after `status = filed` can no longer skip the PDF, the text or the email (`docs/AUDIT_BACKLOG.md:563-568`, `file.ts:50-52`; relies on D16).
  - [ ] The Filed screen per the artboard (report no., PDF, Add photos, Past reports, edit hint) in EN/ES/TR.
- **Moved out:** `denormalize_report_version` reading v2 sources lands in W1-05 (step 10).
- **Tests:** a filing pipeline test (PGlite integration harness) with one PDF, one `filed` text and one email even when each job is retried; a field `e2e:supabase` step: Confirm & send → the `filed` text and the console email appear in the Demo phone; a Filed screen component test.
- **Done when:** both tests pass in CI (once each even when jobs are retried); _(owner)_ the same from a phone through the preview, with the worker running against the preview project.
- **Needs:** `RESEND_API_KEY` for real email (console and the Demo phone _Email_ tab otherwise); the W1-13 owner setup for the phone check.

## M5 · Panel core → demo

### W1-16 · Overview (realtime)

- [ ] **W1-16 done** · today _partial_ (M) · step 20 (Overview)
- **Spec:** P3, §7.1 chips, §11.3, F17. **Design:** `Web-Overview`.
- **Already in the repo:** KPI tiles; Sites today with chip, Late, In at, crew, hours and weather; Needs attention in F17 order; actions Call, Mark no work, Review report, Compare hours; realtime invalidation; an e2e test that flips a row after a server-side update (`apps/web/src/app/overview/Page.tsx`, `apps/web/src/data/assemble.ts:783-790`, `apps/web/e2e/supabase/panel.spec.ts:44-80`).
- **Build (this repo):**
  - [ ] A channel column and a reusable channel icon (D35: the artboard has none; note it in the ticket report).
  - [ ] _Text today's link_: a daily `field_links` row and `send_sms(daily_link)`, role-checked and audited (W1-18 reuses the action).
  - [ ] Needs attention: undeliverable texts; unknown callers and texters from `unknown_contacts` with the existing link and ignore flow; a new `api-link-unknown-contact` (D38: deploy new, switch the caller `apps/web/src/data/supabase/SupabaseSource.ts:1519`; the old function is deleted after the demo); copy for the `call_mismatch` and `no_photo` reasons (`assemble.ts:515-531`).
  - [ ] Replace the "Try it on WhatsApp" card with a Demo phone entry for `is_demo` orgs (D29, `Page.tsx:232-248`).
  - [ ] TR copy for the Overview.
- **Tests:** unit tests for the new rows and reasons; e2e at 1440 and 390 px (screenshots move from 375 px); `e2e:supabase` flips a row after server-side filing.
- **Done when:** the e2e flip and the 390 px no-sideways-scroll test pass in CI; _(by hand)_ the seeded org matches the artboard (plus the channel column) at 1440 and 390 px; _(owner)_ filing from a phone flips the row to _Filed_ within about 2 s on the preview, without a reload.
- **Needs:** for the owner check, the preview project with the worker running against it (W1-13 setup).

### W1-17 · Reports archive and Report review

- [ ] **W1-17 done** · today _partial_ (M) · step 20 (Reports)
- **Spec:** P6, P7, §2.2, §10.3 sources. **Design:** `Web-Reports`, `Web-Report`.
- **Already in the repo:** an archive with URL filters, flags, PDF column and zip; review with version switcher, provenance, clickable sources that seek the player, signed-URL audio with peaks, excerpts and transcript drawer, activity timeline, review-reasons banner, PDF, Sign off with undo (`apps/web/src/app/reports/Page.tsx`, `apps/web/src/app/report/`, `apps/web/e2e/supabase/panel.spec.ts:131-156`).
- **Build (this repo):**
  - [ ] Archive: Channel filter and the W1-16 icon (D35); the No-photo flag (`apps/web/src/data/types.ts:281-296`).
  - [ ] Loaders read audio, peaks and sources from uploads, questions and calls, falling back to `messages` for WhatsApp-era reports (`assemble.ts:1396-1397`, `:1530-1540`); `voice_note`, `call` and `answer` source links.
  - [ ] `VoicePlayer` → `MediaPlayer` on `uploads.peaks` for every clip, at 1× and 1.5×.
  - [ ] The v1.2 provenance line (P7 examples) and a timeline of field events (audit, SMS, calls) instead of WhatsApp bubbles (`apps/web/src/copy/en.ts:630-631`, `:762-768`, `assemble.ts:1450-1456`); the language line from the org (`apps/web/src/app/report/SourcePanel.tsx:33-38`).
  - [ ] TR copy for both pages.
- **Tests:** unit tests for loaders and provenance; seek-to-timestamp; `e2e:supabase` asserts the sign-off audit row.
- **Done when:** demo steps 6–7 pass in `e2e:supabase` (clicking the rain stoppage plays from its timestamp; sign-off shows _Signed off_ and writes the audit row); both pages pass axe and the no-sideways-scroll test at 1440 and 390 px in CI, and _(by hand)_ match the artboards.
- **Needs:** nothing.

### W1-18 · Sites and Site detail

- [ ] **W1-18 done** · today _partial_ (M) · step 20 (Sites)
- **Spec:** P4, P5. **Design:** `Web-Sites`, `Web-Site`.
- **Already in the repo:** site cards with chip, 14-day streak, reporter with `tel:` phone, crew today and weather days; the dashed "Connect another site" card ($399, as on the US artboard); Site detail calendar, latest report, "This month so far", crew-by-company table, and the Crew, Weather and Photos tabs (`apps/web/src/app/sites/Page.tsx`, `apps/web/src/app/site/Page.tsx`).
- **Build (this repo):**
  - [ ] The preference icon and "Prefers text link" or call (`reporters.contact_pref`); the subtitle "by text link or call" (`apps/web/src/copy/en.ts:415`).
  - [ ] Site detail header actions _Text today's link_ · _Call {first}_ · _Site settings_, replacing the `wa.me` button (`apps/web/src/app/site/Page.tsx:82`, `:112-135`); _New report_ stays (D30).
  - [ ] Calendar channel dots (`apps/web/src/components/sitelog/CalendarMonth.tsx:30`); the "CONFIRMED BY ANSWER" badge (`assemble.ts:930-943`).
  - [ ] TR copy for both pages.
- **Tests:** unit tests; e2e and axe at 1440 and 390 px; committed screenshots at both widths.
- **Done when:** the tests pass in CI; _(by hand)_ both pages match the artboards at 1440 and 390 px with seeded data, for the US org and, in TR, for the TR org, except the TR price line, which waits for the owner's answer.
- **Needs:** owner: the TR price for the "Connect another site" card (spec §19 #9 is open). Ask before building a non-US price.

### W1-19 · Cut-over and dress rehearsal

- [ ] **W1-19 done** · today _partial_ (M) · step 21 (every remote action owner-approved)
- **Spec:** §5.2 demo setup, §16.2 M5 demo script.
- **Already in the repo:** automated `db push`, `functions deploy` and panel deploy (`.github/workflows/deploy.yml`, job `supabase` steps "Push migrations" and "Deploy edge functions", job `web` step "Deploy"); the guard and preview support (W1-01) and the field job (W1-04); RUNBOOK §2. A Fly.io worker job is scripted but unused.
- **Moved out:** deploy safety and the read-only inventory to W1-01, field hosting to W1-04, stopping the WhatsApp ladder to W1-10. The backup stays here. Taking the WhatsApp config out of `deploy.yml` and the RUNBOOK waits for step 22.
- **Build (this repo):**
  - [ ] `docs/DEMO_NOTES.md` (URLs, demo logins, how to reset, known gaps) and RUNBOOK updates for the v1.2 deploy.
- **Cut-over, in this order, each step owner-approved:**
  - [ ] Re-run the step-0 inventory (Deploy from `spec-v1.2`, target `inventory`) and take the backup right before the first `db push`: a `pg_dump` of the GAP §4.1 stage 1 tables and a copy of the `audio`/`photos` buckets, stored where the owner chooses (it holds personal data; the free tier has no point-in-time recovery). Confirm the D19 branch chosen in W1-05 still holds (no new real `verified` reporters since W1-01).
  - [ ] Discard the queued WhatsApp-era backlog (mark it `failed` with a `last_error`, `docs/RUNBOOK.md` §2 "Before the worker runs").
  - [ ] Secrets and settings: `LINK_SIGNING_SECRET`, `FIELD_APP_URL`, `APP_URL`, `CORS_EXTRA_ORIGINS`, SMS drivers (`console`), `DEEPGRAM_API_KEY`, `STRIPE_PRICE_ID_SITE_US`; Supabase Auth site and redirect URLs for the panel.
  - [ ] Merge `spec-v1.2` into `claude/focused-newton-5v0u2q`; dispatch Deploy (db push → functions → web and field `--prod`).
  - [ ] `pnpm seed:demo --date today` in apply mode on the `is_demo` orgs.
  - [ ] The worker on the developer machine against the hosted database (GAP §8 Q9).
- **Tests:** smoke checks after the deploy: the panel signs in, `/api/resolve` on the field site answers through the proxy with `no-store`, and the W1-07 cookie probe if it waited for this step.
- **Done when:** _(owner)_ the demo script below passes twice in a row on a real phone against the hosted staging stack.
- **Needs:** owner approval for every remote step; Anthropic and Deepgram keys (Resend optional); a real phone.

---

## After the demo (not week-1 tickets)

**Step 22 · Retire WhatsApp.** GAP §4 and §4.1 stages 5–7, in code order, with `pnpm check`, `pnpm test:db`, Deno check and e2e green at every commit:

- Web: `/try` and its demo store and tests (D29), `VITE_WA_DISPLAY_NUMBER`, remaining `wa.me` and unknown-sender UI, the Setup WhatsApp welcome preview.
- Worker: rewrite the integration harness first, then remove `router/`, `wa/`, the jobs `inbound_message`, `parse_reply`, `send_template` and the WhatsApp `transcribe_audio` path, and `COST_WA_TEMPLATE_USD` (D45). Extract what the GAP lists as reusable first (day off, edit after filing, intake merge rules, the timeout sweep).
- Edge: `whatsapp-webhook` with its config block, `_shared/conversations.ts`. Shared: `wa/*`, `webhook/meta.ts`, `copy/whatsapp.ts`, WhatsApp `JOB_TYPES` once the queue is drained.
- Database: the D13 insert trigger that rejects a null `channel` on new `reports`, `questions` and `unknown_contacts` rows, once no WhatsApp writer remains.
- Fixtures (`fixtures/webhooks/`), env, CI dummies, the WhatsApp lines of `deploy.yml` (`VITE_WA_DISPLAY_NUMBER`), README, RUNBOOK, `apps/*/README.md`, the _(current)_ notes in `CLAUDE.md`, obsolete `docs/AUDIT_BACKLOG.md` items.
- Then one owner-approved step each: turn off any Meta subscription, `supabase functions delete whatsapp-webhook` (later `api-link-unknown-sender`, D38), unset `WA_*` secrets, delete `VITE_WA_DISPLAY_NUMBER`. Deprecate for one release: revoke client `select` on legacy tables, take `unknown_senders` leftovers out of realtime, comment the tables.

**Step 23 · Contract (a later release).** After a fresh dump and at least one stable release: drop legacy tables and columns (`conversations`, WhatsApp columns, `stripe_*`), recreate enum types to retire labels, move legacy `messages` rows to an archive and enforce the v1.2 `NOT NULL`s and a fresh `msg_status` (D15), replace the expand-phase `transcripts` check with the spec's exact XOR and type `report_sources.kind` as `source_kind`, unset `STRIPE_PRICE_ID_SITE`, clean the `_pending/` and `_unknown/` storage prefixes.

## Demo script (end of week 1)

Kestrel Build Group on the hosted staging stack, after `pnpm seed:demo --date today`.

1. The Overview shows the Kestrel sites, five awaiting today.
2. _Text today's link_ for Marco Ruiz (Riverside Lofts): the text appears in the Demo phone, or as a real SMS once Twilio is verified. Open the link on a real phone (first open: the device code also arrives there), record about 2 minutes in Spanish and English, add 2 photos.
3. One question appears ("Delta — 4 or 5?") → tap **5 · full day**.
4. Draft → **Confirm & send**.
5. The `filed` text with the PDF link arrives (Demo phone or SMS) and the email arrives (inbox with Resend, else the Demo phone _Email_ tab); the Overview row flips to **Filed** live.
6. Open the report in the panel, click the rain stoppage to hear it.
7. **Sign off**.
