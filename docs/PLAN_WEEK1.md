# SiteLog — Week 1 build plan (M0–M5 → live demo)

Goal: by the end of week 1, run the **demo script** (bottom of this file) end-to-end on a real phone: text link → record → one question → draft → confirm → PDF by SMS + email → the Overview flips to *Filed* live → open the report, play the audio, sign off.

Rules: `CLAUDE.md`. Spec: `docs/SITELOG_SPEC.md` (v1.2). Designs: `docs/design/`. One ticket at a time, in order; each ends with green `pnpm typecheck && pnpm lint && pnpm test`, a ticked box and a commit `W1-xx: …`.

**Not in week 1:** voice agent and Talk now (week 2, keep the button behind `VITE_FEATURE_TALK_NOW=false`), reminder ladder and `scheduler-tick` (M6), *Other…* answers and *Fix by voice* (M6), hours / weather / glossary / team / settings / billing pages (M9–M10), Turkish market polish (M11). Build the interfaces so these slot in.

**Keys the developer provides:** week-1 needs only a local Supabase (Docker), `ANTHROPIC_API_KEY` and `DEEPGRAM_API_KEY`. Email and SMS run on `console` drivers until `RESEND_API_KEY` / Twilio / İletimerkezi are ready. A ticket that hits a missing key builds the fake implementation, says so, and moves on.

| Day | Milestone | Tickets |
|---|---|---|
| 1 | M0 Foundations | W1-01 … W1-04 |
| 1–2 | M1 Data model & seed | W1-05, W1-06 |
| 2–3 | M2 Field app + SMS | W1-07 … W1-09 |
| 3–4 | M3 Pipeline v1 | W1-10 … W1-13 |
| 4–5 | M4 PDF & email | W1-14, W1-15 |
| 5–7 | M5 Panel core → demo | W1-16 … W1-19 |

---

## M0 · Foundations

### [ ] W1-01 · Monorepo and tooling
- **Spec:** §5, Appendix A, Appendix D.
- **Build:** pnpm workspaces (`apps/*`, `packages/*`), Node 20 (`.nvmrc`), TypeScript 5 strict base `tsconfig`, ESLint (flat config) + Prettier, Vitest workspace, root scripts `dev · build · typecheck · lint · test · format · seed:demo`, `.gitignore`, `README.md` quickstart, GitHub Actions CI (install → typecheck → lint → test). Put `docs/SITELOG_SPEC.md`, `docs/PLAN_WEEK1.md`, `docs/design/*`, `.env.example`, and the brand SVGs in `apps/web/public/brand/` + `apps/field/public/brand/`.
- **Done when:** fresh clone → `pnpm i && pnpm typecheck && pnpm lint && pnpm test` is green locally and in CI.

### [ ] W1-02 · `packages/shared`
- **Spec:** §4.5, §6.2, §9.2, §10.3, §14.1, Conventions.
- **Build:**
  - `enums.ts` — every enum in §6.2 as zod enums + TS types.
  - `report.ts` — zod `DailyReportData` (schemaVersion 2) and `Source`, exactly as §10.3; `computeTotals()` (workers × hoursPerWorker, sums; never trust model totals).
  - `copy/sms.{en,es,tr}.ts` — every key in §9.2; `renderSms(key, locale, vars, { hasVoiceNumber })` drops the "or call {number}" clauses when there is no number (§9.2 note).
  - `sms/segments.ts` — GSM-7 vs UCS-2 segment counter (Turkish ğ ş ı İ force UCS-2 unless the provider supports the Turkish shift table; return both counts).
  - `channels.ts` — `Notifier`, `SmsTransport`, `SmsDriver` (§4.5).
  - `format.ts` — E.164 parse/format (`libphonenumber-js`), report number `RL-2041-0187`, hours/units formatting per locale.
  - `tokens.ts` + `tokens.css` (§14.1) and the Tailwind preset (§14.4) exported for both apps.
  - `copy/ui.{en,tr,es}.json` — i18next resource skeleton with namespaces `common`, `panel`, `field`.
- **Tests:** totals math, report numbering, `renderSms` with/without number in EN/ES/TR, segment counts with Turkish text, zod round-trip of the hero report (§18.1) as a fixture.
- **Done when:** tests green; both apps can import `@sitelog/shared`.

