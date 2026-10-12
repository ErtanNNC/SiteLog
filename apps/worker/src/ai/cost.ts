/** Rough cost estimates for jobs.payload.metrics (§10.11, §15 cost guardrail). USD per 1M tokens. */

interface Rate {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

const RATES: Array<{ match: RegExp; rate: Rate }> = [
  {
    match: /claude-(fable|mythos)/,
    rate: { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 },
  },
  { match: /claude-opus-5-5/, rate: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 } },
  { match: /claude-opus/, rate: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 } },
  { match: /claude-sonnet-4-6/, rate: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 } },
  { match: /claude-sonnet/, rate: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 } },
  { match: /claude-haiku-4-5/, rate: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 } },
  { match: /claude-haiku/, rate: { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 } },
];

export interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export function estimateClaudeCostUsd(model: string, usage: TokenUsage): number {
  const rate = RATES.find((r) => r.match.test(model))?.rate ?? {
    input: 3,
    output: 15,
    cacheRead: 0.3,
    cacheWrite: 3.75,
  };
  const usd =
    (usage.input * rate.input +
      usage.output * rate.output +
      usage.cacheRead * rate.cacheRead +
      usage.cacheWrite * rate.cacheWrite) /
    1_000_000;
  return Math.round(usd * 1e6) / 1e6;
}

/**
 * Transcription is billed per minute of audio: USD per minute for whisper-1 and
 * gpt-4o-transcribe (OpenAI list price). Feeds jobs.payload.metrics.estCostUsd of the
 * transcription jobs, which the cost-per-report estimate sums (src/cost.ts).
 */
export const TRANSCRIPTION_USD_PER_MINUTE = 0.006;

export function estimateTranscriptionCostUsd(
  _model: string,
  audioSeconds: number,
  usdPerMinute = TRANSCRIPTION_USD_PER_MINUTE,
): number {
  return Math.round((audioSeconds / 60) * usdPerMinute * 1e6) / 1e6;
}
