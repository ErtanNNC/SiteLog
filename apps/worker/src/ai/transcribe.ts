import OpenAI, { toFile } from 'openai';
import { join } from 'node:path';
import type { CompanyRow, GlossaryTermRow } from '@sitelog/shared';
import type { Logger } from '../log';
import {
  chunkArgs,
  chunkPlan,
  convertToMp3Args,
  pcmDurationSeconds,
  decodePcmArgs,
  readTemp,
  withTempDir,
  writeTemp,
  type FfmpegRunner,
} from '../media/ffmpeg';
import { estimateTranscriptionCostUsd } from './cost';

/** §10.2 — OGG/Opus → mono 16 kHz MP3 → OpenAI transcription with segment timestamps. */

export interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
}

export interface TranscriptResult {
  language: string | null;
  text: string;
  segments: TranscriptSegment[];
  durationS: number;
  model: string;
  chunks: number;
  estCostUsd: number;
}

export interface TranscriptionApi {
  audio: {
    transcriptions: {
      create(params: {
        file: File;
        model: string;
        response_format: 'verbose_json' | 'json';
        timestamp_granularities?: Array<'segment' | 'word'>;
        prompt?: string;
        language?: string;
      }): Promise<unknown>;
    };
  };
}

/** Whisper prompts are capped at ~224 tokens; keep the vocabulary list short. */
export const TRANSCRIPTION_PROMPT_MAX_CHARS = 700;

/**
 * Vocabulary hint (§10.2 step 4): company names + aliases, site name, top confirmed glossary terms.
 * Phone numbers and personal data never go here.
 */
export function buildTranscriptionPrompt(ctx: {
  siteName: string;
  companies: Array<Pick<CompanyRow, 'name' | 'aliases'>>;
  glossary: Array<Pick<GlossaryTermRow, 'heard' | 'status' | 'times_heard'>>;
  areas?: string[];
}): string {
  const parts: string[] = [`Construction daily site report for ${ctx.siteName}.`];
  const names = ctx.companies.flatMap((c) => [c.name, ...c.aliases.filter((a) => a.length > 2)]);
  const terms = ctx.glossary
    .filter((g) => g.status === 'confirmed' || g.status === 'built_in')
    .sort((a, b) => b.times_heard - a.times_heard)
    .slice(0, 50)
    .map((g) => g.heard);
  const vocab = Array.from(new Set([...names, ...(ctx.areas ?? []), ...terms]));
  let out = parts.join(' ');
  for (const v of vocab) {
    const next = `${out} ${v},`;
    if (next.length > TRANSCRIPTION_PROMPT_MAX_CHARS) break;
    out = next;
  }
  return out.replace(/,$/, '.');
}

interface VerboseJson {
  text?: string;
  language?: string;
  duration?: number;
  segments?: Array<{ start: number; end: number; text: string }>;
}

function parseVerbose(
  raw: unknown,
  offsetS: number,
  fallbackDuration: number,
): { text: string; language: string | null; segments: TranscriptSegment[] } {
  const v = (raw ?? {}) as VerboseJson;
  const text = (v.text ?? '').trim();
  const segs = (v.segments ?? []).map((s) => ({
    start: Math.round((s.start + offsetS) * 100) / 100,
    end: Math.round((s.end + offsetS) * 100) / 100,
    text: s.text.trim(),
  }));
  if (segs.length === 0 && text)
    segs.push({
      start: offsetS,
      end: Math.round((offsetS + (v.duration ?? fallbackDuration)) * 100) / 100,
      text,
    });
  return { text, language: v.language ?? null, segments: segs.filter((s) => s.text.length > 0) };
}

export function stitchLanguages(langs: Array<string | null>): string | null {
  const uniq = Array.from(new Set(langs.filter((l): l is string => !!l).map(normaliseLanguage)));
  return uniq.length ? uniq.join('+') : null;
}

const LANG_NAMES: Record<string, string> = {
  english: 'en',
  spanish: 'es',
  polish: 'pl',
  hindi: 'hi',
  portuguese: 'pt',
  french: 'fr',
  german: 'de',
  italian: 'it',
  vietnamese: 'vi',
  chinese: 'zh',
  tagalog: 'tl',
};