### [ ] W1-03 · Panel shell and sign-in
- **Spec:** §11.1, §11.2, §11.5, F1, P1, §14. **Design:** `Web-Login`, `Web-Overview` (sidebar + top bar only).
- **Build:** Vite + React 18 + TS, Tailwind with the shared preset, Google Fonts (Archivo with width axis, IBM Plex Mono), shadcn/ui restyled (Button primary/secondary/ghost/destructive per §14.3, Input, Dialog, Table, Tabs, Badge → status chips), lucide icons at stroke 2, React Router with every route in §11.1 as placeholder pages, app shell (sidebar, org name, user menu, footer "Agent ready · texts & calls"), TanStack Query, i18next EN/TR with a language switch that keeps the route, Supabase magic-link sign-in (P1 layout) + `/auth/callback` (member → `/`, none → `/setup` placeholder), org switcher, role guard (§2.2), error boundary, optional Sentry.
- **Done when:** sign in with a magic link from the local mail catcher (`supabase status` shows its URL) → empty shell; layout correct at 1440 and 390 px; EN ⇄ TR switch works.

### [ ] W1-04 · Field app shell (PWA)
- **Spec:** §9.3, §14.6, §5 (field app row). **Design:** `Field-03-Today` (header), `Field-10-Today-TR`.
- **Build:** Vite + React PWA (`vite-plugin-pwa`), manifest (name "SiteLog", `display: standalone`, theme `#16181B`, icons 192/512 generated from `logo-app-icon.svg`), routes `/r/:code · /today · /record · /report/:id · /history · /settings · /expired` as placeholders, shared tokens, i18n EN/ES/TR, Vite dev proxy `/api/*` → `{SUPABASE_URL}/functions/v1/field-api/*` (spec §6.5), `--host` so phones on the LAN can open it. No web push.
- **Done when:** the shell loads on iOS Safari and Android Chrome from the LAN URL (or a tunnel) and can be added to the home screen.

## M1 · Data model & seed

### [ ] W1-05 · Database: migrations, RLS, RPCs, storage
- **Spec:** §6.2–§6.5, §2.2, §7.
- **Build:** `supabase init`; migrations `0001_enums`, `0002_tables` (DDL §6.3 **verbatim** — it is validated on Postgres 16, 30 tables incl. `rate_limits`), `0003_indexes_views` (§6.4), `0004_rls` (`is_member(org)`, `has_role(org, roles[])`, policies per the §2.2 matrix; field-side tables get **no** client policies), `0005_rpcs` (`next_report_no(site_id)` → `{project_code}-{seq:0000}` using `sites.report_seq` with row lock; `create_report_version`; `sign_off_report`; all `security definer`, role-checked, writing `audit_log`), `0006_jobs` (`enqueue_job(type, payload, dedupe_key)` with `on conflict (dedupe_key) do nothing` + `pg_notify('jobs')`), `0007_storage` (private buckets `audio`, `photos`, `calls`, `pdfs`, `exports`), realtime publication for `site_days`, `reports`, `messages`.
- **Tests:** two orgs × each role: can/can't read and write per §2.2; the anon key reads nothing field-side; `next_report_no` is gap-free under concurrency.
- **Done when:** `supabase db reset` is clean and the RLS suite passes.

### [ ] W1-06 · Seed data and types
- **Spec:** §18.1, §18.2.
- **Build:** `scripts/seed-demo.ts` (service role; idempotent) creating both demo orgs with `is_demo = true`, office users (dev emails, e.g. `lena@kestrel.test` admin, `sam@kestrel.test` pm, `accounts@kestrel.test`), org settings, sites, reporters with preferences, site_reporters, recipients, companies + aliases, glossary, the Oct 9 states (filed / awaiting / needs review / weather day / missing) and the hero report RL-2041-0187 with v1 and v2 `DailyReportData`. Flag `--date today` shifts the Oct 9 day to today so the Overview looks live during demos. `supabase gen types` → `packages/shared/src/db.types.ts`.
- **Done when:** `pnpm seed:demo` twice in a row gives the same data; Lena signs in and the shell shows "Kestrel Build Group".

## M2 · Field app + SMS

