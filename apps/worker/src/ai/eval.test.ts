import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DailyReportDataV1 } from '@sitelog/shared';
import {
  companyKey,
  compareContextOf,
  compareReport,
  findPhoneNumbers,
  fixtureProblems,
  listFixtureIds,
  loadFixture,
  loadFixtures,
  matchesFilter,
  nextQuestionOf,
  parseArgs,
  printTable,
  replayClient,
  runEval,
  scoreRecorded,
} from './eval';
import { runExtraction } from './extract';

/**
 * Offline checks for the §10.12 golden set (no API key): every fixture parses with the shared
 * schemas, is internally consistent, and its recorded tool output scores as a pass. CI fails here
 * when a fixture is broken, before anyone pays for a live `pnpm eval`.
 */

const ids = listFixtureIds();

describe('golden eval set (§10.12)', () => {
  it('has at least 20 cases, all picked up by the directory scan', () => {
    expect(ids.length).toBeGreaterThanOrEqual(20);
    expect(ids).toContain('riverside-2026-10-09');
    expect(loadFixtures(undefined, ['oakmont']).every((f) => f.id.includes('oakmont'))).toBe(true);
  });

  describe.each(ids)('%s', (id) => {
    it('parses with the shared schemas and is internally consistent', () => {
      const f = loadFixture(id);
      expect(f.recorded).not.toBeNull();
      expect(fixtureProblems(f)).toEqual([]);
    });

    it('scores the recorded tool output as a pass', async () => {
      const res = await scoreRecorded(loadFixture(id));
      expect(res.checks.filter((c) => !c.ok)).toEqual([]);
      expect(res.ok).toBe(true);
    });
  });

  it('covers the spread the spec asks for', () => {
    const all = ids.map((id) => loadFixture(id));
    const langs = all.map((f) => [...f.expected.languageDetected].sort().join('+'));
    expect(langs).toContain('es');
    expect(langs).toContain('en+es');
    expect(langs).toContain('en');
    const asked = new Set(all.map((f) => f.expectedQuestion?.field ?? 'none'));
    for (const field of [
      'none',
      'manpower.workers',
      'manpower.hours',
      'company.unknown',
      'weather.impact',
      'safety',
      'photo',
    ])
      expect(asked, field).toContain(field);
    const periods = all.flatMap((f) => f.expected.weather.periods);
    expect(periods.some((p) => p.fullDay)).toBe(true);
    expect(periods.filter((p) => p.lostHours > 0 && !p.fullDay).length).toBeGreaterThanOrEqual(5);
    expect(all.some((f) => f.expected.manpower.length === 0 && periods.length > 0)).toBe(true);
    const severities = all.flatMap((f) => f.expected.safety.incidents.map((i) => i.severity));
    expect(severities).toEqual(expect.arrayContaining(['near_miss', 'first_aid']));
    const unknown = all.flatMap((f) => f.expected.manpower.filter((m) => m.companyId === null));
    expect(unknown.length).toBeGreaterThanOrEqual(3);
    const bases = new Set(all.flatMap((f) => f.expected.manpower.map((m) => m.hoursBasis)));
    expect(bases).toEqual(new Set(['stated', 'full_day_default', 'unknown']));
    expect(all.some((f) => f.input.texts.length > 0)).toBe(true);
    expect(all.some((f) => f.input.previousAnswers.length > 0)).toBe(true);
    expect(all.some((f) => new Set(f.input.segments.map((s) => s.messageId)).size > 1)).toBe(true);
    expect(all.some((f) => f.input.rejectedMappings.length > 0)).toBe(true);
    expect(all.some((f) => f.expected.deliveries.length > 0)).toBe(true);
    expect(all.some((f) => f.expected.safety.visitors.length > 0)).toBe(true);
    expect(
      all.some((f) => f.input.segments.some((s) => /\[(noise|inaudible)\]/.test(s.text))),
    ).toBe(true);
  });

  it('never sends a phone number to the model', async () => {
    for (const id of ids) {
      const f = loadFixture(id);
      const client = replayClient(f.recorded);
      await runExtraction(client, 'claude-sonnet-4-6', f.input);
      const { system, messages } = client.calls[0]!;
      expect(findPhoneNumbers(JSON.stringify({ system, messages })), id).toEqual([]);
    }
    expect(findPhoneNumbers('call me on +1 555 014 3378')).toEqual(['+1 555 014 3378']);
    expect(findPhoneNumbers('(555) 014-2290')).toEqual(['(555) 014-2290']);
    expect(
      findPhoneNumbers('2026-10-09 07:00–15:30 e0000004-0000-4000-8000-000000000401 68 yd³'),
    ).toEqual([]);
  });
});

