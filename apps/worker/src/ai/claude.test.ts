import { describe, expect, it } from 'vitest';
import { ExtractionOutputSchema } from '@sitelog/shared';
import { z } from 'zod';
import { buildParams, callTool, coerceToSchema, modelProfile, ToolCallError } from './claude';
import { runExtraction } from './extract';
import { quickClassify, stripDayReference } from './classify';
import { quickDayOff } from './dayoff';
import { matchSiteByText } from './site-guess';
import { scriptedClaude } from '../test/harness';
import { legacyInput, legacyRecorded } from '../test/legacy-fixtures';

const input = legacyInput('riverside-2026-10-09');
const recorded = legacyRecorded('riverside-2026-10-09');

describe('model profiles', () => {
  it('forces the tool and temperature 0 on models that accept them', () => {
    expect(modelProfile('claude-sonnet-4-6')).toEqual({
      forcedToolChoice: true,
      sampling: true,
      effort: true,
    });
    expect(modelProfile('claude-haiku-4-5')).toEqual({
      forcedToolChoice: true,
      sampling: true,
      effort: false,
    });
    expect(modelProfile('claude-3-5-sonnet-20241022')).toMatchObject({
      forcedToolChoice: true,
      sampling: true,
    });
  });
  it('uses auto tool choice and no sampling on the 5.5 generation and Fable', () => {
    expect(modelProfile('claude-sonnet-5-5')).toEqual({
      forcedToolChoice: false,
      sampling: false,
      effort: true,
    });
    expect(modelProfile('claude-opus-5-5')).toEqual({
      forcedToolChoice: false,
      sampling: false,
      effort: true,
    });
    expect(modelProfile('claude-haiku-5-5')).toEqual({
      forcedToolChoice: true,
      sampling: false,
      effort: true,
    });
    expect(modelProfile('claude-fable-5-1')).toEqual({
      forcedToolChoice: false,
      sampling: false,
      effort: true,
    });
  });
  it('builds request params accordingly, caching system blocks', () => {
    const req = {
      model: 'claude-sonnet-4-6',
      system: [
        { text: 'sys', cache: true },
        { text: 'glossary', cache: true },
      ],
      messages: [],
      tool: { name: 't', description: 'd', inputSchema: { type: 'object' } },
      schema: z.object({}),
      effort: 'low' as const,
    };
    const p = buildParams(req, [{ role: 'user', content: 'hi' }]);
    expect(p.tool_choice).toEqual({ type: 'tool', name: 't', disable_parallel_tool_use: true });
    expect(p.temperature).toBe(0);
    expect((p.system as Array<{ cache_control?: unknown }>)[0]!.cache_control).toEqual({
      type: 'ephemeral',
    });
    const p2 = buildParams({ ...req, model: 'claude-sonnet-5-5' }, [
      { role: 'user', content: 'hi' },
    ]);
    expect(p2.tool_choice).toEqual({ type: 'auto', disable_parallel_tool_use: true });
    expect(p2.temperature).toBeUndefined();
    expect(p2.output_config).toEqual({ effort: 'low' });
  });
});

describe('callTool validation retry', () => {
  const schema = z.object({ workers: z.number().int(), name: z.string() });
  const req = {
    model: 'claude-sonnet-4-6',
    system: [{ text: 'sys' }],
    messages: [{ role: 'user' as const, content: 'go' }],
    tool: { name: 'count', description: 'd', inputSchema: { type: 'object' } },
    schema,
  };

  it('retries once with the validation error as a tool_result and succeeds', async () => {
    const client = scriptedClaude([
      { input: { workers: 'seven', name: 'Apex' } },
      { input: { workers: 7, name: 'Apex' } },
    ]);
    const res = await callTool(client, req);
    expect(res.data).toEqual({ workers: 7, name: 'Apex' });
    expect(res.retried).toBe(true);
    expect(res.apiCalls).toBe(2);
    const second = client.calls[1]!;
    expect(second.messages).toHaveLength(3);
    const last = second.messages[2]!.content as Array<{
      type: string;
      is_error?: boolean;
      content?: string;
    }>;
    expect(last[0]!.type).toBe('tool_result');
    expect(last[0]!.is_error).toBe(true);
    expect(last[0]!.content).toContain('workers');
    expect(res.usage.input).toBe(2000);
    expect(res.estCostUsd).toBeGreaterThan(0);
  });

  it('fails after the second invalid answer', async () => {
    const client = scriptedClaude([{ input: { workers: 'x' } }, { input: { workers: 'y' } }]);
    await expect(callTool(client, req)).rejects.toMatchObject({ kind: 'invalid_input' });
  });

  it('re-prompts once when an auto-choice model answers in prose', async () => {
    const client = scriptedClaude([
      { text: 'Sure, here is the report' },
      { input: { workers: 3, name: 'Delta' } },
    ]);
    const res = await callTool(client, { ...req, model: 'claude-sonnet-5-5' });
    expect(res.data.workers).toBe(3);
    expect(client.calls[0]!.messages[0]!.content).toContain(
      'Respond only by calling the count tool',
    );
    const client2 = scriptedClaude([{ text: 'no' }, { text: 'still no' }]);
    await expect(callTool(client2, { ...req, model: 'claude-sonnet-5-5' })).rejects.toBeInstanceOf(
      ToolCallError,
    );
  });
});

