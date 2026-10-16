import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Anthropic from '@anthropic-ai/sdk';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import type { MessagesClient } from './claude';
import { estimateClaudeCostUsd } from './cost';
import { parseArgs, runEval, selectedSet } from './eval';
import {
  EVAL_SETS,
  evalModelFor,
  formatDuration,
  isEvalSetSummary,
  markdownSummary,
  parseEvalSets,
  summarizeEval,
  summaryLine,
  type EvalSetSummary,
} from './eval-summary';
import { loadUtteranceCases, runUtteranceEval, scoreUtterance } from './utterance-fixtures';

const tmp = mkdtempSync(join(tmpdir(), 'sitelog-eval-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
afterEach(() => vi.restoreAllMocks());

describe('evalModelFor', () => {
  it('picks the model as the worker does, and one id for both runs every set on it', () => {
    const env = { CLAUDE_MODEL: 'model-full', CLAUDE_MODEL_FAST: 'model-fast' };
    expect(evalModelFor('extraction', env)).toBe('model-full');
    expect(evalModelFor('corrections', env)).toBe('model-full');
    expect(evalModelFor('answers', env)).toBe('model-fast');
    expect(evalModelFor('utterances', env)).toBe('model-fast');
    const one = { CLAUDE_MODEL: 'model-x', CLAUDE_MODEL_FAST: 'model-x' };
    for (const set of EVAL_SETS) expect(evalModelFor(set, one)).toBe('model-x');
  });

  it('falls back like the worker, and never guesses apply_correction', () => {
    expect(evalModelFor('answers', { CLAUDE_MODEL: 'model-full' })).toBe('model-full');
    expect(evalModelFor('utterances', { CLAUDE_MODEL: ' ', CLAUDE_MODEL_FAST: '' })).toBe(
      evalModelFor('extraction', {}),
    );
    expect(evalModelFor('corrections', {})).toBeNull();
  });
});

describe('summarizeEval', () => {
  const usage = (input: number, output: number) => ({ input, output, cacheRead: 0, cacheWrite: 0 });

  it('counts cases, lists the failed ids and sums tokens, costed at cost.ts rates', () => {
    const s = summarizeEval(
      'answers',
      'claude-haiku-4-5',
      false,
      [
        { id: 'a', ok: true, failedChecks: [], usage: usage(1000, 200) },
        { id: 'b', ok: false, failedChecks: ['value'], usage: usage(500, 100) },
        { id: 'c', ok: false, failedChecks: ['call'] },
      ],
      1234.6,
    );
    expect(s).toMatchObject({
      set: 'answers',
      model: 'claude-haiku-4-5',
      cases: 3,
      passed: 1,
      failed: 2,
      failedCases: ['b', 'c'],
      tokens: { input: 1500, output: 300, cacheRead: 0, cacheWrite: 0 },
      wallTimeMs: 1235,
    });
    expect(s.estCostUsd).toBe(estimateClaudeCostUsd('claude-haiku-4-5', s.tokens));
    expect(s.estCostUsd).toBeCloseTo((1500 * 1 + 300 * 5) / 1e6, 9);
  });

  it('an offline run is model "recorded" and costs nothing', () => {
    const s = summarizeEval(
      'extraction',
      'any',
      true,
      [{ id: 'a', ok: true, failedChecks: [] }],
      3,
    );
    expect(s).toMatchObject({ model: 'recorded', recorded: true, estCostUsd: 0, passed: 1 });
    expect(summaryLine(s)).toBe(`EVAL_SUMMARY ${JSON.stringify(s)}`);
    expect(isEvalSetSummary(JSON.parse(summaryLine(s).slice('EVAL_SUMMARY '.length)))).toBe(true);
  });
});

describe('parseEvalSets and the CLI flags', () => {
  it('reads set names, "all" and rejects unknown ones', () => {
    expect(parseEvalSets('all')).toEqual([...EVAL_SETS]);
    expect(parseEvalSets('')).toEqual([...EVAL_SETS]);
    expect(parseEvalSets('utterances, Answers')).toEqual(['answers', 'utterances']);
    expect(() => parseEvalSets('extraction,nope')).toThrow(/unknown eval set: nope/);
  });

  it('parses --set, --utterances, --json and --summarize; one set per run', () => {
    expect(parseArgs(['--set', 'corrections', '--json', 'out/c.json'])).toMatchObject({
      set: 'corrections',
      json: 'out/c.json',
    });
    expect(selectedSet(parseArgs(['--utterances']))).toBe('utterances');
    expect(selectedSet(parseArgs(['--answers', '--set=answers']))).toBe('answers');
    expect(selectedSet(parseArgs([]))).toBe('extraction');
    expect(() => selectedSet(parseArgs(['--answers', '--corrections']))).toThrow(/one set per run/);
    expect(() => parseArgs(['--set', 'all'])).toThrow(/one set per run/);
    expect(() => parseArgs(['--json'])).toThrow(/--json needs a file path/);
    expect(parseArgs(['--summarize', 'a.json', 'b.json']).summarize).toEqual(['a.json', 'b.json']);
    expect(() => parseArgs(['--summarize'])).toThrow(/at least one file/);
  });
});

describe('markdownSummary', () => {
  const row = (over: Partial<EvalSetSummary>): EvalSetSummary => ({
    set: 'extraction',
    model: 'model-a',
    recorded: false,
    cases: 2,
    passed: 2,
    failed: 0,
    failedCases: [],
    tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
    estCostUsd: 0.5,
    wallTimeMs: 61_000,
    ...over,
  });

  it('one row per model and set, failed ids capped, cells escaped, a total per model', () => {
    const md = markdownSummary(
      [
        row({}),
        row({ set: 'answers', passed: 0, failed: 3, cases: 3, failedCases: ['x|y', 'b', 'c'] }),
        row({ model: 'model-b', wallTimeMs: 900 }),
      ],
      2,
    );
    const lines = md.split('\n');
    expect(lines[0]).toBe(
      '| Model | Set | Passed | Failed cases | Tokens in / out | Est. cost | Time |',
    );
    expect(lines[2]).toBe('| `model-a` | extraction | 2/2 | - | 10 / 5 | $0.5000 | 1 min 1 s |');
    expect(lines[3]).toBe(
      '| `model-a` | answers | 0/3 | `x\\|y`, `b`, +1 more | 10 / 5 | $0.5000 | 1 min 1 s |',
    );
    expect(lines[4]).toContain('| `model-b` | extraction | 2/2 |');
    expect(md).toContain('| `model-a` | 2/5 | 20 / 10 | $1.0000 | 2 min 2 s |');
    expect(md).toContain('| `model-b` | 2/2 | 10 / 5 | $0.5000 | 900 ms |');
  });

  it('formats durations', () => {
    expect(formatDuration(450)).toBe('450 ms');
    expect(formatDuration(12_345)).toBe('12.3 s');
    expect(formatDuration(125_000)).toBe('2 min 5 s');
  });
});

describe('classify_utterance golden set', () => {
  const cases = loadUtteranceCases();

  it('scores the intent exactly, the day case-blind and the change without punctuation', () => {
    const c = cases.find((x) => x.id === 'en-edit-fri-apex')!;
    expect(scoreUtterance(c, c.recorded).every((x) => x.ok)).toBe(true);
    const loose = scoreUtterance(c, {
      ...c.recorded,
      entities: { dayReference: ' fri ' },
      correctionText: 'apex was 7, not 6.',
    });
    expect(loose.every((x) => x.ok)).toBe(true);
    const wrong = scoreUtterance(c, {
      ...c.recorded,
      intent: 'fix',
      entities: {},
      correctionText: 'Apex was 8 not 6',
    });
    expect(wrong.filter((x) => !x.ok).map((x) => x.name)).toEqual([
      'intent',
      'dayReference',
      'correctionText',
    ]);
    const tr = cases.find((x) => x.id === 'tr-edit-cuma')!;
    expect(
      scoreUtterance(tr, { ...tr.recorded, entities: { dayReference: 'CUMA' } }).every((x) => x.ok),
    ).toBe(true);
  });

  it('a live run calls the fast model as sms_keyword does and sums its tokens; a failed call fails its case', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const calls: Anthropic.MessageCreateParamsNonStreaming[] = [];
    const client: MessagesClient = {
      messages: {
        async create(params) {
          calls.push(params);
          const text = JSON.stringify(params.messages);
          if (text.includes('DÜZELT')) throw new Error('overloaded');
          const c = cases.find((x) => text.includes(JSON.stringify(x.text).slice(1, -1)))!;
          return {
            id: `msg_${calls.length}`,
            type: 'message',
            role: 'assistant',
            model: params.model,
            content: [{ type: 'tool_use', id: 't', name: 'classify_utterance', input: c.recorded }],
            stop_reason: 'tool_use',
            stop_sequence: null,
            usage: {
              input_tokens: 100,
              output_tokens: 20,
              cache_creation_input_tokens: 0,
              cache_read_input_tokens: 0,
            },
          } as unknown as Anthropic.Message;
        },
      },
    };
    const outcomes = await runUtteranceEval({
      recorded: false,
      client,
      model: 'model-fast',
      filter: [],
    });
    expect(calls.every((p) => p.model === 'model-fast')).toBe(true);
    expect(JSON.stringify(calls[0]!.messages)).toContain('KEYWORD: EDIT');
    const failed = outcomes.filter((o) => !o.ok);
    expect(failed.map((o) => [o.id, o.failedChecks])).toEqual([['tr-edit-cuma', ['call']]]);
    const s = summarizeEval('utterances', 'model-fast', false, outcomes, 10);
    expect(s.tokens.input).toBe(100 * (cases.length - 1));
    expect(s.tokens.output).toBe(20 * (cases.length - 1));
  });
});

describe('pnpm eval: summary line, --json and --summarize', () => {
  it('every set scores offline, prints EVAL_SUMMARY and writes the --json file', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const files: string[] = [];
    for (const set of EVAL_SETS) {
      const file = join(tmp, 'out', `${set}.json`);
      files.push(file);
      const argv = ['--set', set, '--recorded', '--json', file];
      if (set === 'extraction') argv.push('--case', 'pier9');
      expect(await runEval(argv, {})).toBe(0);
      const report = JSON.parse(readFileSync(file, 'utf8')) as EvalSetSummary & {
        results: unknown[];
      };
      expect(isEvalSetSummary(report)).toBe(true);
      expect(report).toMatchObject({ set, model: 'recorded', failed: 0, failedCases: [] });
      expect(report.results).toHaveLength(report.cases);
      expect(report.cases).toBeGreaterThan(0);
    }
    const lines = log.mock.calls.map((c) => String(c[0])).filter((l) => l.startsWith('EVAL_'));
    expect(lines).toHaveLength(EVAL_SETS.length);
    expect(log.mock.calls.flat().join('\n')).toMatch(/4\/4 classify_utterance cases passed/);

    log.mockClear();
    expect(await runEval(['--summarize', ...files], {})).toBe(0);
    const md = String(log.mock.calls[0]![0]);
    for (const set of EVAL_SETS) expect(md).toContain(`| \`recorded\` | ${set} |`);
  });

  it('--utterances skips without a key, and --summarize fails on a file that is not a summary', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await runEval(['--utterances'], {})).toBe(0);
    expect(String(log.mock.calls[0]![0])).toMatch(/^skipped: ANTHROPIC_API_KEY is not set/);
    expect(await runEval(['--summarize', join(tmp, 'missing.json')], {})).toBe(1);
    expect(error).toHaveBeenCalled();
  });
});
