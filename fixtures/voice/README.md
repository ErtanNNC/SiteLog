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
| `tr-kartal-2026-10-09.json`       | TR → tr  | Emre Yıldız, Kartal (tr-TR, §18.2) | Four crews, a pour, the §18.2 glossary phrases; no golden case yet (W1-12 adds Turkish cases)                  |

## Who reads them

- **The fake transcriber** (`apps/worker/src/ai/fake-transcriber.ts`, `TRANSCRIBE_PROVIDER=fake`,
  and the default outside production when the provider's key is missing): it answers with the
  fixture a fake audio file names (the integration harness's `fakeAudio(id, seconds)`), else the
  first fixture in the requested language (a real recording gets the transcript of its reporter's
  language). The CI worker in `e2e-supabase` runs with it.
- **The tests**: `apps/worker/src/ai/transcriber.test.ts` (each file parses, its language follows
  from its reporter, the EN and ES + EN scripts equal their golden cases) and
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
