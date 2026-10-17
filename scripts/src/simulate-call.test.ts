import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  EndCallRequestSchema,
  VOICE_API_ERRORS,
  VOICE_ROUTES,
  VOICE_TOOL_SCHEMAS,
  type VoiceTool,
} from '@sitelog/shared';
import { diffRecorded, isPending, matchSubset } from './call-sim/match.ts';
import {
  defaultEndCall,
  recordedAnswers,
  resolveVars,
  runCallScript,
  type Arranged,
  type SimStack,
  type VoiceHttp,
} from './call-sim/run.ts';
import {
  SIM_FLOWS,
  listSimScripts,
  loadCallScript,
  parseCallScript,
  simTags,
  type SimScript,
} from './call-sim/script.ts';
import { refuseTarget, sqlSimStack, transcriptSegments, type Query } from './call-sim/stack.ts';
import { CALLS_DIR, FIXTURES_DIR, dotenvValue, parseSimArgs, simEnv } from './simulate-call.ts';

/**
 * W3-15: the call simulator's own tests (no stack): the scripts in fixtures/calls parse and cover
 * the suite (spec §10.13, §16.2 M7: ≥ 10 scripted calls, EN and ES, the number and Talk now; the
 * ticket's ten kinds of call), every recorded answer is the contract's, and each script passes
 * against field-api answering what it recorded, while a wrong answer, a slow turn and a refusal
 * are each reported as the runner should.
 */

const scripts = listSimScripts(CALLS_DIR);
const segments = transcriptSegments(FIXTURES_DIR);
const TOKEN = 'A'.repeat(43);

/** field-api answering a script's recorded answers in order (pending ones as HTTP 202). */
function recordedHttp(
  script: SimScript,
  tamper?: (route: string, body: unknown) => unknown,
): VoiceHttp & { seen: Array<{ route: string; body: Record<string, unknown> }> } {
  const queues = new Map<string, unknown[]>();
  for (const [route, answers] of Object.entries(script.routes)) queues.set(route, [...answers]);
  const errors = [...script.queue];
  const seen: Array<{ route: string; body: Record<string, unknown> }> = [];
  const routeOf = (path: string) =>
    Object.entries(VOICE_ROUTES).find(([, r]) => r.path === path)?.[0] ?? path;
  return {
    seen,
    async post(path, body) {
      const route = routeOf(path);
      seen.push({ route, body: body as Record<string, unknown> });
      if (route === 'calls_start')
        return { status: 200, body: { ...script.start.response, callToken: TOKEN } };
      const err = errors.findIndex((e) => e.route === route);
      if (err >= 0) {
        const [e] = errors.splice(err, 1);
        return { status: e!.status, body: e!.body };
      }
      const list = queues.get(route) ?? [];
      const answer = list.length > 1 ? list.shift() : list[0];
      if (answer === undefined) return { status: 501, body: { error: 'no_fixture_answer' } };
      const out = tamper ? tamper(route, answer) : answer;
      return { status: isPending(out) ? 202 : 200, body: out };
    },
  };
}

function fakeStack(script: SimScript, failures: string[] = []): SimStack {
  const arranged: Arranged = {
    orgId: 'org',
    reporterId: script.simulate.arrange.caller === 'unknown' ? null : 'reporter',
    siteIds: Object.fromEntries(
      script.simulate.arrange.sites.map((s, i) => [
        s.key,
        `7c2e4a10-3b5d-4f6a-8e9b-0c1d2e3f4a${(0x50 + i).toString(16)}`,
      ]),
    ),
    start: script.start.request as Arranged['start'],
  };
  return {
    arrange: async () => arranged,
    check: async () => failures,
  };
}

const run = (script: SimScript, http: VoiceHttp, stack = fakeStack(script)) =>
  runCallScript(script, { http, stack, segments, sleep: async () => {} });

