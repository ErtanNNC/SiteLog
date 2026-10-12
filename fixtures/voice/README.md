# fixtures/voice — real-style recordings

The eval set (§10.12) grows from here. Transcripts in `../transcripts/*.json` are the inputs the
worker's extraction eval (`pnpm eval`) actually runs on; recordings are kept so the transcription
step can be re-run when `TRANSCRIBE_MODEL` changes.

## Adding a recording

1. Record a voice note on WhatsApp (EN, ES or mixed; include machinery noise for a few) and export
   the original `.ogg` from a test number, or record `.m4a` on a phone. Keep it under 5 minutes.
2. Save it here as `<site-slug>-<YYYY-MM-DD>-<n>.ogg` (no names or phone numbers in the file name).
3. Produce the transcript fixture with the worker's transcriber (needs `OPENAI_API_KEY`):

   ```bash
   pnpm --filter @sitelog/worker exec tsx -e "
   import { readFileSync, writeFileSync } from 'node:fs';
   import OpenAI from 'openai';
   import { createFfmpegRunner } from './src/media/ffmpeg';
   import { transcribeAudio } from './src/ai/transcribe';
   const audio = readFileSync('../../fixtures/voice/riverside-2026-10-09-1.ogg');
   const t = await transcribeAudio(new OpenAI(), createFfmpegRunner(), { audio, ext: 'ogg', model: process.env.TRANSCRIBE_MODEL ?? 'whisper-1', prompt: 'Construction daily site report.' });
   writeFileSync('../../fixtures/voice/riverside-2026-10-09-1.segments.json', JSON.stringify(t, null, 2));
   "
   ```

4. Copy the segments into a new `../transcripts/<id>.json` (add site context, companies, glossary,
   photos — see the existing files; set `expectedQuestion` to the question code should ask first,
   or `null`), and write the expected `DailyReportData` to `../expected/<id>.json`. Only values
   that are actually said in the recording may appear in `expected`; every non-null number needs a
   source with the segment start time. Save the model's `submit_daily_report` input for the case
   as `../tool-outputs/<id>.json` (the worker tests replay it without an API key).
5. Run `pnpm --filter @sitelog/worker test` (offline: every case must parse with the shared schemas,
   be internally consistent and its recorded tool output must score as a pass) and `pnpm eval`
   (needs `ANTHROPIC_API_KEY`; `--case <part>` to run a subset, `--recorded` to score the recorded
   outputs offline). The eval checks manpower counts and hours exactly, weather `lostHours`
   ±0.5 h, that every non-null number carries a source, that unknown companies are flagged, and
   that code derives the same required gaps and next question as for the expected data.

Recordings are customer-style data: do not commit real customer audio. Synthetic recordings by
the team are fine.
