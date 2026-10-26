import { abortableFetch } from '../abort';
import { DEEPGRAM_USD_PER_MINUTE } from './cost';
import type { TranscriptSegment } from './transcribe';
import type {
  Transcriber,
  TranscriptionLanguage,
  TranscriptionRequest,
  Transcription,
} from './transcriber';

/**
 * Deepgram pre-recorded transcription (§10.2, W1-11) over plain fetch: `POST /v1/listen` with the
 * audio bytes as the body and their media type as sent by the browser (webm/mp4, no conversion),
 * `model` (TRANSCRIBE_MODEL, nova-3), `smart_format`, `utterances`, the reporter's `language`
 * (`multi` | `tr` | `en`) and one `keyterm` per hint. Word timestamps come with every pre-recorded
 * response; segments are the utterances (or, without them, sentences cut from the words).
 */

export const DEEPGRAM_API_BASE = 'https://api.deepgram.com';

export interface DeepgramOptions {
  apiKey: string;
  model: string;
  baseUrl?: string;
  /** Default: global fetch, aborted with the running job (src/abort.ts). */
  fetch?: typeof fetch;
}

export class DeepgramError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = 'DeepgramError';
  }
}

interface DgWord {
  word?: string;
  punctuated_word?: string;
  start?: number;
  end?: number;
  language?: string;
}

interface DgResponse {
  metadata?: { duration?: number; request_id?: string };
  results?: {
    channels?: Array<{
      detected_language?: string;
      alternatives?: Array<{ transcript?: string; words?: DgWord[]; languages?: string[] }>;
    }>;
    utterances?: Array<{ start?: number; end?: number; transcript?: string; channel?: number }>;
  };
}

/** The request Deepgram gets (exported for the tests). */
export function deepgramRequest(
  opts: Pick<DeepgramOptions, 'apiKey' | 'model' | 'baseUrl'>,
  req: Pick<TranscriptionRequest, 'mime' | 'language' | 'keyterms'>,
  withKeyterms = true,
): { url: string; headers: Record<string, string> } {
  const url = new URL('/v1/listen', opts.baseUrl ?? DEEPGRAM_API_BASE);
  url.searchParams.set('model', opts.model);
  url.searchParams.set('smart_format', 'true');
  url.searchParams.set('utterances', 'true');
  url.searchParams.set('language', req.language);
  if (withKeyterms) for (const t of req.keyterms) url.searchParams.append('keyterm', t);
  return {
    url: url.toString(),
    headers: {
      Authorization: `Token ${opts.apiKey}`,
      // The browser's type as stored (e.g. `audio/webm;codecs=opus`), parameters dropped.
      'Content-Type': (req.mime.split(';')[0] ?? '').trim() || 'application/octet-stream',
    },
  };
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Languages by word count, most first, `es+en` style; else the channel's or the requested one. */
function languagesOf(
  words: DgWord[],
  alt: { languages?: string[] } | undefined,
  detected: string | undefined,
  requested: TranscriptionLanguage,
): string | null {
  const counts = new Map<string, number>();
  for (const w of words) {
    const l = w.language?.toLowerCase().split('-')[0];
    if (l) counts.set(l, (counts.get(l) ?? 0) + 1);
  }
  if (counts.size > 0)
    return Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([l]) => l)
      .join('+');
  const listed = (alt?.languages ?? []).map((l) => l.toLowerCase().split('-')[0]!).filter(Boolean);
  if (listed.length > 0) return Array.from(new Set(listed)).join('+');
  if (detected) return detected.toLowerCase().split('-')[0] ?? null;
  return requested === 'multi' ? null : requested;
}

/** Sentences cut from the words (end punctuation or a pause over 1.5 s), when there are no utterances. */
function segmentsFromWords(words: DgWord[]): TranscriptSegment[] {
  const out: TranscriptSegment[] = [];
  let cur: { start: number; end: number; text: string[] } | null = null;
  for (const w of words) {
    const text = (w.punctuated_word ?? w.word ?? '').trim();
    if (!text || w.start === undefined || w.end === undefined) continue;
    if (cur && w.start - cur.end > 1.5) {
      out.push({ start: round2(cur.start), end: round2(cur.end), text: cur.text.join(' ') });
      cur = null;
    }
    cur ??= { start: w.start, end: w.end, text: [] };
    cur.text.push(text);
    cur.end = w.end;
    if (/[.!?]$/.test(text)) {
      out.push({ start: round2(cur.start), end: round2(cur.end), text: cur.text.join(' ') });
      cur = null;
    }
  }
  if (cur) out.push({ start: round2(cur.start), end: round2(cur.end), text: cur.text.join(' ') });
  return out;
}

/** Maps Deepgram's JSON to a Transcription (channel 0, the only one a voice note has). */
export function mapDeepgramResponse(
  raw: unknown,
  ctx: { model: string; language: TranscriptionLanguage },
): Transcription {
  const r = (raw ?? {}) as DgResponse;
  const channel = r.results?.channels?.[0];
  const alt = channel?.alternatives?.[0];
  const words = alt?.words ?? [];
  const text = (alt?.transcript ?? '').trim();
  let segments: TranscriptSegment[] = (r.results?.utterances ?? [])
    .filter((u) => (u.channel ?? 0) === 0)
    .map((u) => ({
      start: round2(u.start ?? 0),
      end: round2(u.end ?? u.start ?? 0),
      text: (u.transcript ?? '').trim(),
    }))
    .filter((s) => s.text.length > 0)
    .sort((a, b) => a.start - b.start);
  if (segments.length === 0) segments = segmentsFromWords(words);
  const lastEnd = segments.at(-1)?.end ?? 0;
  const durationS = round2(r.metadata?.duration ?? lastEnd);
  if (segments.length === 0 && text) segments = [{ start: 0, end: durationS, text }];
  const rate =
    ctx.language === 'multi'
      ? DEEPGRAM_USD_PER_MINUTE.multilingual
      : DEEPGRAM_USD_PER_MINUTE.monolingual;
  return {
    text,
    language: languagesOf(words, alt, channel?.detected_language, ctx.language),
    segments,
    durationS,
    model: ctx.model,
    provider: 'deepgram',
    estCostUsd: Math.round((durationS / 60) * rate * 1e6) / 1e6,
  };
}

export function createDeepgramTranscriber(opts: DeepgramOptions): Transcriber {
  const doFetch = opts.fetch ?? abortableFetch();
  const call = async (req: TranscriptionRequest, withKeyterms: boolean) => {
    const { url, headers } = deepgramRequest(opts, req, withKeyterms);
    return doFetch(url, {
      method: 'POST',
      headers,
      body: new Uint8Array(req.audio),
      ...(req.signal ? { signal: req.signal } : {}),
    });
  };
  return {
    provider: 'deepgram',
    model: opts.model,
    async transcribe(req) {
      if (!opts.apiKey) throw new Error('DEEPGRAM_API_KEY is required for transcription');
      req.signal?.throwIfAborted();
      let res = await call(req, true);
      if (!res.ok && res.status === 400 && req.keyterms.length > 0) {
        // A model or language without key-term support refuses the request; §10.2 passes them
        // only "where the model/language supports them", so ask again without.
        const body = await res.text().catch(() => '');
        if (/keyterm/i.test(body)) res = await call(req, false);
        else throw new DeepgramError(`Deepgram 400: ${body.slice(0, 300)}`, 400);
      }
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new DeepgramError(`Deepgram ${res.status}: ${body.slice(0, 300)}`, res.status);
      }
      return mapDeepgramResponse(await res.json(), { model: opts.model, language: req.language });
    },
  };
}