describe('the scripted calls (fixtures/calls)', () => {
  it('every call fixture parses; at least ten are scripts, one flow tag each', () => {
    const files = readdirSync(CALLS_DIR).filter((f) => f.endsWith('.json'));
    for (const f of files) expect(() => loadCallScript(join(CALLS_DIR, f)), f).not.toThrow();
    expect(scripts.length).toBeGreaterThanOrEqual(10);
    for (const s of scripts) {
      const tags = simTags(s);
      expect(tags).toHaveLength(2);
      expect(tags[0]).toMatch(/^@m[78]$/);
    }
  });

  it('cover EN and ES, the number and Talk now, M7 and M8, and every flow of the suite', () => {
    expect(new Set(scripts.map((s) => s.locale.slice(0, 2)))).toEqual(new Set(['en', 'es']));
    expect(new Set(scripts.map((s) => s.start.request.transport))).toEqual(
      new Set(['pstn', 'web']),
    );
    expect(new Set(scripts.map((s) => s.simulate.milestone))).toEqual(new Set(['m7', 'm8']));
    expect(new Set(scripts.map((s) => s.simulate.flow))).toEqual(new Set(SIM_FLOWS));
    // ES by phone and by Talk now.
    for (const transport of ['pstn', 'web'])
      expect(
        scripts.some((s) => s.locale === 'es-US' && s.start.request.transport === transport),
        transport,
      ).toBe(true);
  });

  it("cover the ticket's ten kinds of call", () => {
    const has = (pred: (s: SimScript) => boolean) => scripts.filter(pred).map((s) => s.id);
    const steps = (s: SimScript) => s.simulate.steps;
    const routes = (s: SimScript) => steps(s).map((x) => x.route as string);
    const kinds: Record<string, string[]> = {
      hero: has(
        (s) =>
          s.simulate.expect.report?.status === 'filed' &&
          routes(s).includes('update_draft') &&
          !routes(s).includes('record_answer'),
      ),
      question: has((s) => routes(s).includes('record_answer')),
      correction: has((s) => routes(s).includes('apply_correction')),
      noWork: has((s) =>
        steps(s).some((x) => x.route === 'set_day_status' && x.body.status === 'no_work'),
      ),
      weatherDay: has((s) =>
        steps(s).some((x) => x.route === 'set_day_status' && x.body.status === 'weather_day'),
      ),
      callback: has((s) => routes(s).includes('schedule_callback')),
      fallback: has((s) => routes(s).includes('start_fallback_recording')),
      unknownCaller: has((s) => s.simulate.arrange.caller === 'unknown'),
      hangUpBeforeYes: has(
        (s) =>
          s.simulate.expect.call.outcome === 'draft_saved' && !routes(s).includes('file_report'),
      ),
      twoSites: has((s) => s.simulate.arrange.sites.length > 1 && routes(s).includes('pick_site')),
    };
    for (const [kind, ids] of Object.entries(kinds)) expect(ids.length, kind).toBeGreaterThan(0);
  });

  it("every recorded answer is the contract's; every queued refusal a field-api error", () => {
    for (const s of scripts) {
      for (const [route, answers] of Object.entries(s.routes)) {
        const schemas = VOICE_TOOL_SCHEMAS[route as VoiceTool];
        expect(schemas, `${s.id} ${route}`).toBeDefined();
        for (const a of answers) {
          const r = schemas.response.safeParse(a);
          expect(r.success, `${s.id} ${route}: ${JSON.stringify(r.error?.issues)}`).toBe(true);
        }
      }
      for (const q of s.queue) {
        expect(q.status).toBeGreaterThanOrEqual(400);
        expect(VOICE_API_ERRORS).toContain((q.body as { error: string }).error);
      }
    }
  });

  it.each(scripts.map((s) => [s.id, s] as const))(
    '%s passes against field-api answering what it recorded',
    async (_id, script) => {
      const http = recordedHttp(script);
      const r = await run(script, http);
      expect(r.failures).toEqual([]);
      expect(r.callId).toBe(script.start.response.callId);
      // Every step was sent, each request the contract's (the runner checks), callId added.
      const tools = http.seen.filter((x) => x.route !== 'calls_start');
      expect(new Set(tools.map((x) => x.body.callId))).toEqual(new Set([r.callId]));
      expect(r.steps.map((x) => x.route)).toEqual(script.simulate.steps.map((x) => x.route));
    },
  );
});

