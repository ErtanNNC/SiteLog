import type { CompanyRow, GlossaryTermRow } from '@sitelog/shared';
import type { Config } from '../config';
import type { Logger } from '../log';
import type { FfmpegRunner } from '../media/ffmpeg';
import { mimeExtension } from '../storage';
import { createDeepgramTranscriber } from './deepgram';
import { createFakeTranscriber } from './fake-transcriber';
import { transcribeAudio, type TranscriptionApi, type TranscriptSegment } from './transcribe';

/**
 * §10.2 Transcription behind one interface (W1-11): Deepgram Nova-3 by default, OpenAI speech to
 * text as the fallback (`TRANSCRIBE_PROVIDER=openai`), and a fake that answers with the expected
 * transcripts of fixtures/voice for tests and keyless development. The web recorder's voice notes
 * (`transcribe_upload`) go through it; the v1.0 WhatsApp path (`transcribe_audio`) keeps calling
 * OpenAI directly until step 22.
 */

export type TranscribeProvider = 'deepgram' | 'openai' | 'fake';

/** Deepgram's `language`: `multi` (code-switching EN/ES), `tr`, or `en` (§10.2). */
export type TranscriptionLanguage = 'multi' | 'tr' | 'en';

export interface TranscriptionRequest {
  audio: Buffer;
  /** The stored media type (`audio/webm;codecs=opus`, `audio/mp4`, …); sent as is (§10.2). */
  mime: string;
  language: TranscriptionLanguage;
  /** Deepgram key terms (`buildKeyterms`); never a phone number. */
  keyterms: string[];
  /** The OpenAI vocabulary prompt (`buildTranscriptionPrompt`). */
  prompt: string;
  /** Known duration, when ffmpeg measured it. */
  durationS?: number;
  /** The job's AbortSignal (W1-10): a timed-out job's request stops. */
  signal?: AbortSignal;
}

export interface Transcription {
  text: string;
  /** Detected language(s), `es+en` style (most words first); null when unknown. */
  language: string | null;
  segments: TranscriptSegment[];
  durationS: number;
  model: string;
  provider: TranscribeProvider;
  estCostUsd: number;
}

export interface Transcriber {
  readonly provider: TranscribeProvider;
  readonly model: string;
  transcribe(req: TranscriptionRequest): Promise<Transcription>;
}

// ───────────────────────────── Language choice (§10.2) ─────────────────────────────

function base(tag: string | null | undefined): string {
  return (tag ?? '').toLowerCase().split(/[-_]/)[0] ?? '';
}

/**
 * The reporter's transcription language (§10.2): `tr` for a Turkish reporter (locale `tr-*`, or
 * Turkish their only language), `multi` for a reporter who speaks only English and/or Spanish
 * (Deepgram's code-switching model), `en` otherwise (another language beside English, an unknown
 * reporter). With no languages listed the locale stands for them. Spec §19 Q56 asks the owner to
 * confirm the reading for an English-only reporter and for mixed lists.
 */
export function transcriptionLanguage(reporter: {
  locale?: string | null;
  languages?: readonly string[] | null;
}): TranscriptionLanguage {
  const locale = base(reporter.locale);
  let langs = Array.from(new Set((reporter.languages ?? []).map(base).filter(Boolean)));
  if (langs.length === 0 && locale) langs = [locale];
  if (locale === 'tr' || (langs.length > 0 && langs.every((l) => l === 'tr'))) return 'tr';
  if (langs.length > 0 && langs.every((l) => l === 'en' || l === 'es')) return 'multi';
  return 'en';
}

// ───────────────────────────── Key terms (§10.2) ─────────────────────────────

/** Deepgram counts key-term tokens (500 at most per request); stay well inside it. */
export const KEYTERMS_MAX = 100;
export const KEYTERMS_MAX_WORDS = 400;
const KEYTERM_MAX_CHARS = 60;

