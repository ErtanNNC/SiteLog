/**
 * W3-15: runs one scripted call against field-api's `/voice/*` routes, as the voice agent would
 * at text level: `calls/start`, the disclosure mark (§19 Q205), then each step of the script in order (a `pending` answer asked
 * again with the same body, as the agent does), each request and answer checked against the
 * voice contract (`VOICE_TOOL_SCHEMAS`) and the script's expected answer, then the stack's checks
 * of what the call left behind. Network and database are behind `VoiceHttp` and `SimStack`, so
 * the runner is unit-tested on fakes (`simulate-call.test.ts`).
 */
import type { z } from 'zod';
import {
  VOICE_ROUTES,
  VOICE_TOOL_SCHEMAS,
  VoiceCallStartRequestSchema,
  VoiceCallStartResponseSchema,
  VoiceDisclosureResponseSchema,
  VoiceDraftStateSchema,
  type VoiceTool,
} from '@sitelog/shared';
import { diffRecorded, isPending, matchSubset } from './match.ts';
import type { SimScript, SimStep } from './script.ts';

export type VoiceCallStartRequest = z.infer<typeof VoiceCallStartRequestSchema>;

/** field-api's voice routes over HTTP (the bearer secret is the implementation's). */
export interface VoiceHttp {
  post(path: string, body: unknown, callToken?: string): Promise<{ status: number; body: unknown }>;
}

/** What `arrange` made for one run. */
export interface Arranged {
  orgId: string | null;
  reporterId: string | null;
  /** Site ids by the script's keys. */
  siteIds: Record<string, string>;
  /** The `calls/start` request the agent would send (the room, the caller's number or call id). */
  start: VoiceCallStartRequest;
}

/** The database side: a fresh org for the script, and the checks after the call. */
export interface SimStack {
  arrange(script: SimScript): Promise<Arranged>;
  /** The script's `expect` against the stack; the failures, or none. */
  check(script: SimScript, run: { callId: string; arranged: Arranged }): Promise<string[]>;
}

export interface RunDeps {
  http: VoiceHttp;
  stack: SimStack;
  /** The extraction case's transcript segments (`fixtures/transcripts/<id>.json`). */
  segments: (extraction: string) => Array<{ start: number; end: number; text: string }>;
  sleep?: (ms: number) => Promise<void>;
  /** How often a `pending` answer is asked again before the step fails (default 30). */
  maxPending?: number;
  log?: (line: string) => void;
}

export interface StepResult {
  route: string;
  status: number;
  pending: number;
  ms: number;
}

export interface SimResult {
  id: string;
  callId: string | null;
  steps: StepResult[];
  failures: string[];
}

/** The call so far: what the step bodies' `$…` values are read from. */
interface Vars {
  draft: z.infer<typeof VoiceDraftStateSchema> | null;
  loadedReportId: string | null;
  confirmKey: string | null;
  correctionId: string | null;
  sites: Record<string, string>;
  segments: () => unknown;
}

/** A step's body with its `$…` values filled in; throws when the call has no such value yet. */
export function resolveVars(value: unknown, vars: Vars): unknown {
  if (typeof value === 'string' && value.startsWith('$')) {
    const need = <T>(v: T | null | undefined, what: string): T => {
      if (v === null || v === undefined) throw new Error(`${value}: the call has no ${what} yet`);
      return v;
    };
    const site = /^\$site\.(.+)$/.exec(value);
    if (site) return need(vars.sites[site[1]!], `site "${site[1]}"`);
    switch (value) {
      case '$segments':
        return vars.segments();
      case '$draft.reportId':
        return need(vars.draft?.reportId, 'draft');
      case '$draft.draftRev':
        return need(vars.draft?.draftRev, 'draft');
      case '$draft.questionId':
        return need(vars.draft?.question?.id, 'open question');
      case '$loaded.reportId':
        return need(vars.loadedReportId, 'report from load_report');
      case '$confirmKey':
        return need(vars.confirmKey, 'confirmKey');
      case '$correctionId':
        return need(vars.correctionId, 'correctionId');
      default:
        throw new Error(`${value}: unknown variable`);
    }
  }
  if (Array.isArray(value)) return value.map((v) => resolveVars(v, vars));
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, resolveVars(v, vars)]),
    );
  return value;
}