describe('runCallScript', () => {
  const hero = scripts.find((s) => s.id === 'northgate-file-en')!;

  it('asks a pending turn again with the same body, then checks the answer', async () => {
    const http = recordedHttp(hero);
    const r = await run(hero, http);
    expect(r.failures).toEqual([]);
    // The recorded `pending` filing (W3-10) was asked again with the same words.
    const files = http.seen.filter((x) => x.route === 'file_report');
    expect(files.map((f) => f.body.utterance)).toEqual([
      'Sounds good, I guess.',
      'Yes, file it.',
      'Yes, file it.',
    ]);
    expect(r.steps.find((x) => x.route === 'file_report' && x.pending === 1)).toBeDefined();
    // file_report names the read-back's report and revision.
    expect(files[1]!.body).toMatchObject({
      reportId: 'a0a90000-0000-4000-8000-000000000001',
      draftRev: 1,
    });
  });

  it('reports a read-back that differs, with its path, and stops there', async () => {
    const http = recordedHttp(hero, (route, body) =>
      route === 'update_draft'
        ? { ...(body as object), readBack: "Here's what I've got: 13 on site. Shall I file it?" }
        : body,
    );
    const r = await run(hero, http);
    expect(r.failures).toHaveLength(1);
    expect(r.failures[0]).toMatch(
      /^step 2 update_draft\.readBack: expected "Here's what I've got: 14/,
    );
    expect(r.steps.map((s) => s.route)).toEqual(['get_context', 'update_draft']);
  });

  it('reports an answer outside the contract', async () => {
    const http = recordedHttp(hero, (route, body) =>
      route === 'update_draft' ? { ...(body as object), draftRev: 0 } : body,
    );
    const r = await run(hero, http);
    expect(r.failures[0]).toMatch(/answer outside the contract/);
  });

  it('fails a refusal the script did not expect, and one it expected that did not come', async () => {
    const http = recordedHttp(hero);
    const refusing: VoiceHttp = {
      post: async (path, body, token) =>
        path.endsWith('/get_context')
          ? { status: 403, body: { error: 'consent_required' } }
          : http.post(path, body, token),
    };
    const r = await run(hero, refusing);
    expect(r.failures).toEqual([`step 1 get_context: HTTP 403 {"error":"consent_required"}`]);

    const callback = scripts.find((s) => s.simulate.steps.some((x) => x.status === 400))!;
    const noRefusal = recordedHttp({ ...callback, queue: [] });
    const r2 = await run(callback, noRefusal);
    expect(r2.failures[0]).toMatch(/expected HTTP 400 not_available, got 501/);
  });

  it('gives up on a turn that stays pending', async () => {
    const pending: VoiceHttp = {
      post: async (path, body, token) =>
        path.endsWith('/update_draft')
          ? { status: 202, body: { status: 'pending', retryAfterMs: 1000 } }
          : recordedHttp(hero).post(path, body, token),
    };
    const r = await runCallScript(hero, {
      http: pending,
      stack: fakeStack(hero),
      segments,
      sleep: async () => {},
      maxPending: 3,
    });
    expect(r.failures).toEqual([
      'step 2 update_draft: HTTP 202 {"status":"pending","retryAfterMs":1000}',
    ]);
    expect(r.steps.at(-1)).toMatchObject({ route: 'update_draft', pending: 3 });
  });

  it("adds the stack's failures after the steps", async () => {
    const r = await run(
      hero,
      recordedHttp(hero),
      fakeStack(hero, ['report.status: expected filed, got awaiting_confirmation']),
    );
    expect(r.failures).toEqual(['report.status: expected filed, got awaiting_confirmation']);
  });

  it('checks calls/start: the reporter field-api found', async () => {
    const http: VoiceHttp = {
      post: async (path, body, token) =>
        path === '/voice/calls/start'
          ? {
              status: 200,
              body: {
                callId: hero.start.response.callId,
                callToken: TOKEN,
                reporter: { firstName: 'Kev', locale: 'en-US' },
              },
            }
          : recordedHttp(hero).post(path, body, token),
    };
    const r = await run(hero, http);
    expect(r.failures[0]).toBe('calls_start.reporter.firstName: expected "Kevin", got "Kev"');
  });
});