describe('compareReport', () => {
  const riverside = loadFixture('riverside-2026-10-09');
  const ctx = compareContextOf(riverside.input);

  it('passes the expected data against itself, with and without context', () => {
    expect(compareReport(riverside.expected, riverside.expected).every((c) => c.ok)).toBe(true);
    expect(compareReport(riverside.expected, riverside.expected, ctx).every((c) => c.ok)).toBe(
      true,
    );
  });

  it('sums a company split over two entries and ignores crews reported absent', () => {
    const actual: DailyReportDataV1 = structuredClone(riverside.expected);
    const apex = actual.manpower[0]!;
    actual.manpower.splice(
      0,
      1,
      { ...apex, workers: 4, totalHours: 32, area: 'Level 4' },
      { ...apex, workers: 2, totalHours: 16, area: 'Level 5' },
    );
    actual.manpower.push({
      ...apex,
      companyId: null,
      companyName: 'Summit Painting',
      companyNameHeard: 'the Summit painters',
      workers: 0,
      totalHours: null,
    });
    expect(compareReport(actual, riverside.expected).filter((c) => !c.ok)).toEqual([]);
  });

  it('flags an invented headcount, a guessed answer to the open question and invented numbers', () => {
    const actual: DailyReportDataV1 = structuredClone(riverside.expected);
    const delta = actual.manpower.find((m) => m.companyName === 'Delta Mechanical')!;
    delta.workers = 5;
    delta.totalHours = 40;
    actual.workPerformed[0]!.percentComplete = 100;
    actual.safety.incidents.push({ description: 'x', severity: 'first_aid', source: [] });
    const failed = compareReport(actual, riverside.expected, ctx)
      .filter((c) => !c.ok)
      .map((c) => `${c.field}: ${c.name}`);
    expect(failed).toEqual([
      'manpower.workers: manpower Delta Mechanical: workers',
      'manpower.hours: manpower Delta Mechanical: hours',
      'safety: safety incidents (severity)',
      'numbers: work quantities and percentages',
      'required_gaps: required gaps (§10.5)',
      'next_question: next question',
    ]);
  });

  it('matches unknown companies by a normalised name and requires the flag', () => {
    expect(companyKey('the Ridgeway crew')).toBe('ridgeway');
    expect(companyKey('los de Ramírez')).toBe('ramirez');
    const oak = loadFixture('oakmont-unknown-sub');
    const actual: DailyReportDataV1 = structuredClone(oak.expected);
    actual.manpower[2]!.companyName = 'Ridgeway Crew';
    actual.newTerms = [];
    actual.proposedQuestions = [];
    const failed = compareReport(actual, oak.expected, compareContextOf(oak.input)).filter(
      (c) => !c.ok,
    );
    expect(failed.map((c) => c.name)).toEqual(['unknown company flagged: Ridgeway']);
  });

  it('checks rejected glossary mappings and the weather question', () => {
    const ng = loadFixture('northgate-2026-10-07-glossary-mishearing');
    const actual: DailyReportDataV1 = structuredClone(ng.expected);
    actual.equipment[0]!.item = 'Lift (concrete placement height)';
    actual.weather.conditionsText = '';
    const failed = compareReport(actual, ng.expected, compareContextOf(ng.input))
      .filter((c) => !c.ok)
      .map((c) => c.name);
    expect(failed).toEqual([
      'required gaps (§10.5)',
      'next question',
      'rejected glossary mappings not used',
    ]);
    expect(nextQuestionOf(actual, compareContextOf(ng.input))).toEqual({
      field: 'weather.impact',
      path: 'weather.conditions',
    });
  });
});

describe('eval CLI', () => {
  afterEach(() => vi.restoreAllMocks());

  it('parses --case filters, --recorded, --list and --concurrency', () => {
    expect(
      parseArgs(['--', '--case', 'riverside', '-c', 'pier9,elm', '--case=oak', '--recorded']),
    ).toMatchObject({ cases: ['riverside', 'pier9', 'elm', 'oak'], recorded: true, list: false });
    expect(parseArgs(['--concurrency', '6', '--list'])).toMatchObject({
      concurrency: 6,
      list: true,
    });
    expect(() => parseArgs(['--nope'])).toThrow(/unknown argument/);
    expect(matchesFilter('pier9-2026-10-05-yesterday', ['yesterday'])).toBe(true);
    expect(matchesFilter('pier9-2026-10-05-yesterday', ['oakmont'])).toBe(false);
    expect(matchesFilter('anything', [])).toBe(true);
  });

  it('prints "skipped" without an API key and scores recorded outputs offline', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await runEval([], {})).toBe(0);
    expect(String(log.mock.calls[0]![0])).toMatch(/^skipped: ANTHROPIC_API_KEY is not set/);
    log.mockClear();
    expect(await runEval(['--recorded', '--case', 'pier9'], {})).toBe(0);
    const out = log.mock.calls.map((c) => String(c[0])).join('\n');
    expect(out).toContain('pier9-2026-10-09-rain-unknown-roofer');
    expect(out).toMatch(/manpower\.workers\s+\d+\/\d+\s+100\.0%/);
    expect(out).not.toContain('riverside');
    expect(out).toMatch(/(\d+)\/\1 cases passed/);
  });

  it('prints per-field accuracy, failures and totals', () => {
    const table = printTable([
      {
        id: 'a',
        ok: false,
        latencyMs: 1200,
        costUsd: 0.012,
        tokens: { input: 1000, output: 500, cacheRead: 3000, cacheWrite: 0 },
        checks: [
          {
            name: 'manpower X: workers',
            ok: false,
            detail: 'got 5, want 6',
            field: 'manpower.workers',
          },
          { name: 'weather lostHours ±0.5', ok: true, field: 'weather.lostHours' },
        ],
      },
      {
        id: 'b',
        ok: true,
        latencyMs: 800,
        costUsd: 0.008,
        checks: [{ name: 'manpower Y: workers', ok: true, field: 'manpower.workers' }],
      },
    ]);
    expect(table).toContain('- manpower X: workers (got 5, want 6)');
    expect(table).toMatch(/manpower\.workers\s+1\/2\s+50\.0%/);
    expect(table).toMatch(/weather\.lostHours\s+1\/1\s+100\.0%/);
    expect(table).toContain('latency p50 800 ms · p90 1200 ms · max 1200 ms');
    expect(table).toContain('cost $0.0200 total · $0.0100 per case');
    expect(table).toContain('1/2 cases passed');
  });
});
