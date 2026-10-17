# SiteLog — Week 4 build plan (M10 setup, team, settings, billing; M11 Turkish market)

> **Sahibine özet (TR).** 4. hafta iki şey yapıyor. **M10:** yeni bir müşterinin SiteLog personeli olmadan kendini kurması: kurulum sihirbazında tercih edilen kanal ve gerçek SMS karşılama önizlemesi, Ekip sayfasında durumlar, kanal değişikliği, cihaz iptali ve onaylı **Şimdi ara**, Ayarlar'da **Saha kanalları** sekmesi, Faturalandırma'nın v1.2'ye taşınması (ABD Stripe; Türkiye sizin kararınızı bekliyor) ve telefon ülke listesinin sabit 12 ülke yerine tüm bölgelerden gelmesi. **M11:** Türkiye paketinin canlıya çıkışı: panelin kalan sayfaları Türkçe, KVKK metinlerinin gösterileceği sayfa, Türkçe sesli asistan ayarı (sayılar, birimler, saatler), Türkçe başlangıç sözlüğü, İletimerkezi teslim durumu ve `SITELOG` başlığıyla gerçek SMS. İlk dokuz ticket hiçbir anahtar istemiyor; açık sorular önerilen varsayılanla bir parametrenin arkasında kuruluyor. En uzun süren işleri bugün başlatmanız gerekiyor: **İletimerkezi aboneliği (e-Devlet) ve `SITELOG` başlığı**, **avukattan KVKK aydınlatma metni, kayıt bildirimi ve onay metni** (Türkçe ve İngilizce; yurt dışına aktarım dahil), **Türkiye için faturalandırma kararı** (Q8: tüzel kişi ve sağlayıcı, Q9: fiyat) ve ABD için **Twilio toll-free doğrulaması** (yeni bir müşterinin gerçek SMS alabilmesi için). Hafta ortasına kadar: Stripe test modu anahtarları ve fiyatı, Azure Speech F0 (3. haftadan), ve aşağıdaki Q229–Q246 önerilerine onayınız.

