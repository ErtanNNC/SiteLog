# @sitelog/worker

The SiteLog job runner (`docs/SITELOG_SPEC.md` §4.2): pulls jobs from Postgres, downloads WhatsApp
media, converts OGG/Opus with ffmpeg, transcribes (OpenAI), extracts the report (Claude tool use),
drives the WhatsApp conversation state machine (§7.2), renders PDFs, sends email and weather jobs.

## Run locally

```bash
cp .env.example .env            # repo root; fill in SUPABASE_DB_URL at least
pnpm install
pnpm --filter @sitelog/worker dev          # tsx watch src/index.ts
curl localhost:8080/health                 # { ok, version, uptimeS, queue: { queued, running, dead } }
```

Useful one-offs:

```bash
pnpm --filter @sitelog/worker test               # vitest, no network, no API keys, < 60 s
pnpm --filter @sitelog/worker typecheck
pnpm --filter @sitelog/worker build              # tsup → dist/index.js (+ dist/fonts)
pnpm --filter @sitelog/worker render-sample-pdf  # tmp/*.pdf from the §18 hero report
pnpm eval                                        # §10.12 extraction eval (needs ANTHROPIC_API_KEY, else "skipped")
```

`ffmpeg` is resolved as `FFMPEG_PATH` → `ffmpeg-static` (if its binary downloaded) → `ffmpeg` on PATH.
The Dockerfile installs the Debian package and sets `FFMPEG_PATH`.

## Environment variables

| Variable                                                    | Default                                       | Used by                                                       |
| ----------------------------------------------------------- | --------------------------------------------- | ------------------------------------------------------------- |
| `SUPABASE_DB_URL`                                           | required                                      | job loop + repository (`postgres` client, service role)       |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`                 | ''                                            | Storage buckets `audio`, `photos`, `pdfs`, `exports`, `logos` |
| `WA_PHONE_NUMBER_ID`, `WA_ACCESS_TOKEN`, `WA_GRAPH_VERSION` | '', '', `v21.0`                               | WhatsApp Cloud API (send, media)                              |
| `OPENAI_API_KEY`, `TRANSCRIBE_MODEL`                        | '', `whisper-1`                               | transcription (`verbose_json` + segment timestamps)           |
| `ANTHROPIC_API_KEY`, `CLAUDE_MODEL`, `CLAUDE_MODEL_FAST`    | '', `claude-sonnet-5-5`, = `CLAUDE_MODEL`     | extraction / corrections / answers / classification           |
| `WEATHER_API_BASE`, `WEATHER_API_KEY`                       | Open-Meteo customer API, ''                   | `fetch_weather`                                               |
| `EMAIL_PROVIDER`, `RESEND_API_KEY`, `EMAIL_FROM`            | `resend`, '', `SiteLog <reports@sitelog.app>` | email (falls back to the `console` provider without a key)    |
| `APP_URL`                                                   | `https://app.sitelog.app`                     | links in emails                                               |
| `WORKER_CONCURRENCY`, `WORKER_PORT`, `WORKER_ID`            | 4, 8080, hostname-pid                         | runner + health server                                        |
| `JOB_TIMEOUT_MS`, `POLL_INTERVAL_MS`, `SWEEP_INTERVAL_MS`   | 300000, 1000, 60000                           | per-job timeout, claim polling, timeout sweep                 |
| `AUDIO_RETENTION_DAYS`                                      | 730                                           | `retention_cleanup`                                           |
| `SENTRY_DSN`, `LOG_LEVEL`, `NODE_ENV`                       | '', `info`, `development`                     | monitoring, JSON logs                                         |
| `FFMPEG_PATH`                                               | ''                                            | ffmpeg binary override                                        |
| `WORKER_DRY_RUN`                                            | false                                         | in-memory storage (tests)                                     |

Secrets that are only needed by some jobs default to empty so the worker boots in a partial
environment; the job that needs a missing secret fails with a clear message (and retries).

## Job types (§10.1)

