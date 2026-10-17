import { estimateClaudeCostUsd, type TokenUsage } from './cost';

/**
 * The machine-readable side of `pnpm eval` (pure, no I/O): which model a golden set runs on, one
 * summary per set (cases, passed, failed case ids, tokens, wall time, the estimated cost at
 * src/ai/cost.ts rates), the `EVAL_SUMMARY {json}` line every run prints, and the Markdown table
 * the eval workflow (.github/workflows/eval.yml) writes to the job summary from the `--json` files.
 */

export const EVAL_SETS = ['extraction', 'answers', 'corrections', 'utterances', 'tr'] as const;
export type EvalSet = (typeof EVAL_SETS)[number];

/**
 * What `all` runs: every set except `tr` (W4-08), the extraction cases whose report language is
 * Turkish, which `extraction` already scores; `--set tr` runs them alone (the TR pilot's check).
 */
export const EVAL_ALL_SETS: readonly EvalSet[] = EVAL_SETS.filter((s) => s !== 'tr');

/** What the worker would use when CLAUDE_MODEL is unset (src/config.ts's default). */
export const EVAL_DEFAULT_MODEL = 'claude-sonnet-5-5';

/**
 * The model a set runs on, from env as the worker picks it: the report extraction and
 * apply_correction on `CLAUDE_MODEL`, parse_answer and classify_utterance on `CLAUDE_MODEL_FAST`
 * (else `CLAUDE_MODEL`). null when the set needs `CLAUDE_MODEL` and it is unset (apply_correction:
 * the eval never guesses its model). Setting both to one id runs every set on that model.
 */
export function evalModelFor(set: EvalSet, env: Record<string, string | undefined>): string | null {
  const full = env.CLAUDE_MODEL?.trim() || '';
  const fast = env.CLAUDE_MODEL_FAST?.trim() || '';
  switch (set) {
    case 'extraction':
    case 'tr':
      return full || EVAL_DEFAULT_MODEL;
    case 'corrections':
      return full || null;
    case 'answers':
    case 'utterances':
      return fast || full || EVAL_DEFAULT_MODEL;
  }
}

/** One scored case, whatever the set. */
export interface EvalOutcome {
  id: string;
  ok: boolean;
  /** Names of the checks that failed. */
  failedChecks: string[];
  /** Tokens of a live call; absent offline. */
  usage?: TokenUsage;
}

export interface EvalSetSummary {
  set: EvalSet;
  /** The model id of a live run; `recorded` for the offline scoring of the recorded outputs. */
  model: string;
  recorded: boolean;
  cases: number;
  passed: number;
  failed: number;
  failedCases: string[];
  tokens: TokenUsage;
  /** USD at src/ai/cost.ts rates for `model`; 0 offline. */
  estCostUsd: number;
  wallTimeMs: number;
}

export interface EvalReport extends EvalSetSummary {
  results: EvalOutcome[];
}

const ZERO: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

export function summarizeEval(
  set: EvalSet,
  model: string,
  recorded: boolean,
  outcomes: readonly EvalOutcome[],
  wallTimeMs: number,
): EvalSetSummary {
  const tokens = outcomes.reduce<TokenUsage>(
    (s, o) => ({
      input: s.input + (o.usage?.input ?? 0),
      output: s.output + (o.usage?.output ?? 0),
      cacheRead: s.cacheRead + (o.usage?.cacheRead ?? 0),
      cacheWrite: s.cacheWrite + (o.usage?.cacheWrite ?? 0),
    }),
    { ...ZERO },
  );
  const failedCases = outcomes.filter((o) => !o.ok).map((o) => o.id);
  return {
    set,
    model: recorded ? 'recorded' : model,
    recorded,
    cases: outcomes.length,
    passed: outcomes.length - failedCases.length,
    failed: failedCases.length,
    failedCases,
    tokens,
    estCostUsd: recorded ? 0 : estimateClaudeCostUsd(model, tokens),
    wallTimeMs: Math.max(0, Math.round(wallTimeMs)),
  };
}