### [ ] W1-07 · `field-api` Edge Function
- **Spec:** §6.5, Appendix B (field routes), F4, F5, §7.1–§7.2.
- **Build:** Deno + Hono router. Auth = link code (sha256 → `field_links`, not revoked/expired) + device cookie `sl_dev` (httpOnly, Secure, SameSite=Lax, 180 d → `field_devices.verified_at`); scope every query to the reporter's sites; rate limits (30/min/device, 5 code sends/h/phone). Routes: `resolve`, `device/send-code` (6 digits, hashed, 10 min) + `device/verify`, `consent` (consents with `text_version`, `contact_pref`, locale → reporter `active`), `today`, `uploads` (signed upload URL 10 min, path `{org}/{site}/{date}/{uuid}.{ext}`, `uploads` row) + `uploads/:id/complete` (creates `site_days`/`reports` on first upload with `next_report_no`, status → `processing`, enqueues `transcribe_upload`), `reports/:id` (question/draft/filed view model), `reports/:id/answer`, `reports/:id/confirm`, `day-status`, `history`, `preferences`. Every state change → `audit_log`. Record `field_devices.last_seen_at` on each call (the worker uses it to skip SMS while the recorder is open).
- **Tests:** expired/revoked link, unverified device, cross-reporter access denied, happy path resolve → verify → upload → complete creates report + job.
- **Done when:** the tests pass against local Supabase.

### [ ] W1-08 · SMS layer, invite and Demo phone
- **Spec:** §4.5, §9.2, F3, §11.1 (`/dev/phone`), §5.2.
- **Build:** `SmsTransport` drivers — `console` (writes `messages`, status `delivered`), `twilio` (REST + status callback), `iletimerkezi` (REST, one-way); driver per org country from env, `is_demo` orgs always `console`. Worker job handlers come in W1-10; here build the send function + `messages` logging so W1-10 just wires it. `api-invite-reporter` (name, mobile, role, sites, locale, contactPref → reporter `invited`, personal `field_links`, `send_welcome` job). `sms-webhook` (Twilio signature check, STOP/HELP/START/CALL/TEXT) with `scripts/replay-webhook.ts`. Panel **Demo phone** `/dev/phone`: reporter list → thread (realtime on `messages`), links open the field app in a 390 × 844 frame or a new tab, reply box goes through the same handler as `sms-webhook`, *Email* tab for console emails.
- **Done when:** inviting Marco shows the welcome text in the Demo phone with a working personal link; Twilio driver and webhook have unit tests with mocked HTTP.

### [ ] W1-09 · Field screens: device check → Today → Recording
- **Spec:** §9.3, §14.6, F4, F5. **Design:** `Field-01-SMS`, `Field-02-Welcome`, `Field-03-Today`, `Field-04-Recording`, `Field-10-Today-TR`.
- **Build:** `/r/:code` resolve → device check ("Is this Marco Ruiz's phone?", code via SMS → Demo phone, `autocomplete="one-time-code"`) → Welcome & consent (first open) → Today (status, prompts, Record ≥ 120 px, Add photos, No work / Weather buttons wired to `day-status`, Talk now behind the feature flag, *Call {number}* only if the country has one) → Recording (`MediaRecorder` mime detection: `audio/webm;codecs=opus` or `audio/mp4`; timer, level meter via `AnalyserNode`, Screen Wake Lock, pause/resume, Stop & send, photo capture) → Processing (poll `GET /reports/:id` every 2 s; no DB session in the field app). Offline: IndexedDB queue of blobs + metadata, retry with backoff, resumes after reload, offline banner with queued count.
- **Done when:** on a real iPhone (Safari) and Android phone (Chrome): record 2 min + 2 photos → files in Storage and `uploads` rows; in airplane mode the clip queues and uploads when back online.

## M3 · Pipeline v1

### [ ] W1-10 · Worker runtime
- **Spec:** §10.1, §15.1 (reliability).
- **Build:** `apps/worker` (Node 20, `tsx` in dev). Direct Postgres via `SUPABASE_DB_URL`; claim with `update … where id in (select … for update skip locked limit n) returning *`; wake on `LISTEN jobs` + 5 s poll fallback; handler registry; backoff 30 s · 2 min · 10 min · 30 min · 2 h, `dead` after 5 with Sentry; stale-lock recovery (> 10 min); `/health`; graceful shutdown; `WORKER_CONCURRENCY`. Wire `send_sms` and `send_welcome` from W1-08.
- **Tests:** backoff schedule; 100 jobs processed exactly once with concurrency 4 against local DB; dedupe key prevents duplicates.
- **Done when:** tests pass; `pnpm --filter worker dev` processes the welcome job created in W1-08.

