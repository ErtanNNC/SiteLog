import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildKeyterms } from '@sitelog/shared';
import { loadConfig } from '../config';
import { loadDotenv } from '../dotenv';
import { createLogger } from '../log';
import { createFfmpegRunner, resolveFfmpegPath } from '../media/ffmpeg';
import { loadFixture } from './eval';
import { createOpenAiClient } from './transcribe';
import { createTranscriber, transcriptionLanguage } from './transcriber';
import { loadVoiceFixtures, voiceFixturesDir } from './voice-fixtures';

/**
 * `pnpm transcribe:fixture -- <fixture id> [audio file]` (W1-11): the by-hand check with a real
 * key. Runs a fixtures/voice recording through the configured transcriber (TRANSCRIBE_PROVIDER,
 * DEEPGRAM_API_KEY from the root `.env`) with the fixture reporter's language and the golden
 * case's hints, prints the result and the word error rate against the expected transcript.
 */

/** Word error rate (substitutions + insertions + deletions over the reference words). */
export function wordErrorRate(reference: string, hypothesis: string): number {
  const words = (s: string) =>
    s
      .toLocaleLowerCase()
      .replace(/[^\p{L}\p{N}\s'-]/gu, ' ')
      .split(/\s+/)
      .filter(Boolean);
  const ref = words(reference);
  const hyp = words(hypothesis);
  if (ref.length === 0) return hyp.length === 0 ? 0 : 1;
  let prev = Array.from({ length: hyp.length + 1 }, (_, j) => j);
  for (let i = 1; i <= ref.length; i++) {
    const cur = [i];
    for (let j = 1; j <= hyp.length; j++) {
      cur[j] = Math.min(
        prev[j]! + 1,
        cur[j - 1]! + 1,
        prev[j - 1]! + (ref[i - 1] === hyp[j - 1] ? 0 : 1),
      );
    }
    prev = cur;
  }
  return Math.round((prev[hyp.length]! / ref.length) * 1000) / 1000;
}

async function main(argv: string[]): Promise<void> {
  const [id, audioArg] = argv.filter((a) => a !== '--');
  const fixture = loadVoiceFixtures().find((f) => f.id === id);
  if (!fixture) {
    const ids = loadVoiceFixtures().map((f) => f.id);
    throw new Error(`usage: pnpm transcribe:fixture -- <${ids.join(' | ')}> [audio file]`);
  }
  const audioPath = audioArg ?? (fixture.audio ? join(voiceFixturesDir()!, fixture.audio) : null);
  if (!audioPath)
    throw new Error(`${fixture.id} has no recording yet (fixtures/voice/README.md says how)`);
  await loadDotenv();
  // No database here: the transcriber needs only its own settings.
  const config = loadConfig({
    ...process.env,
    SUPABASE_DB_URL: process.env.SUPABASE_DB_URL || 'postgres://unused',
  });
  const log = createLogger({ service: 'transcribe-fixture' }, { level: 'warn' });
  const transcriber = createTranscriber(config, {
    openai: createOpenAiClient(config.OPENAI_API_KEY),
    ffmpeg: createFfmpegRunner(resolveFfmpegPath()),
    log,
  });
  const golden = fixture.goldenCase ? loadFixture(fixture.goldenCase) : undefined;
  const keyterms = buildKeyterms({
    siteName: fixture.site,
    companies: golden?.input.companies.map((c) => ({ name: c.name, aliases: c.aliases })) ?? [],
    glossary: (golden?.input.glossary ?? []).map((g) => ({
      heard: g.heard,
      status: 'confirmed' as const,
      times_heard: 1,
    })),
    languages: fixture.reporter.languages,
  });
  const started = Date.now();
  const out = await transcriber.transcribe({
    audio: readFileSync(audioPath),
    mime: fixture.mime,
    language: transcriptionLanguage(fixture.reporter),
    keyterms,
    prompt: `Construction daily site report for ${fixture.site}.`,
  });
  console.log(
    JSON.stringify(
      {
        fixture: fixture.id,
        provider: out.provider,
        model: out.model,
        language: out.language,
        expectedLanguage: fixture.expectedLanguage,
        durationS: out.durationS,
        latencyMs: Date.now() - started,
        segments: out.segments.length,
        wordErrorRate: wordErrorRate(fixture.text, out.text),
        text: out.text,
      },
      null,
      2,
    ),
  );
}

if (process.argv[1] && /transcribe-fixture\.ts$/.test(process.argv[1])) {
  main(process.argv.slice(2)).catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
