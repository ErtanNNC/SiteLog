# SiteLog — Field channels (decision record)

**Status:** Decided · **Date:** 2026-10-13 · **Implemented in:** SITELOG_SPEC.md v1.2 (§4.4, §4.5, §5.2, §7, §8 F3–F24, §9, §15, §19) and the Design canvas page "Field: text link & call"

## Decision

- **WhatsApp is removed.** Field reporting uses two channels only:
  1. **SMS + personal link → mobile web recorder** (no install; record, add photos, answer one question, confirm).
  2. **Live voice assistant**: listens, asks one question, reads the report back, files on a verbal "yes". Three ways in: call the number, **Talk now** in the recorder (browser call), or an outbound reminder call.
- **The site manager chooses** (`contact_pref`: link | call) on first open of the welcome link, and can always use the other channel. The office can set a default when adding the person.
- **Launch markets: US and Turkey.** Org locale (en-US / tr-TR) sets report language, units and currency.

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

Why LiveKit: largest free allowance, Claude/Deepgram/Azure plugins, phone and browser calls through one agent, and it can be self-hosted later (no platform fee, no lock-in). Checked alternatives: Vapi ($10 credit, then $0.05/min + providers), ElevenLabs Agents (15 free min/month, then $0.08/min), Deepgram Voice Agent API ($200 credit, $0.075/min, no Turkish Aura voice).

**Turkey without a Turkish number:** calls in TR use **Talk now** (browser call) until a Turkish SIP trunk (Verimor / Netgsm) is added for the pilot.

## Why the channel change

The product value is "report by voice in ~3 minutes without learning an app", not WhatsApp itself. The pipeline (transcribe → extract → one question → confirm → PDF) is channel-agnostic. Dropping WhatsApp removes Meta template approval, the 24 h window and OGG conversion, and gives full control of the field UX.

## Consequences

| Area | US | Turkey |
|---|---|---|
| SMS | Two-way; toll-free verification (or A2P 10DLC) before real sends; STOP / HELP / START / CALL / TEXT keywords | One-way from alphanumeric sender **SITELOG**; no replies, so all interaction happens on the recorder or the call |
| Calls | TCPA prior express consent for automated/AI calls; recording disclosure in the first 5 s | KVKK notice and explicit consent; recording disclosure in Turkish |
| Consent | Stored per person and channel in `consents` | Same |

- Reminder ladder: daily link 17:00 · weather heads-up −35 min · R1 +15 (SMS, or a call for call-preferring users) · R2 +60 · missing +90 (office alert).
- Post-call reconcile re-runs transcription on the full recording; differences raise `call_mismatch` for office review instead of silently changing a confirmed report.
- WhatsApp, Telegram or Teams can return later as optional adapters behind the same channel interface (§4.5).

## Still open

- Turkish SIP provider and number (Verimor / Netgsm) — only when the TR pilot asks for a real Turkish number.
- Turkey billing provider and Turkey pricing.
- Legal review of US (TCPA, toll-free / 10DLC) and Turkey (KVKK, İYS, cross-border transfer to LiveKit / Deepgram / Azure / Anthropic) before launch.
