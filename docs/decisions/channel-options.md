# SiteLog — Field channels (decision record)

**Status:** Decided · **Date:** 2026-10-13, amended 2026-10-14 · **Implemented in:** SITELOG_SPEC.md v1.2 (§0, §3, §4.4–§4.6, §5.1, §5.2, §6.2, §6.3, §7, §8 F3–F24, §9, §15, §19) and the Design canvas page "Field: text link & call"

## Amendment 2026-10-14 — country packs and message channels (owner decision; consequences in GAP D47–D49)

**The owner's decision, verbatim:**

> Karar: SiteLog global bir ürün; ülkeye özel her şey kod değil "ülke paketi" (yapılandırma) olacak. Şu anki ticket'ı bitirince uygula, sonra plana devam et:
> 1. Ülke paketi: orgs.country/locale'deki US/TR sabitlemelerini ve kurulum sihirbazındaki ülke seçimini bir countries yapılandırmasına bağla: ülke kodu, varsayılan diller, birim, kâğıt boyutu, para birimi, mesaj kanalı sırası (ör. whatsapp → sms ya da sms → whatsapp), SMS gönderici tipi ve kimliği, iki yönlü SMS var mı, link içeren SMS'e izin var mı, sesli numara (yoksa yalnızca Talk now), yasal metin anahtarları. Şimdilik US ve TR paketleri olsun; yeni ülke = yeni satır.
> 2. Kanallar: Notifier kanal sırasını ülke paketinden ve kişinin tercihinden alsın. Kanal türlerine whatsapp ve push'u ekle (uygulamaları 2. haftada, M6 hatırlatmalarıyla). Varsayılan sağlayıcı twilio (SMS + WhatsApp), ülke bazında override mümkün olsun; iki yönlü SMS ve URL izni sürücüden değil ülke paketinden gelsin.
> 3. Spec'i (§3, §4.4, §4.5, §5.1, §5.2, §6.3, §9, §15.2, §19), docs/decisions/channel-options.md'yi ve .env.example'ı güncelle, spec'i projeye geri yaz, PLAN_WEEK1'i gerekiyorsa düzelt. Bitince 3 satırlık özet ver.

**In English:** SiteLog is a global product; everything country-specific becomes a "country pack" (configuration), not code. (1) The US/TR hard-coding in `orgs.country`/`locale` and the setup wizard's country choice are bound to a `countries` configuration: country code, default languages, units, paper size, currency, message channel order (e.g. whatsapp → sms or sms → whatsapp), SMS sender type and id, whether two-way SMS exists, whether SMS with links is allowed, the voice number (none = Talk now only) and the legal text keys. US and TR packs for now; a new country is a new row. (2) The Notifier takes the channel order from the country pack and the person's preference. WhatsApp and push join the channel types (built in week 2 with the M6 reminders). Twilio is the default provider (SMS + WhatsApp), overridable per country; two-way SMS and the permission to send links come from the country pack, not the driver. (3) The spec, this record and `.env.example` are updated.

**What it means**

- **Country pack = one row of `countries`** (spec §4.6, §6.3), the one source of truth, read by SQL (`create_org`, `on_org_created`), the panel (RLS read), the worker and edge functions (service role) and the field app (only the subset `field-api resolve` returns). `orgs.country` references it.

  | Pack field | US | TR |
  |---|---|---|
  | Default org locale (report language) | en-US | tr-TR |
  | Field languages | en-US, es-US | tr-TR, en-US |
  | Units · paper · currency · default time zone | imperial · Letter · USD · America/Chicago | metric · A4 · TRY · Europe/Istanbul |
  | Message channel order | `{sms}` in week 1 (real order: spec §19 Q19) | `{sms}` in week 1 |
  | SMS provider · WhatsApp provider | twilio · twilio | iletimerkezi · twilio |
  | SMS sender type · sender id | toll-free · set per environment once verified | alphanumeric · `SITELOG` once approved |
  | Two-way SMS · links in SMS | yes · yes | no · yes |
  | Voice number | set per environment once bought | none (Talk now only) |
  | Legal text keys | to come (§19 Q28) | to come (§19 Q28) |

  A new country is a new row **when** its languages already have their copy, voice prompts, PDF labels and TTS voices, its providers have drivers, counsel has reviewed its legal texts and the panel's phone-country picker lists it (spec §4.6); otherwise it is code (or counsel work) plus the row. Billing and outbound trunks stay outside the pack for now (spec §19 Q30, Q38).
