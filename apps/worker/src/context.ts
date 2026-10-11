import type OpenAI from 'openai';
import type { Config } from './config';
import type { Db, JobMetrics } from './db';
import type { EmailProvider } from './email/provider';
import type { Logger } from './log';
import type { FfmpegRunner } from './media/ffmpeg';
import type { Storage } from './storage';
import type { WaClient } from './wa/client';
import type { MessagesClient } from './ai/claude';

/** Everything a job or router handler needs. Built once at boot; tests build it with fakes. */
export interface AiClients {
  /** Anthropic Messages client (or a mock). null when ANTHROPIC_API_KEY is missing. */
  claude: MessagesClient | null;
  /** OpenAI client for transcription. null when OPENAI_API_KEY is missing. */
  openai: OpenAI | null;
}

export interface MetricsSink {
  add(delta: JobMetrics): void;
  snapshot(): JobMetrics;
}

export function createMetrics(): MetricsSink {
  const m: JobMetrics = { tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, audioSeconds: 0, estCostUsd: 0 };
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
      if (delta.estCostUsd) m.estCostUsd = Math.round(((m.estCostUsd ?? 0) + delta.estCostUsd) * 1e6) / 1e6;
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
  ffmpeg: FfmpegRunner;
  log: Logger;
  now: () => Date;
  metrics: MetricsSink;
}

export function childCtx(ctx: Ctx, fields: Record<string, unknown>): Ctx {
  return { ...ctx, log: ctx.log.child(fields) };
}