Goal: by the end of week 4 a contractor **onboards itself**: signs in, runs the setup wizard, adds a site and its manager with a preferred channel, sees the real welcome text, and gets the first report by link and by call without anyone at SiteLog touching it; the office manages its people on Team (statuses, preference and message channel with the reporter's agreement, devices, office users, an attested _Call now_), its field channels in Settings, and its subscription in Billing (M10). And the **TR pack goes live**: every panel page in Turkish, the KVKK texts behind the pack's `legal_keys`, real SMS from `SITELOG` through İletimerkezi with delivery status, the Turkish voice tuned for numbers, units and names, Turkish starter glossary terms, and the Demir Yapı demo filing link and call reports end to end in Turkish with a Turkish A4 metric PDF (M11). Acceptance is spec §16.2 M10 and M11 (each ticket's **Done when**, W4-16).

Rules: `CLAUDE.md`. Spec: `docs/SITELOG_SPEC.md` (v1.2), §16.2 M10–M11. Designs: `docs/design/`. Audit: `docs/GAP_ANALYSIS.md` ("GAP"), `docs/AUDIT_BACKLOG.md` ("audit"). Weeks 1–3: `docs/PLAN_WEEK1.md`, `docs/PLAN_WEEK2.md`, `docs/PLAN_WEEK3.md` ("W1-xx", "W2-xx", "W3-xx"). "Q41" is question 41 of spec §19. The week-4 questions Q229 … Q246 ("Owner decisions" below) are in spec §19 as open; every ticket that meets one builds its recommended default behind a named parameter, as weeks 2 and 3 did, and the owner's answer either confirms it or flips the parameter.

## Where week 3 leaves us

- M7–M9 are built and green in CI on `spec-v1.2` (PR #1); the owner's live half (LiveKit project, the agent deployed, the US number, Azure, the Twilio trunk, the phone checks) is open: W3-04, W3-11 … W3-13, W3-16 … W3-18 (`docs/GAP_ANALYSIS.md` "Week 3 status", `claude/STATUS.md`). Week 4 is built on `spec-v1.2` and PR #1 exactly as weeks 1–3 were. The last applied migration is `20261016000390_inbound_call_rooms.sql`.
- **Already in the repo that week 4 builds on (M10):**
  - **Setup wizard** (`apps/web/src/app/setup/`, P2, F2): three steps `/setup/company` · `/setup/site` · `/setup/reports`; the country from the packs with the presets shown read-only and locked once the org exists (W1-06a, `CompanyStep.tsx`, `countries.ts`, §19 Q31); a second org is no longer made on Back (`useUpdateOrg`, audit "Setup wizard: Back from step 2…"); site, geocoding with a manual pin (`geocode.ts`), deadline, manager name and phone, languages spoken, an optional backup reporter, _Add another site_, _Send welcome text_; step 3 reuses Settings' `ReportsSection` and the recipients. **v1.0 leftovers:** the preview renders the WhatsApp template `sitelog_welcome` with quick-reply buttons (`SiteStep.tsx:127`, `@sitelog/shared/wa/templates.ts`), the pricing card says "$399" from `copy.setup` (`apps/web/src/copy/en.ts:2181`), and there is no preferred channel, no "language SiteLog uses", no number-country warning (Q23), no line check, no browser-region preselect (Q32). The whole route is inside `<EnglishOnly>` (`apps/web/src/app/routes.tsx`).
  - **Invite** (`supabase/functions/api-invite-reporter/`): already takes `locale` and `contactPref` (defaults: the pack's first field locale, `link`), reuses a reporter with the same phone (F2 edge case), records opt-outs; the panel's dialogs never send either field (`InviteReporterDialog.tsx`, `SiteStep.tsx`). Re-send is a manual button allowed once after 48 h (`canResend`); nothing re-sends by itself (F3).
  - **Team** (`apps/web/src/app/team/`, P10): reporters table, unknown-contact alert with _Link_ / _Ignore_ (`api-link-unknown-contact`, W1-16), Edit (name, role, sites, languages; `update_reporter()`), Re-send, Disable, office users with role change and removal, never the last admin (`api-invite-office-user`). **v1.0 leftovers:** the phone column is headed "WhatsApp" (`copy.team.columns.whatsapp`), `active` reads "Verified", the undeliverable chip is `not_on_whatsapp` from the v1.0 column `reporters.last_invite_error` (`apps/web/src/data/assemble.ts:2798`), the subtitle speaks of WhatsApp messages (`en.ts:1702`). Missing: _Text today's link_ and _Call now_ in the row menu, _Revoke devices_, the preference and message channel (Q21: "the office at invite and on Team (M10)"), the reporter's language, _Add office user_'s UI language (F24). Inside `<EnglishOnly>`.
  - **Settings** (`apps/web/src/app/settings/`, P12): Reports & reminders, PDF template, Recipients, Payroll export, with an unsaved-changes guard; **Field channels is a `ComingNext` placeholder** (`Page.tsx:165`). The §6.3 columns it needs exist (`daily_link_time`, `auto_call_enabled`, `second_call_enabled`, `call_window_start/end`, `packages/shared/src/db/types.ts:176`) and W3-17's ladder reads them; Reports & reminders still says "on WhatsApp" (`en.ts:1924`, `:1934`). Inside `<EnglishOnly>`.
  - **Billing** (`apps/web/src/app/billing/`, `supabase/functions/api-billing/`, `stripe-webhook/`, `_shared/billing.ts`; P13, F23) from v1.0, on the v1.2 `billing_*` columns: Checkout keeping the rest of the 14-day trial (`checkoutTrial`), the customer portal, quantity sync on site create, pause and resume, invoices, `isBillingBlocked` (past due beyond `past_due_grace_days`, canceled, paused) read by the scheduler and by Talk now. **Gaps:** `PRICE_PER_SITE_CENTS = 39_900` in code and `STRIPE_PRICE_ID_SITE_US` (one price, USD, any org), a lapsed trial blocks nothing (`trialing` is never blocked; audit "Stripe 14-day trial … never enforced when it lapses"), no TR provider (§19 Q8, Q9 open), the past-due banner only on the Billing page, the Site settings drawer (Pause) open to pm and ops (audit "Site settings drawer … open to pm/ops", still open), "$399" and WhatsApp wording in the copy (`en.ts:2059`, `:2082`). Staging has no `STRIPE_*` secret (RUNBOOK), so billing has never run there. Inside `<EnglishOnly>`.
  - **Phone picker:** `PHONE_COUNTRIES`, 12 fixed countries (`apps/web/src/components/sitelog/PhoneInput.tsx:10`), a pack outside it falls back to US (§4.6); `libphonenumber-js/min` is already in `packages/shared/src/format.ts` (`normalizeE164`, `formatPhone`).
  - **Calls placed by the office:** W3-17's `place_call` job and `Telephony` (`apps/worker/src/jobs/place_call.ts`, `apps/worker/src/telephony.ts`), `placesCalls()` / `org_places_calls()`; `office_attested` is refused for the ladder by design (§19 Q131; `supabase/db-tests/src/outbound-calls.test.ts`). The Demo phone rings a demo org's calls.
- **Already in the repo (M11):** the TR pack row (`tr-TR`, metric, A4, TRY, `Europe/Istanbul`, one-way `alphanumeric` SMS through `iletimerkezi`, `{push, whatsapp, sms}`, no voice number, `legal_keys {}`); the İletimerkezi driver (`packages/shared/src/sms/transports.ts:177`, never used for a real send; no delivery status: README "İletimerkezi status"); the Turkish shift-table segment counter (`packages/shared/src/sms/segments.ts`); the one-way variants of every §9.2 key; field app, SMS and voice copy in TR (`packages/shared/src/copy/ui/tr.ts` `field`, `sms.tr.ts`, `voice.tr.ts`); the PDF and the EOT pack in Turkish, A4 and metric (`packages/pdf/src/copy.ts`, W1-14, W3-07; Q66 accepted); TR extraction (`REPORT_LANGUAGE`, golden cases `fixtures/transcripts/kartal-2026-10-09-tr.json`, `atasehir-2026-10-08-rain-tr.json`, TR answer and correction clips in `fixtures/voice/`); the agent's Azure TTS path (`apps/voice-agent/src/sitelog_voice/session.py:210`, `TTS_VOICE_TR` default `tr-TR-EmelNeural`) and Deepgram `tr`; Talk now in TR on the fake `VoiceClient` (`apps/field/e2e/talk.spec.ts`); the panel's TR for the shell, Overview, Sites, Site detail, Reports, Report review, Hours, Weather, Glossary, Demo phone (`routes.tsx` header); the §18.2 demo glossary for Demir Yapı.
- **Missing (M11):** the `/legal/<key>` page (§19 Q50 decided its shape; `apps/field/src/lib/legal.ts` only builds the href, and no pack may set a key until it exists); any Turkish call fixture (`fixtures/calls/` is EN and ES only); spoken-form rules for Turkish numbers, units and times (`voiceNumber()` in `packages/shared/src/voice-tools.ts:40` writes "7,5"); a starter glossary for a new org (status `built_in` exists, nothing seeds it); Turkish for Setup, Team, Settings, Billing and New report (`tr.ts` has a few keys of `team` and `settings` and none of `setup`, `billing`, `newReport`, `pdfZip`); Turkish office emails other than the report email (`apps/worker/src/email/templates.ts`: missing, EOT pack ready, digest, unknown contact, edited-after-sign-off are English), and Supabase's magic-link and invite templates (none in `supabase/config.toml`, so Supabase's English default); a field e2e on the stack for Demir Yapı (only the panel's `demir.spec.ts`).

## How each ticket runs in this repo

As in week 3 (`docs/PLAN_WEEK3.md`, "How each ticket runs"), with `W4-xx` as the commit prefix:

1. One ticket at a time, in the order below; check its **Blocked by** list. A ticket whose questions are open builds everything its **Without the answer** line names, behind a parameter whose default is the recommended answer.
2. Build with tests. SQL in a new timestamped migration after the last applied one (`20261016000390` today), `packages/shared/src/db/types.ts` in the same commit (D7), the D11 allowlist and the role matrix updated.
3. Run `pnpm check` and `pnpm format:check`; `pnpm test:db` when SQL changed; `pnpm e2e` when UI changed; `pnpm e2e:supabase` and `pnpm test:stack` when a Supabase data path changed (CI runs both); `pnpm eval -- --recorded` when a prompt or a golden case changed; `pnpm voice:test` when `apps/voice-agent` or the voice copy changed (`pnpm voice:contract -- --check` too). Deno checks run in CI.
4. Tick the boxes, commit `W4-xx: <summary>`, push to `spec-v1.2`; PR #1 green before the next ticket. Report in three lines against **Done when**. _(owner)_ checks need a real phone, a provider account or an owner action; _(by hand)_ checks are the developer's.
5. Every new user-facing string exists in every language of its surface (panel EN/TR, field EN/ES/TR, SMS EN/ES/TR, voice EN/ES/TR, PDF and email EN/TR); the ES and TR texts are listed for the native-speaker read (Q63). **A panel page that a ticket touches leaves `<EnglishOnly>` in that ticket** (its keys in `apps/web/src/copy/en.ts` and `packages/shared/src/copy/ui/tr.ts`, checked by `apps/web/src/copy/tr-keys.test.ts`); W4-09 sweeps what is left.
6. Every v1.0 WhatsApp word a ticket meets in its page's copy goes in that ticket (the welcome preview, Team's column and chips, Settings' hints, Billing's subtitle); GAP step 22 still retires the Meta code itself.

**Never without the owner's approval** (unchanged): any remote action on a hosted project (`db push`, `functions deploy`, `secrets set`, the worker, a seed, `pnpm countries:set`, SQL, **Supabase Auth email templates and redirect URLs**), **Stripe products, prices, webhooks and live-mode keys**, **İletimerkezi sender titles and sends to real numbers**, LiveKit and Twilio numbers, trunks and dispatch rules, Netlify settings, merging into the live branch.

**Keys and accounts.** CLAUDE.md rule 5 applies to every one of them: the ticket builds behind the interface with a fake or `console` implementation and tests, names the key, and moves on.

| Key / account                                                                                                        | Tickets                   | Without it                                                                                                                                                                                            |
| -------------------------------------------------------------------------------------------------------------------- | ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Stripe test mode (`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_ID_SITE_US`), a webhook to the preview | W4-10 (live check), W4-15 | the existing `stripe-webhook` and `api-billing` Deno tests on structural fakes; demo orgs explain Checkout instead of opening it (as today)                                                           |
| TR billing provider and price (§19 Q8, Q9)                                                                           | W4-10, W4-15              | a TR org is billed `manual` (Q236): no Checkout, the trial and sites shown; no provider code beyond the interface                                                                                     |
| İletimerkezi account, `ILETIMERKEZI_API_KEY` / `ILETIMERKEZI_API_HASH`, the approved `SITELOG` title                 | W4-11 (live), W4-13       | the driver and the delivery-status poller against a mocked API; TR texts go to `console` (the pack has no sender id)                                                                                  |
| Twilio: the US toll-free number verified and set (`pnpm countries:set -- --code US --sms-sender …`)                  | W4-12 (owner half), W4-16 | a real (non-demo) org's welcome is written `failed` `console_real_org` (§19 Q48); CI runs the self-serve flow against a local Twilio stand-in (W4-12)                                                 |
| LiveKit (W3-16) and Azure Speech F0 (`AZURE_SPEECH_KEY`, `AZURE_SPEECH_REGION`)                                      | W4-14, W4-16              | TR calls in text mode with the fakes (W4-07); Talk now on the fake `VoiceClient`                                                                                                                      |
| Counsel: the KVKK aydınlatma metni, recording notice and consent wording for the TR pack (and the US texts), §19 Q28 | W4-06 (texts), W4-13      | the `/legal/<key>` page and the plumbing with a test-only key; both packs keep `legal_keys {}` and the field app's and agent's own wording versions (`field.consent.v1`, `voice.recording_notice.v1`) |
| A Turkish SIP provider and number (§19 Q2), only if the TR pilot asks for one                                        | W4-14                     | Talk now only for TR (the pack's `voice_number` null), as today                                                                                                                                       |

## Tickets

Ordered so that the tickets needing **no key** come first (W4-01 … W4-09; their open questions ship their recommended default), then the provider-backed pieces on fakes (W4-10 … W4-12), then the owner's accounts (W4-13 … W4-15), and the acceptance run last. M10 is W4-01 … W4-05, W4-10, W4-12, W4-15; M11 is W4-06 … W4-09, W4-11, W4-13, W4-14.

| Ticket | Title                                                                                   | Size | Blocked by (§19)                   | Keys (fake without)                          |
| ------ | --------------------------------------------------------------------------------------- | ---- | ---------------------------------- | -------------------------------------------- |
| W4-01  | Phone-country picker from libphonenumber's regions; the number-country warning          | S    | none (Q23, Q32 decided)            | none                                         |
| W4-02  | Setup wizard on v1.2: preferred channel, language, the real welcome preview, line check | M    | Q229, Q234 (pricing card), Q246    | none                                         |
| W4-03  | Team on v1.2: statuses, preference and channel, devices, today's link, office users     | L    | Q241, Q242, Q243, Q244             | none                                         |
| W4-04  | Team's _Call now_ with the office's attestation (F3)                                    | M    | Q230                               | none (console telephony)                     |
| W4-05  | Settings: the Field channels tab and Reports & reminders on v1.2                        | L    | Q231, Q232, Q233                   | none                                         |
| W4-06  | The pack's legal texts: `/legal/<key>`, KVKK notices, the recording notice by key       | M    | Q28, Q50 (texts: counsel)          | none (counsel's texts for go-live)           |
| W4-07  | Turkish voice in code: spoken numbers, units and times; TR call fixtures                | M    | Q245                               | none (Azure for the live half, W4-14)        |
| W4-08  | Turkish starter glossary and the TR extraction set                                      | M    | Q238                               | none (`ANTHROPIC_API_KEY` for the live eval) |
| W4-09  | The panel in Turkish: the pages left, office emails, sign-in emails                     | M    | Q239, Q240                         | none                                         |
| W4-10  | Billing on v1.2: price per org, trial end, past-due banner, TR as `manual`              | L    | Q8, Q9, Q234, Q235, Q236           | Stripe test mode (live check)                |
| W4-11  | İletimerkezi: delivery status and the TR SMS checks                                     | M    | Q49, Q237                          | İletimerkezi (live check)                    |
| W4-12  | Self-serve onboarding end to end, and the welcome's 48 h re-send                        | M    | Q241, Q246                         | none (a local Twilio stand-in)               |
| W4-13  | TR pack go-live: `SITELOG`, İletimerkezi live, legal keys, TR WhatsApp templates        | M    | Q20, Q28, Q49 (counsel)            | İletimerkezi, counsel's texts                |
| W4-14  | Turkish voice live: Azure voice, listening test, TR calls on phones                     | M    | Q1, Q225, Q245; Q2 for a TR number | LiveKit, Azure, Deepgram, Anthropic          |
| W4-15  | Stripe live on the preview project; the TR billing provider once Q8 is decided          | M    | Q8, Q9                             | Stripe; the TR provider                      |
| W4-16  | M10–M11 acceptance: suites, the owner's onboarding run, the TR demo                     | M    | every open Q (ships its default)   | all live keys (owner)                        |

## Not in week 4

- **M12:** the ≥ 30-recording evaluation set and the audio-level call simulations, the §15.2 compliance checklist sign-off, load tests, the field bundle budget, the retention and backup review, the US and TR pilots. Week 4 fills the legal keys only when counsel has approved the texts; counsel's review itself is the owner's.
- **Dedicated numbers per customer** (§3.2, §19 Q4): shared numbers per pack stay.
- **TR outbound calls and a Turkish number** unless the TR pilot asks for one (§19 Q2, Q33): W4-14 wires a TR trunk only when the owner has signed with a provider; Talk now stays the TR call channel.
- **TR e-invoicing** (e-Fatura / e-Arşiv, §19 Q8): only after the owner names the entity and the provider; week 4 ships the `manual` default (Q236).
- **GAP step 22 / 23** (retire the v1.0 Meta integration, `/try`, the legacy `stripe_*` columns): after the cut-over, unchanged (Q240 keeps `/try` English until then).
- **Week-3 owner items** (W3-16 LiveKit and the US number, W3-17's Twilio trunk, Q215's browser answer for demo calls): unchanged; week 4 uses them when they exist (W4-04, W4-12, W4-14).

---

## Part 1 · Buildable now (no key; open questions ship their default)

### W4-01 · Phone-country picker from libphonenumber's regions; the number-country warning

- [ ] **W4-01 done** · today _partial_ (S)
- **Spec:** §4.6 ("the panel's phone-country picker lists it … until M10 derives the picker from libphonenumber's regions"), §16.2 M10, F2 step 2 and edge cases, §19 Q23 (decided: warn at invite when the number's country differs), §19 Q32 (decided: browser-region preselect with self-serve onboarding, M10), CLAUDE.md "Conventions" (`PHONE_COUNTRIES` exception until M10).
- **Design:** none exported (Web-Setup, Web-Team are not in `docs/design/`; the current `PhoneInput` is the reference).
- **Already in the repo:** `PhoneInput` with `PHONE_COUNTRIES` (12 entries, names in English, an example number each), `phoneValue`, `phoneCountryFor` (falls back to US), used by Setup's manager and backup phones and Team's invite; `libphonenumber-js/min` in shared (`normalizeE164`, `formatPhone`).
- **Build:**
  - [x] `packages/shared/src/phone-regions.ts` (Node, browser, Deno): every region of `getCountries()` with its calling code; the name from `Intl.DisplayNames` in the panel's language (EN/TR, "Türkiye", "Almanya"), sorted in that language; the example from libphonenumber's mobile examples where the bundle allows (measure: the panel chunk that loads `PhoneInput` grows by at most 15 kB gzip, else a plain "+{code} …" placeholder). _As built (W4-01): `phoneRegions(language, first)` (cached per language, `Intl.Collator` order), `phoneRegionFor` (US for a code libphonenumber does not know), `searchPhoneRegions` (name from its start, then within, accent- and case-folded with the dotless ı read as i; ISO code; calling code with or without "+"), `parsePhoneIn` (national input by the picked region, so CA and US no longer share +1's parsing), `numberRegion` and `foreignNumberRegion` (Q23). The examples are `libphonenumber-js/mobile/examples` (international in the hint, national as the field's placeholder; "+{code} …" for a region without one); measured on the demo build: `InviteReporterDialog`'s chunk (which carries `PhoneInput`) 3.30 → 6.54 kB gzip, all JS +3.7 kB gzip. `supabase/functions/deno.json` maps the examples subpath._
  - [x] `PhoneInput`: a searchable select (type a name or a calling code), the org's pack country first, then the rest; keyboard and screen-reader labels; `PHONE_COUNTRIES` and `PhoneCountryCode` removed (`phoneCountryFor` keeps its fallback for a region libphonenumber does not know). _As built (W4-01): a button ("Country code: Mexico, MX +52": the name, then the visible text, 44 px) opens a modal popover (it scrolls and holds focus inside Team's invite dialog) with a search field (`combobox`, `aria-activedescendant`) over a `listbox`; arrows, Ctrl+Home/End, PageUp/Down, Enter picks, Escape closes back to the button; no match says so (`role="status"`). The copy is the new `phone.*` keys (EN and TR, read through `useCopy`, so the picker follows the page: English under `<EnglishOnly>` until W4-02/W4-03 convert Setup and Team); `team.invite.country`, `phonePlaceholder`, `phoneHint` and `phoneInvalid` went into it. `PhoneValue.country` and the wizard's `managerCountry` / `backupCountry` are plain region codes._
  - [x] Q23's warning: in Setup and Invite, a valid number whose region differs from the org's pack says so under the field ("This is a {country} number. SiteLog texts it from your {pack country} number."), never blocks; the invite keeps the org's pack (decided). _As built (W4-01): `PhoneInput`'s `packCountry` (Invite: `currentOrg.country`; Setup's manager and backup: the org's country). The number's region is libphonenumber's, or, where its "min" metadata cannot tell regions sharing a calling code apart (the demo's 555-01xx numbers, +44 7700 900…), the picked region when it has that code, else the code's main region. A pack libphonenumber does not know warns nothing. The warning is in the number field's description; the field is not marked invalid._
  - [x] Q32: before an org exists, the wizard preselects the pack whose code is the browser's region (`navigator.languages`, first with a region that is a pack), else US. _As built (W4-01): `browserPackCountry()` in `apps/web/src/app/setup/countries.ts` (`Intl.Locale(tag).region`; a tag without a region or with a region that has no pack is skipped); saved progress still wins, and an org's own country always does._
  - [x] CLAUDE.md "Conventions" and spec §4.6 lose the `PHONE_COUNTRIES` exception (the CLAUDE.md line is proposed in the ticket report, not edited by the ticket). _As built (W4-01): spec §4.6, F2 step 1, §16.2 M10 and §19 Q23/Q32 updated; the CLAUDE.md sentence is in the ticket report._
- **Tests:** unit (every pack's country is listed; names in EN and TR; a +52 number in a US org warns; an unknown region falls back); `PhoneInput` keyboard search; a synthetic pack row `XX` in a test proves the picker needs no code for a new country (§17 DB row).
- **As built (W4-01):** tests: `packages/shared/src/phone-regions.test.ts` (every region once, every pack listed, EN/TR names and Turkish order, the pack first, examples, the US fallback for `XX`, national parsing, search, Q23 incl. +52 in a US org); `PhoneInput.test.tsx` (the full list with the pack first, names in TR and English under `<EnglishOnly>`, keyboard search by "+52" and by name, no match, the warning in EN and TR and never `aria-invalid`, a synthetic `NL` pack listed first with no code and an `XX` row falling back to US); `countries.test.ts` and `Page.supabase.test.tsx` (Q32: `tr-TR` creates a TR org, `de-DE` keeps US); `e2e/smoke.spec.ts` (Team's invite at 1440 and 390 px: every region, Germany by name, "+52" and Enter, the Mexican number's warning in Kestrel, no sideways scroll); `e2e/a11y.spec.ts` (axe with the picker open, its `lang="en"` portal, 44 px); `e2e/supabase/fresh-org.spec.ts` (the TR org now created from a `tr-TR` browser's preselect, run in CI's `e2e-supabase`).
- **Done when:** in CI, the invite dialog lists every libphonenumber region named in the panel's language, a Mexican number in Kestrel shows Q23's warning, a browser in `tr-TR` preselects Türkiye in the wizard, and no `PHONE_COUNTRIES` remains.
- **Needs:** nothing.
- **Blocked by:** none.

### W4-02 · Setup wizard on v1.2: preferred channel, language, the real welcome preview, line check

- [ ] **W4-02 done** · today _partial_ (M)
- **Spec:** F2, P2, §9.2 `welcome` (the pack's variant: `two_way_sms`, `voice_number`), §14.6 (the neutral bubble), §19 Q25 (the welcome always by SMS), Q31, Q32, Q33 (call preference without a voice number), Q38 (a landline gets _Phone call_ only where SiteLog can reach it), §1.3, §16.2 M10.
- **Design:** Web-Setup is not exported (P2 calls step 2 "designed"; the current wizard is the reference, noted in the report); `Field-01-SMS` for the welcome text as the manager receives it (the copy comes from §9.2, which wins over the artboard's punctuation, §19 Q15).
- **Already in the repo:** the three steps, the company presets, geocoding, the backup reporter, _Add another site_, the reports step; `api-invite-reporter` with `locale` and `contactPref`; `renderSms` / `smsTemplate` for the §9.2 text with the pack's variant (`packages/shared/src/copy/sms.ts`).
- **Build:**
  - [ ] Step 2, manager: **language SiteLog uses with them** (the pack's `field_locales`, the first preselected) beside the languages they speak, and **preferred channel** (segmented _Text link_ · _Phone call_, "They can always use the other one."); both sent to `api-invite-reporter` (`locale`, `contactPref`), the backup reporter likewise. A call preference in a pack without a voice number is allowed (Q33) with "They will use Talk now in the recorder."
  - [ ] The preview: the §9.2 `welcome` in the chosen language with the pack's variant (`renderSms`: the reply clause only on two-way packs, "or call {number}" only with a voice number), a sample link, in the §14.6 neutral bubble, SMS only (Q25), with the note "They can also call {number} any time" when the pack has one; the v1.0 `sitelog_welcome` template and its buttons go.
  - [ ] Pricing card from the org's price (W4-10's `billingPrice()`, Q234): "{price} / site / month", "$0 setup · billed per active site"; until W4-10 lands it reads the current default.
  - [ ] Line check per Q229 (`INVITE_LINE_CHECK`, default `delivery`): no pre-check; a number libphonenumber knows to be fixed-line is refused for _Text link_ and allowed for _Phone call_ only where SiteLog can reach it by phone (the pack's voice number or `placesCalls`, F2), else blocked with the F2 message.
  - [ ] The page leaves `<EnglishOnly>`: every `copy.setup` key in EN and TR; country names from the browser in the panel's language.
- **Tests:** unit (preview per pack, language and variant: US EN with the reply clause and the number when set; TR without either; ES); `SiteStep` tests (preference and language sent; Q33 note; Q229 fixed-line cases); the wizard's existing EN tests in TR; Playwright at 390 and 1440 px with axe.
- **Done when:** in CI, a new admin whose browser is `tr-TR` gets Türkiye preselected, adds Kartal with Emre Yıldız (Türkçe, _Phone call_), the preview shows the TR `welcome` with neither a reply clause nor "or call", _Send welcome text_ creates Emre `invited` with `tr-TR` and `call`, and every step reads in Turkish.
- **Needs:** nothing.
- **Blocked by:** **Q229** (line check), **Q234** (the price on the card), **Q246** (what "via call" means for M10). _Without the answers:_ their recommendations.

### W4-03 · Team on v1.2: statuses, preference and channel, devices, today's link, office users

- [ ] **W4-03 done** · today _partial_ (L)
- **Spec:** P10, F3 (statuses, 48 h), F13 step 3, F15 ("Office: Team page can change preference (and, from M10, the message channel) only with the reporter's agreement (logged as `office_attested`)"), F16 (lost phone), F24, §2.2 (admin, ops manage reporters), §19 Q21, Q40, Q94, Q131.
- **Design:** Web-Team is not exported (P10's text and the current page are the reference; noted in the report).
- **Already in the repo:** see "Where week 3 leaves us"; `api-text-daily-link` (Overview's _Text today's link_); field-api's own _Sign out this phone_ (the device and its push subscriptions revoked, W2-14); `reporters.message_channel` (W1-06a) with no client writing it.
- **Build:**
  - [ ] Columns per P10: Name + role · Mobile · **Prefers** (Text link / Call, with the message channel when set: "Link · WhatsApp") · Sites · **Language** (the reporter's locale; spoken languages in the row's details) · On time · 30 d · **Status** (Active · Invite sent · Opted out of texts · Can't text this number · Disabled), statuses from v1.2 data: _Can't text this number_ from the welcome's last attempt (`messages` `undeliverable` / failed walk, W2-01), not `last_invite_error`; status never by colour alone.
  - [ ] Row menu: Edit · Re-send welcome · **Text today's link** (`api-text-daily-link`) · **Call now** (W4-04) · **Revoke devices** · Disable.
  - [ ] Edit gains the preference, the message channel (the pack's built channels other than push, as the field app's Settings) and the language, with Q243's attestation ("{first} asked for this change") required to save a preference or channel change; a new audited RPC (`update_reporter_contact()`, admin and ops) writes `contact_pref`, `message_channel`, `locale`; audited `reporter.preferences_changed` `via office`.
  - [ ] **Revoke devices** per Q244 (`revoke_reporter_devices()`, admin and ops): every `field_devices` row of the reporter `revoked_at`, their `push_subscriptions` revoked, consents and the personal link kept; audited `device.revoked` `via office`; the next open asks for a code (F16).
  - [ ] Opted-out phones per Q242: _Opted out of texts_ shows who stopped it (the person by STOP, the provider); on a one-way pack an admin may clear a provider opt-out with the attestation (an `sms` consent `office_attested`, audited); never on a two-way pack.
  - [ ] Invite dialog: the preference, the language SiteLog uses (W4-02's fields), W4-01's picker and warning.
  - [ ] Office users (F24): _Add office user_ takes the UI language (EN / TR / "the company's language"), stored in `org_members.ui_locale` by `api-invite-office-user`, which also passes it to the invite email (W4-09); the last-admin rule kept.
  - [ ] The page leaves `<EnglishOnly>`; the v1.0 words go (column "WhatsApp", "Verified", the subtitle: P10's "SiteLog matches every call and text to a site by the phone number. Personal links are tied to one person.").
- **Tests:** PGlite (the two RPCs: roles, org scope, audit, attestation required, a channel the pack does not list refused); Team page tests EN/TR (statuses from messages, the menu per role and status, edit with attestation, revoke devices, opt-out clear on TR only); field-api Deno test that a revoked device must verify again; Playwright at 390 / 1440 px with axe.
- **Done when:** in CI, Team reads in Turkish for Demir Yapı and in English for Kestrel with the P10 statuses, an ops user moves Marco to WhatsApp with the attestation (audited `via office`), revokes Jorge's devices (his next open asks for a code), texts Priya today's link (the Demo phone shows it), and an admin invites an office user whose panel opens in Turkish.
- **Needs:** nothing.
- **Blocked by:** **Q241** (automatic re-send, the status it shows), **Q242**, **Q243**, **Q244**. _Without the answers:_ their recommendations.

### W4-04 · Team's _Call now_ with the office's attestation (F3)

- [ ] **W4-04 done** · today _missing_ (M)
- **Spec:** F3 edge cases ("office can switch the reporter to _Phone call_ and place a first call from the panel (button "Call now", only with office attestation that the person agreed — stored as `office_attested`)"), P10 row menu, §9.4 calls policy, §15.2 (TCPA: prior express consent), §19 Q131 (decided: `office_attested` allows only an office-started _Call now_, never the ladder), Q128, Q132, Q215.
- **Design:** none exported (Web-Team; the call itself is the agent's, W3-12).
- **Already in the repo:** `place_call` (dial → ring end / missed), `outbound_call_start()` with the ladder's guards, `Telephony` `livekit` / `console`, `placesCalls()`, the Demo phone's call thread, the `auto_call` consent type with method `office_attested`.
- **Build:**
  - [ ] Per Q230 (`OFFICE_CALL_POLICY`): _Call now_ for admin and ops, shown only where the org places calls (`placesCalls`: a demo org, or a real org whose pack has an outbound trunk here); a sheet with the attestation sentence and _Call now_ / _Cancel_; the attestation stored as an `auto_call` consent `office_attested` (the office user, the wording version), audited `consent.given via office`.
  - [ ] `office_call_start()` (service role via a new `api-office-call` or an RPC the panel calls, admin/ops): purpose `daily_report`, inside the site's call window, refused when the site-day is filed or a call to that reporter is live, not counted in Q128's ladder attempts; queues `place_call` keyed `call:<site_day>:<reporter>:office:<n>`; audited `call.requested via office`.
  - [ ] The ladder still ignores `office_attested` (Q131): a test proves it.
  - [ ] Team row and Site detail show the call's progress (requested, ringing, answered, not reached) from `calls`, EN/TR.
- **Tests:** PGlite (roles, window, filed day, live call, the attestation row, the ladder unchanged); worker PGlite test of the office call on console telephony (rings → no answer → no text to the reporter, the outcome on Team, Q230); Team tests EN/TR; Playwright on the stack (`@m10 @F3`).
- **Done when:** in CI on console telephony, Lena attests and calls Aisha now: her call rings in the Demo phone, the consent row is `office_attested` with Lena as the attester, and that night's R1 for Aisha is still refused without her own `auto_call`; _(owner, with W3-17's trunk)_ a real office call reaches a test phone.
- **Needs:** nothing; the Twilio trunk (W3-17) for a real org's call.
- **Blocked by:** **Q230**. _Without the answer:_ its recommendation.

### W4-05 · Settings: the Field channels tab and Reports & reminders on v1.2

- [ ] **W4-05 done** · today _partial_ (L)
- **Spec:** F22, P12 (Reports & reminders: the ladder cards "−35 heads-up · 17:00 daily link · +15 R1 'Text or call — per person' · +60 R2 · +90 missing", filing "Reporter confirms — on the recorder or by voice on the call"; **Field channels**: the pack read-only, daily link time, _Call people who prefer calls_, _Second call at reminder 2_, call window, default preference for new reporters, daily link expiry, recording notice per language read-only with its version, _Send me a test message_, _Call me now_ hidden without an outbound trunk), §4.6, §7.4, §19 Q30 (quiet hours = the call window), Q31, Q77, Q129.
- **Design:** Web-Settings is not exported (P12's text and the current tabs are the reference).
- **Already in the repo:** the tabs, `ReportsSection`, the guard, the `org_settings` columns, `countries` readable by every office user (RLS), the pack helpers (`packages/shared/src/countries.ts`), the voice copy's `recording_notice` per language.
- **Build:**
  - [ ] **Field channels** tab: the pack card (country, sender type and id or "Not set up in this environment", voice number or "Talk now only", the channel order as words, two-way SMS, links in SMS), read-only with "Set by SiteLog per country"; daily link time; the two call toggles and the call window (shown where the org places calls; otherwise one line why); per Q231 the default preference for new reporters and the daily link expiry (new columns `org_settings.default_contact_pref`, `daily_link_ttl_hours`; Setup and Invite preselect the first, `ensureDailyLink` reads the second before `DAILY_LINK_TTL_HOURS`); the recording notice per field language with its version (the pack's `legal_keys.recording_notice` when set, else `voice.recording_notice.v1`); the test buttons per Q232.
  - [ ] **Reports & reminders** on v1.2: the 17:00 daily-link card in the ladder, R1 "Text or call — per person", the required-fields hint ("one question on the recorder or the call"), filing "Reporter confirms — on the recorder or by voice on the call"; no WhatsApp word left.
  - [ ] Q233: _Report language and units_ in the PDF template tab (`update_org` gains `p_locale`, `p_units`, admin only, audited; new versions only).
  - [ ] Every save through the existing audited path; the page leaves `<EnglishOnly>`.
- **Tests:** PGlite (the new columns, defaults, `update_org` locale/units audit, RLS); unit (`ensureDailyLink` with the org's TTL; the pack card per pack); Settings tests EN/TR; the scheduler reading a changed call window (`logic_test.ts`); Playwright 390 / 1440 px with axe.
- **Done when:** in CI, Kestrel's Field channels shows the US pack (order Push · SMS · WhatsApp, two-way, voice number or "Talk now only"), Demir Yapı's shows one-way SMS and "Talk now only" in Turkish, a changed call window moves the next R1 call in the scheduler's test, and no Settings string mentions WhatsApp as the report channel.
- **Needs:** nothing.
- **Blocked by:** **Q231**, **Q232**, **Q233**. _Without the answers:_ their recommendations.

### W4-06 · The pack's legal texts: `/legal/<key>`, KVKK notices, the recording notice by key

- [ ] **W4-06 done** · today _missing_ (M)
- **Spec:** §4.6 `legal_keys`, §9.1 (privacy notices per pack, linked from the consent screen and the HELP text; the recording notice versioned), §9.4 (disclosure), §15.2 (KVKK: inform before recording, explicit consent where required, cross-border transfer), F4 step 3, §19 Q28 (decided: ids `<CC>.<doc>.v<n>`, filled by a data migration once counsel approves), Q50 (decided: a field-app page per key with the texts in the shared copy per language, offline, versioned; shipped in the same migration change that fills the key), Q40 (counsel's half).
- **Design:** `Field-02-Welcome` (the _Privacy notice_ link under the notice); the `/legal` page has no artboard (built from Field-02's type and spacing).
- **Already in the repo:** `legal_keys` with its schema (`packages/shared/src/countries.ts:52`), `resolve` returning the pack's keys, the Welcome screen's link shown only with a key (`apps/field/src/lib/legal.ts`), `consents.text_version` taking the pack's consent key when set, the agent's disclosure from `voice.recording_notice.v1`.
- **Build:**
  - [ ] `packages/shared/src/copy/legal/` : a catalogue keyed by legal id, each text per field language (TR packs: TR and EN; US: EN and ES), with a test that every key a pack row names has a text in every field locale of that pack (`pnpm test:db`'s pack check gains it).
  - [ ] Field app `/legal/:key`: the text, its version and date, readable offline (precached with the shell), Back; the same page linked from Settings (F15).
  - [ ] The recording notice by key: the voice copy and the field call screen speak and show `legal_keys.recording_notice`'s text when the pack sets it (exported to `apps/voice-agent/copy/` by `pnpm voice:contract`), else `voice.recording_notice.v1`; `calls.disclosure_played` records the version spoken (a column or the dialog log).
  - [ ] The HELP reply (two-way packs) gains the privacy-notice link once a key is set (§9.1), within its segment budget.
  - [ ] No pack key is filled in week 4 until counsel's texts arrive (W4-13 ships the data migration); a test-only key proves the path.
- **Tests:** copy parity per key and locale; field unit and Playwright (EN/ES/TR, offline after first load, 390 px with axe); the agent's copy test with a keyed notice; a PGlite test that a pack naming a key without its text fails the pack check.
- **Done when:** in CI, a test pack with `privacy_notice`, `recording_notice` and `consent` keys shows the Welcome link to `/legal/<key>` in TR, the consent row stores its consent key, the call screen and the agent's opening use the keyed recording notice; with no key (both launch packs today) nothing changes.
- **Needs:** nothing to build; counsel's texts to go live (W4-13).
- **Blocked by:** **Q28**, **Q50** (decided; the texts are counsel's). _Without the texts:_ the page and plumbing ship; the keys stay empty.

### W4-07 · Turkish voice in code: spoken numbers, units and times; TR call fixtures

- [ ] **W4-07 done** · today _partial_ (M)
- **Spec:** §9.4 ("numbers spoken naturally (… TR: 'yüz seksen dört saat')"; Opening (TR); turn-taking), §9.6, §9.7 (TR formal _siz_), §10.2 (`tr` STT), §16.2 M11 ("voice TR (STT/TTS voices, prompts, number reading)", "Azure `tr-TR` voice tuned (numbers, units, company names); TR calls via Talk now"), §19 Q1, Q196.
- **Design:** `Field-10-Today-TR` (_Konuşmak mı istersiniz? Şimdi konuş_, "Asistan tarayıcıdan dinler, numara gerekmez"); the call screen (Field-08) is not exported.
- **Already in the repo:** `voice.tr.ts` (every key), `readBack()` and `voiceNumber()` (TR "7,5"), the TR confirm words (`CALL_CONFIRM_WORDS`), Talk now in TR on the fake client, TR answer and correction clips, `kartal-2026-10-09-tr.json`; no TR call fixture, no spoken-form step.
- **Build:**
  - [ ] Per Q245 (`SPOKEN_FORM`): `speakable(text, language)` in `packages/shared` (pure, Deno-safe), applied by field-api to every line it hands the agent and by the agent to its fixed lines before TTS: units as words (TR "m³" → "metreküp", "°C" → "derece", "km/sa", "%" → "yüzde"), times ("17:30" → "on yedi otuz"), decimals (",5" → "buçuk" in TR, "and a half" in EN), report numbers spoken in groups ("RL iki bin kırk bir, sıfır yüz seksen yedi"), and a per-language pronunciation list for names the listening test flags (empty until W4-14).
  - [ ] TR call fixtures in `fixtures/calls/`: Kartal (Emre, Talk now): the hero (crew, a rain stop, the read-back, "evet"), a question answered ("altı kişi, tam gün"), a correction ("Usta Beton beş değil altı"), a weather day ("yağmur yüzünden iş durdu"), F14 for a two-site TR reporter; their extraction cases `fixtures/transcripts/call-kartal-*-tr.json` with expected data and recorded tool outputs, so `EXTRACT_PROVIDER=fake` and `pnpm eval -- --recorded` cover them.
  - [ ] The call simulator and `pnpm e2e:voice` run the TR scripts (Talk now) beside EN and ES; read-back golden texts in TR.
- **Tests:** `speakable` tables EN/ES/TR; read-back goldens TR; the Python replay of the TR fixtures (`pnpm voice:test`); the worker's PGlite test files a TR call report with a Turkish PDF.
- **Done when:** in CI, the TR scripts file Demir Yapı's Kartal report by Talk now in Turkish on the fakes (disclosure, one question, a read-back whose numbers are words, "evet"), and its PDF is Turkish, A4, metric.
- **Needs:** nothing; Azure for the live half (W4-14).
- **Blocked by:** **Q245**. _Without the answer:_ its recommendation.

### W4-08 · Turkish starter glossary and the TR extraction set

- [ ] **W4-08 done** · today _partial_ (M)
- **Spec:** §16 ("onboarding a contractor is the setup wizard plus their company list, glossary seeds and PDF letterhead"), §16.2 M11 ("report language TR in extraction/writing, TR glossary seeds"), F21, §10.2 (key terms), §10.4, §10.13, §18.2 (Demir Yapı's four seeds).
- **Design:** none exported (Web-Glossary; the W3-08 page is the reference).
- **Already in the repo:** the glossary pipeline (`learnTerms`, `buildKeyterms`, `built_in` status treated as confirmed), the §18.2 seeds in the demo only, two TR golden transcripts.
- **Build:**
  - [x] Per Q238 (`STARTER_GLOSSARY`): `packages/shared/src/glossary/starter.{en,tr}.ts` (field word → official term, kind, language), listed in spec §18 for the native read; `on_org_created` seeds the org's report language's list as `built_in` (migration, idempotent); the glossary page shows them with a _Built in_ tag and lets the office change or reject them (audited RPCs, W3-08). _As built (W4-08):_ 29 terms per language (kinds `term` and `unit` only; no company, crew or area names), `STARTER_GLOSSARY` / `starterGlossaryRows` in `starter.ts`, listed in spec §18.3 for the Q63 native-speaker read. `20261017000410_starter_glossary.sql`: `starter_glossary_terms(language)` (the same rows; `supabase/db-tests/src/starter-glossary.test.ts` holds them equal), `seed_starter_glossary(org)` (service role; adds only the terms the org has no row for, same kind and heard phrase in any case, so a changed or rejected term is never put back; audited `glossary.starter_seeded`), and `on_org_created()` calling it. Existing orgs are not backfilled (the owner's call, spec §18.3). No table change, so no D11 or role-matrix change; `db/types.ts` lists the two functions. The glossary page's built-in rows of the org carry _Change_ (a dialog, `ChangeTermDialog`) and _Reject_, both `review_glossary_term`; global terms (`org_id` null) stay read-only. The §18 demo orgs carry the lists too (less the phrases their own glossary holds); `supabase/seed.sql` regenerated.
  - [x] TR golden set: at least four more TR cases (a crew and hours gap, a delivery in m³, a safety incident, a correction) and the TR call cases of W4-07; `pnpm eval -- --recorded` green; the live eval (`--set tr`) run once with the owner's key. _As built (W4-08):_ `kartal-2026-10-05-crew-gap-tr`, `atasehir-2026-10-06-delivery-m3-tr`, `kartal-2026-10-07-incident-tr` (first aid and a near miss), `atasehir-2026-10-02-correction-tr` (transcripts, expected, recorded tool outputs from `--write-recorded`), each with the §18.2 seeds plus the Turkish starter terms as its glossary; the set has six TR cases. New `--set tr` (the extraction cases in Turkish; `all` leaves it out; `eval.yml` and Deploy's `eval_sets` accept it). `pnpm eval -- --recorded` 35/35 and `--set tr --recorded` 6/6. Not here: W4-07's TR call cases (`call-*-tr`, another ticket's fixtures; `--set tr` picks them up by report language once they land), and the live `--set tr` run (needs the owner's `ANTHROPIC_API_KEY`: Actions → Deploy, target `eval`, sets `tr`).
- **Tests:** PGlite (a new TR org has the TR list, a US org the EN list, a re-run seeds nothing twice); `buildKeyterms` includes them; recorded eval.
- **Done when:** in CI, a new TR org starts with the Turkish starter terms as `built_in`, they appear in the next voice note's key terms and `get_context`, and the TR recorded eval passes.
- **Needs:** nothing; `ANTHROPIC_API_KEY` for the live eval.
- **Blocked by:** **Q238**. _Without the answer:_ its recommendation.

### W4-09 · The panel in Turkish: the pages left, office emails, sign-in emails

- [ ] **W4-09 done** · today _partial_ (M)
- **Spec:** §11.2 (i18n EN/TR; UI language `org_members.ui_locale`, else the org locale), §13 (report emails in the report language; "Magic link | Email | Office user | Sign-in button (EN/TR)"; panel notices in the reader's language, as built), §15.1 (Panel EN/TR), §16.2 M11 ("Panel TR strings"), CLAUDE.md ("pages not translated yet render inside `<EnglishOnly>` until a ticket converts them").
- **Design:** `Web-Login` (the EN/TR switch); the other pages as their tickets say.
- **Already in the repo:** see "Where week 3 leaves us"; `EnglishOnly` (`apps/web/src/i18n/EnglishOnly.tsx`), the key check (`tr-keys.test.ts`), the TR report email (W1-15), notices by `data` (§13 as built).
- **Build:**
  - [ ] New report (`/reports/new`) and the PDF zip copy (`pdfZip`) out of `<EnglishOnly>` with TR keys; whatever W4-02 … W4-05 and W4-10 left; a test that `<EnglishOnly>` wraps only `/try` and `/ops` (Q240).
  - [ ] Office emails per Q239 (`OFFICE_EMAIL_LANGUAGE`): missing, EOT pack ready, weekly digest, unknown contact, edited after sign-off in each recipient's panel language (`ui_locale`, else the org's), the invoice query in the org's report language; templates in EN/TR (`apps/worker/src/email/templates.ts`).
  - [ ] Sign-in and invite emails in TR: `supabase/templates/{magic_link,invite}.html` with an EN and a TR body chosen by the user's metadata (`ui_locale`, set by `api-invite-office-user` and by the login page's language switch on `signInWithOtp`'s `data`), wired in `supabase/config.toml` for the local stack; the hosted templates are an owner step (RUNBOOK).
- **Tests:** page tests in TR for New report; email template tests EN/TR; a local-stack check (Inbucket) that a TR user's magic link is Turkish.
- **Done when:** in CI, Elif Aydın sees every Demir Yapı page in Turkish (no English page but `/ops` and `/try`, Q240), the missing-report email to her is Turkish, and a magic link requested with the language switch on TR arrives in Turkish on the local stack.
- **Needs:** nothing; the owner applies the hosted Auth templates.
- **Blocked by:** **Q239**, **Q240**. _Without the answers:_ their recommendations.

## Part 2 · Provider-backed pieces on fakes (open questions as parameters)

### W4-10 · Billing on v1.2: price per org, trial end, past-due banner, TR as `manual`

- [ ] **W4-10 done** · today _partial_ (L)
- **Spec:** §1.3 (US $399, TR price to be set), F2 step 4 (billing from step 2; US Stripe, TR §19; 14-day trial), F23 (pause/resume from next cycle, invoices, payment method, past-due banner, 14-day grace), P13 ("Price and currency per org (outside the country pack until §19 Q30); US via Stripe; TR provider (§19)"), §13 Billing, §2.2 (billing admin only), §19 Q7, Q8, Q9, Q10, Q30, Q174.
- **Design:** Web-Billing is not exported (P13's text and the current page are the reference).
- **Already in the repo:** see "Where week 3 leaves us" (Checkout with the remaining trial, portal, sync, pause/resume, invoices, the webhook, the block).
- **Build:**
  - [ ] Per Q234 (`BILLING_PRICE_POLICY`): `orgs.price_per_site_minor` and the price's currency (migration; set at `create_org` from `BILLING_DEFAULT_PRICE_<CURRENCY>` env, null when unset), changed only by SiteLog staff (`/ops`, audited); `billingPrice(org)` in shared used by the wizard, Billing and `api-billing`; the Stripe price id per currency in env (`STRIPE_PRICE_ID_SITE_US` kept); `PRICE_PER_SITE_CENTS` goes.
  - [ ] A `BillingProvider` interface in `supabase/functions/_shared/` with `stripe` and `manual`; `orgs.billing_provider` picks it.
  - [ ] Per Q235 (`TRIAL_END_POLICY`): an org `trialing` past `trial_ends_at` with no subscription is treated as past due from that time (the banner, the org's grace days, then `isBillingBlocked`); never a demo org; never a `manual` org.
  - [ ] Per Q236: a TR org (pack `TR`, until Q8) is created with `billing_provider 'manual'`; its Billing page shows the trial, the sites with Pause/Resume and the org's price when set, no Checkout or portal, and "SiteLog invoices you directly"; `/ops` sets its `billing_status`.
  - [ ] The past-due / trial-ended banner in the app shell for admins (every page), §13's "Payment failed" notice from `invoice.payment_failed` (EN/TR).
  - [ ] Pause and Resume admin-only everywhere (closes the audit's "Site settings drawer … open to pm/ops"); a failed quantity sync after _Add site_ retried by a job instead of `.catch(() => undefined)` (the audit's "Adding a site never increments …" caveat).
  - [ ] Billing out of `<EnglishOnly>`: money by `Intl` in the org's currency and the panel's language, no "$399" in copy.
- **Tests:** unit (`billingPrice`, the trial-end rule, the provider pick); Deno (`api-billing` per provider, Checkout's price id per currency, the webhook's `payment_failed`); PGlite (price columns, staff-only writes, `create_org` per pack); Billing tests EN/TR; Playwright 390 / 1440 px.
- **Done when:** in CI, Kestrel's Billing reads "6 × $399.00 = $2,394.00" from the org's price, Demir Yapı's reads in Turkish with no Checkout and "SiteLog invoices you directly", a real US org whose trial ended yesterday without a card shows the banner and is blocked after its grace days, and Pause is offered to admins only; _(owner, W4-15)_ Stripe test mode on the preview.
- **Needs:** Stripe test-mode keys for the live check.
- **Blocked by:** **Q8**, **Q9** (owner), **Q234**, **Q235**, **Q236**. _Without the answers:_ their recommendations; TR stays `manual`.

### W4-11 · İletimerkezi: delivery status and the TR SMS checks

- [ ] **W4-11 done** · today _partial_ (M)
- **Spec:** §4.5 (statuses, fallback after `failed` / `undeliverable`, `message_failed`), §9.1 (Turkish encoding checked for the TR provider), §9.2 (one-way variants, ≤ 1 segment where possible), §15.2 TR (licensed provider, registered title, İYS check), §17 SMS (delivery receipts, one-way copy), README "İletimerkezi status", §19 Q15, Q20, Q49.
- **Design:** `Field-01-SMS` (the thread; no TR thread is drawn, the §9.2 TR column is the text).
- **Already in the repo:** the driver (send, refusals, `450` undeliverable), the segment counter with the Turkish shift table, `sms-copy-spec.test.ts`.
- **Build:**
  - [ ] Per Q237 (`ILETIMERKEZI_STATUS`): a delayed `sms_status` job per İletimerkezi send (+2 min, +15 min, +2 h until final) reading the order's report and moving the `messages` row through the §4.5 statuses (never backwards), so the fallback walk and `message_failed` work for TR texts; the request shape re-checked against the provider's documentation and recorded in the driver's comment.
  - [ ] Per Q49 (`ILETIMERKEZI_IYS`, default informational, no İYS fields): the parameter in the driver so counsel's answer is a configuration change.
  - [ ] A TR SMS budget test: every TR key rendered with typical variables is ≤ 2 segments with the shift table and says which keys are 1; the driver sends the text as is (no transliteration).
  - [ ] README "İletimerkezi status" deviation removed once built.
- **Tests:** the driver and the poller against a mocked İletimerkezi (delivered, undelivered, unknown, a report not ready yet, 429 / 5xx); the status walk on PGlite; the segment table.
- **Done when:** in CI, a TR text sent through the mocked İletimerkezi goes `sent → delivered`, an undelivered one walks to the next channel or tells the office once, and every TR key fits its segment budget; _(owner, W4-13)_ the same on a real phone from `SITELOG`.
- **Needs:** İletimerkezi credentials and the approved title for the live check.
- **Blocked by:** **Q49** (counsel), **Q237**. _Without the answers:_ their recommendations.

### W4-12 · Self-serve onboarding end to end, and the welcome's 48 h re-send

- [ ] **W4-12 done** · today _missing_ (M)
- **Spec:** §16.2 M10 Done when ("a new contractor self-onboards a site and gets the first report via link **and** via call without SiteLog staff"), F1, F2, F3 (the 48 h re-send), F4, F5, F6 (Talk now), §19 Q48 (a real org on `console` texts no one), Q116.
- **Design:** `Web-Login`, `Field-01-SMS` … `Field-07-Filed` (the flow the test walks).
- **Already in the repo:** sign-up open (`enable_signup = true`), `create_org`, the wizard, the welcome job, the field flow, Talk now and the call simulator, `apps/web/e2e/supabase/fresh-org.spec.ts` (a fresh org and a typed report, no reporter).
- **Build:**
  - [ ] A local Twilio stand-in for the stack (a tiny HTTP server the worker and the functions reach through `TWILIO_API_BASE` and `ILETIMERKEZI_API_BASE`, read only when `SMS_PROVIDER_STUB=true`, which only the local stack and CI set, as `SCHEDULER_CLOCK_OVERRIDE`) so a **real** (non-demo) org's welcome and links are sent and read back in tests without a real phone.
  - [ ] Per Q241 (`WELCOME_RESEND`): one automatic re-send 48 h after an invite with no reaction (no consent, no link opened), in the site's daytime, keyed `welcome_resend:<reporter>`, audited; Team shows "Re-sent automatically"; the manual Re-send stays for later.
  - [ ] `apps/web/e2e/supabase/worker/self-serve.spec.ts` (`@m10`): a brand-new user signs up, runs the wizard (US pack with the stand-in sender), invites a manager, the stand-in receives the welcome, the manager's link verifies a device, records, files; the same manager files the next day by Talk now on the fake `VoiceClient` (Q246); the panel shows both filed reports and the PDF. A TR variant on the mocked İletimerkezi (`@m11`).
- **Tests:** the e2e above; worker PGlite for the 48 h re-send (once, not after a reaction, not for an opted-out phone).
- **Done when:** in CI, a fresh US org and a fresh TR org each onboard a site with no seed and no staff action and file a report by link and one by call (Talk now); _(owner, W4-16)_ the same on the preview project with the US sender and a real phone.
- **Needs:** nothing in CI; the owner's senders for the live run.
- **Blocked by:** **Q241**, **Q246**. _Without the answers:_ their recommendations.

## Part 3 · Provider accounts (fake or console without)

### W4-13 · TR pack go-live: `SITELOG`, İletimerkezi live, legal keys, TR WhatsApp templates

- [ ] **W4-13 done** · today _missing_ (M)
- **Spec:** §16.2 M11 ("`SITELOG` sender id set, legal texts (`legal_keys`)", "İletimerkezi live with `SITELOG`"), §5.2 "Demo setup" step 7, §9.1, §15.2 TR, §19 Q20 ("revisit at M11 with Twilio's TR registration rules and prices"), Q28, Q49, Q50, Q12 (TR data location, counsel).
- **Design:** `Field-01-SMS`, `Field-02-Welcome`.
- **Already in the repo:** everything above on mocks; `pnpm countries:set` (sender, WhatsApp sender and templates, `--print-whatsapp-templates`).
- **Build:**
  - [ ] RUNBOOK "TR go-live": the owner's steps in order (İletimerkezi account and e-Devlet subscription, the `SITELOG` title, credentials as worker and functions secrets, the Turkish shift table confirmed with İletimerkezi, `pnpm countries:set -- --code TR --sms-sender SITELOG` on the preview project, a non-demo TR test org and a real phone; optionally the TR WhatsApp sender and templates), each owner-approved.
  - [ ] The legal-keys data migration once counsel's texts arrive (W4-06's catalogue gets the texts; the TR pack's `privacy_notice`, `recording_notice`, `consent` and the US pack's when ready), shipped together per Q50.
  - [ ] Q20 revisited: a one-paragraph comparison (İletimerkezi vs a Twilio alphanumeric sender for TR: registration, price, two-way) for the owner; the pack's provider changes only by a migration if the owner decides so.
- **Tests:** the pack checks with the filled keys (`pnpm test:db`); the RUNBOOK steps by hand.
- **Done when:** _(owner)_ on the preview project a non-demo TR test org's reporter gets the welcome and the daily link from `SITELOG` on a real phone, the row reaches `delivered` (W4-11), and the Welcome screen links the KVKK notice by its key.
- **Needs:** owner: İletimerkezi account and title, credentials, counsel's TR texts (and US texts), a TR phone, approval of each remote step.
- **Blocked by:** **Q28** / **Q50** texts (counsel), **Q49** (counsel), **Q20** (owner's revisit). Not Q2.

### W4-14 · Turkish voice live: Azure voice, listening test, TR calls on phones

- [ ] **W4-14 done** · today _missing_ (M)
- **Spec:** §16.2 M11 ("Azure `tr-TR` voice tuned (numbers, units, company names); TR calls via Talk now, plus a Turkish number on a TR SIP trunk if the pilot asks for it"), §5.2, §9.1 (voices picked after listening tests; STT tested on noisy site audio in all three languages), §19 Q1, Q2, Q225, Q245.
- **Design:** `Field-10-Today-TR`.
- **Already in the repo:** W3-16's RUNBOOK "Voice" steps, `pnpm voice:samples`, `pnpm voice:latency`; W4-07's spoken forms and TR fixtures.
- **Build:**
  - [ ] The TR listening test with `pnpm voice:samples` (both Azure voices; the read-backs, the disclosure, numbers, units, times, the §18.2 company and site names), at 24 kHz and 8 kHz; the owner picks `TTS_VOICE_TR`; names it mispronounces go into W4-07's pronunciation list.
  - [ ] TR STT on noisy site audio: the TR clips of `fixtures/voice` and two owner recordings through Deepgram `tr`, word error noted in the ticket report.
  - [ ] Talk now TR calls on an iPhone and an Android phone (Demir Yapı on the preview project): `pnpm voice:latency` for TR.
  - [ ] Only if the owner signs a TR SIP provider (Q2): the trunk as a LiveKit inbound and outbound trunk, `pnpm countries:set -- --code TR --voice … --outbound-trunk …`, the Q228 dispatch rule; otherwise nothing.
- **Tests:** by hand; the latency and STT numbers in the ticket report.
- **Done when:** _(owner + developer)_ a Turkish Talk now call on a real phone files Demir Yapı's report in Turkish with the chosen voice, numbers read naturally, latency within F6's targets or the gap named.
- **Needs:** owner: W3-16's LiveKit project and agent deploy, Azure Speech F0, the listening test, the phones; a TR SIP provider only if the pilot needs a number.
- **Blocked by:** **Q1**, **Q225**, **Q245**; **Q2** for a TR number only.

### W4-15 · Stripe live on the preview project; the TR billing provider once Q8 is decided

- [ ] **W4-15 done** · today _missing_ (M)
- **Spec:** F2 step 4, F23, P13, §13 Billing, §15.1 (billing webhook signatures), §19 Q7, Q8, Q9, Q10.
- **Design:** none (Stripe's hosted pages).
- **Already in the repo:** W4-10 on fakes; RUNBOOK §2 step 9 (the Stripe price).
- **Build:**
  - [ ] RUNBOOK "Billing": Stripe test mode on the preview project (the $399 per-unit price, `STRIPE_PRICE_ID_SITE_US`, the webhook to `stripe-webhook`, the secrets), owner-approved; the switch to live mode is a separate owner step before the US pilot.
  - [ ] The run on the preview project with a non-demo test org: Checkout keeping the trial, _Add site_ → quantity +1, Pause → next cycle, Resume, the portal, a failed test card → past due → banner → block after grace (with a short grace on the test org).
  - [ ] Once Q8 is decided: the TR provider as a second `BillingProvider` (its checkout, webhook signature, invoices; e-Fatura per the provider) in its own ticket-sized commit; until then TR stays `manual`.
- **Tests:** by hand on Stripe test mode; the TR provider's Deno tests when built.
- **Done when:** _(owner + developer)_ the preview project runs the F23 cycle on Stripe test mode end to end; TR is `manual` or on the owner's provider.
- **Needs:** owner: Stripe test-mode account, price and webhook approval; Q8 and Q9 for TR.
- **Blocked by:** **Q8**, **Q9** for TR only.

## Part 4 · Acceptance

### W4-16 · M10–M11 acceptance: suites, the owner's onboarding run, the TR demo

- [ ] **W4-16 done** · today _missing_ (M)
- **Spec:** §16.2 M10, M11 **Done when**, §17 (E2E panel "TR locale"; Field app; SMS one-way copy and delivery receipts).
- **Design:** every artboard above; screenshots at 390 and 1440 px in EN and TR for the report.
- **Build:**
  - [ ] `pnpm e2e:m10` (the specs tagged `@m10`: W4-12's self-serve, Team, Call now, Settings, Billing) and `pnpm e2e:m11` (`@m11`: Demir Yapı's link report in Turkish on the stack through the worker, a TR call by Talk now through the simulator, the TR PDF, the TR self-serve variant, the panel in TR); CI's `e2e-supabase` runs both as their own steps; listed in CLAUDE.md "Commands" (proposed in the report).
  - [ ] `docs/DEMO_NOTES.md` "Week 4": the owner's onboarding run (a new company on the preview project: sign up, wizard, a real phone gets the welcome, a link report, a call by the US number or Talk now), the TR demo in Turkish (panel, recorder, Talk now, PDF, `SITELOG` texts), the Billing cycle.
  - [ ] Spec (§4.6 without the `PHONE_COUNTRIES` exception, P2, P10, P12, P13, F2, F3, F15, F22–F24 as built, §19 with the owner's answers to Q229 … Q246), README deviations, GAP and this plan updated.
- **Done when:** both suites pass in CI; _(owner)_ M10: a new contractor self-onboards on the preview project and gets the first report by link and by call without SiteLog staff; M11: Demir Yapı (and a non-demo TR test org with `SITELOG`) completes link and call reports end to end in Turkish with the PDF in Turkish; every question still open is listed with the default that shipped.
- **Needs:** owner: the US sender (Twilio toll-free verified), W3-16's LiveKit, İletimerkezi and `SITELOG`, Stripe test mode, phones.
- **Blocked by:** none; a question still open ships its recommended default and is named in the report.

---

## Owner decisions for week 4

New questions for spec §19, numbered from Q229, written into §19 as **open** with their recommended default; each ticket builds the default behind the named parameter until the owner answers.

**Setup, Team and Settings (M10)**

- **Q229 · Checking that a manager's number can get texts** (F2 / P2 "SMS-capability lookup"; no provider named; a lookup costs per number). _Recommended:_ no paid lookup now: the welcome's own delivery decides (_Can't text this number_, F3), and a number libphonenumber knows to be fixed-line is refused for _Text link_ and allowed for _Phone call_ only where SiteLog can reach it by phone; Twilio Lookup later if pilots meet landlines. `INVITE_LINE_CHECK`.
- **Q230 · Team's _Call now_** (F3, P10, Q131). _Recommended:_ admin and ops; a sheet with the attestation ("{first} agreed to get calls from SiteLog for the daily report") stored as an `auto_call` consent `office_attested` with the office user and wording version; one call (purpose `daily_report`) inside the site's call window, refused when the day is filed or a call to them is live, outside Q128's ladder attempts, no `missed_call` text if unanswered (the office sees the outcome); shown only where the org places calls. `OFFICE_CALL_POLICY`.
- **Q231 · Settings' "default preference for new reporters" and "daily link expiry"** (P12, F22) have no column in §6.3, and the expiry is env (`DAILY_LINK_TTL_HOURS`). _Recommended:_ `org_settings.default_contact_pref` (default `link`, preselected by Setup and Invite) and `org_settings.daily_link_ttl_hours` (null = the env value, 1–168), admin-editable, audited; §6.3 updated.
- **Q232 · Who Settings' _Send me a test message_ and _Call me now_ reach** (office users have no phone in §6.3). _Recommended:_ a number typed in a sheet each time (E.164, not stored, the admin attests it is their own), a fixed `test_message` text (new key, EN/ES/TR) through the pack's real transport (console for demo orgs), at most 5 an hour per org, audited with the number masked; _Call me now_ only where the org places calls: a short scripted call (the disclosure, one line, goodbye), nothing recorded.
- **Q233 · Where admins change the report language and units after creation** (Q31 makes them admin-editable; no page names the place). _Recommended:_ Settings → PDF template, "Report language and units" (en-US / tr-TR, imperial / metric) through `update_org`, audited; new report versions only (filed versions keep theirs), with a confirm that says so.
- **Q241 · F3's "no reaction in 48 h → one re-send"** (as built: the office's Re-send allowed once after 48 h). _Recommended:_ automatic, once, in the site's daytime (09:00–18:00 site time), audited; Team shows "Re-sent automatically"; the manual button stays for later. `WELCOME_RESEND`.
- **Q242 · Clearing a phone's text opt-out from Team** (Q94 left the office's way to M10). _Recommended:_ never on a two-way pack (START by the person only); on a one-way pack an admin may clear an opt-out the provider recorded, with an attestation that the person asked for texts again, stored as an `sms` consent `office_attested`, audited; the provider may still refuse.
- **Q243 · What the office records when it changes a reporter's preference or message channel** (F15 "only with the reporter's agreement (logged as `office_attested`)"). _Recommended:_ a required checkbox "{first} asked for this change"; audited `reporter.preferences_changed` with `via office` and the office user; no consent row (a preference is not a consent); a channel without its consent is saved and stays unreachable until the reporter consents in the recorder, which the Team row says.
- **Q244 · What _Revoke devices_ revokes** (P10, F16 lost phone). _Recommended:_ every verified device of the reporter and its push subscriptions; consents and the personal link stay; the next open asks for a code; audited `device.revoked via office`.
- **Q246 · "Via call" in M10's Done when** for a new contractor. _Recommended:_ Talk now counts (it is the call channel wherever the pack has no number, and needs no trunk); the owner's run also calls the US number once W3-16 has set it.

**Billing (M10)**

- **Q234 · Where the price per site lives** (P13 "per org"; today `PRICE_PER_SITE_CENTS` in code and one Stripe price). _Recommended:_ `orgs.price_per_site_minor` with its currency, set at creation from an env default per currency (`BILLING_DEFAULT_PRICE_USD=39900`; TRY once Q9 is set), changed only by SiteLog staff on `/ops` (audited); the Stripe price id per currency in env. `BILLING_PRICE_POLICY`.
- **Q235 · A trial that ends with no payment method** (§19 Q7; nothing happens today, audit "… never enforced when it lapses"). _Recommended:_ the same as past due from `trial_ends_at`: an admin banner on every page, the org's grace days (14), then reminders and calls pause (`isBillingBlocked`); never for demo or `manual` orgs. `TRIAL_END_POLICY`.
- **Q236 · A TR org's billing until Q8 is decided.** _Recommended:_ `billing_provider 'manual'`: the Billing page shows the trial, the sites (Pause/Resume) and the price in TRY when set, no Checkout or portal, "SiteLog invoices you directly"; SiteLog staff set its status on `/ops`; the trial-end rule does not apply.

**Turkish market (M11)**

- **Q237 · İletimerkezi delivery status** (README: rows stay `sent`). _Recommended:_ poll the order's report from a delayed job (+2 min, +15 min, +2 h until final) and map it to the §4.5 statuses, so TR texts fall back and tell the office like Twilio's; a push report URL instead if the account offers one. `ILETIMERKEZI_STATUS`.
- **Q238 · TR glossary seeds** (§16, M11; only the §18.2 demo has seeds; nothing seeds a new org). _Recommended:_ a short built-in starter list per report language (TR about 30 site words → official terms; EN likewise), written by us, listed in spec §18 for the native read, seeded `built_in` into every new org by `on_org_created`, changeable or rejectable on the glossary page. `STARTER_GLOSSARY`.
- **Q239 · The language of office emails** other than the report email (missing, EOT pack ready, digest, unknown contact, edited after sign-off: English today) **and of the sign-in and invite emails** (§13 "EN/TR"). _Recommended:_ each office recipient's panel language (`ui_locale`, else the org's), the org's report language for site recipients and the invoice query; Supabase's magic-link and invite templates in EN and TR chosen by the user's `ui_locale` metadata (the login page's switch, the invite). `OFFICE_EMAIL_LANGUAGE`.
- **Q240 · `/ops` and `/try` in Turkish.** _Recommended:_ `/ops` stays English (SiteLog staff only); `/try` (v1.0's WhatsApp simulator, D29) stays English until GAP step 22 removes it; README deviation.
- **Q245 · How Turkish (and EN/ES) numbers, units, times and names are spoken** (§9.4 "numbers spoken naturally", M11 "tuned"). _Recommended:_ code turns every spoken line into words before TTS (`speakable()`): units as words (metreküp, derece, yüzde), times ("on yedi otuz"), ",5" as "buçuk", report numbers in groups, and a per-language pronunciation list for names the listening test flags; the owner's listening test (W4-14) confirms or adjusts. `SPOKEN_FORM`.

**Already in spec §19, still open, touching week 4:** Q2 (Turkish SIP provider and number: only if the TR pilot needs one), Q8 and Q9 (TR billing entity, provider and price), Q12 (TR data location, counsel), Q20 (İletimerkezi vs Twilio for TR SMS: "revisit at M11"), Q28 / Q50 (counsel's legal texts; the page ships in W4-06), Q40 (counsel's half), Q49 (İYS, counsel), Q63 / Q66 / Q68 (the native-speaker read: week 4 adds the panel's remaining TR, the TR emails, the starter glossary and the TR spoken forms), Q1 and Q225 (the voices; the TR listening test is W4-14), Q174 (the billing read in `resolve`; W4-10 adds the trial-end rule to it), Q196 (an unknown caller's language: unchanged while TR has no number), Q206 (Deepgram opt-out; recommended before pilots).

**Owner actions (not decisions), in order of lead time**

1. **Start today (days):** İletimerkezi account, the e-Devlet subscription approval and the `SITELOG` title (§5.2 step 7); ask İletimerkezi whether the account sends with the Turkish single shift table and whether it offers a delivery-report push URL (Q237).
2. **Start today (counsel):** the TR pack's KVKK aydınlatma metni, recording notice and consent wording in TR and EN, the cross-border transfer basis for LiveKit, Deepgram, Azure, Anthropic, Twilio and İletimerkezi (§15.2), İYS (Q49) and the TR data location (Q12); the US privacy policy, recording notice and consent (and `auto_call`, W3-17) for the US pack.
3. **Start today (decisions):** TR billing: the merchant entity and the provider (Q8), the TR price (Q9); the US Twilio toll-free verification if not done, since a real US contractor's welcome needs it (W4-12, W4-16).
4. **By mid-week (minutes each):** Stripe test mode (account, the $399 per-unit price, the webhook to the preview project's `stripe-webhook`, the secrets), approval of the Supabase Auth email templates on the preview project (W4-09), and the answers to Q229–Q246.
5. **During W4-14:** W3-16's LiveKit project and agent (if not done), Azure Speech F0, the TR listening test, an iPhone and an Android phone for Talk now in Turkish; a non-demo TR test org with a TR phone for `SITELOG` (W4-13).
6. **Export the artboards week 4 builds without:** Web-Setup, Web-Team, Web-Settings, Web-Billing (or confirm the spec and the current pages are the reference).
7. **Before the pilots (M12):** Stripe live mode, LiveKit Ship if more than 5 concurrent calls, the native-speaker read of the ES and TR copy (Q63), a TR SIP provider only if the TR pilot asks for a number (Q2).