### [ ] W1-11 · Transcription (Deepgram)
- **Spec:** §10.2, §5.2. **Needs:** `DEEPGRAM_API_KEY`.
- **Build:** `Transcriber` interface → `{ text, language, segments[{start,end,text}], durationS, model }`; Deepgram pre-recorded `nova-3` with `smart_format`, `utterances`, word timestamps; language `multi` for EN/ES reporters, `tr` for Turkish, else `en`; key terms (company names + aliases, areas, top glossary terms) where supported. OpenAI fallback behind the same interface (stub + test is enough). Job `transcribe_upload`: signed download URL → transcript row → waveform peaks + duration with ffmpeg (≈ 600 peaks) into `uploads.peaks` → enqueue `extract_report` (dedupe per report + latest upload).
- **Fixtures:** `fixtures/voice/` — at least an EN note, an ES + EN mixed note with a crew whose hours are missing (like the hero report), and a TR note; record them or synthesise them with TTS; save expected transcripts.
- **Done when:** a fixture upload produces a transcript with segments and peaks in the DB; latency and audio seconds are logged.

### [ ] W1-12 · Extraction, validation, questions, weather
- **Spec:** §10.3–§10.5, §10.10–§10.12, §10.11. **Needs:** `ANTHROPIC_API_KEY`, `CLAUDE_MODEL`.
- **Build:** `submit_daily_report` tool from the zod schema (`zod-to-json-schema`), forced `tool_choice`, temperature 0; system prompt v2 **verbatim** in `apps/worker/src/ai/prompts/extract.v2.md`; user message with site context, companies + aliases, glossary, `OBSERVED_WEATHER`, `REPORT_LANGUAGE`, `UNITS`, `REPORTER_LOCALE`, `CHANNEL=web`, `WORKING_HOURS`, `DEFAULT_SHIFT_HOURS`; prompt caching on the system prompt + glossary block; zod validation with one retry. Code: recompute totals, required-field checks, low-confidence rules, question priority and max (§10.5) → `report_versions` v1 (author `agent`), `questions` (one active at a time), report status `awaiting_answer` or `awaiting_confirmation`. `decide_next` texts `question_ready` / `draft_ready` only if the reporter's device wasn't seen in the last 30 s. `fetch_weather` for the site-day (Open-Meteo hourly precipitation, temperature, wind, gusts in org units) → `site_days.weather`. `pnpm --filter worker eval` runs the fixtures against expected JSON (exact workers and hours, nothing invented, report language correct).
- **Done when:** the ES + EN fixture yields a draft plus exactly one question about the crew with missing hours, ≤ 60 s p50 from upload to draft on a dev machine; eval green.

### [ ] W1-13 · Field screens: Question → Draft → Confirm
- **Spec:** §9.3, F7 (buttons only), F8. **Design:** `Field-05-Question`, `Field-06-Draft`.
- **Build:** Question — one per screen, ≤ 2 option buttons from the question (≥ 56 px); button answers map to values in code (no LLM), source `{type:'answer'}`, re-validate, next question or draft. *Other…* hidden until M6. Draft — sections with numbers per the artboard; steppers shown but read-only this week (editing arrives with corrections in M6); sticky **Confirm & send** → `confirm` → `file_report` job.
- **Done when:** on a phone: answer "5 · full day" → draft shows the crew with 40 h → Confirm & send moves the report to filing.

## M4 · PDF & email

### [ ] W1-14 · PDF daily report
- **Spec:** §12, §10.10. **Design:** `Report-P1`, `Report-P2`.
- **Build:** `@react-pdf/renderer` `ReportDocument` in the worker; Letter for US, A4 for TR; embedded **static** TTF fonts (Archivo regular/semibold/bold/extrabold, an expanded cut for headings if available; IBM Plex Mono) — variable fonts are not reliable in react-pdf; all labels EN/TR; ≤ 4 photos; footer with mark, weather attribution, page x of y; file name `{report_no}_{YYYY-MM-DD}_v{version}.pdf`. Job `render_pdf` → `pdfs` bucket → `report_versions.pdf_path`. A script renders the hero report (v2) and a Turkish sample to `tmp/` for visual checks.
- **Done when:** the hero PDF matches the two artboards in structure and copy; the Turkish sample renders ğ ş ı İ correctly.

