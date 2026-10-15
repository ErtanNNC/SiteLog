import { copyFile, readFile } from 'node:fs/promises';
import type { SiteDayWeather } from '@sitelog/shared';
import { findPhoneNumbers } from '../ai/eval';
import {
  createFixtureClaude,
  type FakeClaude,
  type FixtureClaudeOptions,
  type FixtureLibrary,
} from '../ai/fake-claude';
import { fakeAudio, readFakeAudio } from '../ai/fake-transcriber';
import type { TranscriptionApi } from '../ai/transcribe';
import type { EmailProvider } from '../email/provider';
import type { FfmpegRunner } from '../media/ffmpeg';
import type { Storage } from '../storage';
import type { FakeWaClient, WaClient } from '../wa/client';

/**
 * The outside world for the integration test and the load test: every external call the worker
 * makes (Meta media + messages, OpenAI transcription, Claude, Supabase Storage, the email provider,
 * Open-Meteo, ffmpeg) answered from fixtures/, with optional simulated latency and transient
 * failures. Nothing here talks to the network.
 */

// ───────────────────────────── Clock ─────────────────────────────

export interface Clock {
  now(): Date;
  /** Manual clocks only. */
  set(d: Date): void;
  advance(ms: number): void;
}

/** A clock that only moves when told to (deterministic tests). */
export function manualClock(start: Date): Clock {
  let t = start.getTime();
  return {
    now: () => new Date(t),
    set: (d) => {
      t = d.getTime();
    },
    advance: (ms) => {
      t += ms;
    },
  };
}

/**
 * Virtual time for a time-scaled run: starts at `start` and runs 1/scale times faster than the
 * wall clock, so a 12 s transcription that really sleeps 12 s × scale still reads as 12 s.
 */
export function scaledClock(start: Date, scale: number): Clock {
  const t0 = Date.now();
  let offset = 0;
  return {
    now: () => new Date(start.getTime() + (Date.now() - t0) / scale + offset),
    set: (d) => {
      offset += d.getTime() - (start.getTime() + (Date.now() - t0) / scale + offset);
    },
    advance: (ms) => {
      offset += ms;
    },
  };
}

// ───────────────────────────── Latency / failures ─────────────────────────────

/** [min, max] seconds at time scale 1 (uniformly sampled). */
export type Range = readonly [number, number];

export interface LatencyProfile {
  /** Meta media download (URL lookup + GET). */
  media: Range;
  /** OpenAI transcription of a 3-minute note (scaled linearly by the note length, floor 30 %). */
  transcribe: Range;
  /** Claude extraction (submit_daily_report, the main model). */
  claude: Range;
  /** The fast model: classify_reply, parse_answer, classify_day_off, guess_site. */
  claudeFast: Range;
  /** apply_correction (main model, short output). */
  claudeCorrection: Range;
  /** One WhatsApp Cloud API send. */
  wa: Range;
  /** Email provider send. */
  email: Range;
  /** One Supabase Storage upload/download. */
  storage: Range;
}

export const NO_LATENCY: LatencyProfile = {
  media: [0, 0],
  transcribe: [0, 0],
  claude: [0, 0],
  claudeFast: [0, 0],
  claudeCorrection: [0, 0],
  wa: [0, 0],
  email: [0, 0],
  storage: [0, 0],
};

/** Roughly what production sees (§15 budgets assume these). */
export const REALISTIC_LATENCY: LatencyProfile = {
  media: [0.4, 1.5],
  transcribe: [8, 20],
  claude: [12, 35],
  claudeFast: [0.8, 2.5],
  claudeCorrection: [3, 8],
  wa: [0.2, 0.8],
  email: [0.3, 1.2],
  storage: [0.05, 0.3],
};

export type CallKind = keyof LatencyProfile;

export interface SimStats {
  calls: Record<string, number>;
  failures: Record<string, number>;
  /** Wall-clock ms spent in simulated waits (already multiplied by the time scale). */
  simulatedMs: number;
}

export interface Sim {
  readonly scale: number;
  readonly profile: LatencyProfile;
  rng(): number;
  /** Wait the sampled latency for `kind` (× factor), then maybe throw a transient error. */
  call(kind: CallKind, factor?: number): Promise<void>;
  stats: SimStats;
}

/** mulberry32: a small seeded PRNG so load-test runs are reproducible. */
export function seededRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class TransientFakeError extends Error {
  constructor(kind: string) {
    super(`simulated transient failure: ${kind} (503 overloaded)`);
    this.name = 'TransientFakeError';
  }
}