/** A run of 7 or more digits (a phone number, an account number): never sent to a provider. */
function hasLongNumber(term: string): boolean {
  return term.replace(/[\s().+-]/g, '').match(/\d{7,}/) !== null;
}

export interface VocabularyContext {
  siteName: string;
  companies: Array<Pick<CompanyRow, 'name' | 'aliases'>>;
  glossary: Array<
    Pick<GlossaryTermRow, 'heard' | 'status' | 'times_heard'> &
      Partial<Pick<GlossaryTermRow, 'kind' | 'official' | 'language'>>
  >;
  /** The reporter's languages (`es`, `en`, `tr`): glossary terms in other languages are left out. */
  languages?: readonly string[];
}

function usable(term: GlossaryTermRow['status']): boolean {
  return term === 'confirmed' || term === 'built_in';
}

/**
 * §10.2 hints as Deepgram key terms: the site name, company names and aliases, the site's areas
 * (glossary terms of kind `area`, heard and official), and the top 50 confirmed glossary terms in
 * the reporter's languages. Deduplicated (case-insensitive), capped, and never a phone number.
 */
export function buildKeyterms(ctx: VocabularyContext): string[] {
  const langs = new Set((ctx.languages ?? []).map(base).filter(Boolean));
  const inLanguage = (l: string | undefined) => !l || langs.size === 0 || langs.has(base(l));
  const glossary = ctx.glossary.filter((g) => usable(g.status));
  const areas = glossary
    .filter((g) => g.kind === 'area')
    .flatMap((g) => [g.heard, ...(g.official ? [g.official] : [])]);
  const terms = glossary
    .filter((g) => g.kind !== 'area' && inLanguage(g.language))
    .sort((a, b) => b.times_heard - a.times_heard)
    .slice(0, 50)
    .map((g) => g.heard);
  const candidates = [
    ctx.siteName,
    ...ctx.companies.flatMap((c) => [c.name, ...c.aliases]),
    ...areas,
    ...terms,
  ];
  const seen = new Set<string>();
  const out: string[] = [];
  let words = 0;
  for (const raw of candidates) {
    const term = raw.replace(/\s+/g, ' ').trim();
    if (term.length < 2 || term.length > KEYTERM_MAX_CHARS || hasLongNumber(term)) continue;
    const key = term.toLocaleLowerCase();
    if (seen.has(key)) continue;
    const n = term.split(' ').length;
    if (out.length >= KEYTERMS_MAX || words + n > KEYTERMS_MAX_WORDS) break;
    seen.add(key);
    out.push(term);
    words += n;
  }
  return out;
}

// ───────────────────────────── Choice and construction ─────────────────────────────

export const DEFAULT_TRANSCRIBE_MODEL: Record<TranscribeProvider, string> = {
  deepgram: 'nova-3',
  openai: 'whisper-1',
  fake: 'fake',
};

export interface TranscriberChoice {
  provider: TranscribeProvider;
  model: string;
  /** Deepgram or OpenAI chosen in production without its key: every job fails until it is set. */
  missingKey: string | null;
  /** Why the choice differs from TRANSCRIBE_PROVIDER, for the boot log. */
  note: string | null;
}

/**
 * TRANSCRIBE_PROVIDER (default `deepgram`) with its key. Outside production a provider without
 * its key becomes the fake (as EMAIL_PROVIDER=resend without a key becomes console), so a
 * keyless checkout runs end to end. In production it never does: a fake transcript would be
 * invented report content, so the job fails (and retries) until the key is set. TRANSCRIBE_MODEL
 * is the chosen provider's model; empty takes that provider's default.
 */
