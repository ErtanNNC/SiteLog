import { describe, expect, it } from 'vitest';
import { runWithSignal } from '../abort';
import { abortableFetch } from '../abort';
import {
  createDeepgramTranscriber,
  DeepgramError,
  deepgramRequest,
  mapDeepgramResponse,
} from './deepgram';
import type { TranscriptionRequest } from './transcriber';

/** A Deepgram pre-recorded response (nova-3, `language=multi`, `utterances=true`), trimmed. */
function heroResponse() {
  return {
    metadata: { request_id: 'req-1', duration: 67.52, channels: 1 },
    results: {
      channels: [
        {
          alternatives: [
            {
              transcript:
                'Okay, Friday report, Riverside Block B. Primero el clima: llovió desde las siete.',
              languages: ['en', 'es'],
              words: [
                { word: 'okay', punctuated_word: 'Okay,', start: 0.1, end: 0.4, language: 'en' },
                { word: 'friday', punctuated_word: 'Friday', start: 0.5, end: 0.9, language: 'en' },
                {
                  word: 'report',
                  punctuated_word: 'report,',
                  start: 0.9,
                  end: 1.3,
                  language: 'en',
                },
                {
                  word: 'riverside',
                  punctuated_word: 'Riverside',
                  start: 1.4,
                  end: 2,
                  language: 'en',
                },
                { word: 'block', punctuated_word: 'Block', start: 2, end: 2.3, language: 'en' },
                { word: 'b', punctuated_word: 'B.', start: 2.3, end: 2.5, language: 'en' },
                {
                  word: 'primero',
                  punctuated_word: 'Primero',
                  start: 6.2,
                  end: 6.6,
                  language: 'es',
                },
                { word: 'el', punctuated_word: 'el', start: 6.6, end: 6.7, language: 'es' },
                { word: 'clima', punctuated_word: 'clima:', start: 6.7, end: 7.1, language: 'es' },
                { word: 'llovió', punctuated_word: 'llovió', start: 7.2, end: 7.6, language: 'es' },
                { word: 'desde', punctuated_word: 'desde', start: 7.6, end: 7.9, language: 'es' },
                { word: 'las', punctuated_word: 'las', start: 7.9, end: 8, language: 'es' },
                { word: 'siete', punctuated_word: 'siete.', start: 8, end: 8.4, language: 'es' },
              ],
            },
          ],
        },
      ],
      utterances: [
        {
          start: 6.2,
          end: 8.4,
          channel: 0,
          transcript: 'Primero el clima: llovió desde las siete.',
        },
        { start: 0.1, end: 2.5, channel: 0, transcript: 'Okay, Friday report, Riverside Block B.' },
      ],
    },
  };
}

function request(over: Partial<TranscriptionRequest> = {}): TranscriptionRequest {
  return {
    audio: Buffer.from('webm-bytes'),
    mime: 'audio/webm;codecs=opus',
    language: 'multi',
    keyterms: ['Riverside Lofts — Block B', 'Delta Mechanical', 'the Delta guys'],
    prompt: 'unused by Deepgram',
    ...over,
  };
}

interface Seen {
  url: URL;
  init: RequestInit;
}

