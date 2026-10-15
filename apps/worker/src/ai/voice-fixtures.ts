import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

/**
 * fixtures/voice (W1-11): one JSON per voice note with its expected transcript, the reporter it
 * stands for (so the Deepgram language follows from §10.2) and, once recorded, its audio file. The
 * fake transcriber answers with these transcripts; `pnpm transcribe:fixture` runs a recording
 * through the configured provider and compares it with them.
 */

const Segment = z.object({
  start: z.number().min(0),
  end: z.number().min(0),
  text: z.string().min(1),
});

export const VoiceFixtureSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9-]+$/),
    description: z.string().min(1),
    /** The recording beside this file (`<id>.webm`, `.m4a`, …); null until one is recorded. */
    audio: z.string().nullable(),
    mime: z.string().startsWith('audio/'),
    site: z.string().min(1),
    reporter: z.object({ locale: z.string(), languages: z.array(z.string()) }),
    /** What `transcriptionLanguage(reporter)` gives (§10.2): checked by the tests. */
    transcriptionLanguage: z.enum(['multi', 'tr', 'en']),
    /** The language(s) the transcript is in, `en+es` style (most words first). */
    expectedLanguage: z.string().min(2),
    /** The golden extraction case (fixtures/transcripts) this note is the script of, if any. */
    goldenCase: z.string().nullable(),
    durationS: z.number().positive(),
    text: z.string().min(1),
    segments: z.array(Segment).min(1),
  })
  .strict();

export type VoiceFixture = z.infer<typeof VoiceFixtureSchema>;

/**
 * fixtures/voice, found from this module up (src/ai in the repo, dist in a build). Null in an
 * image that ships without fixtures (the worker's Docker image).
 */
export function voiceFixturesDir(): string | null {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    const candidate = join(dir, 'fixtures', 'voice');
    if (existsSync(candidate)) return candidate;
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}

let cached: VoiceFixture[] | null = null;

/** Every fixtures/voice/*.json, by id. Throws when the folder is missing or a file is invalid. */
export function loadVoiceFixtures(dir: string | null = voiceFixturesDir()): VoiceFixture[] {
  if (cached && dir === voiceFixturesDir()) return cached;
  if (!dir) throw new Error('fixtures/voice not found: the fake transcriber runs from the repo');
  const out = readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => {
      const parsed = VoiceFixtureSchema.safeParse(JSON.parse(readFileSync(join(dir, f), 'utf8')));
      if (!parsed.success)
        throw new Error(`fixtures/voice/${f}: ${parsed.error.issues[0]?.message ?? 'invalid'}`);
      if (`${parsed.data.id}.json` !== f) throw new Error(`fixtures/voice/${f}: id does not match`);
      return parsed.data;
    });
  if (dir === voiceFixturesDir()) cached = out;
  return out;
}
