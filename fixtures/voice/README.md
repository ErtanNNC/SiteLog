# fixtures/voice — web recorder voice notes and their expected transcripts

One JSON file per voice note (W1-11, spec §10.2). Each holds the expected transcript (`text` and
timed `segments`), the reporter it stands for (`reporter.locale`, `reporter.languages`), the
Deepgram language that reporter gets (`transcriptionLanguage`: `multi` for English and/or Spanish
speakers, `tr` for Turkish, `en` otherwise), the language(s) of the transcript (`expectedLanguage`),
the golden extraction case it is the script of (`goldenCase`, `../transcripts/<id>.json`) and its
recording (`audio`).

| File                              | Language | Reporter (§18)                     | What it covers                                                                                                 |
| --------------------------------- | -------- | ---------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `en-elm-2026-10-02.json`          | EN → en  | Priya Raman, Elm St. (EN · HI)     | Partial-day rain-out, one self-perform crew, a delivery (golden `elm-2026-10-02-rain-morning`)                 |
| `es-en-riverside-2026-10-09.json` | ES + EN  | Marco Ruiz, Riverside (ES · EN)    | The hero report: code-switching, the Delta crew on site with no headcount (D27; golden `riverside-2026-10-09`) |
| `tr-kartal-2026-10-09.json`       | TR → tr  | Emre Yıldız, Kartal (tr-TR, §18.2) | Four crews, a pour, the §18.2 glossary phrases (golden `kartal-2026-10-09-tr`, W1-12)                          |

### Spoken answers (W2-09, `kind: "answer"`)

F7 _Other…_: the clip a reporter says for an open question. Each is the answer of a case in
`../answers/` (the `parse_answer` golden set), whose recorded tool output the fake Claude returns
for that transcript.

| File                                | Language | Reporter                     | What it covers                                             |
| ----------------------------------- | -------- | ---------------------------- | ---------------------------------------------------------- |
| `answer-en-delta-five-all-day.json` | EN       | Marco Ruiz (ES · EN → multi) | "Five, all day." to the Delta question (W2-09's Done-when) |
| `answer-es-delta-cinco.json`        | ES       | Marco Ruiz                   | The same answer in Spanish                                 |
| `answer-tr-demirci-alti.json`       | TR       | Emre Yıldız (tr)             | The rebar crew of the Kartal report: six, a full day       |
| `answer-en-unclear.json`            | EN       | Priya Raman (EN · HI → en)   | No answer in it: below 0.7, asked once more, then flagged  |

### Corrections (W2-10, `kind: "correction"`)

F8 _Fix by voice_: the clip a reporter says on the draft. Each is the fix of a case in
`../corrections/` (the `apply_correction` golden set), whose recorded tool output the fake Claude
returns for that transcript.

| File                            | Language | Reporter                     | What it covers                                      |
| ------------------------------- | -------- | ---------------------------- | --------------------------------------------------- |
| `correction-en-apex-seven.json` | EN       | Marco Ruiz (ES · EN → multi) | "Apex had seven, not six." (W2-10's Done-when)      |
| `correction-en-apex-total.json` | EN       | Marco Ruiz                   | The headcount and a total said: the total is code's |
| `correction-en-which-crew.json` | EN       | Marco Ruiz                   | A number with no crew: the model asks which         |
| `correction-es-apex-siete.json` | ES       | Marco Ruiz                   | The Apex fix in Spanish                             |
| `correction-tr-usta-bes.json`   | TR       | Emre Yıldız (tr)             | The Usta Beton headcount of the Kartal draft        |

### Test recordings (W2-13, `kind: "test"`)

F4's optional 20-second test on the Welcome screen: `test-en-check.json` (Priya, en),
`test-es-en-check.json` (Marco, ES + EN → multi) and `test-tr-check.json` (Emre, tr). The fake
transcriber answers a test clip with the one in its reporter's language; nothing is filed.

Every file has a `kind` (`report` when absent, `answer`, `test`, `correction`); the fake transcriber answers a
request with a fixture of the request's purpose (`TranscriptionRequest.purpose`), so a real
Chromium recording of an answer gets an answer transcript in its reporter's language.

## Who reads them

- **The fake transcriber** (`apps/worker/src/ai/fake-transcriber.ts`, `TRANSCRIBE_PROVIDER=fake`,
  and the default outside production when the provider's key is missing): it answers with the
  fixture a fake audio file names (the integration harness's `fakeAudio(id, seconds)`), else the
  first fixture in the requested language (a real recording gets the transcript of its reporter's
  language). The CI worker in `e2e-supabase` runs with it.
- **The tests**: `apps/worker/src/ai/transcriber.test.ts` (each file parses, its language follows
  from its reporter, the EN, ES + EN and TR scripts equal their golden cases) and
  `apps/worker/src/integration/upload.integration.test.ts` (a fixture upload through
  `transcribe_upload` on PGlite).
- **`pnpm transcribe:fixture -- <id> [audio file]`**: the by-hand check with a real key. It runs a
  recording through the configured provider (`TRANSCRIBE_PROVIDER`, `DEEPGRAM_API_KEY` in the root
  `.env`) with the fixture reporter's language and the golden case's hints, and prints the
  transcript, the detected language, the latency and the word error rate against `text`.

## No recordings yet

`audio` is `null` in all three: this repository was built without a microphone or an offline
text-to-speech engine, so there are no audio files, only the scripts. Until they exist, the
by-hand Deepgram check needs a recording made from the script:

1. Read the fixture's `text` aloud in the field app (`pnpm dev:field`, the Recording screen) or a
   phone's voice recorder, at a natural pace, with some site noise for one of them. The browser
   gives `audio/webm` (Chrome, Firefox) or `audio/mp4` (Safari); keep what it gives.
2. Save it here as `<id>.webm` or `<id>.m4a` (no names or phone numbers in the file name; the
   team's own voices only, never customer audio) and set `audio` (and `mime`, for mp4) in the JSON.
3. Run `pnpm transcribe:fixture -- <id>` with `DEEPGRAM_API_KEY` set. Adjust `segments` to the
   recording's real timings if you want them exact; keep `text` as said.

Larger than about 1 MB per file is too big for the repository: keep notes short (under a minute)
or store them outside git and pass the path as the second argument.