export function normaliseLanguage(l: string): string {
  const low = l.toLowerCase();
  return LANG_NAMES[low] ?? (low.length <= 3 ? low : low.slice(0, 2));
}

export interface TranscribeInput {
  audio: Buffer;
  /** File extension of the original (ogg, mp3, m4a, …). */
  ext: string;
  model: string;
  prompt: string;
  /** Known duration (skips the decode when provided). */
  durationS?: number;
}

/** The whole pipeline for one voice note. Chunks > 15 min into ≤ 10-min pieces with offsets. */
export async function transcribeAudio(
  api: TranscriptionApi,
  run: FfmpegRunner,
  input: TranscribeInput,
  log?: Logger,
): Promise<TranscriptResult> {
  return withTempDir(async (dir) => {
    const original = await writeTemp(dir, `in.${input.ext || 'ogg'}`, input.audio);
    const mp3 = join(dir, 'audio.mp3');
    await run(convertToMp3Args(original, mp3));
    let durationS = input.durationS ?? 0;
    if (!durationS) {
      const { stdout } = await run(decodePcmArgs(mp3));
      durationS = pcmDurationSeconds(stdout);
    }
    const plan = chunkPlan(durationS);
    const parts: Array<{ text: string; language: string | null; segments: TranscriptSegment[] }> =
      [];
    for (const chunk of plan) {
      let path = mp3;
      if (plan.length > 1) {
        path = join(dir, `chunk-${chunk.index}.mp3`);
        await run(chunkArgs(mp3, path, chunk.startS, chunk.durationS));
      }
      const file = await toFile(await readTemp(path), `audio-${chunk.index}.mp3`, {
        type: 'audio/mpeg',
      });
      const raw = await createWithFallback(
        api,
        { file, model: input.model, prompt: input.prompt },
        log,
      );
      parts.push(parseVerbose(raw, chunk.startS, chunk.durationS));
    }
    const segments = parts.flatMap((p) => p.segments).sort((a, b) => a.start - b.start);
    return {
      language: stitchLanguages(parts.map((p) => p.language)),
      text: parts
        .map((p) => p.text)
        .filter(Boolean)
        .join(' ')
        .trim(),
      segments,
      durationS,
      model: input.model,
      chunks: plan.length,
      estCostUsd: estimateTranscriptionCostUsd(input.model, durationS),
    };
  });
}

async function createWithFallback(
  api: TranscriptionApi,
  p: { file: File; model: string; prompt: string },
  log?: Logger,
): Promise<unknown> {
  try {
    return await api.audio.transcriptions.create({
      file: p.file,
      model: p.model,
      response_format: 'verbose_json',
      timestamp_granularities: ['segment'],
      prompt: p.prompt,
    });
  } catch (err) {
    // Some models accept only json/text; fall back to one segment for the chunk.
    const msg = err instanceof Error ? err.message : String(err);
    if (/response_format|timestamp_granularities|verbose_json/i.test(msg)) {
      log?.warn('transcription model does not support verbose_json; falling back to json', {
        model: p.model,
      });
      return api.audio.transcriptions.create({
        file: p.file,
        model: p.model,
        response_format: 'json',
        prompt: p.prompt,
      });
    }
    throw err;
  }
}

/** Fewer than 5 words → "I couldn't make that out" (§F4 edge case). */
export function isUnintelligible(text: string, minWords = 5): boolean {
  return text.trim().split(/\s+/).filter(Boolean).length < minWords;
}

/** "Heard you clearly: '{first ~12 words}.'" */
export function firstWords(text: string, n = 12): string {
  return text
    .trim()
    .split(/\s+/)
    .slice(0, n)
    .join(' ')
    .replace(/[.,;:!?]+$/, '');
}

export function createOpenAiClient(apiKey: string): OpenAI | null {
  if (!apiKey) return null;
  return new OpenAI({ apiKey, maxRetries: 2, timeout: 180_000 });
}
