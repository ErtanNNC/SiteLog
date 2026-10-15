import { describe, expect, it } from 'vitest';
import { loadConfig, testConfig } from '../config';
import { memoryLogger } from '../log';
import { parseAnswerWithModel } from './answer';
import { classifyWithModel } from './classify';
import { loadFixture } from './eval';
import { runReportExtraction, type ExtractionInputV2 } from './extract';
import {
  DEFAULT_FAKE_EXTRACTION_CASE,
  createExtractionClient,
  FAKE_EXTRACTION_IN_PRODUCTION,
  createFixtureClaude,
  loadFixtureLibrary,
  resolveExtractorChoice,
  type FakeClaude,
} from './fake-claude';
import { createFakeTranscriber } from './fake-transcriber';

const MODEL = 'claude-sonnet-5-5';
const UPLOAD = '0b6f3c2e-6a1d-4f7e-9c1a-2d3e4f5a6b7c';

/** A golden case's input as a phone recording gives it: one upload of our own, no photos. */
function phoneInput(caseId: string, text?: string): ExtractionInputV2 {
  const input = structuredClone(loadFixture(caseId).input);
  const segments = text
    ? [{ uploadId: UPLOAD, start: 0, end: 12, text }]
    : input.segments.map((s) => ({ ...s, uploadId: UPLOAD }));
  return { ...input, segments, photos: [] };
}

function fake(): FakeClaude {
  return createFixtureClaude({
    lib: () => loadFixtureLibrary(),
    defaultCase: DEFAULT_FAKE_EXTRACTION_CASE,
  });
}

describe('EXTRACT_PROVIDER choice', () => {
  it('the fake only when EXTRACT_PROVIDER=fake is set, outside production', () => {
    for (const env of ['development', 'test'] as const) {
      expect(
        resolveExtractorChoice({ EXTRACT_PROVIDER: 'fake', ANTHROPIC_API_KEY: '', NODE_ENV: env }),
      ).toMatchObject({ provider: 'fake', note: expect.stringMatching(/EXTRACT_PROVIDER=fake/) });
    }
    expect(
      resolveExtractorChoice({
        EXTRACT_PROVIDER: 'claude',
        ANTHROPIC_API_KEY: 'k',
        NODE_ENV: 'test',
      }),
    ).toEqual({ provider: 'claude', note: null });
  });

  it('never falls back to the fake: Claude without its key leaves no client, in every environment', () => {
    for (const env of ['development', 'test', 'production'] as const) {
      expect(
        resolveExtractorChoice({
          EXTRACT_PROVIDER: 'claude',
          ANTHROPIC_API_KEY: '',
          NODE_ENV: env,
        }),
      ).toMatchObject({
        provider: 'claude',
        note: expect.stringMatching(/ANTHROPIC_API_KEY is not set: extraction fails/),
      });
      const log = memoryLogger();
      const client = createExtractionClient(
        { EXTRACT_PROVIDER: 'claude', ANTHROPIC_API_KEY: '', NODE_ENV: env },
        log,
      );
      expect(client).toBeNull();
      expect(log.lines.join('\n')).toMatch(
        /"level":"warn".*extraction provider.*ANTHROPIC_API_KEY is not set/,
      );
    }
    // The default config (pnpm dev:worker with no key) is Claude, not the fake.
    expect(
      createExtractionClient(testConfig({ ANTHROPIC_API_KEY: '' }), memoryLogger()),
    ).toBeNull();
  });

  it('refuses EXTRACT_PROVIDER=fake in production, with or without a key', () => {
    for (const key of ['', 'k']) {
      expect(() =>
        resolveExtractorChoice({
          EXTRACT_PROVIDER: 'fake',
          ANTHROPIC_API_KEY: key,
          NODE_ENV: 'production',
        }),
      ).toThrow(FAKE_EXTRACTION_IN_PRODUCTION);
      expect(() =>
        createExtractionClient(
          { EXTRACT_PROVIDER: 'fake', ANTHROPIC_API_KEY: key, NODE_ENV: 'production' },
          memoryLogger(),
        ),
      ).toThrow(/refused in production/);
    }
  });

  it('an explicit fake worker gets the fixture client, with a warning saying so', () => {
    const log = memoryLogger();
    const client = createExtractionClient(
      testConfig({ EXTRACT_PROVIDER: 'fake', ANTHROPIC_API_KEY: '' }),
      log,
    ) as FakeClaude;
    expect(client).not.toBeNull();
    expect(client.calls).toEqual([]);
    expect(log.lines.join('\n')).toMatch(/"level":"warn".*extraction provider.*fake extractor/);
  });

  it('defaults to claude and rejects other names', () => {
    expect(testConfig().EXTRACT_PROVIDER).toBe('claude');
    expect(() =>
      loadConfig({ SUPABASE_DB_URL: 'postgres://test', EXTRACT_PROVIDER: 'openai' }),
    ).toThrow(/EXTRACT_PROVIDER/);
  });
});