describe('the pieces', () => {
  it('resolveVars fills the call so far and refuses a value the call has not got yet', () => {
    const vars = {
      draft: {
        reportId: 'r',
        draftRev: 3,
        missing: [],
        question: { id: 'q', text: 't', choices: [] },
        readBack: null,
      },
      loadedReportId: null,
      confirmKey: 'k',
      correctionId: null,
      sites: { northgate: 's1' },
      segments: () => [{ start: 0, end: 1, text: 'x' }],
    };
    expect(
      resolveVars(
        {
          a: '$draft.reportId',
          b: '$draft.draftRev',
          c: ['$site.northgate', '$confirmKey'],
          d: '$segments',
          e: 'plain',
        },
        vars,
      ),
    ).toEqual({ a: 'r', b: 3, c: ['s1', 'k'], d: [{ start: 0, end: 1, text: 'x' }], e: 'plain' });
    expect(() => resolveVars('$loaded.reportId', vars)).toThrow(/no report from load_report yet/);
    expect(() => resolveVars('$site.hillcrest', vars)).toThrow(/no site "hillcrest"/);
  });

  it('recordedAnswers skips pending answers and repeats the last', () => {
    const next = recordedAnswers(hero());
    expect(next('file_report')).toEqual({ status: 'not_confirmed' });
    expect(next('file_report')).toMatchObject({ status: 'filed' });
    expect(next('file_report')).toMatchObject({ status: 'filed' });
    expect(next('pick_site')).toBeUndefined();
    function hero() {
      return scripts.find((s) => s.id === 'northgate-file-en')!;
    }
  });

  it("defaultEndCall is the contract's end_call, without a phone number", () => {
    for (const s of scripts) {
      const body = { callId: s.start.response.callId, outcome: 'abandoned', ...defaultEndCall(s) };
      expect(EndCallRequestSchema.safeParse(body).success, s.id).toBe(true);
      expect(JSON.stringify(body)).not.toMatch(/\+1555|555 01/);
    }
  });

  it('diffRecorded ignores ids but not their absence; matchSubset checks only what it names', () => {
    expect(
      diffRecorded({ reportId: 'a', draftRev: 1, n: 2 }, { reportId: 'b', draftRev: 4, n: 2 }),
    ).toEqual([]);
    expect(diffRecorded({ reportId: 'a' }, {})).toEqual(['$.reportId: missing']);
    expect(diffRecorded({ a: 1 }, { a: 1, extra: true })).toEqual([
      '$.extra: not expected, got true',
    ]);
    expect(diffRecorded({ q: null }, { q: { id: 'x' } })).toEqual([
      '$.q: expected null, got {"id":"x"}',
    ]);
    expect(matchSubset({ a: { b: 1 } }, { a: { b: 1, c: 2 }, d: 3 })).toEqual([]);
    expect(
      matchSubset({ s: [{ name: 'N' }] }, { s: [{ name: 'N', id: 'x' }, { name: 'H' }] }),
    ).toEqual(['$.s: expected 1 items, got 2: [{"name":"N","id":"x"},{"name":"H"}]']);
    expect(matchSubset({ siteId: null }, { siteId: 'x' })).toEqual([
      '$.siteId: expected null, got "x"',
    ]);
  });

  it('a script with an unknown variable, a missing site or a refusal without its code is refused', () => {
    const base = JSON.parse(
      JSON.stringify(scripts.find((s) => s.id === 'northgate-file-en')!),
    ) as Record<string, unknown> & {
      simulate: { steps: Array<Record<string, unknown>>; expect: Record<string, unknown> };
    };
    const bad = structuredClone(base);
    bad.simulate.steps[1]!.body = { segments: '$transcript' };
    expect(() => parseCallScript(bad, 'bad')).toThrow(/unknown variable \$transcript/);
    const site = structuredClone(base);
    site.simulate.expect.report = { site: 'pier9', status: 'filed' };
    expect(() => parseCallScript(site, 'site')).toThrow(/no site "pier9"/);
    const refusal = structuredClone(base);
    refusal.simulate.steps[0]!.status = 400;
    expect(() => parseCallScript(refusal, 'refusal')).toThrow(/a refusal names its error/);
  });

  it('parseSimArgs, simEnv and the local-only target', () => {
    expect(parseSimArgs(['--', 'fixtures/calls/a.json'])).toEqual({
      files: ['fixtures/calls/a.json'],
      all: false,
      live: false,
    });
    expect(parseSimArgs(['--all'])).toMatchObject({ all: true });
    expect(parseSimArgs(['--live', 'x.json'])).toMatchObject({ live: true });
    expect(() => parseSimArgs([])).toThrow(/--all/);
    expect(() => parseSimArgs(['--all', 'x.json'])).toThrow(/not both/);
    expect(() => parseSimArgs(['--fast'])).toThrow(/unknown argument --fast/);

    const fnEnv = 'APP_URL=http://localhost:5173\nVOICE_AGENT_TOOL_SECRET="dev-secret" # local\n';
    expect(dotenvValue(fnEnv, 'VOICE_AGENT_TOOL_SECRET')).toBe('dev-secret');
    expect(dotenvValue('X=1 # note', 'X')).toBe('1');
    expect(dotenvValue('X=', 'X')).toBeUndefined();
    expect(
      simEnv(
        { DB_URL: 'postgresql://p@127.0.0.1:54322/postgres', API_URL: 'http://127.0.0.1:54321' },
        fnEnv,
      ),
    ).toEqual({
      dbUrl: 'postgresql://p@127.0.0.1:54322/postgres',
      fieldApiUrl: 'http://127.0.0.1:54321/functions/v1/field-api',
      toolSecret: 'dev-secret',
    });
    expect(simEnv({ VOICE_AGENT_TOOL_SECRET: 'env' }, fnEnv).toolSecret).toBe('env');

    const local = 'http://127.0.0.1:54321/functions/v1/field-api';
    expect(refuseTarget('postgresql://p@127.0.0.1:54322/postgres', local)).toBeNull();
    expect(refuseTarget(undefined, local)).toMatch(/SUPABASE_DB_URL is not set/);
    expect(refuseTarget('postgresql://p@db.abc.supabase.co:5432/postgres', local)).toMatch(
      /not a local database/,
    );
    expect(
      refuseTarget(
        'postgresql://p@localhost:54322/postgres',
        'https://abc.supabase.co/functions/v1/field-api',
      ),
    ).toMatch(/not a local stack/);
  });
});

