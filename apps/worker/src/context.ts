import type OpenAI from 'openai';
import type { SmsNotifier } from '@sitelog/shared';
import type { Config } from './config';
import type { Db, JobMetrics } from './db';
import type { EmailProvider } from './email/provider';
import type { Logger } from './log';
import type { FfmpegRunner } from './media/ffmpeg';
import type { Storage } from './storage';
import type { WaClient } from './wa/client';
import type { MessagesClient } from './ai/claude';
import type { Transcriber } from './ai/transcriber';
import type { TelephonyRegistry } from './telephony';

/** Everything a job or router handler needs. Built once at boot; tests build it with fakes. */
export interface AiClients {
  /** Anthropic Messages client (or a mock). null when ANTHROPIC_API_KEY is missing. */
  claude: MessagesClient | null;
  /**
   * OpenAI client: the v1.0 WhatsApp voice notes' transcription (until step 22) and the fallback
   * transcriber. null when OPENAI_API_KEY is missing.
   */
  openai: OpenAI | null;
  /** §10.2 transcription of the web recorder's voice notes (W1-11, TRANSCRIBE_PROVIDER). */
  transcriber: Transcriber;
}

export interface MetricsSink {
  add(delta: JobMetrics): void;
  snapshot(): JobMetrics;
}

export function createMetrics(): MetricsSink {
  const m: JobMetrics = {
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    audioSeconds: 0,
    estCostUsd: 0,
  };
  return {
    add(delta) {
      const t = m.tokens!;
      if (delta.tokens) {
        t.input = (t.input ?? 0) + (delta.tokens.input ?? 0);
        t.output = (t.output ?? 0) + (delta.tokens.output ?? 0);
        t.cacheRead = (t.cacheRead ?? 0) + (delta.tokens.cacheRead ?? 0);
        t.cacheWrite = (t.cacheWrite ?? 0) + (delta.tokens.cacheWrite ?? 0);
      }
      if (delta.audioSeconds) m.audioSeconds = (m.audioSeconds ?? 0) + delta.audioSeconds;
      if (delta.estCostUsd)
        m.estCostUsd = Math.round(((m.estCostUsd ?? 0) + delta.estCostUsd) * 1e6) / 1e6;
      for (const [k, v] of Object.entries(delta)) {
        if (!['tokens', 'audioSeconds', 'estCostUsd', 'latencyMs'].includes(k)) m[k] = v;
      }
    },
    snapshot() {
      return structuredClone(m);
    },
  };
}

export interface Ctx {
  config: Config;
  db: Db;
  wa: WaClient;
  storage: Storage;
  ai: AiClients;
  email: EmailProvider;
  /** The Notifier (spec §4.5, W1-08): every text to a field reporter goes through it. */
  notifier: SmsNotifier;
  /**
   * W3-17: how outbound calls are placed (`console` for demo orgs, `livekit` on a pack's trunk).
   * Built from the config at boot; tests pass a fake. Absent: built from `config` when needed.
   */
  telephony?: TelephonyRegistry;
  ffmpeg: FfmpegRunner;
  log: Logger;
  now: () => Date;
  metrics: MetricsSink;
  /**
   * The job's AbortSignal (W1-10): aborted when the job outlives JOB_TIMEOUT_MS. The runner also
   * runs the handler inside `runWithSignal` (src/abort.ts), so the boot-time clients' HTTP calls
   * abort with it; a handler checks it (`signal.throwIfAborted()`) between long steps. Outside a
   * job (the base Ctx, the timeout sweep) it never aborts.
   */
  signal: AbortSignal;
}

export function childCtx(ctx: Ctx, fields: Record<string, unknown>): Ctx {
  return { ...ctx, log: ctx.log.child(fields) };
}
