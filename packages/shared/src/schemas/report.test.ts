import { describe, expect, it } from 'vitest';
import {
  DailyReportDataSchema,
  DailyReportDataV1Schema,
  ExtractionOutputSchema,
  StoredReportDataSchema,
  emptyReportData,
  emptyReportDataV1,
  extractionToolInputSchema,
} from './report.ts';
import { CorrectionResultSchema, ParsedAnswerSchema, toolInputSchema } from './ai.ts';
import { backoffSeconds, JOB_MAX_ATTEMPTS, parseJobPayload } from './jobs.ts';
import { PG_ENUMS } from '../enums.ts';

describe('report schemas', () => {
  it('accepts the empty skeleton and rejects invented shapes', () => {
    expect(DailyReportDataV1Schema.parse(emptyReportDataV1('2026-10-09')).reportDate).toBe(
      '2026-10-09',
    );
    expect(() =>
      DailyReportDataV1Schema.parse({ ...emptyReportDataV1('2026-10-09'), reportDate: 'Oct 9' }),
    ).toThrow();
    expect(() =>
      DailyReportDataV1Schema.parse({
        ...emptyReportDataV1('2026-10-09'),
        manpower: [{ companyName: 'x' }],
      }),
    ).toThrow();
  });
  it('produces a JSON Schema usable as a Claude tool input', () => {
    const schema = extractionToolInputSchema();
    expect(schema.type).toBe('object');
    expect(schema.$schema).toBeUndefined();
    const props = schema.properties as Record<string, unknown>;
    expect(Object.keys(props)).toEqual(Object.keys(ExtractionOutputSchema.shape));
    expect(JSON.stringify(schema)).toContain('Headcount. null when not stated');
    expect(schema.required as string[]).toContain('manpower');
  });
  it('exposes the other tool schemas', () => {
    expect(toolInputSchema(CorrectionResultSchema).type).toBe('object');
    expect(toolInputSchema(ParsedAnswerSchema).type).toBe('object');
  });
  it('validates job payloads and backoff', () => {
    expect(
      parseJobPayload('render_pdf', {
        reportId: '3f2a1c4e-0b1d-4c8e-9f6a-1b2c3d4e5f60',
        version: 2,
      }),
    ).toMatchObject({ version: 2, sendToWhatsApp: false });
    expect(() => parseJobPayload('inbound_message', { messageId: 'nope' })).toThrow();
  });
  it('backs off 30 s, 2 min, 10 min, 30 min, 2 h, and the sixth failure is dead (§10.1, D17)', () => {
    expect([1, 2, 3, 4, 5, 6, 7].map(backoffSeconds)).toEqual([
      30,
      120,
      600,
      1800,
      7200,
      null,
      null,
    ]);
    expect(JOB_MAX_ATTEMPTS).toBe(6);
    expect(backoffSeconds(0)).toBe(30);
  });
  it('takes notify(reporterId, key, vars, dedupeKey) for the Notifier keys only (§10.1, D48)', () => {
    const reporterId = '3f2a1c4e-0b1d-4c8e-9f6a-1b2c3d4e5f60';
    expect(
      parseJobPayload('notify', {
        reporterId,
        key: 'filed',
        vars: { site: 'Riverside Lofts', link: 'https://go.talkolog.com/r/abc' },
        dedupeKey: 'notify:filed:r1',
      }),
    ).toEqual({
      reporterId,
      key: 'filed',
      vars: { site: 'Riverside Lofts', link: 'https://go.talkolog.com/r/abc' },
      dedupeKey: 'notify:filed:r1',
    });
    expect(
      parseJobPayload('notify', { reporterId, key: 'daily_link', dedupeKey: 'k' }).vars,
    ).toEqual({});
    // The two-way replies are sms-webhook's, never a notify job; a key is required.
    expect(() =>
      parseJobPayload('notify', { reporterId, key: 'help', vars: {}, dedupeKey: 'k' }),
    ).toThrow();
    expect(() => parseJobPayload('notify', { reporterId, key: 'filed', vars: {} })).toThrow();
    expect(() =>
      parseJobPayload('notify', { reporterId, key: 'filed', vars: {}, dedupeKey: '' }),
    ).toThrow();
  });
  it('keeps enum lists non-empty and unique', () => {
    for (const [name, values] of Object.entries(PG_ENUMS)) {
      expect(values.length, name).toBeGreaterThan(0);
      expect(new Set(values).size, name).toBe(values.length);
    }
  });
});

