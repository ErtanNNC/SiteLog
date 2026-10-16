import { describe, expect, it } from 'vitest';
import {
  loadConfig,
  openAiTranscribeModel,
  STALE_LOCK_MS,
  WORKER_CLOCK_REFUSED,
  workerClock,
} from './config';

const BASE = { SUPABASE_DB_URL: 'postgres://localhost/test' };

describe('worker config: job timeout and the stale lock', () => {
  it('reclaims after 10 minutes (GAP D18) and times a job out at 5 by default', () => {
    expect(STALE_LOCK_MS).toBe(10 * 60_000);
    expect(loadConfig(BASE).JOB_TIMEOUT_MS).toBe(5 * 60_000);
  });

  it('refuses a job timeout that would outlast the stale lock', () => {
    expect(loadConfig({ ...BASE, JOB_TIMEOUT_MS: String(9 * 60_000) }).JOB_TIMEOUT_MS).toBe(
      9 * 60_000,
    );
    expect(() => loadConfig({ ...BASE, JOB_TIMEOUT_MS: String(10 * 60_000) })).toThrow(
      /JOB_TIMEOUT_MS: must end a minute before claim_jobs reclaims/,
    );
  });
});

describe('worker config: transcription (W1-11)', () => {
  it('defaults to Deepgram with the provider model left to the transcriber', () => {
    const c = loadConfig(BASE);
    expect(c.TRANSCRIBE_PROVIDER).toBe('deepgram');
    expect(c.TRANSCRIBE_MODEL).toBe('');
    expect(c.DEEPGRAM_API_KEY).toBe('');
    expect(() => loadConfig({ ...BASE, TRANSCRIBE_PROVIDER: 'whisper' })).toThrow(
      /TRANSCRIBE_PROVIDER/,
    );
  });

  it('keeps the WhatsApp voice notes on an OpenAI model whatever Deepgram model is set', () => {
    expect(openAiTranscribeModel(loadConfig({ ...BASE, TRANSCRIBE_MODEL: 'nova-3' }))).toBe(
      'whisper-1',
    );
    expect(
      openAiTranscribeModel(
        loadConfig({
          ...BASE,
          TRANSCRIBE_PROVIDER: 'openai',
          TRANSCRIBE_MODEL: 'gpt-4o-transcribe',
        }),
      ),
    ).toBe('gpt-4o-transcribe');
  });
});

describe('worker config: the CI test clock (WORKER_CLOCK_OVERRIDE, W2-06)', () => {
  const START = '2026-10-12T22:46:30.000Z';

  it('is the real clock by default', () => {
    const now = workerClock(loadConfig(BASE), () => 1_000);
    expect(now().getTime()).toBe(1_000);
  });

  it('starts at WORKER_CLOCK_START and moves on in real time', () => {
    let real = 5_000_000;
    const config = loadConfig({
      ...BASE,
      WORKER_CLOCK_OVERRIDE: 'true',
      WORKER_CLOCK_START: START,
    });
    const now = workerClock(config, () => real);
    expect(now().toISOString()).toBe(START);
    real += 90_000;
    expect(now().toISOString()).toBe('2026-10-12T22:48:00.000Z');
  });

  it('is refused in production and without a start', () => {
    expect(() =>
      loadConfig({
        ...BASE,
        NODE_ENV: 'production',
        WORKER_CLOCK_OVERRIDE: 'true',
        WORKER_CLOCK_START: START,
      }),
    ).toThrow(WORKER_CLOCK_REFUSED);
    expect(() =>
      workerClock({
        NODE_ENV: 'production',
        WORKER_CLOCK_OVERRIDE: true,
        WORKER_CLOCK_START: START,
      }),
    ).toThrow(WORKER_CLOCK_REFUSED);
    expect(() => loadConfig({ ...BASE, WORKER_CLOCK_OVERRIDE: 'true' })).toThrow(
      /WORKER_CLOCK_START/,
    );
    // Off, a stray start changes nothing.
    expect(
      workerClock(loadConfig({ ...BASE, WORKER_CLOCK_START: START }), () => 7)().getTime(),
    ).toBe(7);
  });
});