describe('coerceToSchema (tool input as the schema describes it)', () => {
  const schema = {
    type: 'object',
    properties: {
      weather: {
        type: 'object',
        properties: { text: { type: 'string' }, note: { type: 'string' } },
        required: ['text'],
      },
      items: {
        type: 'array',
        items: {
          type: 'object',
          properties: { pct: { type: 'integer' }, workers: { type: ['integer', 'null'] } },
          required: ['workers'],
        },
      },
      count: { type: 'integer' },
      value: {},
    },
    required: ['weather', 'items', 'count'],
  };

  it('parses a stringified object or array and drops null on optional fields', () => {
    expect(
      coerceToSchema(
        {
          weather: '{"text":"Rain","note":null}',
          items: '[{"pct":null,"workers":null}]',
          count: null,
          value: null,
        },
        schema,
      ),
    ).toEqual({
      weather: { text: 'Rain' },
      items: [{ workers: null }],
      count: null,
      value: null,
    });
  });

  it('leaves what it cannot read to Zod and never mutates the input', () => {
    const input = { weather: 'sunny', items: [], count: 3 };
    const copy = structuredClone(input);
    expect(coerceToSchema(input, schema)).toEqual(input);
    expect(input).toEqual(copy);
    expect(coerceToSchema({ weather: '[1]', items: '{}', count: 1 }, schema)).toEqual({
      weather: '[1]',
      items: '{}',
      count: 1,
    });
  });
});

describe('extraction post-processing with the recorded tool output', () => {
  it('recomputes totals, resolves companies and keeps the Delta gap', async () => {
    const client = scriptedClaude([{ input: recorded }]);
    const res = await runExtraction(client, 'claude-sonnet-4-6', input);
    expect(res.data.schemaVersion).toBe(1);
    expect(res.data.reportDate).toBe('2026-10-09');
    expect(res.data.photos).toHaveLength(2);
    expect(res.data.weather.observed?.precipIn).toBe(0.4);
    const apex = res.data.manpower.find((m) => m.companyName === 'Apex Concrete')!;
    expect(apex.companyId).toBe('00000000-0000-4000-8000-00000000d001');
    expect(apex.totalHours).toBe(48);
    const delta = res.data.manpower.find((m) => m.companyName === 'Delta Mechanical')!;
    expect(delta.workers).toBeNull();
    expect(delta.totalHours).toBeNull();
    expect(res.data.missingRequired).toContain('manpower.workers:Delta Mechanical');
    expect(ExtractionOutputSchema.safeParse(res.raw).success).toBe(true);
    const sys = client.calls[0]!.system as Array<{ text: string }>;
    expect(sys[0]!.text).toContain("You are TalkOlog's report writer");
    expect(sys[1]!.text).toContain('GLOSSARY');
    expect(JSON.stringify(client.calls[0])).not.toContain('+1555');
  });

  it('maps a model total that disagrees to workers × hours and reports it', async () => {
    const wrong = structuredClone(recorded) as { manpower: Array<{ totalHours: number | null }> };
    wrong.manpower[0]!.totalHours = 99;
    const res = await runExtraction(scriptedClaude([{ input: wrong }]), 'claude-sonnet-4-6', input);
    expect(res.data.manpower[0]!.totalHours).toBe(48);
    expect(res.discrepancies).toHaveLength(1);
  });
});

describe('quick classifiers (no model)', () => {
  const now = new Date('2026-10-12T20:00:00Z'); // Monday
  it('handles the §9.5 grammar deterministically', () => {
    expect(quickClassify('ok', now, 'America/Chicago')?.intent).toBe('confirm');
    expect(quickClassify('Dale', now, 'America/Chicago')?.intent).toBe('confirm');
    expect(quickClassify('help', now, 'America/Chicago')?.intent).toBe('help');
    expect(quickClassify('stop', now, 'America/Chicago')?.intent).toBe('stop');
    expect(quickClassify('no work today', now, 'America/Chicago')?.intent).toBe('no_work');
    expect(quickClassify('language es', now, 'America/Chicago')).toMatchObject({
      intent: 'language',
      entities: { language: 'es' },
    });
    const edit = quickClassify('edit Friday — Apex was 7 guys, not 6', now, 'America/Chicago');
    expect(edit).toMatchObject({
      intent: 'edit_request',
      entities: { dayReference: '2026-10-09' },
      correctionText: 'Apex was 7 guys, not 6',
    });
    expect(quickClassify('Apex had 7 not 6', now, 'America/Chicago')).toBeNull();
  });
  it('strips day references', () => {
    expect(stripDayReference("yesterday's report: Delta had 5")).toBe('Delta had 5');
    expect(stripDayReference('Oct 9 — hours were 8')).toBe('hours were 8');
  });
  it('classifies day-off messages', () => {
    expect(quickDayOff('rained out, sent the crew home at 11')).toMatchObject({
      kind: 'weather_day',
      releasedAt: '11:00',
      cause: 'rain',
      fullDay: false,
    });
    expect(quickDayOff('site closed for holiday')).toMatchObject({
      kind: 'no_work',
      fullDay: true,
    });
  });
  it('infers sites from text', () => {
    const sites = [
      { id: 'a', name: 'Riverside Lofts — Block B', projectCode: 'RL-2041' },
      { id: 'b', name: 'Oakmont Medical Center', projectCode: 'OM-1187' },
    ];
    expect(matchSiteByText('report for RL-2041', sites)).toMatchObject({
      siteId: 'a',
      confidence: 1,
    });
    expect(matchSiteByText('oakmont today, dry', sites)).toMatchObject({ siteId: 'b' });
    expect(matchSiteByText('poured the deck', sites).siteId).toBeNull();
  });
});