function mockFetch(responses: Array<() => Response>): { fetch: typeof fetch; seen: Seen[] } {
  const seen: Seen[] = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: new URL(String(input)), init: init ?? {} });
    init?.signal?.throwIfAborted();
    const next = responses.shift();
    if (!next) throw new Error('unexpected request');
    return next();
  }) as typeof fetch;
  return { fetch: fetchFn, seen };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('Deepgram request (§10.2)', () => {
  it('posts the audio as recorded to /v1/listen with nova-3, smart_format, utterances, the language and one keyterm per hint', async () => {
    const { fetch, seen } = mockFetch([() => json(heroResponse())]);
    const t = createDeepgramTranscriber({ apiKey: 'dg-key', model: 'nova-3', fetch });
    await t.transcribe(request());
    expect(seen).toHaveLength(1);
    const { url, init } = seen[0]!;
    expect(url.origin + url.pathname).toBe('https://api.deepgram.com/v1/listen');
    expect(url.searchParams.get('model')).toBe('nova-3');
    expect(url.searchParams.get('smart_format')).toBe('true');
    expect(url.searchParams.get('utterances')).toBe('true');
    expect(url.searchParams.get('language')).toBe('multi');
    expect(url.searchParams.getAll('keyterm')).toEqual([
      'Riverside Lofts — Block B',
      'Delta Mechanical',
      'the Delta guys',
    ]);
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Token dg-key');
    // The browser's webm, no conversion; the codecs parameter dropped.
    expect(headers['Content-Type']).toBe('audio/webm');
    expect(Buffer.from(init.body as Uint8Array).toString()).toBe('webm-bytes');
  });

  it('sends tr and en as asked, and mp4 from Safari as audio/mp4', () => {
    const tr = deepgramRequest(
      { apiKey: 'k', model: 'nova-3' },
      { mime: 'audio/mp4', language: 'tr', keyterms: [] },
    );
    const u = new URL(tr.url);
    expect(u.searchParams.get('language')).toBe('tr');
    expect(u.searchParams.has('keyterm')).toBe(false);
    expect(tr.headers['Content-Type']).toBe('audio/mp4');
  });

  it('asks again without key terms when Deepgram refuses them for the model or language', async () => {
    const { fetch, seen } = mockFetch([
      () =>
        new Response('{"err_msg":"Keyterm prompting is not supported for this model"}', {
          status: 400,
        }),
      () => json(heroResponse()),
    ]);
    const t = createDeepgramTranscriber({ apiKey: 'k', model: 'nova-3', fetch });
    const out = await t.transcribe(request({ language: 'tr' }));
    expect(seen.map((s) => s.url.searchParams.getAll('keyterm').length)).toEqual([3, 0]);
    expect(out.segments.length).toBeGreaterThan(0);
  });

  it('throws a DeepgramError with the status for any other failure (the job retries)', async () => {
    const { fetch } = mockFetch([
      () => new Response('{"err_msg":"Invalid credentials"}', { status: 401 }),
    ]);
    const t = createDeepgramTranscriber({ apiKey: 'bad', model: 'nova-3', fetch });
    const err = await t.transcribe(request()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DeepgramError);
    expect((err as DeepgramError).status).toBe(401);
    const { fetch: f400 } = mockFetch([
      () => new Response('corrupt or unsupported data', { status: 400 }),
    ]);
    const t2 = createDeepgramTranscriber({ apiKey: 'k', model: 'nova-3', fetch: f400 });
    await expect(t2.transcribe(request())).rejects.toThrow(/Deepgram 400: corrupt/);
  });

  it('refuses to run without a key', async () => {
    const t = createDeepgramTranscriber({
      apiKey: '',
      model: 'nova-3',
      fetch: mockFetch([]).fetch,
    });
    await expect(t.transcribe(request())).rejects.toThrow(/DEEPGRAM_API_KEY/);
  });

  it('passes the job signal: an aborted job never reaches Deepgram, and a request in flight stops', async () => {
    const { fetch, seen } = mockFetch([() => json(heroResponse())]);
    const t = createDeepgramTranscriber({ apiKey: 'k', model: 'nova-3', fetch });
    const aborted = new AbortController();
    aborted.abort(new Error('job timed out'));
    await expect(t.transcribe(request({ signal: aborted.signal }))).rejects.toThrow(/timed out/);
    expect(seen).toHaveLength(0);

    // The default fetch is abortableFetch: the running job's signal reaches it with no argument.
    const job = new AbortController();
    let sawSignal: AbortSignal | undefined;
    const hanging = (async (_i: string | URL | Request, init?: RequestInit) => {
      sawSignal = init?.signal ?? undefined;
      return new Promise<Response>((_res, rej) =>
        init?.signal?.addEventListener('abort', () => rej(new Error('aborted by the job'))),
      );
    }) as typeof fetch;
    const t2 = createDeepgramTranscriber({
      apiKey: 'k',
      model: 'nova-3',
      fetch: abortableFetch(hanging),
    });
    const p = runWithSignal(job.signal, () => t2.transcribe(request()));
    await new Promise((r) => setTimeout(r, 5));
    job.abort(new Error('timeout'));
    await expect(p).rejects.toThrow(/aborted by the job/);
    expect(sawSignal?.aborted).toBe(true);
  });
});

describe('Deepgram response mapping', () => {
  it('maps utterances to ordered segments, words to languages by count, and the metadata duration', () => {
    const out = mapDeepgramResponse(heroResponse(), { model: 'nova-3', language: 'multi' });
    expect(out.text).toBe(
      'Okay, Friday report, Riverside Block B. Primero el clima: llovió desde las siete.',
    );
    expect(out.segments).toEqual([
      { start: 0.1, end: 2.5, text: 'Okay, Friday report, Riverside Block B.' },
      { start: 6.2, end: 8.4, text: 'Primero el clima: llovió desde las siete.' },
    ]);
    expect(out.language).toBe('es+en'); // 7 Spanish words, 6 English
    expect(out.durationS).toBe(67.52);
    expect(out.model).toBe('nova-3');
    expect(out.provider).toBe('deepgram');
    expect(out.estCostUsd).toBeCloseTo((67.52 / 60) * 0.0052, 6);
  });

  it('cuts sentences from the word timestamps when there are no utterances', () => {
    const raw = heroResponse();
    delete (raw.results as { utterances?: unknown }).utterances;
    const out = mapDeepgramResponse(raw, { model: 'nova-3', language: 'multi' });
    expect(out.segments).toEqual([
      { start: 0.1, end: 2.5, text: 'Okay, Friday report, Riverside Block B.' },
      { start: 6.2, end: 8.4, text: 'Primero el clima: llovió desde las siete.' },
    ]);
  });

  it('names the requested language for a monolingual request without word languages', () => {
    const out = mapDeepgramResponse(
      {
        metadata: { duration: 3 },
        results: {
          channels: [{ alternatives: [{ transcript: 'Bugün hava açıktı.', words: [] }] }],
        },
      },
      { model: 'nova-3', language: 'tr' },
    );
    expect(out.language).toBe('tr');
    expect(out.segments).toEqual([{ start: 0, end: 3, text: 'Bugün hava açıktı.' }]);
    expect(out.estCostUsd).toBeCloseTo((3 / 60) * 0.0043, 6);
  });

  it('reads silence as an empty transcript with no segments', () => {
    const out = mapDeepgramResponse(
      {
        metadata: { duration: 4 },
        results: { channels: [{ alternatives: [{ transcript: '' }] }] },
      },
      { model: 'nova-3', language: 'multi' },
    );
    expect(out).toMatchObject({ text: '', segments: [], durationS: 4, language: null });
  });
});
