import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FIXTURES_DIR, loadFixture, replayClient } from '../eval';
import { postProcessReportExtraction, runReportExtraction } from '../extract';
import {
  EXTRACTION_V2_SOURCE_NOTE,
  buildExtractionUserMessageV2,
  extractionSystemPromptV2,
  formatObservedWeatherIn,
  promptPath,
} from './extraction.v2';

const SPEC = join(FIXTURES_DIR, '..', 'docs', 'SITELOG_SPEC.md');

describe('extraction v2 prompt (W1-12, D24)', () => {
  it('is spec §10.4 "System prompt (v2)" verbatim', () => {
    const spec = readFileSync(SPEC, 'utf8');
    const at = spec.indexOf('**System prompt (v2):**');
    const start = spec.indexOf('```text\n', at) + '```text\n'.length;
    const block = spec.slice(start, spec.indexOf('```', start));
    expect(readFileSync(promptPath(), 'utf8')).toBe(block);
    expect(extractionSystemPromptV2()).toBe(block.trimEnd());
  });

  it('sends the spec §10.4 source-format note verbatim (§19 Q59)', () => {
    const spec = readFileSync(SPEC, 'utf8');
    const at = spec.indexOf('**Source-format note (v2)');
    expect(at).toBeGreaterThan(0);
    const start = spec.indexOf('```text\n', at) + '```text\n'.length;
    const block = spec.slice(start, spec.indexOf('```', start));
    expect(EXTRACTION_V2_SOURCE_NOTE).toBe(block.trimEnd());
  });

  it('builds the user message with the v2 variables (hero, EN report, imperial)', () => {
    const hero = loadFixture('riverside-2026-10-09');
    const msg = buildExtractionUserMessageV2(hero.input);
    for (const line of [
      'REPORT_DATE: 2026-10-09',
      'REPORT_LANGUAGE: en',
      'UNITS: imperial (in, °F, mph, yd³, ft)',
      'REPORTER_LOCALE: es-US',
      'CHANNEL: web',
      'WORKING_HOURS: 07:00–15:30',
      'DEFAULT_SHIFT_HOURS: 8',
    ])
      expect(msg).toContain(line);
    expect(msg).toMatch(
      /OBSERVED_WEATHER \(hourly, local\): day total precip 0\.40 in · temp 58–64 F/,
    );
    expect(msg).toContain('VOICE NOTE uploadId=11111111-0000-4000-8000-000000000101');
    expect(msg).toContain('[33.0–40.5] The Delta guys were on two doing the ductwork east wing');
    expect(msg).not.toContain('messageId');
  });

  it('gives a Turkish org OBSERVED_WEATHER in mm, °C and km/h', () => {
    const tr = loadFixture('atasehir-2026-10-08-rain-tr');
    const msg = buildExtractionUserMessageV2(tr.input);
    expect(msg).toContain('REPORT_LANGUAGE: tr');
    expect(msg).toContain('UNITS: metric (mm, °C, km/h, m³, m)');
    expect(msg).toContain('REPORTER_LOCALE: tr-TR');
    expect(msg).toMatch(
      /day total precip 8\.4 mm · temp 14–18 C · wind \d+ km\/h · max gust 32 km\/h/,
    );
    expect(msg).toMatch(/08:00 precip 3\.0 mm, temp 14 C, wind 16 km\/h, gusts 31 km\/h/);
    expect(formatObservedWeatherIn(null, 'metric')).toBe('not available');
  });

  it('sends the prompt, the source note and the org block as system blocks (cached)', async () => {
    const hero = loadFixture('riverside-2026-10-09');
    const client = replayClient(hero.recorded);
    const res = await runReportExtraction(client, 'claude-sonnet-5-5', hero.input);
    const params = client.calls[0]!;
    const system = params.system as Array<{ text: string; cache_control?: unknown }>;
    expect(system.map((b) => b.text)).toEqual([
      extractionSystemPromptV2(),
      EXTRACTION_V2_SOURCE_NOTE,
      expect.stringContaining('COMPANIES: '),
    ]);
    expect(system.map((b) => !!b.cache_control)).toEqual([false, true, true]);
    // D23: the 5.5 generation takes no forced tool_choice; the instruction is appended instead.
    expect(params.tool_choice).toEqual({ type: 'auto', disable_parallel_tool_use: true });
    expect(params.temperature).toBeUndefined();
    expect(JSON.stringify(params.messages)).toContain(
      'Respond only by calling the submit_daily_report tool.',
    );
    expect(res.data).toMatchObject({
      schemaVersion: 2,
      reportLanguage: 'en',
      units: 'imperial',
      reportDate: '2026-10-09',
    });
    const forced = replayClient(hero.recorded);
    await runReportExtraction(forced, 'claude-sonnet-4-6', hero.input);
    expect(forced.calls[0]!.tool_choice).toMatchObject({
      type: 'tool',
      name: 'submit_daily_report',
    });
    expect(forced.calls[0]!.temperature).toBe(0);
  });
});

describe('postProcessReportExtraction (code after the model)', () => {
  const hero = loadFixture('riverside-2026-10-09');

  it('recomputes totals, sets what code owns and drops sources that point nowhere', () => {
    const raw = structuredClone(hero.recorded!);
    raw.manpower[0]!.totalHours = 50; // 6 × 8 is 48
    raw.manpower[1]!.source.push(
      { type: 'voice_note', uploadId: 'not-an-upload', start: 1 },
      { type: 'answer', questionId: 'not-a-question' },
      { type: 'office_edit', userId: 'u', at: '2026-10-09T00:00:00Z' },
      { type: 'call', callId: 'c', start: 0 },
    );
    const { data, discrepancies, droppedSources } = postProcessReportExtraction(raw, hero.input);
    expect(data.manpower[0]!.totalHours).toBe(48);
    expect(discrepancies).toEqual([
      { index: 0, companyName: 'Apex Concrete', modelTotal: 50, computedTotal: 48 },
    ]);
    expect(droppedSources).toBe(4);
    expect(data.manpower[1]!.source).toEqual(hero.expected.manpower[1]!.source);
    expect(data.photos).toEqual(hero.input.photos);
    expect(data.weather.observed).toEqual(hero.expected.weather.observed);
    // The Delta headcount stays unknown: code never fills a number nobody said.
    expect(data.manpower[2]).toMatchObject({ workers: null, totalHours: null });
  });

  it('writes a TR report in metric with the observed weather converted', () => {
    const tr = loadFixture('kartal-2026-10-09-tr');
    const { data } = postProcessReportExtraction(tr.recorded!, tr.input);
    expect(data).toMatchObject({ reportLanguage: 'tr', units: 'metric' });
    expect(data.weather.observed).toEqual({
      precip: 0,
      tempMin: 15,
      tempMax: 22,
      wind: 11,
      gust: 24,
      provider: 'Open-Meteo',
    });
  });
});
