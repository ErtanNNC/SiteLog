import { describe, expect, it } from 'vitest';
import {
  DailyReportDataSchema,
  ExtractionOutputSchema,
  emptyReportData,
  extractionToolInputSchema,
} from './report.ts';
import { CorrectionResultSchema, ParsedAnswerSchema, toolInputSchema } from './ai.ts';
import { backoffSeconds, parseJobPayload } from './jobs.ts';
import { PG_ENUMS } from '../enums.ts';

describe('report schemas', () => {
  it('accepts the empty skeleton and rejects invented shapes', () => {
    expect(DailyReportDataSchema.parse(emptyReportData('2026-10-09')).reportDate).toBe(
      '2026-10-09',
    );
    expect(() =>
      DailyReportDataSchema.parse({ ...emptyReportData('2026-10-09'), reportDate: 'Oct 9' }),
    ).toThrow();
    expect(() =>
      DailyReportDataSchema.parse({
        ...emptyReportData('2026-10-09'),
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
    expect(backoffSeconds(1)).toBe(30);
    expect(backoffSeconds(4)).toBe(1800);
    expect(backoffSeconds(5)).toBeNull();
  });
  it('keeps enum lists non-empty and unique', () => {
    for (const [name, values] of Object.entries(PG_ENUMS)) {
      expect(values.length, name).toBeGreaterThan(0);
      expect(new Set(values).size, name).toBe(values.length);
    }
  });
});