- **Notifier order:** the person's preferred message channel first, if the pack offers it, then the pack's order; a channel is used only if it is built, consented, not opted out (per-channel opt-outs: spec §19 Q40), and (for SMS) allowed to carry the message's link.
- **WhatsApp returns as a message channel, through Twilio,** not the v1.0 Meta Cloud API integration (which is still retired, GAP step 22). Templates and the 24 h service window apply to WhatsApp only; OGG conversion returns only if inbound voice notes are ever accepted (spec §19 Q26).
- **Web push** is an optional channel for the installed field app (iOS allows it only there), never a person's only channel.
- **Both are built in week 2 with the M6 reminders.** Week 1 sends SMS only.
- **Twilio is the default** SMS and WhatsApp provider, overridable per pack.
- **Two-way SMS and links in SMS come from the pack,** never from the driver.

**As built, pending the owner** (not part of the decision above):

- The TR pack keeps İletimerkezi for SMS (spec §19 Q20).
- **`console`** for `is_demo` orgs on every channel, and for any pack with no SMS sender id in that environment, so nothing is sent before a sender is approved and set (`pnpm countries:set`; spec §19 Q29). The rule applies per channel; where the WhatsApp sender and its template ids live is spec §19 Q39.

### Providers as amended (2026-10-14)

The 2026-10-13 rows below stand except these:

| Need | Provider | Free for the demo |
|---|---|---|
| Messaging, SMS + WhatsApp (default for every pack) | **Twilio** (US pack: toll-free number) | Trial can't send custom texts (preset templates, 5 verified numbers) → upgrade + toll-free verification needed for real texts (~$2.15/month number + ~$0.01 per SMS); WhatsApp Sandbox for development (week 2) |
| SMS — TR pack override | **İletimerkezi** (sender `SITELOG`) | 100 test SMS; title approval 1–2 business days via e-Devlet |
| Web push (week 2) | Standard Web Push (VAPID), no provider | Free |
| Demo without real messages | `console` transport + **Demo phone** page in the panel | Free, no registration |

### Consequences as amended (2026-10-14)

| Area | US pack | TR pack |
|---|---|---|
| SMS | `two_way_sms` true: toll-free verification (or A2P 10DLC) before real sends; STOP / HELP / START / CALL / TEXT keywords | `two_way_sms` false: one-way from alphanumeric sender **SITELOG**; no replies, so all interaction happens on the recorder or the call |
| Calls | Voice number per pack (none → Talk now); TCPA prior express consent for automated/AI calls; recording disclosure in the first 5 s | No voice number yet → Talk now; KVKK notice and explicit consent; recording disclosure in Turkish |
| Consent | Stored per person and channel in `consents` | Same |
| Message channel order | `{sms}` in week 1 (spec §19 Q19) | `{sms}` in week 1 |

- Links reach people by message: SMS now; WhatsApp (Twilio) and web push from week 2.
- Reminder ladder: R1 +15 is a message on the person's channel order, or a call for call-preferring users.
- Dropping WhatsApp as the reporting channel still removes Meta template approval, the 24 h window and OGG conversion from the report flow; templates and the 24 h window return for WhatsApp only, as an optional message channel.

## Decision (2026-10-13)

- **WhatsApp is removed.** Field reporting uses two channels only: _(Superseded in part by the 2026-10-14 amendment: the v1.0 Meta WhatsApp integration stays removed, but WhatsApp returns through Twilio as a message channel in week 2, beside SMS and web push.)_
  1. **SMS + personal link → mobile web recorder** (no install; record, add photos, answer one question, confirm).
  2. **Live voice assistant**: listens, asks one question, reads the report back, files on a verbal "yes". Three ways in: call the number, **Talk now** in the recorder (browser call), or an outbound reminder call.
- **The site manager chooses** (`contact_pref`: link | call) on first open of the welcome link, and can always use the other channel. The office can set a default when adding the person.
- **Launch markets: US and Turkey.** Org locale (en-US / tr-TR) sets report language, units and currency. _(Superseded by the 2026-10-14 amendment: markets become country packs, US and TR at launch; the pack presets locale, units, paper, currency and time zone, and the org locale sets the report language.)_

## Providers (v1.2) — demo on free tiers

