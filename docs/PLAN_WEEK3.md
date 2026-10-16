# SiteLog — Week 3 build plan (M7 voice v1, M8 voice v2, M9 hours, weather & EOT, glossary)

> **Sahibine özet (TR).** 3. hafta sesli asistanı kuruyor: M7'de gelen aramalar ve kayıt ekranından **Talk now** ile tarayıcı araması (dinle, tek soru sor, raporu oku, "evet" ile dosyala), M8'de sesli sorular, düzeltmeler, "bugün iş yok / yağmur / beni sonra ara" gibi istekler, hatırlatma aramaları ve arama sonrası kayıt karşılaştırması; M9'da ekip saatleri ve fatura kontrolü, hava durumu ve EOT kanıt paketi, sözlük. İlk 15 ticket hiçbir anahtar istemiyor: Python ses ajanı, `field-api` ses uçları, `voice-events` ve arama simülatörü sahte (fake) LiveKit, Claude ve Deepgram ile CI'da test ediliyor; M9 doğrudan yapılabiliyor. En uzun süren işleri bugün başlatmanız gerekiyor: giden aramalar için Twilio Elastic SIP Trunk, aranabilir bir ABD numarası ve Trust Hub / STIR-SHAKEN kaydı (W3-17), ve avukattan yapay zekâ ile otomatik arama onayı (TCPA) ile kayıt bildirimi metinleri. Hafta ortasına kadar (W3-16'dan önce): LiveKit Cloud projesi (ücretsiz Build planı ve ücretsiz ABD numarası), Türkçe ses için Azure Speech F0 anahtarı, elinizdeki Deepgram ve Anthropic anahtarlarının ajan sırlarına eklenmesine onay ve aşağıdaki Q117–Q134 önerilerine onayınız.

Goal: by the end of week 3 a site manager can **report by talking**: call the pack's number or tap **Talk now** in the recorder, hear the recording notice, talk freely, answer one spoken question, hear a read-back, say "yes" and get the PDF and a photos link (M7); the call takes questions, corrections, _no work_, _weather day_, _call me back_, _text me instead_ and _change Friday's report_, SiteLog calls call-preferring reporters at R1, and every filed call is reconciled against its recording (M8); and the office side of the voice data is finished: crew hours and invoice checks with voice-note and call evidence, the weather log and the EOT evidence pack in the report language, and the glossary feeding both extraction and speech recognition (M9). Acceptance is spec §16.2 M7, M8 and M9 (each ticket's **Done when**, W3-18).

Rules: `CLAUDE.md`. Spec: `docs/SITELOG_SPEC.md` (v1.2), §16.2 M7–M9. Designs: `docs/design/`. Audit: `docs/GAP_ANALYSIS.md` ("GAP"). Week 1 and 2: `docs/PLAN_WEEK1.md`, `docs/PLAN_WEEK2.md` ("W1-xx", "W2-xx"). "Q41" is question 41 of spec §19. The week-3 questions Q117 … Q134 ("Owner decisions" below) were proposed here and are in spec §19; the owner decided all of them on 2026-10-16 with the recommended defaults. Every ticket that meets one builds its recommended default behind a named parameter, as week 2 did, and the owner's answer either confirms it or flips the parameter.

## Where week 2 leaves us

- M6 is built and green in CI (PR #1, 96d30ce, `e2e:supabase` and `pnpm e2e:m6` included); the owner's second phone check passed with the real Deepgram and Claude on the preview project (2026-10-16). Open boxes: W2-12, W2-14 … W2-17 wait for their first CI run or the owner's real WhatsApp / push / phone checks; the cut-over (W1-19) is still the owner's. Week 3 is built on `spec-v1.2` and PR #1 exactly as weeks 1 and 2 were.
- **Already in the repo that week 3 builds on:**
  - **Schema:** `calls` (every §6.3 column, `20261013000007_schema_expand_v1_2.sql:159`), the `calls` storage bucket (admin, pm, ops read), the enums `call_direction`, `call_transport`, `call_status`, `call_outcome`, `field_channel 'voice'`, `source_kind 'call'`, `link_kind 'photos'`, `consent_type 'auto_call'`; `transcripts.call_id`, `report_sources.call_id`, `questions.call_id`, `unknown_contacts.call_id`; `countries.voice_number` (per environment, `pnpm countries:set -- --voice`; no unique index yet, §4.6 leaves it to M7); `org_settings.auto_call_enabled`, `second_call_enabled`, `call_window_*`.
  - **Shared:** the `Source` union with `{type:'call', callId, start, end?}` and `reporter_edit.via 'call'` (`packages/shared/src/schemas/report.ts:56`, `:73`); §9.2 keys `call_coming`, `missed_call`, `photos_link`, `finish_report` in EN/ES/TR (`packages/shared/src/copy/sms.*.ts`); `remind()` with a `call` outcome that never fires (`packages/shared/src/schedule/remind.ts`; `scheduler-tick/logic.ts:484` `OUTBOUND_TRUNK = false`); `Notifier.call()` refusing (`packages/shared/src/notify/notifier.ts:808`); `PreferencesRequestSchema` refusing `noCallsToday` (`packages/shared/src/field-api.ts:216`).
  - **Field app:** Today's _Talk now_ button behind `VITE_FEATURE_TALK_NOW` (no handler, `apps/field/src/screens/today/Today.tsx:500`), _Call {number}_ when the pack has a voice number, `placesAutomatedCalls()` answering false (`apps/field/src/lib/features.ts:11`), the copy `today.talkNow` / `talkNowHint` (EN/ES/TR); a photos link takes photos only (`field-api/app.ts:695`) and opens Today, not F9's photo-only screen.
  - **Panel:** P7 plays every answered call of a report from the `calls` bucket with one lane (`apps/web/src/components/sitelog/MediaPlayer.tsx`, `apps/web/src/data/assemble.ts:1819`), excerpts with a speaker (`TranscriptExcerpt.tsx`, agent lines muted), the generic `call_mismatch` banner and `callSourceAt` (§19 Q74); Team links an unknown caller (`api-link-unknown-contact`, channel `voice`). The Kestrel seed has two calls (Northgate inbound, Hillcrest R1 not answered then called back) with peaks and no recording file (`packages/shared/src/demo/kestrel.ts:1170`).
  - **M9 from v1.0, working but not v1.2:** `/hours` (matrix, invoices, `InvoiceCheckAside` with voice-note chips and a `mailto:` query, `apps/web/src/app/hours/`), `api-export-payroll` (`supabase/functions/api-export-payroll/csv.ts`), `/weather` (KPIs, heatmap, delay log, `PackDialog`), `api-evidence-pack` and `build_evidence_pack` (`apps/worker/src/jobs/build_evidence_pack.ts`, `apps/worker/src/pdf/render.ts:270`, `packages/pdf/src/EvidencePack.tsx`), `/glossary` (review cards, tabs All · Companies · Spanish), `learnTerms` (`apps/worker/src/pipeline/glossary.ts`), batch STT key terms from confirmed terms (`buildKeyterms`, `apps/worker/src/ai/transcriber.ts:117`). Hours, Weather and Glossary still render inside `<EnglishOnly>` (`apps/web/src/app/routes.tsx`); the EOT pack is English only and says every report was "confirmed on WhatsApp" (`EvidencePack.tsx:87`).
- **Missing:** `apps/voice-agent` (no Python in the repo), `voice-events`, every `field-api` voice route, `place_call`, `post_call_reconcile`, `scripts/src/simulate-call.ts`, `fixtures/calls/`, the voice copy for the agent, call speaker lanes.
- **Found while planning:** commit c7f8d59 (W2-03) deleted spec §20, the appendices A–E, with its §19 edit. Appendix B (the server API surface, including the voice routes `POST /voice/calls/start` and `POST /voice/tools/*`) and Appendix A (the `apps/voice-agent` layout) are cited across the spec, CLAUDE.md, the README and `supabase/functions/README.md` were missing from the file. They are restored verbatim (2026-10-16, before week 3); W3-01 brings Appendix B up to the routes weeks 1–2 added.

## How each ticket runs in this repo

As in week 2 (`docs/PLAN_WEEK2.md`, "How each ticket runs"), with `W3-xx` as the commit prefix:

1. One ticket at a time, in the order below; check its **Blocked by** list. A ticket whose questions are open builds everything its **Without the answer** line names, behind a parameter whose default is the recommended answer.
2. Build with tests. SQL in a new timestamped migration after the last applied one (`20261016000260` today), `packages/shared/src/db/types.ts` in the same commit (D7), the D11 allowlist and the role matrix updated.
3. Run `pnpm check` and `pnpm format:check`; `pnpm test:db` when SQL changed; `pnpm e2e` when UI changed; `pnpm e2e:supabase` and `pnpm test:stack` when a Supabase data path changed (CI runs both); `pnpm eval -- --recorded` when a prompt changed; **`pnpm voice:test`** (new, W3-02: ruff, pyright, pytest) when `apps/voice-agent` changed. Deno checks run in CI.
4. Tick the boxes, commit `W3-xx: <summary>`, push to `spec-v1.2`; PR #1 green before the next ticket. Report in three lines against **Done when**. _(owner)_ checks need a real phone, a provider account or an owner action; _(by hand)_ checks are the developer's.
5. Every new user-facing string exists in every language of its surface (field EN/ES/TR, panel EN/TR, SMS EN/ES/TR, **voice EN/ES/TR**: the agent's spoken lines are copy too, `packages/shared/src/copy/voice.*.ts`, W3-01); the ES and TR texts are listed for the native-speaker read (Q63).
6. `apps/worker/src/ai/` and `.github/` are being edited by the eval work in parallel: a ticket that touches them (W3-02's CI job, W3-08's live-mode prompt, W3-10's reconcile extraction, W3-08's `buildKeyterms` move) rebases on that work first and keeps its change in one commit.

**Never without the owner's approval** (unchanged): any remote action on a hosted project (`db push`, `functions deploy`, `secrets set`, the worker, a seed, `pnpm countries:set`, SQL), **`lk agent create` / `lk agent deploy`, LiveKit dispatch rules, numbers and webhooks, Twilio trunks and numbers**, Netlify settings, merging into the live branch.

**Keys and accounts.** CLAUDE.md rule 5 applies to every one of them: the ticket builds behind the interface with a fake or `console` implementation and tests, names the key, and moves on.

| Key / account                                                                                                                           | Tickets                       | Without it                                                                                                                                                                     |
| --------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ANTHROPIC_API_KEY` (+ `CLAUDE_MODEL_FAST` for the dialog)                                                                              | W3-08 … W3-12, W3-16          | `EXTRACT_PROVIDER=fake` with recorded call tool outputs (`fixtures/calls/`); in pytest a `FakeLLM` replaying recorded agent turns                                              |
| `DEEPGRAM_API_KEY` (streaming Nova-3, Aura-2 TTS, batch for reconcile)                                                                  | W3-10, W3-12, W3-16           | `TRANSCRIBE_PROVIDER=fake` with the call fixtures; text-mode agent sessions (no STT/TTS)                                                                                       |
| LiveKit Cloud project (`LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`), `lk` CLI login, free US number + dispatch rule, webhook | W3-04 (live), W3-13, W3-16    | webhooks signed with a test secret; a `LiveKitApi` interface with a fake (room, dispatch, token); `talkNow` false; the agent in text mode                                      |
| `VOICE_AGENT_TOOL_SECRET`                                                                                                               | W3-03                         | developer-generated locally (`openssl rand -base64 32`); the owner sets the hosted value                                                                                       |
| Azure Speech F0 (`AZURE_SPEECH_KEY`, `AZURE_SPEECH_REGION`)                                                                             | W3-12 (TR voice), W3-16       | TR calls tested in text mode; Deepgram `tr` STT works without it; the live TR voice waits                                                                                      |
| Twilio Elastic SIP Trunking: an upgraded account, a trunk, a voice-capable US number, Trust Hub profile and SHAKEN/STIR (long lead)     | W3-17                         | `console` telephony: a demo org's outbound call rings the Demo phone, answered in the browser (Q132); real orgs place no calls (as today, §19 Q38)                             |
| Counsel: the `auto_call` consent wording (TCPA, AI voice), the recording notice per language and pack                                   | W3-14, W3-17 (before a pilot) | the field app's and agent's own wording versions (`field.consent.v1`, new `voice.consent.v1`, `voice.recording_notice.v1`), as §19 Q28 allows until counsel fills `legal_keys` |

## Tickets

Ordered so that the tickets needing **no owner answer and no key** come first (W3-01 … W3-08, which include all of M9), then the call pipeline whose open questions are only parameters and whose providers are fakes (W3-09 … W3-15), then the provider accounts (W3-16, W3-17), and the acceptance run last.

| Ticket | Title                                                                       | Size | Blocked by (proposed §19)        | Keys (fake without)                      |
| ------ | --------------------------------------------------------------------------- | ---- | -------------------------------- | ---------------------------------------- |
| W3-01  | Spec appendices back; the voice contract in `packages/shared`               | M    | none                             | none                                     |
| W3-02  | `apps/voice-agent` scaffold: Python package, fakes, pytest, CI job          | M    | none                             | none                                     |
| W3-03  | Calls data and the `field-api` call routes (start, context, bookkeeping)    | L    | none                             | none                                     |
| W3-04  | `voice-events`: LiveKit webhooks                                            | M    | none                             | LiveKit (live check only)                |
| W3-05  | Panel call player with speaker lanes; call evidence in P7                   | M    | none                             | none                                     |
| W3-06  | Crew hours, invoice check and payroll CSV on v1.2 (F19, P8)                 | M    | Q133                             | none                                     |
| W3-07  | Weather & delays and the EOT evidence pack on v1.2 (F20, P9)                | L    | Q134                             | none                                     |
| W3-08  | Glossary review and key terms for calls (F21, P11)                          | M    | none                             | none                                     |
| W3-09  | Live draft on a call: `update_draft` and spoken questions                   | L    | Q117, Q118                       | Anthropic                                |
| W3-10  | Read-back, the spoken yes, fixes and filing on a call                       | L    | Q118, Q119                       | Anthropic, Deepgram                      |
| W3-11  | Hang-ups, fallback recording and post-call reconcile (§10.9)                | L    | Q122, Q123                       | Anthropic, Deepgram                      |
| W3-12  | The voice agent: dialog, disclosure, tools, recording (Python)              | XL   | Q119, Q120                       | LiveKit, Deepgram, Anthropic, Azure (TR) |
| W3-13  | Talk now and the photos-link screen in the field app                        | L    | Q121                             | LiveKit                                  |
| W3-14  | Special intents on calls, first-call consent, unknown callers (F6, F3, F13) | L    | Q120, Q124, Q128 (callback half) | Anthropic                                |
| W3-15  | Scripted call simulator and the call suite                                  | M    | none                             | none (`--live` needs LiveKit + Deepgram) |
| W3-16  | M7 live: LiveKit Cloud, the US number, Talk now, voices, latency            | M    | Q121                             | LiveKit, Deepgram, Anthropic, Azure      |
| W3-17  | Outbound reminder calls (M8)                                                | XL   | Q125 … Q132                      | Twilio SIP trunk + number, LiveKit       |
| W3-18  | M7–M9 acceptance: suites, phones, the pilot metric                          | M    | every open Q (ships its default) | all live keys (owner)                    |

## Not in week 3

- **M10:** Settings' _Field channels_ tab (the pack read-only, auto-call and second-call toggles, the call window, _Call me now_), Team's _Call now_ with attestation and device revocation, Setup's preferred channel. W3-17 reads the existing `org_settings` columns; the panel controls for them are M10.
- **M11:** a Turkish phone number and the TR SIP trunk (§19 Q2, open with the owner), Turkish voice tuning beyond W3-16's listening test (numbers, units, company names), TR glossary seeds. Turkish calls in week 3 are **Talk now** only.
- **M12:** the ≥ 30-recording evaluation set and the ≥ 10 _audio_ call simulations in CI (W3-15 builds the harness and runs it text-level in CI, audio-level by hand), load tests (300 concurrent calls), the field bundle budget (W3-13 keeps `livekit-client` out of the main chunk).
- **GAP step 22 / 23** (retire the v1.0 Meta integration, contract): after the cut-over, unchanged.

---

## Part 1 · Buildable now (no owner answer, no key)

### W3-01 · Spec appendices back; the voice contract in `packages/shared`

- [x] **W3-01 done** · today _missing_ (M)
- **Spec:** §20 Appendix A and B (deleted by c7f8d59, restored verbatim 2026-10-16), §4.2, §6.5 ("per-call token minted when the call starts, bound to `call_id` + reporter"), §9.4 (tools table, openings, dialog policy), §7.3, §6.3 `calls`, §10.3.
- **Already in the repo:** the field contract (`packages/shared/src/field-contract.ts`, request schemas `field-api.ts`), `deriveLinkCode` (HMAC, `packages/shared/src/links.ts`), the call `Source`, the §9.2 copy; no voice schemas, no voice copy.
- **Build:**
  - [x] Restore §20 (Appendices A–E) verbatim (done 2026-10-16, before week 3).
  - [x] Update Appendix B to every route weeks 1–2 added (`test-clip`, `consent/grant`, `push/*`, `expired/daily-link`, `reports/:id/edit`, the correction routes, `GET preferences`) and Appendix A to the repo as built (`apps/field`, `packages/pdf`, `supabase/db-tests`, `apps/voice-agent` as W3-02 lays it out). A spec test (beside `scripts/src/sms-copy-spec.test.ts`) fails when a `field-api` route is missing from Appendix B.
  - [x] `packages/shared/src/voice.ts` (Deno-safe, `.ts` imports): Zod schemas for `POST /voice/calls/start {room, from?, callId?, transport}` → `{callId, callToken, reporter?: {firstName, locale}, unknown?: true}` and for each tool's input and output in §9.4's table (`get_context`, `update_draft`, `record_answer`, `apply_correction`, `file_report`, `set_day_status`, `schedule_callback`, `set_preference`, `load_report`, `start_fallback_recording`, `end_call`), plus `recording_upload` and `end_call`'s `{outcome, dialogLog, metrics}`; the `calls.dialog_log`, `calls.metrics` and two-lane `calls.peaks` (`{reporter: number[], agent: number[]}`, a v1 single array still read) shapes; `deriveCallToken(secret, callId)` (HMAC-SHA-256, like link codes: nothing stored).
  - [x] `pnpm voice:contract` (new root script, `scripts/src/voice-contract.ts`): writes the JSON Schema of every voice schema (`z.toJSONSchema`) to `apps/voice-agent/contract/*.json`, checked in; CI fails on a diff (the Python side validates against these, W3-02).
  - [x] Voice copy catalogue `packages/shared/src/copy/voice.{en,es,tr}.ts`: the §9.4 openings (inbound, outbound, Talk now), the disclosure (the pack's recording notice per call language until §19 Q28's `legal_keys.recording_notice` is filled: `voice.recording_notice.v1`), fillers ("Got it, one moment"), the silence prompts (§7.3), the fallback line (F6), goodbyes per outcome, the read-back templates (W3-10), the F3 consent sentence (Q120), the F13 unknown-caller line; exported to `apps/voice-agent/copy/*.json` by the same script. TR formal _siz_, no exclamation marks (§9.7).
- **Tests:** schema round-trips; `deriveCallToken` vectors; the Appendix B route test; copy parity EN/ES/TR (every key, every placeholder); the contract script's idempotence.
- **Done when:** spec §20 is back with an Appendix B that lists every `field-api` route the code serves (the test proves it), and `apps/voice-agent/contract/` and `copy/` are generated and drift-checked.
- **Needs:** nothing.
- **Blocked by:** none.

### W3-02 · `apps/voice-agent` scaffold: Python package, fakes, pytest, CI job

- [ ] **W3-02 done** · today _partial_ (M): scaffold, fakes and `pnpm voice:test` built (74 tests, no key, no network), the CI job and the CLAUDE.md lines added; ticks when the `voice-agent` CI job is green
- **Spec:** §4.2, §5 (Python 3.11+, `livekit-agents` with `deepgram`, `anthropic`, `azure`, `silero`, `inference.TurnDetector`; `httpx`; `lk agent deploy`), §9.4, §17 (Voice: scripted call simulations), Appendix A (W3-01).
- **Already in the repo:** nothing in Python; the pnpm workspace, the CI jobs `check`, `db`, `edge-functions`, `e2e`, `e2e-supabase`, `eval`.
- **Build:**
  - [x] Layout (Appendix A refined; one package, `src/` layout):

    ```
    apps/voice-agent/
      pyproject.toml  uv.lock  .python-version (3.12)  livekit.toml.example  Dockerfile  README.md
      contract/*.json  copy/*.json              # generated by `pnpm voice:contract` (W3-01)
      src/sitelog_voice/
        agent.py        # entrypoint: WorkerOptions(agent_name=LIVEKIT_AGENT_NAME), entrypoint(ctx)
        config.py       # env (pydantic-settings); never logs a secret or a phone number
        session.py      # AgentSession per call language: STT, LLM, TTS, VAD, turn detector
        dialog.py       # §7.3 as a pure state machine: states, timers (8 s silence, 10/12 min caps), limits
        tools.py        # @function_tool wrappers → FieldApi (W3-03 … W3-14)
        field_api.py    # httpx client: bearer VOICE_AGENT_TOOL_SECRET + X-Call-Token, timeouts, retries, pydantic models
        contract.py     # pydantic models checked against contract/*.json
        copy.py         # spoken lines from copy/*.json by key and language
        prompts/        # en.md, es.md, tr.md: §9.4's dialog policy, verbatim (a test compares it with the spec)
        recording.py    # dual-channel writer (reporter left, agent right) → OGG/Opus → signed upload (W3-12)
        voicemail.py    # first-utterance classifier for outbound calls (W3-17)
        metrics.py      # turn latency p50/p95, interruptions, STT confidence → end_call
      tests/
        fakes/          # FakeFieldApi (respx), FakeLLM (recorded agent turns), fake clock
        test_*.py       # unit; sim/ replays fixtures/calls/*.json (W3-15)
    ```

  - [x] Dependencies pinned exactly in `uv.lock` (`livekit-agents` with the plugins above, `httpx`, `pydantic`, `pydantic-settings`, `sentry-sdk`; dev: `pytest`, `pytest-asyncio`, `respx`, `pytest-socket`, `ruff`, `pyright`, `jsonschema`). The exact testing API of the pinned `livekit-agents` (text-mode `AgentSession.run`, its result assertions) is checked when pinning; where it is not public, the harness drives `dialog.py` and `tools.py` directly. _As built:_ `livekit-agents` 1.8.3 (plugins `anthropic`, `azure`, `deepgram`, `silero`; `inference.TurnDetector` is in the core package, so no `turn-detector` extra and no `transformers`), Python 3.12; its public `AgentSession.run()` / `RunResult.expect` drive the text-mode sessions.
  - [x] Fakes, so nothing needs a key or a network: `FakeFieldApi` (respx routes answering from `fixtures/calls/*.json`, validating every request against `contract/`), `FakeLLM` (replays recorded agent turns: text and tool calls, per fixture), text-mode sessions (no STT/TTS); `pytest-socket` forbids any other network. _As built:_ `apps/voice-agent/tests/fakes/`; the first fixture is `fixtures/calls/smoke-get-context.json` (its `$comment` gives the shape W3-15 extends).
  - [x] Root scripts: `pnpm voice:test` (`uv run ruff check`, `ruff format --check`, `pyright`, `pytest -m "not live"`) and `pnpm voice:console` (`lk agent console`, by hand); both listed in CLAUDE.md "Commands" (_open:_ the CLAUDE.md line is proposed in the W3-02 report, not yet added).
  - [x] CI job `voice-agent` (in `.github/workflows/ci.yml`; as built `uv sync --locked` and `pnpm voice:contract -- --check`, coordinated with the eval work editing that file): `astral-sh/setup-uv`, `uv sync --frozen`, the `voice:test` steps, and `pnpm voice:contract` with `git diff --exit-code`. `deploy.yml` gets no agent step: `lk agent deploy` stays an owner-approved hand step (RUNBOOK, W3-16).
  - [x] Sentry for the agent (`SENTRY_DSN`, the `voice-agent` environment tag); logs carry the call id, never a phone number or a transcript. _As built:_ `observability.py`, events tagged `service: voice-agent` with `SENTRY_ENVIRONMENT`; a log filter and Sentry's `before_send` redact phone numbers.
- **Tests:** config parsing; the field-api client (auth headers, timeout, one retry on 5xx, never on 4xx, contract validation both ways); the prompt files equal §9.4; one text-mode smoke session with `FakeLLM` and `FakeFieldApi` that calls `get_context` and ends.
- **Done when:** `pnpm voice:test` passes locally and the `voice-agent` CI job is green on PR #1 with no key and no network.
- **Needs:** nothing.
- **Blocked by:** none.

### W3-03 · Calls data and the `field-api` call routes (start, context, bookkeeping)

- [ ] **W3-03 done** · today _missing_ (L)
- **Spec:** §4.3 B, §6.3 `calls`, §6.5, §9.4 ("How a call starts", tools), F6 step 3, F14 (call), §10.12 (no phone numbers to models, tools scoped to the caller's sites), §19 Q29, Q44.
- **Already in the repo:** `calls` and its RLS (select for admin, pm, ops); `field-api` on Hono with the store split (`app.ts`, `store.ts`, `store_supabase.ts`, `fake_store.ts`); `ensurePersonalLink`, `ensureDailyLink`; the reporter lookup by phone per pack for SMS (`sms-webhook`, §19 Q44's rule).
- **Build:**
  - [ ] Migration: `create unique index on countries (voice_number) where voice_number is not null` (§4.6: inbound calls find the pack by the number called); `calls.language`, `calls.call_token_issued_at`, `calls.attempt smallint`, `calls.site_day_id`; service-only RPCs `voice_call_start()` (one row per room, idempotent on `provider_call_id`, audited `call.started`), `voice_call_update()` (status, disclosure, answered), `voice_call_end()` (outcome, dialog log, metrics, duration; audited `call.ended`; enqueues `post_call`, W3-11); role matrix, allowlist, `db/types.ts`.
  - [ ] `field-api` `/voice/*` (server-to-server, no `Origin`): bearer `VOICE_AGENT_TOOL_SECRET` (constant-time) on every route, plus `X-Call-Token` (`deriveCallToken`) on every tool; a tool acts only on the call's reporter, their sites and that day's report (403 otherwise); 60 tool calls a minute per call (`rate_limits`).
  - [ ] `POST /voice/calls/start`: SIP `from` → the reporter in the real orgs of the pack whose `voice_number` was called (the §19 Q44 rule: two orgs → the site question covers both; none → `unknown: true`, F13, W3-14); a web call passes the `callId` W3-13 created. Answers first name, locale and the call token, **never the phone number**, and stores `from_e164` server-side only.
  - [ ] Tools without the model: `get_context` (first name, sites with today's status and deadline, report language, companies + aliases, the key terms from `buildKeyterms` moved to `packages/shared`, W3-08), `set_preference` (`link` / `call`, audited as the reporter, `via voice`; the `pref_text_ok` / `pref_call_ok` text per §9.5), `load_report` (a day reference resolved by code, `resolveDayReference` from W2-12; a summary of that day's filed report for the reporter's sites within 14 days, §19 Q81), `start_fallback_recording` (marks the call, W3-11), `end_call`, and `POST /voice/calls/:id/recording` (a signed upload URL into `calls/{org}/{call}.ogg`).
  - [ ] F14 on a call: `get_context` lists ≤ 3 sites by name; `POST /voice/tools/pick_site {siteId}` (an addition to §9.4's table, recorded in Appendix B) fixes the call's site.
- **Tests:** PGlite (RPCs, idempotence, audit, the voice-number index, RLS: no office user reads another org's calls, no field client reads any); Deno tests per route (auth both layers, scoping, an unknown caller, a number in two orgs, a reporter of three sites, rate limit, no phone number in any answer).
- **Done when:** in CI, a fake SIP start for Kevin O'Brien's number on the US pack's voice number returns his first name and a call token, `get_context` returns Northgate with today's status and no phone number, and every other reporter's site is refused.
- **Needs:** nothing (`VOICE_AGENT_TOOL_SECRET` generated locally).
- **Blocked by:** none.

### W3-04 · `voice-events`: LiveKit webhooks

- [ ] **W3-04 done** · today _missing_ (M)
- **Spec:** §4.2 (`voice-events`: `room_started`, `participant_joined`, `participant_left`, `room_finished`, SIP status for outbound calls), §5.1 (`LIVEKIT_API_SECRET` verifies webhooks), §7.3, §10.1 (`post_call_reconcile`), CLAUDE.md (webhooks validate signatures; jobs idempotent).
- **Already in the repo:** the webhook patterns of `sms-webhook` (store once per provider id, audit and enqueue in one transaction, fast ack); `replay-webhook` (Meta; Twilio forms).
- **Build:**
  - [ ] `supabase/functions/voice-events`: verifies the LiveKit webhook JWT (signed with the API secret, its `sha256` claim equal to the body's hash; `npm:livekit-server-sdk`'s `WebhookReceiver` if it runs under Deno, else `jose`), dedupes on the event id, updates `calls` through `voice_call_update()` (`ringing`, `in_progress`, `completed`, `no_answer`, `busy`, `failed` from the SIP participant's `sip.callStatus`), and on `room_finished` for a call the agent never ended (agent crash, network) ends it as `draft_saved` or `abandoned` and enqueues `post_call` (W3-11) — the backstop, never a second `post_call` (job key `post_call:<call>`).
  - [ ] `supabase/config.toml` entry (public, no JWT), `.env.example` and §5.1 unchanged keys; `fixtures/livekit/*.json` and `pnpm replay-webhook -- fixtures/livekit/<event>.json` signing with a local secret.
- **Tests:** Deno tests (signature good, bad, replayed; each event; the backstop on a call left open; duplicate delivery), a PGlite test of the status moves (never backwards).
- **Done when:** in CI, the replayed fixtures move a call through ringing → in progress → completed, a forged signature is refused with 401, and a room finished without `end_call` leaves one `post_call` job; _(owner, W3-16)_ LiveKit's webhook test delivers to the preview project.
- **Needs:** nothing (a test secret); LiveKit for the live check.
- **Blocked by:** none.

### W3-05 · Panel call player with speaker lanes; call evidence in P7

- [ ] **W3-05 done** · today _partial_ (M)
- **Spec:** §11.3 `MediaPlayer` ("for calls, two lanes (reporter / assistant) and a speaker filter"), `SourceLink` (_call 2:15_), `TranscriptExcerpt`, P7 (provenance "phone call 18:41 (2 min 05 s) · confirmed by voice", Activity "call placed/answered/ended", `call_mismatch` banner), §19 Q74 (M7 extends the reason with both values), Q93 (decided: P7 plays a spoken answer's clip; a follow-up from week 2). **Design:** `Web-Report`.
- **Already in the repo:** one-lane call playback from the `calls` bucket, call excerpts with muted agent lines, `callSourceAt`, the generic banner (W1-17); `transcripts.segments[].speaker` read as `reporter` / `agent` (`assemble.ts:586`).
- **Build:**
  - [ ] `MediaPlayer`: two lanes from the two-lane `peaks` (W3-01; a single array stays one lane), labels "Site manager" / "SiteLog assistant" (EN/TR), a speaker filter (both · reporter · assistant) that dims the other lane and skips its segments in the excerpt list, keyboard operable, status not by colour alone; `seek(seconds)` from a call source.
  - [ ] Provenance and Activity for calls (inbound, outbound, Talk now: "browser call"), `confirmed_via 'voice'`, the call's outcome, the fallback-recording mode; `call_mismatch:<path>:<heard>:<confirmed>` worded with both values and _Play at m:ss_ (Q74).
  - [ ] Q93: P7's _answer 17:41_ plays the spoken answer's clip (`uploads.question_id`).
  - [ ] Demo data: a synthetic two-lane recording for Northgate and Hillcrest in demo mode (`apps/web/public/demo/`, generated tones, no speech), so the lanes show without a stack.
- **Tests:** unit tests of the lane fold and the filter; P7 tests in EN/TR (provenance, banner values, Activity); Playwright at 390 and 1440 px with axe.
- **Done when:** in demo mode Northgate's report plays its call with two lanes, the filter hides the assistant's lines, _call 2:15_ seeks, and a `call_mismatch` reason reads "The call recording says 5 workers, the confirmed report says 4".
- **Needs:** nothing.
- **Blocked by:** none.

### W3-06 · Crew hours, invoice check and payroll CSV on v1.2 (F19, P8)

- [x] **W3-06 done** (CI green with `e2e/supabase/hours.spec.ts`, run 38971337627) · built (`20261016000270_invoice_gap_notice.sql`, `e2e/supabase/hours.spec.ts`); ticks when the `e2e-supabase` CI job runs the new spec green
- **Spec:** F19, P8 ("evidence links can be voice-note or call timestamps", "h" / "sa"), §13 _Invoice gap_ (ops, accounts), §2.2 (accounts), §16.2 M9 (**BrightLine shows +16 h with evidence**). **Design:** none in `docs/design/` (the canvas's Web-Hours is not exported; build on the v1.0 page and note it).
- **Already in the repo:** the page, the invoice dialog and check aside, `buildQueryMailto`, `invoice_gaps` RPC, `api-export-payroll` with the spec's columns; the Kestrel week Oct 5–9 (1,804 h, BrightLine +16 h, ClearView +8 h). Open audit findings this ticket closes: `docs/AUDIT_BACKLOG.md` "Payroll CSV does not neutralise spreadsheet formulas…" (`:738`, `:913`), "No 'invoice_gap' panel notification is ever produced" (`:829`), "Crew hours for accounts users links to report pages they cannot open" (`:871`, check it is still open), "Invoice upload path uses the raw file name…" (`:878`).
- **Build:**
  - [x] EN/TR: the page out of `<EnglishOnly>`, its copy in `en.ts` and `copy/ui/tr.ts`, hours "h" / "sa" and money by the org's currency (`Intl`, minor units). _As built: no money on the page (`sub_invoices` has no amount, spec §6.3), so nothing to format; numbers and dates in the panel's language._
  - [x] Evidence per gap day from v2 sources: a voice note (_audio 0:41_), a **call** (_call 2:15_, opening P7 at that second) or an answer; the `mailto:` query lists the same with the report numbers; accounts users see numbers without links (§2.2).
  - [x] `invoice_gap` notice per Q133's parameter (`INVOICE_GAP_POLICY`), keyed per invoice and gap, from the invoice save and from a new version that changes the hours behind it.
  - [x] Payroll CSV: every cell starting `=`, `+`, `-`, `@`, tab or CR prefixed with `'` (OWASP); the invoice upload path from a slug and a uuid.
- **Tests:** CSV injection vectors; gap notice once per change; evidence from voice-note, call and answer sources; page tests EN/TR at 390/1440 px; an `e2e:supabase` spec on the seeded week.
- **Done when:** in CI, the seeded week shows BrightLine +16 h with its voice-note evidence and Northgate's call evidence, the invoice save posts one `invoice_gap` notice to ops and accounts, the CSV neutralises a formula name, and the page reads in Turkish.
- **Needs:** nothing.
- **Blocked by:** **Q133** (when an invoice gap is notified). _Without the answer:_ its recommendation.

### W3-07 · Weather & delays and the EOT evidence pack on v1.2 (F20, P9)

- [ ] **W3-07 done** · today _partial_ (L) · built (`20261016000280_weather_call_evidence.sql`, `apps/worker/src/jobs/evidence-pack.pglite.test.ts`, `apps/web/e2e/weather.spec.ts`); ticks when CI runs the new demo e2e spec and the worker's PGlite pack test green
- **Spec:** F20 ("PDF in the org's report language with transcript excerpts, photos, observed weather and attribution"), P9 (_Voice note ts_ or _Call ts_ chips, observed values in org units), §10.11, §12 (fonts, paper), §13 _EOT pack ready_, §16.2 M9 (**Riverside October EOT pack builds in < 2 min**), §19 Q91. **Design:** none exported for Web-Weather or the pack (build on v1.0 and note it).
- **Already in the repo:** the page, heatmap, delay log, `PackDialog`, `api-evidence-pack`, `build_evidence_pack`, `EvidencePack.tsx` (English labels, "confirmed on WhatsApp"), `weatherExcerpts` (voice-note sources only), `claim_ready` (audio + photo + observed). Open audit findings this ticket closes: "EOT pack ignores the 'included sections' checklist" (`:432`), "EOT packs for the same site and period overwrite each other's PDF" (`:439`), "EOT pack cover states every report was confirmed on WhatsApp…" (`:446`), "Evidence-pack transcript excerpts match timestamps across different voice notes" (`:630`), "'X h lost to weather in this set' sums only the current page" (`:899`).
- **Build:**
  - [x] EN/TR page (out of `<EnglishOnly>`), evidence chips with _Call ts_ from call sources, observed values in the org's units, the set's lost-hours total from the RPC, not the page. _As built: a call-sourced weather period now carries the call on its delay record (`denormalize_report_version`, 20261016000280, which re-runs it for existing call reports); the chips link to P7 at the second; `report_archive_weather_hours()` sums the archive's set; P9's claim-ready follows Q134 too._
  - [x] The pack in the org's report language (`packages/pdf/src/copy.ts` gains the pack's labels, EN/TR, Turkish dates and "sa"; Q66's native read covers them), the org's paper; each day's line says how it was confirmed (recorder, call, office, filed without confirmation) per Q134; excerpts per clip (the source's upload or call, never across clips), call excerpts from the reporter's lane only with _call m:ss_; the dialog's included sections honoured; one stored file per pack id (`…_{packId}.pdf`), so a rebuild never overwrites an earlier pack.
  - [x] Performance: the Riverside October pack (a month of seeded weather days: the seed generator's `--date` calendar extended to a full month for this test) built by the worker in < 2 min on CI's runner, timed in the job metrics. _As built: the month is generated by the PGlite test on top of the §18 seed (every free weekday of October for Riverside and for Demir Yapı's Kartal: a recorder voice note, a call, or a 2 h timeout in turn, each with a photo and observed weather), not by the seed generator, so `supabase/seed.sql` and the demo stay §18 as written; `build_evidence_pack` records `packBuildMs` in the job metrics and the test asserts < 2 min (about 3 s here)._
- **Tests:** PDF render tests EN/TR (labels, the confirmation line, excerpts per clip, call excerpts); worker PGlite test of the build (sections, version-stamped path, call sources); a timed integration test; page tests EN/TR.
- **Done when:** in CI, Riverside's October pack builds in under 2 minutes in Turkish for Demir Yapı's site and in English for Riverside, cites voice-note and call excerpts from the right clip, and states each day's confirmation honestly.
- **Needs:** nothing.
- **Blocked by:** **Q134** (unconfirmed reports in a pack). _Without the answer:_ its recommendation.

### W3-08 · Glossary review and key terms for calls (F21, P11)

- [ ] **W3-08 done** · today _partial_ (M) · built (`20261016000290_glossary_rpcs.sql`, `packages/shared/src/glossary/keyterms.ts`, `e2e/glossary.spec.ts`); ticks when W3-03's `get_context` returns `buildKeyterms` with its Deno test, and CI runs the new e2e spec green
- **Spec:** F21 (auto-learn ≥ 0.9 for plain terms; review cards Approve · Change · Reject; companies Add as subcontractor · Map to…; "confirmed terms are used both by extraction **and** as speech-recognition hints for calls and voice notes"), P11 (tabs All · Companies · Spanish · Turkish), §10.2 hints, §18.2 TR seeds. **Design:** none exported for Web-Glossary.
- **Already in the repo:** the page (tabs All · Companies · Spanish), `AddTermDialog`, `review_glossary_term`, `resolve_unknown_company`, `learnTerms` and `termLanguage`, batch key terms (`buildKeyterms` in `apps/worker/src/ai/transcriber.ts`, confirmed and built-in terms only). Open audit findings: "Re-extractions inflate glossary times_heard and repeat the review notification" (`:836`), "resolve_unknown_company adds a duplicate glossary row on every resolve" (`:983`).
- **Build:**
  - [x] EN/TR page, the **Turkish** tab, Change (edit the official term) and Map to… for companies, all through audited RPCs. _As built: the review cards already had Change (terms) and Add as subcontractor · Map to… (companies) through `review_glossary_term` (audited `glossary.reviewed`); Add term was a direct insert with no audit row and is now `add_glossary_term` (audited `glossary.added`; the same phrase, kind and scope updates its row). The dialog offers Turkish and starts in the panel's language._
  - [x] `buildKeyterms` moved to `packages/shared/src/glossary/keyterms.ts` (the worker imports it; done in one commit with the eval work, see "How each ticket runs" 6), so `get_context` (W3-03) gives the agent the same hints for Deepgram streaming (`keyterm`, Nova-3) as a voice note gets. _As built: `siteName` also takes a list (a call before `pick_site`: each of the reporter's sites). `get_context` itself is W3-03's; its Deno test (the reporter's key terms) comes with it._
  - [x] `learnTerms` counts a term once per report (not per extraction) and notifies once per new term; `resolve_unknown_company` upserts. _As built: a re-extraction passes the previous draft's `newTerms` as already counted (the audit's fix); `upsertGlossaryTerm` says whether it inserted, and only new rows waiting for review notify. Spec §19 Q138's recommended default applied: §18.2's "demirci ekibi" is kind `company` in the Demir Yapı seed and the TR eval inputs._
- **Tests:** keyterms unit tests in shared (moved), page tests EN/TR with the Turkish tab, PGlite tests for the two audit fixes, a Deno test that `get_context` returns the reporter's key terms.
- **Done when:** in CI, approving "demirci ekibi → Donatı ekibi" for Demir Yapı puts it in the Turkish tab, in the next voice note's key terms and in `get_context`'s key terms; a re-extraction does not raise `times_heard`.
- **Needs:** nothing.
- **Blocked by:** none.

## Part 2 · The call pipeline on fakes (open questions as parameters)

### W3-09 · Live draft on a call: `update_draft` and spoken questions

- [ ] **W3-09 done** · today _missing_ (L)
- **Spec:** §4.3 B step 3, §10.4 live mode ("same tool and prompt on the transcript so far"; `CHANNEL=call`), §10.5 (call: choices spoken, photo never asked on a call: `no_photo` later), F7 (call), §9.4 `update_draft` / `record_answer`, §10.7.
- **Already in the repo:** extraction v2 (`runReportExtraction`, prompt and source note), `decide_next`'s pure decision, question selection with options, `parse_answer` (fast model, `answerRefusal`), `applyAnswer`, `EXTRACT_PROVIDER=fake`.
- **Build:**
  - [ ] `update_draft {transcript: [{start, end, text}]}` (reporter lane, seconds from the call's start): field-api stores the turn (`calls.dialog_log`), creates or merges the site-day's report (`channel 'voice'`, `report_sources` kind `call`), and per Q117 enqueues a priority `voice_turn` job and waits (≤ 15 s, `VOICE_TOOL_WAIT_MS`) for its result row; the worker runs live-mode extraction with call sources (`{type:'call', callId, start, end}`; the §10.4 source-format note gains its call line, a spec change) and the question selection with the call rules; answers `{missing, question?: {id, text, choices[≤2]}, readBack?}` with the read-back from code per Q118 (W3-10).
  - [ ] `record_answer {questionId, utterance, start}`: `parse_answer` on the words (the call language), `applyAnswer` with sources the answer and the call second, F7's confirmation sentence from code's numbers in the call language; unclear → ask once more with the choices; twice → `unanswered:<field>` and move on (F7).
  - [ ] A second call or a voice note the same day merges into the report (§7.2: re-extract with all sources).
  - [ ] Recorded fixtures: `fixtures/calls/<id>.json` (turns, the expected tool answers, recorded tool outputs) for EN and ES (Riverside's hero said on a call; Northgate's 14 workers; a Delta headcount gap), so `EXTRACT_PROVIDER=fake` answers live mode.
- **Tests:** worker PGlite integration (a call turn → draft with call sources, a question, an answer applied, totals in code), Deno route tests (wait, timeout → `pending` the agent fills with "one moment", scoping), recorded-output eval cases (`pnpm eval -- --recorded`).
- **Done when:** in CI, a scripted Northgate call turn yields a draft of 14 workers from 2 companies, 100.0 h, every value citing the call second; the Delta gap asks "four or five people, and the full day?" with two choices, and "five, all day" applies 5 × 8 = 40 h.
- **Needs:** `ANTHROPIC_API_KEY` for the live eval only.
- **Blocked by:** **Q117** (how live tools reach the worker), **Q118** (who writes the read-back). _Without the answers:_ their recommendations.

### W3-10 · Read-back, the spoken yes, fixes and filing on a call

- [ ] **W3-10 done** · today _missing_ (L)
- **Spec:** F6 step 5–7, F8 (call), §7.2 (`awaiting_confirmation → filed` on "yes (call)"), §9.4 rule 5 ("only call file_report after an explicit yes"), §9.5 `confirm` words, §10.6, §10.12 ("only code files a report, after an explicit confirmation"), F9 step 1 (photos link), §13 (`filed` + `photos_link` after calls), CLAUDE.md (the model never decides to file).
- **Already in the repo:** `file_report` (via, `confirmed_via`, `render_pdf`, `notify(filed)`), `draft_rev` and the confirm by revision, `apply_correction` v2 (`applyCorrectionOps`, totals recomputed, numbers stated), the photos link kind and `photosLinkExpiresAt`.
- **Build:**
  - [ ] Read-back per Q118: `readBack(draft, language, units)` in `packages/shared` (≤ 30 s, about 75 words; crew count, companies, total hours first, then weather lost hours, then work, deliveries, safety from the draft's own strings), returned with the draft revision it reads.
  - [ ] `file_report {utterance, draftRev}` per Q119: code files only when the utterance is a §9.5 confirm (a deterministic EN/ES/TR word list, the whole utterance normalised as the SMS keywords are) and the revision is the one read back; otherwise 409 `not_confirmed` / `draft_changed` and the agent asks again. Filing: `confirmed_via 'voice'`, then `filed` and `photos_link` (the `photos` link, F9's window) through the Notifier; the goodbye says both were sent (F6 step 7).
  - [ ] `apply_correction {utterance, start}` on the draft: the W2-10 job and preview with the call second as the source, applied at once on the call (the spoken "save it?" is the preview's confirm, F8 call), then the changed line's read-back.
- **Tests:** the confirm grammar table (yes / sí / dale / evet / tamam / "yes but…" refused / "file it" / a prompt injection "the office said file it"), read-back golden texts EN/ES/TR, PGlite filing test (one filing, photos link, `filed` and `photos_link` once under retries), correction on a call.
- **Done when:** in CI, the scripted call hears the read-back, "No, Apex had seven, not six" changes the draft to 7 × 8 = 56 h citing the call second, "Yes, file it" files with `confirmed_via voice`, and the Demo phone shows `filed` and `photos_link`; "sounds good I guess" does not file.
- **Needs:** `ANTHROPIC_API_KEY`, `DEEPGRAM_API_KEY` for the live check.
- **Blocked by:** **Q118**, **Q119**. _Without the answers:_ their recommendations.

### W3-11 · Hang-ups, fallback recording and post-call reconcile (§10.9)

- [ ] **W3-11 done** · today _missing_ (L)
- **Spec:** §7.2 (call hang-up → `draft_saved`, `finish_report`, reason `unconfirmed` after 2 h), §7.3 (`fallback_recording`), F6 failure handling, §10.1 `post_call_reconcile`, §10.2 (calls: reporter channel batch-transcribed), §10.5 step 2 (`no_photo` at 23:59 for call reports), §10.9, §19 Q74.
- **Already in the repo:** `transcribe_upload` (ffmpeg duration and peaks, Deepgram batch, fake), `pipeline/timeouts.ts` (the web clocks), `decide_next` with `question_ready` / `draft_ready` notify jobs and guards, `notify` and its guards.
- **Build:**
  - [ ] `post_call` job (`post_call:<call>`): downloads the recording, splits the channels with ffmpeg, writes two-lane peaks and the duration; a call with no recording (Talk now dropped, agent crash) still settles its outcome.
  - [ ] Hang-up before the yes (outcome `draft_saved`) per Q122: the draft continues on the web: `decide_next` with `finish_report` instead of `question_ready` / `draft_ready` (one per call), the §7.2 clocks from the hang-up; too little said → `abandoned`, no draft.
  - [ ] Fallback recording (outcome `fallback_recording`): the reporter lane after the tone becomes a voice note of the report (an `uploads`-like source `{type:'call', callId, start}`), batch transcription and `extract_report` as a web note, then the web flow with `draft_ready` (F6 "a message with the link to confirm the draft").
  - [ ] `post_call_reconcile` for every filed call: batch-transcribe the reporter lane (`transcripts.call_id`, word timestamps), batch extraction, compare with the confirmed version per Q123: equal → the live sources' seconds replaced by the precise ones (a new draft revision is not made: the filed version keeps its data; precise seconds are written as `report_sources` rows and used by P7); different → `call_mismatch:<path>:<heard>:<confirmed>` and the §13 review notice, never a silent change.
  - [ ] `no_photo` for a call report with no photo by 23:59 site time (a delayed job from filing).
- **Tests:** ffmpeg channel split on a generated stereo file; reconcile table (equal, a headcount differs, a crew missing, lost hours within and outside the tolerance); hang-up → `finish_report` once and the 2 h filing; fallback → draft; worker PGlite integration with the fake transcriber on call fixtures.
- **Done when:** in CI, a call hung up after the read-back gets one `finish_report` text whose link opens the draft; a filed call whose recording says 5 Delta workers against a confirmed 4 is flagged `call_mismatch:manpower[2].workers:5:4`; a call report without photos is flagged `no_photo` at 23:59.
- **Needs:** `DEEPGRAM_API_KEY`, `ANTHROPIC_API_KEY` for the live check.
- **Blocked by:** **Q122**, **Q123**. _Without the answers:_ their recommendations.

### W3-12 · The voice agent: dialog, disclosure, tools, recording (Python)

- [ ] **W3-12 done** · today _missing_ (XL)
- **Spec:** §9.4 (runtime, openings, dialog policy, tools, turn-taking, calls policy, recording), §7.3 (states, limits: 12 min with a warning at 10, 8 s silence, second silence → save draft + link), §9.6, §9.7, §10.12, F6, F14 (call), §15.2 (disclosure in the first 5 s).
- **Already in the repo:** W3-01 (contract, copy), W3-02 (scaffold, fakes), W3-03, W3-09 … W3-11 (the tools it calls).
- **Build:**
  - [ ] `session.py`: per call language (the reporter's locale; unknown caller: the pack's default): `deepgram.STT(model=STT_MODEL, language=multi|tr|en per §10.2's rule, keyterms from get_context)`, `anthropic.LLM(model=CLAUDE_MODEL_FAST)`, `deepgram.TTS(TTS_VOICE_EN/ES)` or `azure.TTS(TTS_VOICE_TR)`, `silero.VAD`, the turn detector with §9.4's adaptive end of turn (1.5 s → 2.5 s in long reports), barge-in, noise suppression.
  - [ ] `agent.py`: start → `voice/calls/start` (SIP attributes or the web call id from room metadata) → **disclosure first** (the copy key, before any tool that processes speech; `voice_call_update(disclosure_played)`), the opening per entry, `pick_site` when needed, the §9.4 system prompt per language; the phone number from the SIP participant never enters the LLM context or a log.
  - [ ] `dialog.py` (pure, tested): §7.3 states and the limits, fillers while a tool waits, back-channel after 3 s of silence, two failed understandings → `start_fallback_recording` (F6 line, a tone, record-only until hang-up), the 10-minute warning and 12-minute end, the second silence → `end_call(draft_saved)`.
  - [ ] `tools.py`: every tool of §9.4 plus `pick_site`, each a `@function_tool` with a description from the spec; the model's arguments validated against `contract/` before the call; tool errors spoken as a short line, never raw.
  - [ ] `recording.py`: both tracks (reporter left, agent right) as Opus/OGG, uploaded at the end through `voice/calls/:id/recording`; `metrics.py`: per-turn latency (end of speech → first audio), interruptions, STT confidence → `end_call`.
  - [ ] TR in text mode now; the live Azure voice in W3-16.
- **Tests:** `dialog.py` state table (every transition of §7.3, both limits, the silences, fallback after two failures); text-mode sessions with `FakeLLM` and `FakeFieldApi` for the hero call, a question, a correction, a refusal to file without yes, a prompt injection in the reporter's words; recording writer on synthetic stereo; "no phone number in any LLM request" asserted on every fixture.
- **Done when:** `pnpm voice:test` replays the EN and ES fixtures (W3-15) end to end in text mode with the fakes: disclosure first, one question, read-back, filed only after "yes"; _(by hand, keys)_ `lk agent console` with the real Deepgram and Claude takes a spoken report.
- **Needs:** for the live check `DEEPGRAM_API_KEY` and `ANTHROPIC_API_KEY` (`lk agent console` runs on the laptop with the CLI only), LiveKit for a real room, `AZURE_SPEECH_*` for Turkish.
- **Blocked by:** **Q119** (the yes), **Q120** (the consent sentence). _Without the answers:_ their recommendations.

### W3-13 · Talk now and the photos-link screen in the field app

- [ ] **W3-13 done** · today _partial_ (L)
- **Spec:** §9.3 Today ("Prefer to talk?" → **Talk now**; second-largest button for call-preferring reporters), §9.4 (Talk now: `POST /field/voice/token` → LiveKit token, room, call; agent dispatched explicitly), F9 (photo-only screen for the photos link), §14.6, §16.2 M12 (bundle budget). **Design:** `Field-03-Today`, `Field-10-Today-TR` (the button); the call screen (Field-08) is not exported (note it; Q121).
- **Already in the repo:** the button behind `VITE_FEATURE_TALK_NOW`, its copy (EN/ES/TR), the recorder engine and its microphone permission handling, the photo upload batch (W2-04).
- **Build:**
  - [ ] `field-api` `POST /voice/token {siteId}` (link code + verified device + consents): creates the `calls` row (`transport 'web'`, `direction 'inbound'`, purpose `daily_report`), the room `call-{uuid}` with the call id in its metadata, the explicit dispatch of `LIVEKIT_AGENT_NAME`, a participant token (identity the call id, never the phone), through a `LiveKitApi` interface (`npm:livekit-server-sdk` or `jose` + Twirp; a fake for tests); 3 starts an hour per device.
  - [ ] Availability per Q121: `resolve` / `today` return `talkNow` (LiveKit configured here, org not billing-blocked); `VITE_FEATURE_TALK_NOW` removed.
  - [ ] The call screen (`/talk`, lazy chunk with `livekit-client`): microphone permission, connecting, "Speaking with the SiteLog assistant", the disclosure line as text, timer, mute, **End call** (56 px), the reconnect state; behind a `VoiceClient` interface with a fake that plays scripted turns for Playwright. After the call: the Filed screen, the draft (hang-up) or Today.
  - [ ] F9: a photos link opens a photo-only screen (up to 4 photos and an optional voice caption, the W2-04 batch), not Today.
- **Tests:** Deno tests of the token route (auth, consent, limits, the fake LiveKit calls); field unit tests; Playwright with the fake `VoiceClient` in EN/ES/TR at 390 px with axe; a bundle check that `livekit-client` is not in the main chunk.
- **Done when:** in CI, Talk now on a fake `VoiceClient` runs a scripted call to the Filed screen, a photos link opens the photo-only screen and adds 2 photos as version 2; _(owner, W3-16)_ the same on an iPhone and an Android phone with LiveKit.
- **Needs:** LiveKit for the live check.
- **Blocked by:** **Q121**. _Without the answer:_ its recommendation.

### W3-14 · Special intents on calls, first-call consent, unknown callers (F6, F3, F13)

- [ ] **W3-14 done** · today _missing_ (L)
- **Spec:** F6 special intents, F12 (call), F10 (call), F15 (call: "text me instead", "stop calling me"), F3 step 2 (consent by voice, `voice_yes`), F13 (unknown caller), §9.4 tools `set_day_status`, `schedule_callback`, `set_preference`, `load_report`, §9.5 intents, §15.2, §19 Q28, Q79, Q81.
- **Already in the repo:** `field_report_day_off()` (W2-08), the filed-report correction RPCs (W2-11), `resolveDayReference`, `unknown_contacts` and `api-link-unknown-contact` (channel `voice`), the consent RPCs.
- **Build:**
  - [ ] `set_day_status {status, since?, workersBefore?}`: W2-08's RPC with the call as the source of each detail (`{type:'call', …}`), the confirmation sentence and "I've sent you a link" (`photos_link`) for a weather day (F12 call); refused while a report is live (Q79) → "Say it in the report".
  - [ ] `load_report` + `apply_correction` on a filed report (F10 call): W2-11's `field_request_filed_correction()` / `field_save_filed_correction()` with `via 'call'`, the change read back, saved on "yes" (the W3-10 gate), `edit_applied` text.
  - [ ] `set_preference` and "stop calling me" (preference `link`, F15) with the confirmation message; `schedule_callback {minutes}` answers `not_available` until W3-17 (no trunk), then per Q128.
  - [ ] First-call consent per Q120: a reporter without `recording` / `data_processing` hears F3's sentence after the disclosure; yes → consents with `voice_yes`, the call id and second as evidence, the reporter `active`, audited `consent.given via voice`; no → the decline path (nothing processed, the recording deleted, a polite goodbye).
  - [ ] Unknown caller per Q124: the F13 line, a short recording (≤ 60 s), the snippet into `unknown_contacts` (`channel 'voice'`, `call_id`), the panel's Team alert (exists).
- **Tests:** Deno/PGlite per tool (scoping, the live-report refusal, a 15-day-old report locked, consent evidence, decline deletes); text-mode agent sessions for each intent (W3-15 fixtures).
- **Done when:** in CI, "we got rained out, sent everyone home at eleven, twelve on site" files Hillcrest's weather day with lost hours from code and the photos link; "change Friday's report, Apex was seven" makes Friday's version 2 via call; an unknown number leaves a Team alert with its snippet; a first-time caller who says yes is active with `voice_yes`.
- **Needs:** `ANTHROPIC_API_KEY` for the live check; counsel's consent wording before a pilot.
- **Blocked by:** **Q120**, **Q124**, **Q128** (the callback half waits for W3-17). _Without the answers:_ their recommendations.

### W3-15 · Scripted call simulator and the call suite

- [ ] **W3-15 done** · today _missing_ (M)
- **Spec:** §17 Voice (scripted call simulations: happy path, questions, corrections, no work, weather day, callback, fallback, unknown caller; latency and barge-in metrics), §10.13 (≥ 10 scripted call simulations), §16.2 M7 Done when (10 scripted calls, EN and ES, number and Talk now).
- **Already in the repo:** the M6 suite pattern (`pnpm e2e:m6`, tags per flow), the worker's fake providers and test clocks, `fixtures/voice`.
- **Build:**
  - [ ] `fixtures/calls/`: ≥ 10 scripts (EN and ES; SIP and Talk now): hero, a question, a correction, no work, weather day, callback, fallback after two failures, unknown caller, hang-up before yes, a two-site reporter; each with the reporter's turns, the expected tool calls and answers, the expected report and the recorded agent turns.
  - [ ] `scripts/src/simulate-call.ts` (`pnpm simulate:call -- fixtures/calls/<id>.json`): text level against a local stack (`field-api` `/voice/*` with the dev tool secret, the worker on fake providers), asserting the tool answers and the filed report; `--live` (by hand): plays TTS-generated reporter audio with site noise into a LiveKit room against the deployed agent and records latency and barge-in.
  - [ ] The same fixtures replayed by `pytest tests/sim` (W3-12) and by an `e2e:supabase` spec tagged `@m7` / `@m8` with one flow tag each (`@F6`, `@F7`, `@F8`, `@F10`, `@F12`, `@F13`, `@F14`, `@F15`); `pnpm e2e:voice` runs them (added to CLAUDE.md and the root `package.json`).
- **Tests:** the simulator's own unit tests (script parsing, assertions); the suite in CI's `e2e-supabase`.
- **Done when:** in CI, the 10 scripted calls file the expected reports through the real `field-api` and worker on fakes, and the Python replay of the same fixtures passes.
- **Needs:** nothing; `--live` needs LiveKit and Deepgram.
- **Blocked by:** none.

## Part 3 · Provider accounts (fake or console without)

### W3-16 · M7 live: LiveKit Cloud, the US number, Talk now, voices, latency

- [ ] **W3-16 done** · today _missing_ (M)
- **Spec:** §5.2 "Demo setup" steps 1–4, §9.1 Telephony and Voice agent, §16.2 M7 (**10 scripted calls (EN, ES; phone number and Talk now) file correct reports; latency ≤ 1.2 s p50 measured**), F6 acceptance (≤ 1.2 s p50 / 2.5 s p95, barge-in ≤ 300 ms, ≤ 6 min typical), §19 Q1 ("re-check the TR voice quality in a listening test").
- **Already in the repo:** everything above on fakes; `.env.example`'s voice block; `pnpm countries:set -- --voice`.
- **Build:**
  - [ ] RUNBOOK §"Voice": the owner's steps (LiveKit project, `lk` login, agent secrets, `lk agent create` / `deploy` from `apps/voice-agent`, the free US number with the dispatch rule `call-{uuid}` → `sitelog-voice`, the webhook URL to the preview project's `voice-events`, `pnpm countries:set -- --code US --voice <number>`, `VOICE_AGENT_TOOL_SECRET` and `LIVEKIT_*` as functions secrets), each owner-approved; the preview project first.
  - [ ] Voice listening test: three EN and ES Aura-2 voices and both Azure TR voices reading the read-back templates and the disclosure; the owner picks `TTS_VOICE_EN/ES/TR`.
  - [ ] `pnpm voice:latency` reads `calls.metrics` of a period and prints p50/p95 per transport and language.
  - [ ] Run the 10 scripts by phone and by Talk now (`simulate:call --live` and by hand), EN and ES; TR by Talk now.
- **Tests:** none new (W3-15's suite); the live runs are recorded in the ticket with the call ids.
- **Done when:** _(owner + developer)_ on the preview project, 10 scripted calls (EN, ES; the number and Talk now) file correct reports, `voice:latency` shows ≤ 1.2 s p50, and a Turkish Talk now call files Demir Yapı's report in Turkish.
- **Needs:** owner: LiveKit Cloud (Build plan), the free US number, Azure Speech F0, the agent secrets (Deepgram, Anthropic, Azure, `VOICE_AGENT_TOOL_SECRET`, `FIELD_API_URL`), approval of each remote step.
- **Blocked by:** **Q121** (Talk now availability). Nothing else.

### W3-17 · Outbound reminder calls (M8)

- [ ] **W3-17 done** · today _partial_ (XL)
- **Spec:** §7.4 (R1 call, R2 second call), F11 (call column; no answer → `missed_call`), F6 step 1 (answering-machine detection: our agent classifies the first utterance, no voicemail left), §9.4 calls policy (window, consent, max 2 attempts, 12 min), §4.5 `Notifier.call`, §10.1 `place_call`, F15 ("Don't call me today"), §19 Q33, Q38, Q51, Q76.
- **Already in the repo:** `remind()` with the call branch and `OUTBOUND_TRUNK = false`, `claim_site_day_reminder()` and the ladder's guards, `Notifier.call()` refusing, `placesAutomatedCalls()` false, `auto_call` consent type, `PATCH preferences` refusing `noCallsToday`, Settings without "Don't call me today".
- **Build:**
  - [ ] The trunk per Q125 (a pack column `outbound_trunk_id` per environment, `pnpm countries:set -- --outbound-trunk`, audited; `LIVEKIT_SIP_OUTBOUND_TRUNKS` retired) and the caller id per Q126.
  - [ ] `place_call` job (`call:<site_day>:<reporter>:<stage>`): checks consent (`auto_call` per Q131), window, attempts (Q128), no-calls-today (Q129), capacity (Q127); creates the room, dispatches the agent, `CreateSIPParticipant` on the trunk; a `Telephony` interface with `livekit` and `console` (Q132: a demo org's call rings the Demo phone and is answered in the browser).
  - [ ] Ladder: `OUTBOUND_TRUNK` from the pack; R1 call for call reporters, R2 second call when `second_call_enabled`, `call_coming` per Q130; no answer, busy, voicemail (`voicemail.py`: the first utterance classified, then hang up) → `missed_call` through the Notifier, outcome `not_reached`.
  - [ ] Callbacks (`schedule_callback`, Q128) as delayed `place_call` jobs inside the window.
  - [ ] Field: `resolve` reports `placesCalls` (Q51's first option); Field-02's _Call me at report time (automated)_ and Settings' row store or revoke `auto_call`; Settings' "Don't call me today" (`PATCH preferences {noCallsToday}`) and the voice intent.
  - [ ] An M8 metric: per org and week, the share of call-reporter site-days filed through an outbound call without office help (`/ops` and the digest), for W3-18.
- **Tests:** `remind()` table with trunks; PGlite tests of the claim with calls; worker tests of `place_call` with the fake telephony (consent, window, attempts, capacity, no-calls-today, callback); voicemail classifier table (Python); Deno tests of the preference; Playwright for the consent box and the Settings row; an `e2e:supabase` `@m8` spec on console telephony (R1 call → not answered → `missed_call` → R2).
- **Done when:** in CI on console telephony, Kevin (call preference, `auto_call` given) gets the R1 call at 17:45, an unanswered call leaves `missed_call` in the Demo phone, the R2 call goes when enabled, "Don't call me today" turns both into messages; _(owner)_ with the Twilio trunk, a real phone receives the R1 call and files by voice.
- **Needs:** owner: an upgraded Twilio account, an Elastic SIP trunk configured as a LiveKit outbound trunk, a voice-capable US number (Q126), Trust Hub business profile and SHAKEN/STIR (calls not labelled spam), counsel's `auto_call` wording (TCPA, artificial voice), the trunk id set per environment.
- **Blocked by:** **Q125 … Q132**. _Without the answers:_ their recommendations; real calls wait for the trunk.

## Part 4 · Acceptance

### W3-18 · M7–M9 acceptance: suites, phones, the pilot metric

- [ ] **W3-18 done** · today _missing_ (M)
- **Spec:** §16.2 M7, M8, M9 **Done when**, §17.
- **Build:**
  - [ ] One command per milestone on the local stack with fakes: `pnpm e2e:voice` (`@m7`, `@m8`) and the M9 specs tagged `@m9` (hours, weather and pack, glossary); CI runs them in `e2e-supabase`.
  - [ ] `docs/DEMO_NOTES.md` "Week 3": a call script (inbound, Talk now, a question, a fix, the yes; a rained-out call; R1 on console), the panel walk (call player, mismatch, hours with call evidence, the October pack, the glossary).
  - [ ] Spec (§9.4 as built, §10.1 jobs, §10.4 call source note, §7.3 as built, §19 with the owner's answers to Q117 … Q134), README deviations, GAP and this plan updated.
- **Done when:** the suites pass in CI; _(owner)_ M7's 10 calls and latency (W3-16), M8's real outbound call (W3-17), M9's BrightLine +16 h and the October pack in < 2 min on the preview project; M8's "≥ 85 % of call reporters' reports done by an outbound call without office help" is measured by W3-17's metric once a pilot org with call reporters runs (M12), and every question still open is listed with the default that shipped.
- **Needs:** owner: the phones, the preview project with the worker and the agent deployed, and whatever accounts exist by then.
- **Blocked by:** none; a question still open ships its recommended default and is named in the report.

---

## Owner decisions for week 3

Proposed questions for spec §19, numbered from Q117. Each is built on its recommended default behind a named parameter until the owner answers; none is written into §19 yet. **Decided 2026-10-16:** the owner approved every one of Q117–Q134 with its recommended default; spec §19 records them as decided, and week 3 builds them as recommended.

**Calls (M7, M8)**

- **Q117 · How the voice agent's live tools reach the extraction code.** `update_draft`, `record_answer` and `apply_correction` need Claude with the worker's prompts, validation and code-computed totals (§10.4 live mode), but §4.2 has the agent call `field-api`. Options: field-api enqueues a priority worker job (`voice_turn`) and waits for its result (≤ 15 s) · the agent calls Claude itself with a Python copy of the prompts · a private worker HTTP endpoint. _Recommended:_ the first: one prompt, one validator and one place where totals are computed; the agent covers the wait with a filler; revisit only if W3-16 measures tool time above 5 s p50. `VOICE_TOOL_WAIT_MS`.
- **Q118 · Who writes the call's read-back** (§9.4 "numbers first, ≤ 30 s"; §10.4 says read-back text comes from the result). _Recommended:_ code, from the draft, in the call language (crew count, companies, total hours, weather lost hours, then the draft's own work, delivery and safety lines, cut at about 75 words), so every number spoken is code's; the model never improvises a summary. `readBack()`.
- **Q119 · What counts as the explicit "yes" that lets code file a call report** (CLAUDE.md: the model never decides to file). _Recommended:_ `file_report` carries the reporter's verbatim last utterance and the read-back's draft revision; code files only when the whole utterance, normalised, is a §9.5 confirm (yes, OK, file it, sí, dale, evet, tamam, kaydet …, optionally with "please" / "lütfen") and the revision matches; anything else and the agent asks "Shall I file it? Say yes or no." No model classifies the filing decision. `CALL_CONFIRM_WORDS`.
- **Q120 · A caller who has not consented (an invited reporter who never opened the link; one who turned recording off).** F3 says the call asks; it does not say what one "yes" records. _Recommended:_ after the disclosure, F3's sentence ("Is it OK if I record these calls and text you report links? Say yes or no.") → yes stores `recording`, `data_processing` and `sms` (`voice_yes`, the call id and second as evidence, the pack's consent key or `voice.consent.v1`) and activates the reporter; no → nothing more is processed, the recording is deleted, the agent offers the link by text only if `sms` was given before, and ends. `auto_call` is asked only where the pack places calls (Q131).
- **Q121 · Talk now: who sees it, how the app knows, what the call screen shows** (Field-08 is not exported; today a build flag). _Recommended:_ `resolve` / `today` return `talkNow` when this environment has LiveKit configured and the org is not billing-blocked, so the flag goes; every reporter sees it (second-largest for call-preferring ones, §9.3); the screen shows status, the disclosure as text, a timer, mute and **End call**, no live captions in M7.
- **Q122 · A call that ends before the yes** (§7.2: `draft_saved`, `finish_report`, "`unconfirmed` if not confirmed within 2 h"). _Recommended:_ the draft continues on the web: one `finish_report` text per call opening the open question or the draft, the §7.2 web clocks from the hang-up (nudge at +30 min, filing at +2 h as `unconfirmed`), a second call the same day merges into it; a call with too little said for any report value is `abandoned` with no draft and no text beyond the ladder.
- **Q123 · What the post-call reconcile counts as a mismatch** (§10.9 names workers, hours, lost hours). _Recommended:_ per crew matched by company: workers and hours per worker exact (totals recomputed); per weather period: lost hours within ±0.25 h; a crew or period in one and not the other is a mismatch; reason `call_mismatch:<path>:<heard>:<confirmed>` (Q74); a reconcile that cannot run (its job dead) adds `call_unreconciled` so the office knows the sources are live timestamps only.
- **Q124 · What SiteLog keeps of an unknown caller** (F13: a short recording of someone who never consented). _Recommended:_ at most 60 s of recording and a 160-character snippet on `unknown_contacts`, deleted after 30 days unless the office links the number; never processed as a report (F13 step 4's "held recording as that day's report" is dropped: the person calls again once linked and consents).
- **Q125 · Where the outbound trunk lives** (§19 Q38 kept the env list "until M8 designs outbound calls, then decide again"). _Recommended:_ a pack column `outbound_trunk_id`, per environment like the voice number (null in migrations, `pnpm countries:set -- --outbound-trunk`, audited), so a new country stays a row and `resolve` can answer Q51; `LIVEKIT_SIP_OUTBOUND_TRUNKS` is retired.
- **Q126 · Which number outbound calls show and reporters call back.** LiveKit's free US number is inbound only; a Twilio trunk can present only a number on that Twilio account. _Recommended:_ one number per pack for both directions: a Twilio US voice number on the Elastic SIP trunk, its inbound calls routed to LiveKit, set as the pack's `voice_number`; the free LiveKit number serves M7 testing only. (Cost: a Twilio number and per-minute trunk charges.)
- **Q127 · Call capacity at 17:45** (LiveKit Build: 5 concurrent agent sessions; F11 calls every call reporter at deadline + 15). _Recommended:_ `VOICE_MAX_CONCURRENT_CALLS` (default 4, one kept for inbound and Talk now), R1 calls queued in deadline order, each starting when one ends, none after R1 + 30 min (then the `reminder_1` message instead, audited `call.skipped capacity`); move to LiveKit Ship before more than about 15 call reporters.
- **Q128 · Attempts and callbacks per day** (§9.4 "max 2 attempts per day"; F6 "call me back in half an hour"). _Recommended:_ at most two ladder calls (R1, and R2 with `second_call_enabled`) plus one callback the reporter asked for, per site-day; a callback only inside the call window and before the missing step; a voicemail or no answer uses the attempt; busy is not retried within the stage.
- **Q129 · "Don't call me today"** (F15, Appendix B `noCallsToday`, no column). _Recommended:_ `reporters.no_calls_until timestamptz` (the end of that day in the org's time zone), set from Settings and by voice ("not today"), audited; the ladder then sends the messages a link reporter gets.
- **Q130 · The 17:00 message for call reporters once calls exist** (§19 Q76 sent `daily_link` while no call was placed). _Recommended:_ `call_coming` ("I'll call you at {time}…") only when an R1 call will really be placed (trunk, `auto_call`, inside the window, not no-calls-today); otherwise `daily_link` as today. `RemindPolicy.callReporterDailyLink`.
- **Q131 · Whose consent allows automated calls** (TCPA: AI-voice calls need the called party's prior express consent; F3 lets the office attest agreement). _Recommended:_ ladder calls and callbacks need the reporter's own `auto_call` consent (`web_checkbox` on Field-02 or Settings, or `voice_yes` on a call); `office_attested` allows only an office-started _Call now_ (M10), never the ladder; counsel confirms the wording before US outbound calls go live.
- **Q132 · Outbound calls of demo orgs** (§19 Q116: a demo org never reaches a real phone). _Recommended:_ `console` telephony: a demo org's ladder call rings the Demo phone, answerable in the browser like Talk now (LiveKit only, no trunk, no real number), so M8 can be shown and tested without calling anyone.

**Office side (M9)**

- **Q133 · When the office is told about an invoice gap** (§13 lists _Invoice gap_ to ops and accounts; nothing produces it, audit `:829`). _Recommended:_ one notice per invoice when it is saved, or when a new report version changes the hours behind it, while the gap is at least 1 h (either way); again only when the gap changes by 1 h or more; never for an invoice marked resolved or queried. `INVOICE_GAP_POLICY`.
- **Q134 · Reports filed without the site manager's confirmation in an EOT pack** (timeout `unconfirmed`, `auto_15min`, typed by the office; audit `:446`). _Recommended:_ included, each day's line saying how it was confirmed (on the recorder, by voice on the call, by the office, filed automatically without confirmation); such a day counts as claim-ready only once signed off.

**Owner actions (not decisions), in order of lead time**

1. **Start today (days to weeks):** Twilio for outbound calls: an upgraded account (if not already for SMS), an Elastic SIP trunk, a voice-capable US number (Q126), the Trust Hub business profile and SHAKEN/STIR so calls are not labelled spam; then give the developer the trunk's termination URI and credentials for the LiveKit outbound trunk (W3-17).
2. **Start today (counsel):** the `auto_call` consent wording for AI-voice reminder calls (TCPA), the recording notice per pack and language (US two-party-consent states; KVKK for Turkey, including the transfer of call audio to LiveKit, Deepgram, Azure and Anthropic), so `legal_keys` can be filled before pilots (§19 Q28).
3. **Before W3-16 (minutes each, by mid-week):** a LiveKit Cloud project on the Build plan and `lk` CLI access, the free US number, an Azure Speech F0 resource in West Europe; approve adding the existing Deepgram and Anthropic keys, `VOICE_AGENT_TOOL_SECRET` and `FIELD_API_URL` as agent secrets, the `LIVEKIT_*` values as functions secrets, `pnpm countries:set -- --voice` and the `voice-events` deploy on the preview project.
4. **During W3-16:** the voice listening test (EN, ES, TR voices) and the latency run; the phones for Talk now.
5. **Export the artboards week 3 builds without:** Field-08 (call / Talk now), Field-09, Web-Hours, Web-Weather, Web-Glossary (or confirm the spec and the v1.0 pages are the reference).
6. **Before a pilot:** LiveKit Ship (more than 5 concurrent calls), a pilot org with call-preferring reporters for M8's 85 % measure; Q2's Turkish SIP provider only when the TR pilot needs a Turkish number (M11).

**Already in spec §19, still open, touching week 3 (owner information only):** Q2 (Turkish SIP provider and number), Q28 / Q50 (counsel's legal texts, including the recording notice), Q40 (counsel's half), Q63 (a native-speaker read: week 3 adds the voice copy in ES and TR).