export function resolveTranscriberChoice(
  config: Pick<
    Config,
    'TRANSCRIBE_PROVIDER' | 'TRANSCRIBE_MODEL' | 'DEEPGRAM_API_KEY' | 'OPENAI_API_KEY' | 'NODE_ENV'
  >,
): TranscriberChoice {
  const requested = config.TRANSCRIBE_PROVIDER;
  const keyName =
    requested === 'deepgram' ? 'DEEPGRAM_API_KEY' : requested === 'openai' ? 'OPENAI_API_KEY' : '';
  const key =
    requested === 'deepgram'
      ? config.DEEPGRAM_API_KEY
      : requested === 'openai'
        ? config.OPENAI_API_KEY
        : 'n/a';
  if (requested !== 'fake' && !key) {
    if (config.NODE_ENV === 'production') {
      return {
        provider: requested,
        model: config.TRANSCRIBE_MODEL || DEFAULT_TRANSCRIBE_MODEL[requested],
        missingKey: keyName,
        note: `${keyName} is not set: transcription fails until it is`,
      };
    }
    return {
      provider: 'fake',
      model: DEFAULT_TRANSCRIBE_MODEL.fake,
      missingKey: null,
      note: `TRANSCRIBE_PROVIDER=${requested} without ${keyName}: the fake transcriber (fixtures/voice) answers`,
    };
  }
  if (requested === 'fake') {
    return {
      provider: 'fake',
      model: DEFAULT_TRANSCRIBE_MODEL.fake,
      missingKey: null,
      note:
        config.NODE_ENV === 'production'
          ? 'TRANSCRIBE_PROVIDER=fake in production: every voice note gets a fixture transcript'
          : null,
    };
  }
  return {
    provider: requested,
    model: config.TRANSCRIBE_MODEL || DEFAULT_TRANSCRIBE_MODEL[requested],
    missingKey: null,
    note: null,
  };
}

/** A transcriber whose key is missing in production: each call fails with what to set. */
function missingKeyTranscriber(choice: TranscriberChoice): Transcriber {
  return {
    provider: choice.provider,
    model: choice.model,
    async transcribe() {
      throw new Error(
        `${choice.missingKey} is required for transcription (TRANSCRIBE_PROVIDER=${choice.provider})`,
      );
    },
  };
}

/** OpenAI behind the interface: the v1.0 pipeline (MP3, split above 15 min, segment timestamps). */
export function createOpenAiTranscriber(
  api: TranscriptionApi,
  ffmpeg: FfmpegRunner,
  model: string,
  log?: Logger,
): Transcriber {
  return {
    provider: 'openai',
    model,
    async transcribe(req) {
      req.signal?.throwIfAborted();
      const t = await transcribeAudio(
        api,
        ffmpeg,
        {
          audio: req.audio,
          ext: mimeExtension(req.mime, 'webm'),
          model,
          prompt: req.prompt,
          durationS: req.durationS,
        },
        log,
      );
      return {
        text: t.text,
        language: t.language,
        segments: t.segments,
        durationS: t.durationS,
        model: t.model,
        provider: 'openai',
        estCostUsd: t.estCostUsd,
      };
    },
  };
}

export function createTranscriber(
  config: Config,
  deps: {
    openai: TranscriptionApi | null;
    ffmpeg: FfmpegRunner;
    log: Logger;
    fetch?: typeof fetch;
  },
): Transcriber {
  const choice = resolveTranscriberChoice(config);
  if (choice.note)
    (choice.missingKey || config.NODE_ENV === 'production' ? deps.log.warn : deps.log.info)(
      'transcription provider',
      { provider: choice.provider, model: choice.model, note: choice.note },
    );
  if (choice.missingKey) return missingKeyTranscriber(choice);
  if (choice.provider === 'fake') return createFakeTranscriber();
  if (choice.provider === 'openai') {
    if (!deps.openai) return missingKeyTranscriber({ ...choice, missingKey: 'OPENAI_API_KEY' });
    return createOpenAiTranscriber(deps.openai, deps.ffmpeg, choice.model, deps.log);
  }
  return createDeepgramTranscriber({
    apiKey: config.DEEPGRAM_API_KEY,
    model: choice.model,
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
  });
}
