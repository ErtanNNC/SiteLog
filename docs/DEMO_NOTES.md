# SiteLog demo notes (W1-19)

The M5 demo on the hosted staging stack after the v1.2 cut-over: where everything is, who signs in, how to reset, the rehearsal checklist (spec §16.2 M5 demo script, click by click) and the known gaps. How the stack gets there is `docs/RUNBOOK.md` §2 "Cut-over (W1-19), step by step"; every remote step there is owner-approved.

## Where

| What                  | Where                                                                                                                            |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Office panel          | `https://staging-sitelog.netlify.app`                                                                                            |
| Field web recorder    | `https://sitelog-field-staging-ertannnc.netlify.app` (its own site, D42; the exact URL is in the Deploy run's field summary)     |
| field-api, through it | `https://sitelog-field-staging-ertannnc.netlify.app/api/*` → `https://abuanbyzttuqksdctqcp.supabase.co/functions/v1/field-api/*` |
| Demo phone            | panel → **Demo phone** (`/dev/phone`): every text of the demo orgs (tab **Texts**) and every email (tab **Email**)               |
| Worker                | the developer machine, `pnpm dev:worker`; health at `http://localhost:8080/health`                                               |
| Supabase project      | `abuanbyzttuqksdctqcp` (staging)                                                                                                 |

## Who

Office users (panel, magic link only; `.example` addresses get no mail, so each sign-in is a one-time link minted with RUNBOOK step 6):

| User                            | Org                      | Role     | Panel language |
| ------------------------------- | ------------------------ | -------- | -------------- |
| `lena@kestrelbuild.example`     | Kestrel Build Group (US) | admin    | English        |
| `sam@kestrelbuild.example`      | Kestrel Build Group      | pm       | English        |
| `accounts@kestrelbuild.example` | Kestrel Build Group      | accounts | English        |
| `elif@demiryapi.example`        | Demir Yapı A.Ş. (TR)     | admin    | Turkish        |

Site managers (field app, from the personal link in their welcome text on the Demo phone; spec §18):

| Reporter                   | Site                               | Reports by | Note                                    |
| -------------------------- | ---------------------------------- | ---------- | --------------------------------------- |
| Marco Ruiz                 | Riverside Lofts — Block B, RL-2041 | Text link  | the demo's reporter (speaks ES · EN)    |
| Dana Whitfield             | Oakmont Medical Center, OM-1187    | Text link  |                                         |
| Tomasz Nowak               | Pier 9 Warehouse Retrofit, P9-0932 | Text link  | filed 16:58 in the live day             |
| Priya Raman                | Elm St. Townhomes, ES-0377         | Text link  |                                         |
| Kevin O'Brien, Aisha Bello | Northgate, Hillcrest               | Call       | calls are week 2 (M7): not in this demo |
| Selin Kaya (TR)            | Ataşehir Ofis Binası, AO-0512      | Text link  | the Turkish field app                   |

Both demo orgs are `is_demo`: every text goes through `console` to the Demo phone, never to a real phone, whatever the country pack holds. No pack has a sender id on staging (RUNBOOK step 4 checks it).

## Timing and reset

- The seed is a live day in Chicago time (`pnpm seed:demo -- --date today --apply --allow-staging`, RUNBOOK step 5). Run after 17:00 Chicago (01:00 Istanbul while Chicago is on daylight time, 02:00 from Nov 1) for §18.1's view: Pier 9 filed at 16:58, five sites awaiting. Run earlier, the day stops at the clock: before 16:59 all six sites are awaiting (step 1 of the script then reads "6 awaiting").
- The seeded day is that Chicago date: a demo after Chicago midnight (08:00 Istanbul in October) needs a fresh seed for the new day.
- **Reset between rehearsals:** run the same seed command again. It replaces the demo orgs' rows (reports, links, devices, texts) and drops their jobs; the customer org is never touched. On the phone, the device check comes back (the device rows are reseeded); if the field app still shows the previous run, open the personal link again from the new welcome text.

## Rehearsal checklist (spec §16.2 M5, twice in a row on a real phone)

Two screens: the panel on a laptop, signed in as Lena; the field app on the phone. The worker runs on the laptop (RUNBOOK step 7). "Keys" says what each step needs beyond the deployed stack: **none** works with no provider key, **Anthropic** needs `ANTHROPIC_API_KEY`, **Deepgram** needs `DEEPGRAM_API_KEY` (without it, outside production, the worker's fake transcriber answers with the Riverside fixture transcript whatever was said), **Resend** is optional.

Read-aloud script for Marco (the Riverside hero, `fixtures/voice/es-en-riverside-2026-10-09.json`, about 70 s; say Delta's crew without a number so the one question comes): _"Okay, Friday report, Riverside Block B. Long day but a good one. Primero el clima: llovió desde las siete hasta las diez y media, no pudimos hacer block afuera en la fachada sur. So masonry outside stood down about three and a half hours, we moved those guys inside to do the interior block on two. Then we poured the deck on four, like sixty-eight yards, finished around two thirty, Apex had six guys all day on that. BrightLine, five electricians full day on three, rough-in is about sixty percent now. The Delta guys were on two doing the ductwork east wing, todo el día también. Ironclad had three guys tying rebar for the five deck, full day, and they brought two loads of rebar around one o'clock. Our guys, four laborers all day, cleanup and helping the pour. Safety, we did the toolbox talk this morning on wet weather access, slippery decks, no incidents, nobody got hurt. El lunes necesitamos la bomba de concreto a las siete para el deck de cinco. That's it, sending two photos."_

| #   | Demo script (§16.2)                                              | Click by click                                                                                                                                                                                                                                                                                                                                                                                                | Keys                    | Pass when                                                                                                    |
| --- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------ |
| 0   | Before                                                           | Laptop: open Lena's sign-in link → Overview ("Today across 6 sites"). Worker `/health` shows `ok: true`, `listening: true`. Phone: get Marco's personal link from **Demo phone** → **Texts** → Marco Ruiz → the welcome text (copy it to the phone yourself, e.g. by mail or a QR code; or open it there with **Text today's link** on Riverside's Site detail first, which adds a daily link to his thread). | none                    | the welcome text is in Marco's thread                                                                        |
| 1   | Overview shows 5 sites awaiting                                  | Overview: the **Today in numbers** bar shows Filed 1 (Pier 9) and Awaiting 5; **Sites today** lists Riverside as Awaiting.                                                                                                                                                                                                                                                                                    | none                    | 5 awaiting (6 before 16:59 Chicago)                                                                          |
| 2   | Site manager taps the link, talks, adds photos                   | Phone: open the link → "Is this Marco's phone?" → **Yes, text me a code** → laptop: the code ("SiteLog code: …") appears in Marco's Demo phone thread → type it → **Continue** (the welcome and consent screen shows only if Marco has no consent) → Today: **Record today's report** → read the script → **Add photo** twice → **Stop & send** → "Writing your report…".                                     | Deepgram (or the fake)  | Processing ticks "Transcribed"; the device check passing is the W1-07 cookie probe through the Netlify proxy |
| 3   | One question ("Delta — 4 or 5?") → tap                           | Phone: the **Quick check** screen asks about Delta's crew, "Heard at m:ss in your note"; tap one of the two answers (or type the number and keep **Full day**). The confirmation line shows the computed hours.                                                                                                                                                                                               | Anthropic               | one question only; the line's total is workers × hours                                                       |
| 4   | Draft → Confirm & send                                           | Phone: **Check today's report** (crew by company, weather, done, delivered, safety, next workday, 2 photos) → **Confirm & send** → "Filing your report…" → **Filed.**                                                                                                                                                                                                                                         | Anthropic               | the Filed screen with the report number                                                                      |
| 5   | PDF link arrives on the Demo phone; Overview flips to Filed live | Laptop: Marco's thread gets "Filed: Daily Report RL-2041-…. PDF: …" (the PDF link opens in a new tab); **Email** tab shows the report email with the PDF while `EMAIL_PROVIDER=console`; Overview's Riverside row turns Filed without a reload. Phone: **Open the PDF**.                                                                                                                                      | none (Resend: optional) | text, email and PDF present; the row changed without a reload                                                |
| 6   | Open the report, play the rain stoppage                          | Overview → Riverside row (or **Reports**) → the report → in the weather line, the source chip "audio m:ss" (about 0:06–0:19 in this script; §16.2's "0:41" is the 2 min 48 s hero note of the seed) → the player jumps there and plays.                                                                                                                                                                       | Deepgram (real timings) | the chip plays the rain sentence                                                                             |
| 7   | Sign off                                                         | Report review → **Sign off** → "Sign off RL-2041-… v1?" → **Sign off** → "… signed off." (undo within 10 minutes).                                                                                                                                                                                                                                                                                            | none                    | "Signed off by Lena Ortiz"; a `report.signed_off` audit row                                                  |

`question_ready` and `draft_ready` texts are not sent while the phone has the report open (D25: a device seen in the last 30 s), so the Demo phone usually shows only the code and the filed text during the run.

Without keys, steps 0–2 and the panel parts of 1, 5 (for seeded reports) and 7 can still be rehearsed: the panel on the seeded data (Overview, Sites, Reports, Report review and sign-off of a seeded report such as Oakmont's "Needs review"), the Demo phone, the device check and the upload. Step 3 onwards needs Anthropic: without it `extract_report` retries and dies, and the office gets a `processing_failed` notice.

## Known gaps

- **Real texts.** Demo orgs never text a real phone; a real SMS needs a non-demo org and the pack's sender id (`pnpm countries:set`, owner-approved, only after US toll-free verification or the TR BTK title). The personal link reaches the phone by hand (step 0).
- **Demo phone and the field app on `*.netlify.app`.** The panel cannot frame the field app with its cookie (two registrable domains), so its links open in a new tab (RUNBOOK, D42); custom domains are GAP §8 Q7.
- **Seeded reports have no files.** The seed is SQL only: seeded voice notes, photos and PDFs have rows but no Storage objects, so their players jump to a timestamp but play nothing and their PDF links fail until a sign-off or edit re-renders the PDF. Step 6 uses the report filed live.
- **Calls and Talk now** are week 2 (M7): Kevin's and Aisha's call reports exist only as seeded rows; the TR pack has no voice number.
- **Reminders.** `scheduler-tick` does not run on staging (pg_cron's Vault secrets are missing, GAP §8), and week 1 has no SMS reminder ladder (W1-10): no automatic daily links or missing alerts. Use **Text today's link** on Site detail.
- **No hosted worker.** The worker runs on the developer machine (GAP §8 Q9); with the laptop asleep nothing is processed (uploads wait in the queue).
- **Report review** (W1-17, `81c9500`) is built and its `e2e:supabase` specs cover demo steps 6 and 7 on the seeded hero report, but they have not run in CI yet (no runners on 2026-10-15): confirm the labels of steps 6 and 7 at the first rehearsal.
- **The customer org on staging** (one org, one invited reporter, from before v1.2) is left as it is; its reporter is `invited` and gets nothing (no sender id: `console`, written `failed`, spec §19 Q48).
