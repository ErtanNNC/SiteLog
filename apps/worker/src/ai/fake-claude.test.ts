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
  it('outside production: fake when asked, and when Claude has no key', () => {
    expect(
      resolveExtractorChoice({
        EXTRACT_PROVIDER: 'fake',
        ANTHROPIC_API_KEY: '',
        NODE_ENV: 'development',
      }),
    ).toEqual({ provider: 'fake', note: null });
    const keyless = resolveExtractorChoice({
      EXTRACT_PROVIDER: 'claude',
      ANTHROPIC_API_KEY: '',
      NODE_ENV: 'development',
    });
    expect(keyless.provider).toBe('fake');
    expect(keyless.note).toMatch(/without ANTHROPIC_API_KEY: the fake extractor/);
    expect(
      resolveExtractorChoice({
        EXTRACT_PROVIDER: 'claude',
        ANTHROPIC_API_KEY: 'k',
        NODE_ENV: 'test',
      }),
    ).toEqual({ provider: 'claude', note: null });
  });

  it('in production never the fake: Claude, and no client without the key', () => {
    for (const p of ['claude', 'fake'] as const) {
      expect(
        resolveExtractorChoice({
          EXTRACT_PROVIDER: p,
          ANTHROPIC_API_KEY: '',
          NODE_ENV: 'production',
        }).provider,
      ).toBe('claude');
      const log = memoryLogger();
      const client = createExtractionClient(
        { EXTRACT_PROVIDER: p, ANTHROPIC_API_KEY: '', NODE_ENV: 'production' },
        log,
      );
      expect(client).toBeNull();
      expect(log.lines.join('\n')).toMatch(/ANTHROPIC_API_KEY is not set: extraction fails/);
    }
    const ignored = resolveExtractorChoice({
      EXTRACT_PROVIDER: 'fake',
      ANTHROPIC_API_KEY: 'k',
      NODE_ENV: 'production',
    });
    expect(ignored).toMatchObject({ provider: 'claude', note: expect.stringMatching(/ignored/) });
  });

  it('a keyless worker outside production gets the fake client, with a log line saying so', () => {
    const log = memoryLogger();
    const client = createExtractionClient(testConfig({ ANTHROPIC_API_KEY: '' }), log) as FakeClaude;
    expect(client).not.toBeNull();
    expect(client.calls).toEqual([]);
    expect(log.lines.join('\n')).toMatch(/extraction provider.*fake extractor/);
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