export function createSim(
  opts: {
    scale?: number;
    profile?: LatencyProfile;
    seed?: number;
    /** Probability that a call throws a transient error after its latency (0–1). */
    failRate?: number;
    /** Kinds that may fail (default: the API calls, not storage). */
    failKinds?: CallKind[];
    /**
     * Deterministic tests: move this (manual) clock forward by the sampled latency instead of
     * sleeping, so "slow" calls cost no wall time but the worker still sees the time pass.
     */
    advance?: Clock;
  } = {},
): Sim {
  const scale = opts.scale ?? 1;
  const profile = opts.profile ?? NO_LATENCY;
  const rng = seededRng(opts.seed ?? 1);
  const failRate = opts.failRate ?? 0;
  const failKinds = new Set<CallKind>(
    opts.failKinds ?? ['media', 'transcribe', 'claude', 'claudeFast', 'wa', 'email'],
  );
  const stats: SimStats = { calls: {}, failures: {}, simulatedMs: 0 };
  return {
    scale,
    profile,
    rng,
    stats,
    async call(kind, factor = 1) {
      stats.calls[kind] = (stats.calls[kind] ?? 0) + 1;
      const [lo, hi] = profile[kind];
      const seconds = (lo + (hi - lo) * rng()) * factor;
      const ms = seconds * 1000 * scale;
      if (ms > 0 && opts.advance) {
        opts.advance.advance(seconds * 1000);
      } else if (ms > 0) {
        stats.simulatedMs += ms;
        await sleep(ms);
      }
      if (failRate > 0 && failKinds.has(kind) && rng() < failRate) {
        stats.failures[kind] = (stats.failures[kind] ?? 0) + 1;
        throw new TransientFakeError(kind);
      }
    },
  };
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ───────────────────────────── Fixtures ─────────────────────────────

// The golden-case library moved to src/ai/fake-claude.ts with the fixture Claude.
export {
  loadFixtureLibrary,
  type FixtureCase,
  type FixtureLibrary,
  type RecordedReplies,
} from '../ai/fake-claude';
// ───────────────────────────── Media + ffmpeg ─────────────────────────────

// The bytes a fake voice note carries (which case, how long): shared with the worker's fake
// transcriber (TRANSCRIBE_PROVIDER=fake), which reads the same marker.
export { fakeAudio, readFakeAudio };

/** A tiny valid 1×1 PNG so photos render in the PDF without binary fixtures. */
export const FAKE_PHOTO = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

const PCM_RATE = 8000;
const PCM_PATTERN = (() => {
  const b = Buffer.alloc(PCM_RATE * 2);
  for (let i = 0; i < PCM_RATE; i++) b.writeInt16LE(Math.round(Math.sin(i / 20) * 12000), i * 2);
  return b;
})();

/**
 * ffmpeg without the binary: "conversion" copies the input to the output path (so the fake audio
 * bytes reach the transcription fake), and the PCM decode returns `durationS` of a sine wave so
 * duration and waveform peaks come out right.
 */
export function createFakeFfmpeg(): FfmpegRunner {
  return async (args) => {
    const input = args[args.indexOf('-i') + 1]!;
    if (args.includes('s16le')) {
      const meta = readFakeAudio(await readFile(input));
      const pcm = Buffer.alloc(Math.round((meta?.durationS ?? 2) * PCM_RATE) * 2);
      pcm.fill(PCM_PATTERN);
      return { stdout: pcm, stderr: '' };
    }
    await copyFile(input, args[args.length - 1]!);
    return { stdout: Buffer.alloc(0), stderr: '' };
  };
}

// ───────────────────────────── OpenAI transcription ─────────────────────────────

export interface FakeTranscriber extends TranscriptionApi {
  calls: Array<{ fixtureId: string; prompt: string | undefined }>;
}

/** verbose_json with the golden segments of the case encoded in the audio bytes. */
export function createFakeTranscriber(lib: FixtureLibrary, sim: Sim): FakeTranscriber {
  const calls: FakeTranscriber['calls'] = [];
  return {
    calls,
    audio: {
      transcriptions: {
        async create(params) {
          const meta = readFakeAudio(Buffer.from(await params.file.arrayBuffer()));
          if (!meta) throw new Error('fake transcription: the file is not a fake voice note');
          const phones = findPhoneNumbers(params.prompt ?? '');
          if (phones.length) throw new Error(`phone number sent to transcription: ${phones[0]}`);
          calls.push({ fixtureId: meta.fixtureId, prompt: params.prompt });
          const c = lib.get(meta.fixtureId);
          await sim.call('transcribe', Math.max(0.3, meta.durationS / 180));
          return {
            text: c.segments.map((s) => s.text).join(' '),
            language: c.language,
            duration: meta.durationS,
            segments: c.segments,
          };
        },
      },
    },
  };
}

// ───────────────────────────── Claude ─────────────────────────────

// The fixture-backed Messages client lives in src/ai/fake-claude.ts (EXTRACT_PROVIDER=fake uses it
// too); the harness adds the simulated latency and transient failures.
export {
  emptyExtraction,
  emptyExtractionV2,
  type FakeClaude,
  type FakeClaudeCall,
} from '../ai/fake-claude';

export interface FakeClaudeOptions extends Omit<FixtureClaudeOptions, 'lib' | 'beforeCall'> {
  lib: FixtureLibrary;
  sim: Sim;
}

/** The fixture Claude (src/ai/fake-claude.ts) with the harness's latency and failures. */
export function createFakeClaude(opts: FakeClaudeOptions): FakeClaude {
  const { sim, ...rest } = opts;
  return createFixtureClaude({ ...rest, beforeCall: (kind) => sim.call(kind) });
}
// ───────────────────────────── WhatsApp, storage, email ─────────────────────────────

export interface WaEvent {
  /** Clock time of the send (virtual time in a scaled run). */
  at: Date;
  kind: FakeWaClient['sent'][number]['kind'];
  to: string;
  body?: string;
  buttons?: Array<{ id: string; title: string }>;
  filename?: string;
  waMessageId: string | null;
}

export interface SimWaClient extends WaClient {
  inner: FakeWaClient;
  events: WaEvent[];
  /** Called after every successful send (the load test's reporters listen here). */
  onSend: ((e: WaEvent) => void) | null;
}

/** createFakeWaClient (payload validation + recording) with latency, failures and clock stamps. */
export function withSimWa(inner: FakeWaClient, sim: Sim, clock: Clock): SimWaClient {
  const events: WaEvent[] = [];
  const client: SimWaClient = {
    inner,
    events,
    onSend: null,
    async sendText(to, text) {
      return send(() => inner.sendText(to, text));
    },
    async sendButtons(to, body, buttons) {
      return send(() => inner.sendButtons(to, body, buttons));
    },
    async sendList(to, body, options, buttonText) {
      return send(() => inner.sendList(to, body, options, buttonText));
    },
    async sendDocument(to, doc) {
      return send(() => inner.sendDocument(to, doc));
    },
    async sendTemplate(to, template) {
      return send(() => inner.sendTemplate(to, template));
    },
    async markRead(id) {
      await inner.markRead(id);
    },
    async downloadMedia(mediaId) {
      await sim.call('media');
      return inner.downloadMedia(mediaId);
    },
    async uploadMedia(buffer, mime, filename) {
      await sim.call('wa');
      return inner.uploadMedia(buffer, mime, filename);
    },
  };
  async function send(fn: () => Promise<{ waMessageId: string | null }>) {
    await sim.call('wa');
    const res = await fn();
    const last = inner.sent[inner.sent.length - 1]!;
    const e: WaEvent = {
      at: clock.now(),
      kind: last.kind,
      to: last.to,
      body: last.body,
      buttons: last.buttons,
      filename: last.filename,
      waMessageId: res.waMessageId,
    };
    events.push(e);
    client.onSend?.(e);
    return res;
  }
  return client;
}

export function withSimStorage(inner: Storage, sim: Sim): Storage {
  return {
    ...inner,
    async upload(bucket, path, data, contentType) {
      await sim.call('storage');
      return inner.upload(bucket, path, data, contentType);
    },
    async download(bucket, path) {
      await sim.call('storage');
      return inner.download(bucket, path);
    },
  };
}

export function withSimEmail(inner: EmailProvider, sim: Sim): EmailProvider {
  return {
    ...inner,
    name: inner.name,
    async send(msg) {
      await sim.call('email');
      return inner.send(msg);
    },
  };
}

// ───────────────────────────── Weather ─────────────────────────────

/**
 * An Open-Meteo hourly response for `date` (and the day before, as `past_days=1` returns) built
 * from a SiteDayWeather fixture (the `observedWeather` of a golden case).
 */
export function openMeteoResponse(date: string, observed: SiteDayWeather): unknown {
  const prev = new Date(`${date}T12:00:00Z`);
  prev.setUTCDate(prev.getUTCDate() - 1);
  const prevDate = prev.toISOString().slice(0, 10);
  const byHour = new Map(observed.hours.map((h) => [h.time.slice(0, 2), h]));
  const time: string[] = [];
  const precipitation: number[] = [];
  const temperature: number[] = [];
  const wind: number[] = [];
  const gusts: number[] = [];
  for (const d of [prevDate, date]) {
    for (let h = 0; h < 24; h++) {
      const hh = String(h).padStart(2, '0');
      const row = d === date ? byHour.get(hh) : undefined;
      time.push(`${d}T${hh}:00`);
      precipitation.push(row?.precipIn ?? 0);
      temperature.push(row?.tempF ?? 60);
      wind.push(row?.windMph ?? 5);
      gusts.push(row?.gustMph ?? 9);
    }
  }
  return {
    hourly: {
      time,
      precipitation,
      temperature_2m: temperature,
      wind_speed_10m: wind,
      wind_gusts_10m: gusts,
    },
  };
}

/** A `fetch` stand-in for Open-Meteo (anything else is refused: the worker must not hit the network). */
export function fakeWeatherFetch(
  response: unknown,
): (url: string | URL | Request) => Promise<Response> {
  return async (url) => {
    const u = String(url instanceof Request ? url.url : url);
    if (!/open-meteo/.test(u)) throw new Error(`unexpected network call in a test: ${u}`);
    return new Response(JSON.stringify(response), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
}