describe('report data v2 (§10.3) and the stored-data union', () => {
  const v1 = () => emptyReportDataV1('2026-10-09');
  const v2 = () => emptyReportData('2026-10-09', { reportLanguage: 'tr', units: 'metric' });
  const rejects = (data: unknown) =>
    expect(StoredReportDataSchema.safeParse(data).success).toBe(false);
  const audio = { type: 'audio', messageId: 'm1', start: 3 };
  const voice = { type: 'voice_note', uploadId: 'u1', start: 3 };
  const crew = (hoursBasis: string, source: unknown[]) => ({
    companyId: 'c1',
    companyNameHeard: 'Apex',
    companyName: 'Apex Concrete',
    workers: 6,
    hoursPerWorker: 8,
    totalHours: 48,
    hoursBasis,
    confidence: 0.9,
    source,
  });

  it('accepts a v1 and a v2 skeleton and tells them apart by schemaVersion', () => {
    expect(StoredReportDataSchema.parse(v1()).schemaVersion).toBe(1);
    const parsed = StoredReportDataSchema.parse(v2());
    expect(parsed).toEqual(DailyReportDataSchema.parse(v2()));
    expect(parsed).toMatchObject({ schemaVersion: 2, reportLanguage: 'tr', units: 'metric' });
  });

  it('accepts every v2 source kind', () => {
    const source = [
      voice,
      { type: 'call', callId: 'call-1', start: 12, end: 15.5 },
      { type: 'answer', questionId: 'q1' },
      { type: 'office_edit', userId: 'u1', at: '2026-10-10T01:10:00Z' },
      { type: 'weather_api' },
    ];
    expect(
      StoredReportDataSchema.parse({ ...v2(), manpower: [crew('answer', source)] }).manpower[0]!
        .source,
    ).toEqual(source);
  });

  it('rejects malformed data', () => {
    rejects({ ...v2(), schemaVersion: 3 });
    rejects({ ...v2(), schemaVersion: undefined });
    rejects(null);
    rejects('{"schemaVersion":2}');
    // A v2 shape labelled v1 and the other way round (unknown keys are stripped, as for the
    // model's output, so what tells them apart is what each version requires).
    rejects({ ...v2(), schemaVersion: 1, photos: [{ uploadId: 'p1', takenAt: 'T' }] });
    rejects({ ...v1(), schemaVersion: 2 });
    // v2 needs the report language and units, from their lists.
    const { reportLanguage: _l, ...noLanguage } = v2();
    void _l;
    rejects(noLanguage);
    rejects({ ...v2(), reportLanguage: 'es' });
    rejects({ ...v2(), units: 'si' });
    // Sources, bases, photos and terms of the other version.
    rejects({ ...v2(), manpower: [crew('stated', [audio])] });
    rejects({ ...v1(), manpower: [crew('stated', [voice])] });
    rejects({ ...v2(), manpower: [crew('reply', [voice])] });
    rejects({ ...v1(), manpower: [crew('answer', [audio])] });
    rejects({ ...v2(), manpower: [crew('stated', [{ type: 'text', messageId: 'm1' }])] });
    rejects({ ...v2(), manpower: [crew('stated', [{ type: 'call', start: 1 }])] });
    rejects({ ...v2(), photos: [{ messageId: 'p1', takenAt: 'T' }] });
    rejects({ ...v1(), photos: [{ uploadId: 'p1', takenAt: 'T' }] });
    rejects({
      ...v2(),
      newTerms: [
        { heard: 'colado', proposedOfficial: 'Concrete pour', kind: 'term', confidence: 1 },
      ],
    });
    rejects({
      ...v2(),
      weather: {
        conditionsText: 'Rain',
        periods: [],
        observed: { precipIn: 0.4, tempMinF: 58, tempMaxF: 64, windMph: 9, provider: 'x' },
      },
    });
    // Constraints both versions share.
    rejects({ ...v2(), reportDate: 'Oct 9' });
    rejects({ ...v2(), manpower: [{ ...crew('stated', []), workers: -1 }] });
    rejects({
      ...v2(),
      proposedQuestions: [{ field: 'photo', question: 'Photo?', options: ['a', 'b', 'c'] }],
    });
  });

  it('keeps the Claude tool on v1 until W1-12', () => {
    const tool = JSON.stringify(extractionToolInputSchema());
    expect(tool).toContain('"reply"');
    expect(tool).toContain('"messageId"');
    expect(tool).not.toContain('voice_note');
    expect(tool).not.toContain('uploadId');
  });
});
