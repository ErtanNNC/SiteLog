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
  /**
   * What the clip is (W2-09, W2-13, W2-10): a report's voice note (the default), a spoken answer
   * to a question, the Welcome screen's test, or a fix of the draft (*Fix by voice*). Providers ignore it; the fake answers with a fixture
   * of that kind.
   */
  purpose?: 'report' | 'answer' | 'test' | 'correction';
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

// Key terms (§10.2): `buildKeyterms` is in @sitelog/shared (glossary/keyterms.ts, W3-08), so a
// call's `get_context` gives the agent the same hints as a voice note gets here.

// ───────────────────────────── Choice and construction ─────────────────────────────

export const DEFAULT_TRANSCRIBE_MODEL: Record<TranscribeProvider, string> = {
  deepgram: 'nova-3',
  openai: 'whisper-1',
  fake: 'fake',
};

export interface TranscriberChoice {
  provider: TranscribeProvider;
  model: string;
  /** Deepgram or OpenAI chosen without its key: every job fails until it is set. */
  missingKey: string | null;
  /** Why the choice differs from TRANSCRIBE_PROVIDER, for the boot log. */
  note: string | null;
}

/** TRANSCRIBE_PROVIDER=fake under NODE_ENV=production: the worker refuses to start. */
export const FAKE_TRANSCRIPTION_IN_PRODUCTION =
  'TRANSCRIBE_PROVIDER=fake is refused in production: a fake transcript is invented report content. Set deepgram (or openai) with its key, or run with NODE_ENV=development.';

/**
 * TRANSCRIBE_PROVIDER (default `deepgram`) with its key. The fake answers only when
 * TRANSCRIBE_PROVIDER=fake is set explicitly, never as a fallback: a provider without its key
 * fails every job (which retries) until the key is set, with a warning at boot. In production
 * `fake` is refused (throws): a fake transcript would be invented report content.
 * TRANSCRIBE_MODEL is the chosen provider's model; empty takes that provider's default.
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
  if (requested === 'fake') {
    if (config.NODE_ENV === 'production') throw new Error(FAKE_TRANSCRIPTION_IN_PRODUCTION);
    return {
      provider: 'fake',
      model: DEFAULT_TRANSCRIBE_MODEL.fake,
      missingKey: null,
      note: 'TRANSCRIBE_PROVIDER=fake: every voice note gets a fixtures/voice transcript',
    };
  }
  if (!key) {
    return {
      provider: requested,
      model: config.TRANSCRIBE_MODEL || DEFAULT_TRANSCRIBE_MODEL[requested],
      missingKey: keyName,
      note: `${keyName} is not set: transcription fails until it is (TRANSCRIBE_PROVIDER=fake for fixture transcripts outside production)`,
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
    deps.log.warn('transcription provider', {
      provider: choice.provider,
      model: choice.model,
      note: choice.note,
    });
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