### [ ] W1-15 · Filing, SMS and email
- **Spec:** §10.1 `file_report`, §13, F8. **Design:** `Field-07-Filed`. **Needs:** `RESEND_API_KEY` (else console).
- **Build:** `file_report` — freeze the version, denormalise to `manpower_entries`, `weather_events`, `work_items`, `report_sources`; report `filed`, site-day `filed`, `is_late`, `confirmed_via`, audit. Then `render_pdf` → `send_sms(filed)` with a link to the Filed screen (`/r/{personal code}/report/{id}`, which opens the PDF through a fresh signed URL) → `send_email` (Resend, PDF attached, subject per §13; `console` driver shows it in the Demo phone *Email* tab). Filed screen per artboard (report no., PDF, Add photos, Past reports, edit hint).
- **Done when:** confirming the fixture report produces the PDF, the `filed` text in the Demo phone, and the email (inbox or console tab) — once each, even if the job is retried.

## M5 · Panel core → demo

### [ ] W1-16 · Overview (realtime)
- **Spec:** P3, §7.1 chips, §11.3. **Design:** `Web-Overview`.
- **Build:** KPIs, **Sites today** table (status chip, channel icon, in-at, crew, hours, weather), **Needs attention** (missing, needs review, unknown contact, undeliverable text), actions (*Text today's link* → `daily_link` SMS; *Call {first}* → `tel:`; *Mark no work* → RPC; *Review report*). Supabase realtime on `site_days` and `reports` for the org.
- **Done when:** the seeded org looks like the artboard at 1440 and 390 px; filing from a phone flips the row to *Filed* within ~2 s without a reload.

### [ ] W1-17 · Reports archive and Report review
- **Spec:** P6, P7, §2.2, §10.3 sources. **Design:** `Web-Reports`, `Web-Report`.
- **Build:** archive table with filters (site, status, channel, date range) and flags. Review page: header (report no., version switch v1/v2, status), provenance line, every number clickable → seeks the `MediaPlayer` to its source timestamp (audio via signed URL, waveform from `uploads.peaks`, 1× / 1.5×), excerpts + full-transcript drawer, activity timeline (`audit_log` + `messages`), review-reasons banner, Download PDF, **Sign off** via `sign_off_report` (pm/admin only).
- **Done when:** demo steps 6–7 work: clicking the rain stoppage plays from its timestamp; sign-off shows *Signed off* and writes the audit log.

### [ ] W1-18 · Sites and Site detail
- **Spec:** P4, P5. **Design:** `Web-Sites`, `Web-Site`.
- **Build:** site cards (chip, streak, reporter + phone + preference icon, crew today, weather days this month, dashed "Connect another site" card); Site detail header actions, *Daily reports* tab (calendar with channel dots, latest-report card, "This month so far", crew-by-company table with badges). Other tabs as placeholders.
- **Done when:** both pages match the artboards at 1440 and 390 px with seeded data.

### [ ] W1-19 · Demo deploy and dress rehearsal
- **Spec:** §5.2 demo setup, §16.2 M5 demo script.
- **Build:** hosted Supabase (free project): `supabase link`, `db push`, `functions deploy`, secrets. Panel and field app on a free static host with the `/api/*` rewrite to `field-api` (first-party cookie). Worker on the developer's machine against the hosted DB (or Fly.io). `pnpm seed:demo --date today`. Write `docs/DEMO_NOTES.md`: URLs, demo logins, how to reset, known gaps.
- **Done when:** the demo script below passes twice in a row on a real phone against the hosted stack.

---

## Demo script (end of week 1)

1. Overview shows the Kestrel sites, five awaiting today.
2. Marco's daily link appears in the Demo phone (or a real SMS); open it on a phone, record ~2 minutes in Spanish and English, add 2 photos.
3. One question appears ("Delta — 4 or 5?") → tap **5 · full day**.
4. Draft → **Confirm & send**.
5. The PDF link arrives (Demo phone or SMS) and by email; the Overview row flips to **Filed** live.
6. Open the report in the panel, click the rain stoppage to hear it.
7. **Sign off**.