/** What the call's state takes from an answer: the latest draft, keys and ids. */
function remember(route: string, answer: unknown, vars: Vars): void {
  if (!answer || typeof answer !== 'object') return;
  const a = answer as Record<string, unknown>;
  const draft = route === 'update_draft' ? a : a.draft;
  const parsed = VoiceDraftStateSchema.safeParse(draft);
  if (parsed.success) vars.draft = parsed.data;
  if (typeof a.confirmKey === 'string') vars.confirmKey = a.confirmKey;
  if (typeof a.correctionId === 'string') vars.correctionId = a.correctionId;
  if (route === 'load_report' && typeof a.reportId === 'string') vars.loadedReportId = a.reportId;
}

/**
 * The recorded answers of each route in order, `pending` ones left out; the last one repeats
 * (as the agent's FakeFieldApi serves them).
 */
export function recordedAnswers(script: SimScript): (route: string) => unknown {
  const used = new Map<string, number>();
  return (route) => {
    const list = (script.routes[route] ?? []).filter((a) => !isPending(a));
    if (list.length === 0) return undefined;
    const i = used.get(route) ?? 0;
    used.set(route, i + 1);
    return list[Math.min(i, list.length - 1)];
  };
}

/** `end_call`'s log and metrics when the step leaves them out: the script's turns, no numbers. */
export function defaultEndCall(script: SimScript): Record<string, unknown> {
  const dialogLog: Array<{ t: number; speaker: 'agent' | 'reporter'; text: string }> = [];
  const agentTexts = script.agentTurns
    .map((t) => t.text)
    .filter((t): t is string => typeof t === 'string');
  const n = Math.max(script.reporterTurns.length, agentTexts.length);
  for (let i = 0; i < n; i++) {
    const r = script.reporterTurns[i];
    if (r) dialogLog.push({ t: i * 10, speaker: 'reporter', text: r.slice(0, 4000) });
    const a = agentTexts[i];
    if (a) dialogLog.push({ t: i * 10 + 5, speaker: 'agent', text: a.slice(0, 4000) });
  }
  return {
    dialogLog,
    metrics: {
      latencyP50Ms: null,
      latencyP95Ms: null,
      interruptions: 0,
      sttConfidence: null,
      turns: script.reporterTurns.length,
    },
  };
}

function routePath(route: string, callId: string): string {
  const r = VOICE_ROUTES[route];
  if (!r) throw new Error(`unknown voice route ${route}`);
  return r.path.replace('{callId}', callId);
}

function issues(err: z.ZodError): string {
  return err.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
}