| Job                              | Payload                                                                                | What it does                                                                                                                                                                                                                                                                                                            |
| -------------------------------- | -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `inbound_message`                | `{ messageId }`                                                                        | Routes one inbound message through the §7.2 state machine (`src/router`). Downloads + stores media immediately, measures duration and waveform `peaks` (stored in `messages.payload.peaks` for the web VoicePlayer).                                                                                                    |
| `transcribe_audio`               | `{ messageId, reportId?, testMode? }`                                                  | OGG → mono 16 kHz MP3 → OpenAI `verbose_json` with segments (chunks > 15 min into ≤ 10-min pieces with offsets). Then: test-note echo, `extract_report`, or `parse_reply`. Short intake transcripts that are really commands ("rained out at 11") void the report and run the command.                                  |
| `extract_report`                 | `{ reportId }`                                                                         | Composes the §10.4 prompt (all audio/text sources, previous answers, previous draft, photos, observed weather), calls `submit_daily_report`, post-processes (totals, companies, observed weather, photos), stores the draft version, learns glossary terms, then `decide_next`. Re-runs when sources arrived meanwhile. |
| `decide_next`                    | `{ reportId }`                                                                         | Validation (§10.5) → one question (`awaiting_answer`) or the draft card (`awaiting_confirmation`); weather-day / no-work reports file directly.                                                                                                                                                                         |
| `parse_reply`                    | `{ messageId, reportId }`                                                              | Voice replies: classify (§10.8) → answer / fix / confirm / edit / day-off / more content.                                                                                                                                                                                                                               |
| `file_report`                    | `{ reportId, trigger, confirmMessageId? }`                                             | Freeze the version, `denormalize_report_version`, `filed_at` / `confirmed_at` / `is_late`, site-day `filed`, review reasons + `notify_org('needs_review')`, enqueue `render_pdf`, send "Filed."                                                                                                                         |
| `render_pdf`                     | `{ reportId, version, sendToWhatsApp, emailRecipients, changeNote?, notifyReporter? }` | `@react-pdf/renderer` → `pdfs/{org}/{site}/{report_no}_v{n}.pdf`; WhatsApp document + edit hint; enqueues `report_filed` / `report_updated` email; `notifyReporter` sends the office-edit template.                                                                                                                     |
| `send_email`                     | `{ kind, … }`                                                                          | `report_filed`, `report_updated`, `report_missing`, `invoice_query`, `evidence_pack_ready`, `weekly_digest`, `unknown_sender`, `report_edited_after_signoff`.                                                                                                                                                           |
| `fetch_weather`                  | `{ siteId, date }`                                                                     | Open-Meteo hourly → `site_days.weather` (shared `summarizeHourly`).                                                                                                                                                                                                                                                     |
| `send_welcome`                   | `{ reporterId, siteId?, reinvite }`                                                    | `sitelog_welcome` / `sitelog_reinvite` template; conversation → `welcome_sent`. 4xx from Meta (number not on WhatsApp) is recorded on the reporter and not retried.                                                                                                                                                     |
| `send_template` / `send_message` | see shared `JobPayloadSchemas`                                                         | Scheduler-initiated templates (free-form inside the 24 h window) / free-form text.                                                                                                                                                                                                                                      |
| `build_evidence_pack`            | `{ packId }`                                                                           | §F16 PDF → `exports` bucket → pack `ready` + email + notification.                                                                                                                                                                                                                                                      |
| `retention_cleanup`              | `{ before? }`                                                                          | Deletes audio + photos (and their transcripts) older than `AUDIO_RETENTION_DAYS`; reports and PDFs are kept.                                                                                                                                                                                                            |
| `weekly_digest`                  | `{ orgId, weekStart }`                                                                 | §13 digest to admin + pm.                                                                                                                                                                                                                                                                                               |

## Retries, timeouts, idempotency

- Jobs are claimed with `claim_jobs(worker, limit)` (`FOR UPDATE SKIP LOCKED`; stuck `running` jobs
  are reclaimed after 15 min) and finished with `complete_job` / `fail_job`. `fail_job` applies the
  §10.1 backoff (30 s, 2 min, 10 min, 30 min, 2 h) and marks the job `dead` after 5 attempts. A dead
  job is reported to Sentry and the reporter gets `error_retry` once per report (flag
  `conversations.context.error_notified_for`).
- Every job has a 5-minute timeout (`JOB_TIMEOUT_MS`). Metrics (`tokens`, `audioSeconds`,
  `latencyMs`, `estCostUsd`) are written to `jobs.payload.metrics`.
- Enqueues use dedupe keys: `transcribe:<message>`, `extract:<report>:<sourceCount>`,
  `decide:<report>:<cause>`, `file:<report>`, `render_pdf:<report>:<version>`, `email:<kind>:<report>:<version>`.
  Inbound messages are routed once (`messages.status` becomes `read`); filing and rendering are
  no-ops when already done.