export const SUMMARY_PREFIX = 'EVAL_SUMMARY ';

/** The one line every scored run prints: `EVAL_SUMMARY {json}` (grep-able, one per set). */
export function summaryLine(s: EvalSetSummary): string {
  return `${SUMMARY_PREFIX}${JSON.stringify(s)}`;
}

/** "extraction" or "answers,corrections" or "all" (EVAL_ALL_SETS) → the sets, in EVAL_SETS order. */
export function parseEvalSets(value: string): EvalSet[] {
  const names = value
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (names.length === 0 || names.includes('all')) return [...EVAL_ALL_SETS];
  for (const n of names)
    if (!(EVAL_SETS as readonly string[]).includes(n))
      throw new Error(`unknown eval set: ${n} (one of ${EVAL_SETS.join(', ')}, all)`);
  return EVAL_SETS.filter((s) => names.includes(s));
}

/** The `--json` file's shape check: a summary from another run is data, so it is read strictly. */
export function isEvalSetSummary(v: unknown): v is EvalSetSummary {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  const t = o.tokens as Record<string, unknown> | undefined;
  return (
    typeof o.set === 'string' &&
    (EVAL_SETS as readonly string[]).includes(o.set) &&
    typeof o.model === 'string' &&
    typeof o.cases === 'number' &&
    typeof o.passed === 'number' &&
    Array.isArray(o.failedCases) &&
    o.failedCases.every((x) => typeof x === 'string') &&
    !!t &&
    typeof t.input === 'number' &&
    typeof t.output === 'number' &&
    typeof o.estCostUsd === 'number' &&
    typeof o.wallTimeMs === 'number'
  );
}

function cell(s: string): string {
  return s
    .replace(/\\/g, '\\\\')
    .replace(/\|/g, '\\|')
    .replace(/[\r\n]+/g, ' ');
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)} s`;
  return `${Math.floor(s / 60)} min ${Math.round(s % 60)} s`;
}

/**
 * The job summary table: one row per model × set, in the order given, then a total per model.
 * Failed cases are listed by id (at most `maxFailed`, then "+n more").
 */
export function markdownSummary(summaries: readonly EvalSetSummary[], maxFailed = 8): string {
  const lines = [
    '| Model | Set | Passed | Failed cases | Tokens in / out | Est. cost | Time |',
    '| --- | --- | ---: | --- | ---: | ---: | ---: |',
  ];
  for (const s of summaries) {
    const shown = s.failedCases.slice(0, maxFailed).map((id) => `\`${cell(id)}\``);
    if (s.failedCases.length > maxFailed) shown.push(`+${s.failedCases.length - maxFailed} more`);
    lines.push(
      `| \`${cell(s.model)}\` | ${s.set} | ${s.passed}/${s.cases} | ${shown.join(', ') || '-'} | ${s.tokens.input} / ${s.tokens.output} | $${s.estCostUsd.toFixed(4)} | ${formatDuration(s.wallTimeMs)} |`,
    );
  }
  const models = [...new Set(summaries.map((s) => s.model))];
  if (summaries.length > 1 && models.length > 0) {
    lines.push(
      '',
      '| Model | Passed | Tokens in / out | Est. cost | Time |',
      '| --- | ---: | ---: | ---: | ---: |',
    );
    for (const m of models) {
      const rows = summaries.filter((s) => s.model === m);
      const sum = (f: (s: EvalSetSummary) => number) => rows.reduce((n, s) => n + f(s), 0);
      lines.push(
        `| \`${cell(m)}\` | ${sum((s) => s.passed)}/${sum((s) => s.cases)} | ${sum((s) => s.tokens.input)} / ${sum((s) => s.tokens.output)} | $${sum((s) => s.estCostUsd).toFixed(4)} | ${formatDuration(sum((s) => s.wallTimeMs))} |`,
      );
    }
  }
  return lines.join('\n');
}