describe('sqlSimStack.check', () => {
  const callback = scripts.find((s) => s.id === 'northgate-callback-en')!;
  const arranged: Arranged = {
    orgId: 'o',
    reporterId: 'r',
    siteIds: { northgate: 's' },
    start: callback.start.request as Arranged['start'],
  };

  function fakeQuery(rows: {
    call: Record<string, unknown>;
    contactPref: string;
    reports?: unknown[];
  }): Query {
    return (async (text: string) => {
      if (text.includes('from calls where id')) return [rows.call];
      if (text.includes('from reporters where id')) return [{ contact_pref: rows.contactPref }];
      if (text.includes('from reports r join site_days')) return rows.reports ?? [];
      return [];
    }) as Query;
  }
  const ended = {
    outcome: 'abandoned',
    fallback: null,
    reporter_id: 'r',
    started_at: '2026-10-16T15:00:00Z',
    ended_at: '2026-10-16T15:02:00Z',
  };

  it('passes when the call left what the script expects', async () => {
    const stack = sqlSimStack({ q: fakeQuery({ call: ended, contactPref: 'link' }), waitMs: 0 });
    expect(await stack.check(callback, { callId: 'c', arranged })).toEqual([]);
  });

  it('names each difference', async () => {
    const stack = sqlSimStack({
      q: fakeQuery({
        call: { ...ended, outcome: 'draft_saved' },
        contactPref: 'call',
        reports: [{ status: 'awaiting_confirmation' }],
      }),
      waitMs: 0,
    });
    expect(await stack.check(callback, { callId: 'c', arranged })).toEqual([
      'call.outcome: expected abandoned, got draft_saved',
      'report: expected none, got awaiting_confirmation',
      'reporter.contactPref: expected link, got call',
    ]);
  });
});