describe('the fake extractor', () => {
  it('answers the fake transcript of a phone recording with its golden case; code does the rest', async () => {
    // What the fake transcriber gives a real recording of an EN/ES reporter (Marco, Dana): the
    // hero note, es-en-riverside-2026-10-09.
    const transcript = await createFakeTranscriber().transcribe({
      audio: Buffer.from('real-browser-audio'),
      mime: 'audio/webm;codecs=opus',
      language: 'multi',
      keyterms: [],
      prompt: '',
    });
    const client = fake();
    const result = await runReportExtraction(
      client,
      MODEL,
      phoneInput('riverside-2026-10-09', transcript.text),
    );
    expect(client.calls).toEqual([
      { tool: 'submit_daily_report', fixtureId: 'riverside-2026-10-09' },
    ]);
    expect(result.raw.missingRequired).toEqual(['manpower.workers:Delta Mechanical']);
    const delta = result.data.manpower.find((m) => m.companyName === 'Delta Mechanical')!;
    expect(delta.workers).toBeNull();
    // Code, not the fake: schemaVersion, photos (the report's, none) and the totals.
    expect(result.data.schemaVersion).toBe(2);
    expect(result.data.photos).toEqual([]);
    for (const m of result.data.manpower) {
      if (m.workers !== null && m.hoursPerWorker !== null)
        expect(m.totalHours).toBe(m.workers * m.hoursPerWorker);
    }
    // Sources point at the recording's upload (remapped), so none is dropped.
    expect(result.droppedSources).toBe(0);
    expect(JSON.stringify(result.data)).toContain(UPLOAD);
  });

  it('matches the Turkish note to its case', async () => {
    const client = fake();
    await runReportExtraction(client, MODEL, phoneInput('kartal-2026-10-09-tr'));
    expect(client.calls[0]).toEqual({
      tool: 'submit_daily_report',
      fixtureId: 'kartal-2026-10-09-tr',
    });
  });

  it('a transcript no case knows gets the hero case: one open question', async () => {
    const client = fake();
    const result = await runReportExtraction(
      client,
      MODEL,
      phoneInput(
        'riverside-2026-10-09',
        'Testing the recorder from the parking lot, nothing else.',
      ),
    );
    expect(client.calls).toEqual([
      { tool: 'submit_daily_report', fixtureId: DEFAULT_FAKE_EXTRACTION_CASE, fallback: true },
    ]);
    expect(result.raw.missingRequired.length).toBeGreaterThan(0);
    expect(result.droppedSources).toBe(0);
  });

  it('answers the small tools from replies.json through callTool', async () => {
    const client = fake();
    const classified = await classifyWithModel(client, MODEL, {
      state: 'awaiting_answer',
      lastOutbound: null,
      text: 'five guys all day',
      isVoice: false,
    });
    expect(classified.data.intent).toBe('answer');
    const answer = await parseAnswerWithModel(client, MODEL, {
      question: { field: 'manpower.workers', prompt: 'How many?', options: [], target: {} },
      replyText: '5 full day',
      companies: [],
      defaultShiftHours: 8,
    });
    expect(answer.data.field).toBe('manpower.workers');
    expect(client.calls.map((c) => c.tool)).toEqual(['classify_reply', 'parse_answer']);
  });
});