| Need | Provider | Free for the demo |
|---|---|---|
| Voice runtime | **LiveKit Agents** (open source, Python) on **LiveKit Cloud** Build plan | 1,000 agent minutes/month, 5 concurrent sessions, no card |
| US phone number | **LiveKit Phone Numbers** | 1 US number, 50 inbound minutes/month |
| Speech-to-text (live + batch), EN/ES voices | **Deepgram** (Nova-3, Aura-2) | $200 sign-up credit |
| Turkish voice | **Azure AI Speech** (`tr-TR` neural) | F0: 0.5 M characters/month |
| LLM | **Claude** (Anthropic API) | Paid, small per report |
| SMS — US | **Twilio** (toll-free number) | Trial can't send custom texts (preset templates, 5 verified numbers) → upgrade + toll-free verification needed for real texts (~$2.15/month number + ~$0.01 per SMS) |
| SMS — TR | **İletimerkezi** (sender `SITELOG`) | 100 test SMS; title approval 1–2 business days via e-Devlet |
| Demo without SMS | `console` driver + **Demo phone** page in the panel | Free, no registration |

_(The three SMS rows are superseded in part by the 2026-10-14 amendment: Twilio is the default SMS and WhatsApp provider for every pack, İletimerkezi is the TR pack's SMS override, web push joins in week 2, and `console` covers every message channel; see "Providers as amended".)_

Why LiveKit: largest free allowance, Claude/Deepgram/Azure plugins, phone and browser calls through one agent, and it can be self-hosted later (no platform fee, no lock-in). Checked alternatives: Vapi ($10 credit, then $0.05/min + providers), ElevenLabs Agents (15 free min/month, then $0.08/min), Deepgram Voice Agent API ($200 credit, $0.075/min, no Turkish Aura voice).

**Turkey without a Turkish number:** calls in TR use **Talk now** (browser call) until a Turkish SIP trunk (Verimor / Netgsm) is added for the pilot.

## Why the channel change

The product value is "report by voice in ~3 minutes without learning an app", not WhatsApp itself. The pipeline (transcribe → extract → one question → confirm → PDF) is channel-agnostic. Dropping WhatsApp removes Meta template approval, the 24 h window and OGG conversion, and gives full control of the field UX. _(Amended 2026-10-14: WhatsApp returns through Twilio as an optional message channel, not as the reporting channel; templates and the 24 h window apply to it only.)_

## Consequences

| Area | US | Turkey |
|---|---|---|
| SMS | Two-way; toll-free verification (or A2P 10DLC) before real sends; STOP / HELP / START / CALL / TEXT keywords | One-way from alphanumeric sender **SITELOG**; no replies, so all interaction happens on the recorder or the call |
| Calls | TCPA prior express consent for automated/AI calls; recording disclosure in the first 5 s | KVKK notice and explicit consent; recording disclosure in Turkish |
| Consent | Stored per person and channel in `consents` | Same |

_(Amended 2026-10-14: the columns are the US and TR packs, and two-way SMS, the voice number and the channel order are pack values; see "Consequences as amended".)_

- Reminder ladder: daily link 17:00 · weather heads-up −35 min · R1 +15 (SMS, or a call for call-preferring users) · R2 +60 · missing +90 (office alert). _(Amended 2026-10-14: R1 is a message on the person's channel order, or a call.)_
- Post-call reconcile re-runs transcription on the full recording; differences raise `call_mismatch` for office review instead of silently changing a confirmed report.
- WhatsApp, Telegram or Teams can return later as optional adapters behind the same channel interface (§4.5). _(WhatsApp returned with the 2026-10-14 amendment, as a message channel through Twilio, built in week 2.)_

## Still open

- Turkish SIP provider and number (Verimor / Netgsm) — only when the TR pilot asks for a real Turkish number.
- Turkey billing provider and Turkey pricing.
- Legal review of US (TCPA, toll-free / 10DLC) and Turkey (KVKK, İYS, cross-border transfer to LiveKit / Deepgram / Azure / Anthropic, and for WhatsApp to Meta / Twilio) before launch.
- Country packs and message channels: spec §19 questions 19–40. Waiting for the owner: Q19 (channel orders), Q22 (fallback), Q25 (first contact and WhatsApp consent, with Q24 for packs without links in SMS), Q26 (inbound WhatsApp), Q27 (web push), Q39 (WhatsApp sender and templates), Q40 (per-channel opt-out) before M6; Q28 (legal text keys) before go-live; Q30 (billing outside the pack) before M10. The rest carry recommendations followed unless the owner objects.