- The 60-second sweep (`src/router/timeouts.ts`) implements §7.2 timeouts: `awaiting_answer` > 60 min
  → draft with the gap flagged; `awaiting_confirmation` → nudge at +30 min, file at +2 h with
  `unconfirmed` (or file at +15 min with `filing_mode = 'auto_15min'`); `processing` > 10 min → "taking
  a little longer" once.

## Layout

```
src/
  index.ts        boot: dotenv (dev), config, Sentry, health server, runner, SIGTERM
  config.ts       zod-validated env
  db.ts           Db interface + postgres implementation (RPC wrappers)
  storage.ts      Supabase Storage (service role) + in-memory fake
  runner.ts       claim → run → complete/fail, dead-job handling, sweep
  router/         §7.2 state machine (session, inbound parsing, media, handlers/*, timeouts, continue)
  pipeline/       compose · validate · draft · file · versions · glossary
  ai/             claude (tool calls, caching, validation retry) · extract · correction · answer · classify · dayoff · site-guess · transcribe · prompts/ · eval
  wa/             Graph API client + payload builders · send (window logic, outbound rows)
  pdf/            ReportDocument · EvidencePack · fonts · render · sample-data · render-sample
  email/          provider (resend | console) · templates
  media/ffmpeg.ts ffmpeg resolution, commands, chunk plan, peaks
  test/           fake Db, harness with the §18 demo org
```

## Decisions (where the spec is silent or the API moved)

- **Forced tool use / temperature.** The spec asks for `tool_choice: submit_daily_report` and
  temperature 0. The current Claude 5.5 generation (`claude-sonnet-5-5`, `claude-opus-5-5`) and the
  Fable family reject forced `tool_choice` and non-default sampling (HTTP 400). `src/ai/claude.ts`
  detects the model: it forces the tool and sends `temperature: 0` where the model accepts them, and
  otherwise uses `tool_choice: auto` + an explicit "respond only by calling the tool" instruction, checks
  that the tool was called (one re-prompt), and sets `output_config.effort`. Zod validation retries once
  with the error fed back as an `is_error` tool result.
- **Prompt caching.** The §10.4 user template carries COMPANIES / GLOSSARY / REJECTED; to cache them
  they live in a second `system` block with `cache_control` (the system prompt is the first). The user
  message keeps the remaining lines of the template verbatim.
- **Media download timing.** Audio and photos are downloaded in `inbound_message` (URLs are
  short-lived), so the ack can say "2 min 48 s" and the waveform peaks are computed once. When the site
  or day is still unknown (picker / which-day), the download happens right after the choice.
- **Multi-site inference** (F12) uses the message text/caption (project code, site name, distinctive
  first word; ≥ 0.85) and the `guess_site` tool for unknown senders. A voice note from a multi-site
  reporter gets the picker rather than a transcription-first guess (one tap, no extra model call).
- **Voice while a question or draft is pending** is transcribed first; `parse_reply` then decides
  between answer, fix, confirm and "more content" (merge + re-extract), reconciling §F6 step 4 with the
  §7.2 merge rule.
- **Content for an already-filed day**: photos within 10 minutes attach as a new version (`Photo
added`), anything else is treated as an edit of that report (within the 14-day window).
- **Weather day via text** uses `classify_day_off` (Claude) with a regex fallback when no model is
  configured; lost hours = working-hours end − release time, full day = `default_shift_hours`.
  The weather-day report is filed silently (no WhatsApp PDF) and emailed when `email_pdf_on_file`.
- **No work**: site-day → `no_work`; a `kind='no_work'` report + PDF only when `org_settings.no_work_pdf`.
- **Review reasons** also include `missing:<path>` for required values that were never obtained, so a
  report confirmed with a gap is flagged for the office.
- **Retention** deletes transcripts together with their audio (both are customer data per §15).
- **PDF**: SVG logos are not embeddable by react-pdf; the org name is used instead. `lineHeight` is set
  on text styles, not the page (react-pdf drops render-prop text inside fixed elements otherwise).
- **`render_pdf.notifyReporter`** (set by the `create_report_version` RPC) is read from the raw payload
  because the shared schema strips it.

## Fixtures and eval

`fixtures/transcripts/*.json` are extraction inputs (`ExtractionInput`), `fixtures/expected/*.json` the
expected `DailyReportData`, `fixtures/tool-outputs/*.json` recorded model outputs the tests use without
API keys, `fixtures/webhooks/*.json` Meta payloads for `scripts/replay-webhook`. `pnpm eval` runs the
real extraction on every transcript and prints a results table (exit 1 on failure; "skipped" without
`ANTHROPIC_API_KEY`).