/** Runs the script; never throws for a mismatch (they are `failures`), only for a broken script. */
export async function runCallScript(script: SimScript, deps: RunDeps): Promise<SimResult> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const maxPending = deps.maxPending ?? 30;
  const log = deps.log ?? (() => {});
  const result: SimResult = { id: script.id, callId: null, steps: [], failures: [] };
  const fail = (line: string) => {
    result.failures.push(line);
    log(`  FAIL ${line}`);
  };

  const arranged = await deps.stack.arrange(script);
  const startReq = VoiceCallStartRequestSchema.safeParse(arranged.start);
  if (!startReq.success) throw new Error(`calls/start request: ${issues(startReq.error)}`);
  const started = await deps.http.post(routePath('calls_start', ''), arranged.start);
  const startAnswer = VoiceCallStartResponseSchema.safeParse(started.body);
  if (started.status !== 200 || !startAnswer.success) {
    fail(`calls_start: HTTP ${started.status} ${JSON.stringify(started.body)}`);
    return result;
  }
  const { callId, callToken } = startAnswer.data;
  result.callId = callId;
  log(`  calls_start → ${callId}`);
  for (const line of diffRecorded(script.start.response, startAnswer.data, 'calls_start'))
    fail(line);

  const recorded = recordedAnswers(script);

  // As the agent: once the opening with the recording notice has played, field-api is told
  // (§19 Q205), before any request that processes speech. The post-call job (W3-11) then waits
  // for the call's recording, which a text-level run never uploads (the audio level's, `--live`).
  const disclosure = await deps.http.post(routePath('disclosure', callId), { callId }, callToken);
  const marked = VoiceDisclosureResponseSchema.safeParse(disclosure.body);
  if (disclosure.status !== 200 || !marked.success) {
    fail(`disclosure: HTTP ${disclosure.status} ${JSON.stringify(disclosure.body)}`);
    return result;
  }
  for (const line of diffRecorded(
    recorded('disclosure') ?? { ok: true },
    marked.data,
    'disclosure',
  ))
    fail(line);
  const vars: Vars = {
    draft: null,
    loadedReportId: null,
    confirmKey: null,
    correctionId: null,
    sites: arranged.siteIds,
    segments: () => {
      if (!script.extraction) throw new Error('$segments: the script names no extraction');
      return deps.segments(script.extraction);
    },
  };

  for (const [i, step] of script.simulate.steps.entries()) {
    const label = `step ${i + 1} ${step.route}`;
    const before = result.failures.length;
    await runStep(step, label);
    if (result.failures.length > before) return result; // later steps would only cascade
  }

  for (const line of await deps.stack.check(script, { callId, arranged })) fail(line);
  return result;

  async function runStep(step: SimStep, label: string): Promise<void> {
    const route = step.route as VoiceTool;
    const schemas = VOICE_TOOL_SCHEMAS[route];
    let body = resolveVars(step.body, vars) as Record<string, unknown>;
    if (route === 'end_call') body = { ...defaultEndCall(script), ...body };
    body = { callId, ...body };
    const req = schemas.request.safeParse(body);
    if (!req.success) throw new Error(`${script.id} ${label}: request ${issues(req.error)}`);
    const t0 = Date.now();
    let res = await deps.http.post(routePath(route, callId), body, callToken);
    let pending = 0;
    while (res.status === 202 && isPending(res.body) && pending < maxPending) {
      pending += 1;
      const wait = (res.body as { retryAfterMs?: number }).retryAfterMs ?? 1000;
      await sleep(Math.min(Math.max(wait, 100), 5000));
      res = await deps.http.post(routePath(route, callId), body, callToken);
    }
    result.steps.push({ route, status: res.status, pending, ms: Date.now() - t0 });
    log(`  ${label} → HTTP ${res.status}${pending ? ` after ${pending} pending` : ''}`);

    if (step.status >= 400) {
      const code = (res.body as { error?: unknown } | null)?.error;
      if (res.status !== step.status || code !== step.error)
        fail(
          `${label}: expected HTTP ${step.status} ${step.error}, got ${res.status} ${JSON.stringify(res.body)}`,
        );
      return;
    }
    if (res.status < 200 || res.status > 201) {
      fail(`${label}: HTTP ${res.status} ${JSON.stringify(res.body)}`);
      return;
    }
    const answer = schemas.response.safeParse(res.body);
    if (!answer.success) {
      fail(`${label}: answer outside the contract: ${issues(answer.error)}`);
      return;
    }
    if (isPending(answer.data)) {
      fail(`${label}: still pending after ${pending} tries`);
      return;
    }
    const expected = step.expect ?? 'recorded';
    if (expected === 'recorded') {
      const want = recorded(route);
      if (want === undefined) fail(`${label}: the script records no answer for ${route}`);
      else for (const line of diffRecorded(want, answer.data, label)) fail(line);
    } else {
      for (const line of matchSubset(expected, answer.data, label)) fail(line);
    }
    remember(route, answer.data, vars);
  }
}
