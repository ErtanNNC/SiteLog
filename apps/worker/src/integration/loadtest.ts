/**
 * Load test (§16.2 M9: "500 reports in 30 min through the worker"; §15.1: upload → draft within
 * 60 s p50 / 150 s p95, the v1.2 target from W1-12; v1.0 quoted 90 s / 180 s). The reports are
 * WhatsApp voice notes until step 22 moves the load test to the web recorder.
 *
 *   pnpm loadtest                                          # 500 reports over 30 min, PGlite, scale 0.02
 *   pnpm loadtest -- --reports 50 --time-scale 0.05        # a quick run
 *   pnpm loadtest -- --instances 3 --concurrency 4         # three worker containers × 4 slots
 *   DATABASE_URL=postgres://postgres:postgres@127.0.0.1:54322/postgres pnpm loadtest -- --instances 2
 *
 * What runs for real: the webhook ingest (src/integration/webhook.ts, the edge function's logic),
 * the worker's runner loop (createRunner().start(): claim_jobs → runJob), every job handler, the
 * router, PDF rendering and every SQL statement. What is faked (src/integration/fakes.ts): Meta,
 * OpenAI, Claude, Storage, the email provider and ffmpeg, each with a sampled latency.
 *
 * Time scale: every simulated latency, the reporters' think time, the arrival window and the poll
 * interval are multiplied by --time-scale, and the worker runs on a virtual clock that goes
 * 1/scale times faster than the wall clock, so timings print as scale-1 seconds. Real CPU and
 * database time are NOT scaled; in virtual time they are stretched by 1/scale, so the virtual
 * latencies are an upper bound (a pessimistic run). The "at scale 1" projection removes that
 * stretch: slot-seconds per report = real job time − simulated waits + simulated waits / scale.
 *
 * Run it against a scratch database: it creates its own org ("Load test …", removed at the end
 * unless --keep), but the runner claims every due job in the queue and runs one timeout sweep at
 * start, like a real worker.
 */
import { writeFileSync } from 'node:fs';
import type { Sql } from 'postgres';
import { deadlineInstant, type SiteDayWeather } from '@sitelog/shared';
import { connectDb, connectSql, type Db } from '../db';
import { createLogger, silentLogger } from '../log';
import { createRunner, type Runner } from '../runner';
import { startPgliteDatabase, type PgliteDatabase } from '../test/pglite';
import {
  createSim,
  fakeWeatherFetch,
  loadFixtureLibrary,
  openMeteoResponse,
  REALISTIC_LATENCY,
  scaledClock,
  sleep,
  type LatencyProfile,
  type Range,
  type WaEvent,
} from './fakes';
import { buttonReplyPayload, readdress, textPayload, webhookFixture } from './webhook';
import { createWorld } from './world';

/** §15.1: web upload → draft on screen, seconds (W1-12; v1.0 had 90 / 180). */
export const DRAFT_TARGET_S = { p50: 60, p95: 150 } as const;

const TZ = 'America/Chicago';

export interface LoadTestOptions {
  reports: number;
  /** Arrival window, virtual minutes (0 = all at once). */
  windowMin: number;
  timeScale: number;
  instances: number;
  concurrency: number;
  /** Worker poll interval at scale 1 (POLL_INTERVAL_MS). */
  pollMs: number;
  /** Reporter reaction time to a question / draft, seconds. */
  think: Range;
  /** A photo follows the voice note after this many seconds; null = no photo. */
  photoDelay: Range | null;
  latency: LatencyProfile;
  failRate: number;
  cases: string[];
  seed: number;
  date: string;
  /** Give up this many virtual minutes after the last arrival. */
  timeoutMin: number;
  databaseUrl: string | null;
  keep: boolean;
  json: string | null;
  verbose: boolean;
}

export const DEFAULTS: LoadTestOptions = {
  reports: 500,
  windowMin: 30,
  timeScale: 0.02,
  instances: 1,
  concurrency: 4,
  pollMs: 1000,
  think: [10, 45],
  photoDelay: [0, 40],
  latency: REALISTIC_LATENCY,
  failRate: 0,
  cases: [],
  seed: 1,
  date: '2026-10-13',
  timeoutMin: 60,
  databaseUrl: null,
  keep: false,
  json: null,
  verbose: false,
};

const USAGE = `usage: pnpm loadtest -- [options]
  --reports N            reports to push (default 500)
  --window MIN           arrival window in minutes, 0 = burst (default 30)
  --time-scale S         wall-clock seconds per simulated second (default 0.02)
  --instances I          worker instances (default 1)
  --concurrency C        WORKER_CONCURRENCY per instance (default 4)
  --poll-ms MS           POLL_INTERVAL_MS at scale 1 (default 1000)
  --think A-B            reporter reaction time, s (default 10-45)
  --photo-delay A-B      photo after the voice note, s (default 0-40); --no-photo to skip
  --transcribe A-B       transcription of a 3-min note, s (default 8-20)
  --claude A-B           extraction call, s (default 12-35)
  --claude-fast A-B      classify / parse calls, s (default 0.8-2.5)
  --wa A-B --media A-B --email A-B --storage A-B   other external latencies, s
  --fail-rate F          probability an external call fails transiently (default 0)
  --cases a,b            golden cases to use (id substrings; default: every single-note case)
  --seed N  --date YYYY-MM-DD  --timeout MIN  --json FILE  --verbose
  --database-url URL     use this Postgres instead of PGlite (or set DATABASE_URL); --keep keeps the org`;

function range(v: string | undefined, flag: string): Range {
  const m = /^(\d+(?:\.\d+)?)(?:-(\d+(?:\.\d+)?))?$/.exec(v ?? '');
  if (!m) throw new Error(`${flag} expects A or A-B (seconds), got "${v}"`);
  const a = Number(m[1]);
  return [a, m[2] ? Number(m[2]) : a];
}

function num(v: string | undefined, flag: string): number {
  const n = Number(v);
  if (v === undefined || !Number.isFinite(n) || n < 0) throw new Error(`${flag} expects a number`);
  return n;
}

export function parseArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): LoadTestOptions {
  const o: LoadTestOptions = {
    ...DEFAULTS,
    latency: { ...DEFAULTS.latency },
    databaseUrl: env.DATABASE_URL || null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const next = () => argv[++i];
    switch (a) {
      case '--':
        break;
      case '--reports':
        o.reports = Math.max(1, Math.round(num(next(), a)));
        break;
      case '--window':
        o.windowMin = num(next(), a);
        break;
      case '--time-scale':
        o.timeScale = num(next(), a);
        if (o.timeScale <= 0 || o.timeScale > 1) throw new Error('--time-scale must be in (0, 1]');
        break;
      case '--instances':
        o.instances = Math.max(1, Math.round(num(next(), a)));
        break;
      case '--concurrency':
        o.concurrency = Math.max(1, Math.round(num(next(), a)));
        break;
      case '--poll-ms':
        o.pollMs = num(next(), a);
        break;
      case '--think':
        o.think = range(next(), a);
        break;
      case '--photo-delay':
        o.photoDelay = range(next(), a);
        break;
      case '--no-photo':
        o.photoDelay = null;
        break;
      case '--transcribe':
      case '--claude':
      case '--media':
      case '--wa':
      case '--email':
      case '--storage': {
        const key = a.slice(2) as keyof LatencyProfile;
        o.latency[key] = range(next(), a);
        break;
      }
      case '--claude-fast':
        o.latency.claudeFast = range(next(), a);
        break;
      case '--fail-rate':
        o.failRate = num(next(), a);
        break;
      case '--cases':
        o.cases = (next() ?? '').split(',').filter(Boolean);
        break;
      case '--seed':
        o.seed = num(next(), a);
        break;
      case '--date':
        o.date = next() ?? o.date;
        if (!/^\d{4}-\d{2}-\d{2}$/.test(o.date)) throw new Error('--date expects YYYY-MM-DD');
        break;
      case '--timeout':
        o.timeoutMin = num(next(), a);
        break;
      case '--database-url':
        o.databaseUrl = next() ?? null;
        break;
      case '--keep':
        o.keep = true;
        break;
      case '--json':
        o.json = next() ?? null;
        break;
      case '--verbose':
        o.verbose = true;
        break;
      case '--help':
      case '-h':
        console.log(USAGE);
        process.exit(0);
        break;
      default:
        throw new Error(`unknown option ${a}\n${USAGE}`);
    }
  }
  return o;
}

// ───────────────────────────── Setup ─────────────────────────────

interface LoadSite {
  index: number;
  siteId: string;
  phone: string;
  recipient: string;
}

const FIRST_NAMES = ['Marco', 'Priya', 'Jorge', 'Dana', 'Luis', 'Kim', 'Tomasz', 'Aisha', 'Sam'];

/** A dedicated org with N single-reporter sites, the golden cases' companies and idle conversations. */
async function createLoadOrg(
  sql: Sql,
  o: LoadTestOptions,
  runId: string,
  companies: Array<{ name: string; trade: string | null; aliases: string[]; selfPerform: boolean }>,
): Promise<{ orgId: string; sites: LoadSite[] }> {
  const [org] = await sql<Array<{ id: string }>>`
    insert into orgs (name, timezone, billing_status) values (${`Load test ${runId}`}, ${TZ}, 'active')
    returning id`;
  const orgId = org!.id;
  await sql`insert into companies ${sql(
    companies.map((c) => ({
      org_id: orgId,
      name: c.name,
      trade: c.trade,
      aliases: c.aliases,
      is_self_perform: c.selfPerform,
      status: 'confirmed',
    })),
  )} on conflict (org_id, name) do nothing`;

  // Phones: a block of +1555xxxxxxx numbers no conversation uses yet.
  let base = 2_000_000 + Math.floor(Math.random() * 7_000_000);
  for (let attempt = 0; ; attempt++) {
    const phones = Array.from({ length: o.reports }, (_, i) => phoneAt(base, i));
    const [hit] = await sql<Array<{ n: number }>>`
      select count(*)::int as n from conversations where phone_e164 = any(${sql.array(phones)}::text[])`;
    if (hit!.n === 0) break;
    if (attempt > 20) throw new Error('could not find a free phone block');
    base = 2_000_000 + Math.floor(Math.random() * 7_000_000);
  }

  const sites: LoadSite[] = [];
  const BATCH = 250;
  for (let start = 0; start < o.reports; start += BATCH) {
    const idx = Array.from({ length: Math.min(BATCH, o.reports - start) }, (_, k) => start + k);
    const siteRows = await sql<Array<{ id: string; project_code: string }>>`
      insert into sites ${sql(
        idx.map((i) => ({
          org_id: orgId,
          name: `Load Site ${pad(i + 1)}`,
          project_code: `LT-${pad(i + 1)}`,
          address: 'Austin, TX',
          lat: 30.26,
          lng: -97.74,
          timezone: TZ,
          active_since: o.date,
        })),
      )} returning id, project_code`;
    const siteByCode = new Map(siteRows.map((s) => [s.project_code, s.id]));
    const reporterRows = await sql<Array<{ id: string; phone_e164: string }>>`
      insert into reporters ${sql(
        idx.map((i) => ({
          org_id: orgId,
          name: `${FIRST_NAMES[i % FIRST_NAMES.length]} Tester${pad(i + 1)}`,
          phone_e164: phoneAt(base, i),
          role: 'site_manager',
          languages: ['en', 'es'],
          status: 'active',
          verified_at: new Date().toISOString(),
        })),
      )} returning id, phone_e164`;
    const reporterByPhone = new Map(reporterRows.map((r) => [r.phone_e164, r.id]));
    const rows = idx.map((i) => ({
      index: i,
      siteId: siteByCode.get(`LT-${pad(i + 1)}`)!,
      reporterId: reporterByPhone.get(phoneAt(base, i))!,
      phone: phoneAt(base, i),
      recipient: `office+${pad(i + 1)}@loadtest.example`,
    }));
    await sql`insert into site_reporters ${sql(
      rows.map((r) => ({ site_id: r.siteId, reporter_id: r.reporterId, is_primary: true })),
    )}`;
    await sql`insert into site_recipients ${sql(
      rows.map((r) => ({ site_id: r.siteId, email: r.recipient })),
    )}`;
    await sql`insert into conversations ${sql(
      rows.map((r) => ({
        org_id: orgId,
        reporter_id: r.reporterId,
        phone_e164: r.phone,
        state: 'idle',
        context: sql.json({}),
      })),
    )}`;
    for (const r of rows)
      sites.push({ index: r.index, siteId: r.siteId, phone: r.phone, recipient: r.recipient });
  }
  return { orgId, sites };
}

function phoneAt(base: number, i: number): string {
  return `+1555${String(base + i).padStart(7, '0')}`;
}

function pad(n: number): string {
  return String(n).padStart(4, '0');
}

// ───────────────────────────── Per-report tracking ─────────────────────────────

interface Track {
  site: LoadSite;
  caseId: string;
  /** Virtual ms. */
  receivedAt: number | null;
  ackAt: number | null;
  firstReplyAt: number | null;
  draftAt: number | null;
  okAt: number | null;
  pdfAt: number | null;
  emailAt: number | null;
  questions: string[];
  drafts: number;
  /** Buttons we did not know how to answer (e.g. a which-day or weather follow-up prompt). */
  unhandled: string[];
  /** "Got the photos. Send a quick voice note…" received after the voice note was delivered. */
  photosOnly: number;
  errors: string[];
}

export interface Percentiles {
  n: number;
  p50: number | null;
  p95: number | null;
  max: number | null;
}

export function percentiles(values: number[]): Percentiles {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  const at = (p: number) =>
    v.length ? v[Math.min(v.length - 1, Math.ceil(p * v.length) - 1)]! : null;
  return { n: v.length, p50: at(0.5), p95: at(0.95), max: v.length ? v[v.length - 1]! : null };
}

// ───────────────────────────── Run ─────────────────────────────

export interface LoadTestResult {
  options: Omit<LoadTestOptions, 'databaseUrl'> & { database: 'pglite' | 'postgres' };
  wallSeconds: number;
  /** The run hit --timeout before every site-day closed. */
  timedOut: boolean;
  reports: {
    pushed: number;
    /** site_days.status per site at the end: filed, weather_day, no_work, processing, … */
    siteDays: Record<string, number>;
    /** Site-days that reached filed / weather_day / no_work. */
    closed: number;
    /** Daily reports filed after the reporter's OK. */
    filedByConfirm: number;
    notClosed: Array<{ site: string; case: string; status: string | null; notes: string[] }>;
    withQuestions: number;
    questionsByField: Record<string, number>;
    /** extract_report jobs (Claude extraction calls) per report. */
    extractionsPerReport: number;
    /**
     * Intake races: site-days that got more than one (non-void) report, and reporters told "Got the
     * photos. Send a quick voice note…" although their voice note had been delivered.
     */
    siteDaysWithSeveralReports: number;
    photosOnlyAfterVoiceNote: number;
    /** Extraction requests with neither a transcript nor a text (every report here has a voice note). */
    extractionsWithoutTranscript: number;
    needsReview: number;
    byCase: Record<
      string,
      { pushed: number; closed: number; questions: number; outcomes: Record<string, number> }
    >;
    /**
     * Golden cases whose reports ended in different site-day statuses (e.g. some filed, some logged
     * as a weather day). Each case replays the same transcript, so a mix means a race decided it.
     */
    inconsistentCases: Array<{ case: string; outcomes: Record<string, number> }>;
  };
  latencySeconds: {
    ack: Percentiles;
    firstResponse: Percentiles;
    draftNoQuestion: Percentiles;
    draftAll: Percentiles;
    confirmToPdf: Percentiles;
    confirmToEmail: Percentiles;
    receivedToFiled: Percentiles;
  };
  throughput: { closedPerWallMinute: number; closedPerVirtualMinute: number };
  jobs: {
    total: number;
    byType: Record<
      string,
      { n: number; retries: number; dead: number; runMsP50: number | null; runMsP95: number | null }
    >;
    retries: number;
    dead: number;
    pendingRetry: number;
    errors: Record<string, number>;
    maxQueued: number;
    maxRunning: number;
  };
  external: { calls: Record<string, number>; failures: Record<string, number> };
  projection: {
    slots: number;
    slotSecondsPerReportAtScale1: number;
    realMsPerReport: number;
    reportsPer30MinAtScale1: number;
    slotsFor500In30Min: number;
    slotsFor500In30MinAt70Pct: number;
    meets500In30Min: boolean;
    meetsDraftTargets: boolean;
  };
  privacy: { phoneLeaksToClaude: number };
}

export async function runLoadTest(
  o: LoadTestOptions,
  out: (line: string) => void = console.log,
): Promise<LoadTestResult> {
  // Letters only: digit runs in names reach prompts (the org's self-perform company name goes into
  // the transcription vocabulary) and would trip the phone-number guard of the fakes.
  const runId = Array.from({ length: 6 }, () =>
    String.fromCharCode(97 + Math.floor(Math.random() * 26)),
  ).join('');
  const scale = o.timeScale;
  const lib = loadFixtureLibrary(o.cases);
  if (lib.ids.length === 0) throw new Error(`no single-voice-note golden case matches ${o.cases}`);

  // Database: PGlite (one shared connection) or a real Postgres (one pool per instance).
  let pglite: PgliteDatabase | null = null;
  let adminSql: Sql;
  const instanceDbs: Db[] = [];
  if (o.databaseUrl) {
    adminSql = connectSql(o.databaseUrl, { max: 4 });
    for (let k = 0; k < o.instances; k++)
      instanceDbs.push(connectDb(o.databaseUrl, { max: o.concurrency + 2 }));
  } else {
    out('booting PGlite (migrations)…');
    pglite = await startPgliteDatabase({ seed: false });
    adminSql = pglite.sql;
    for (let k = 0; k < o.instances; k++) instanceDbs.push(pglite.db);
  }

  const companies = new Map<
    string,
    { name: string; trade: string | null; aliases: string[]; selfPerform: boolean }
  >();
  for (const id of lib.ids) {
    for (const c of lib.get(id).fixture.input.companies)
      companies.set(c.name, {
        name: c.name,
        trade: c.trade ?? null,
        aliases: c.aliases,
        selfPerform: !!c.isSelfPerform,
      });
  }
  out(`creating org with ${o.reports} sites / reporters…`);
  const { orgId, sites } = await createLoadOrg(adminSql, o, runId, [...companies.values()]);
  const [mark] = await adminSql<Array<{ id: number | null }>>`select max(id)::int as id from jobs`;
  const jobMark = mark?.id ?? 0;

  // Nothing may reach the network: Open-Meteo answers from a fixture, anything else throws.
  const weatherCase = lib.get(lib.ids[0]!).fixture.input.observedWeather;
  const realFetch = globalThis.fetch;
  globalThis.fetch = fakeWeatherFetch(
    openMeteoResponse(o.date, (weatherCase ?? { hours: [] }) as unknown as SiteDayWeather),
  ) as typeof fetch;

  const start = deadlineInstant(o.date, '12:30', TZ); // after noon: no "today or yesterday?" prompt
  const clock = scaledClock(start, scale);
  const sim = createSim({ scale, profile: o.latency, seed: o.seed, failRate: o.failRate });
  const log = o.verbose ? createLogger({ service: 'loadtest' }, { level: 'error' }) : silentLogger;
  const world = createWorld({
    db: instanceDbs[0]!,
    sql: adminSql,
    clock,
    sim,
    lib,
    log,
  });
  const emailAt = new Map<string, number>();
  const baseEmail = world.ctx.email;
  world.ctx.email = {
    name: baseEmail.name,
    async send(m) {
      const res = await baseEmail.send(m);
      for (const to of m.to) emailAt.set(to, clock.now().getTime());
      return res;
    },
  };

  // Reporters ------------------------------------------------------------------------------------
  const rng = sim.rng;
  const sample = ([a, b]: Range) => a + (b - a) * rng();
  const tracks = sites.map<Track>((site) => ({
    site,
    caseId: lib.ids[site.index % lib.ids.length]!,
    receivedAt: null,
    ackAt: null,
    firstReplyAt: null,
    draftAt: null,
    okAt: null,
    pdfAt: null,
    emailAt: null,
    questions: [],
    drafts: 0,
    unhandled: [],
    photosOnly: 0,
    errors: [],
  }));
  const byPhone = new Map(tracks.map((t) => [t.site.phone, t]));
  let pending = 0;
  let wamidSeq = 0;
  const wamid = (t: Track) => `wamid.lt.${runId}.${t.site.index}.${++wamidSeq}`;
  /** Run `fn` after `seconds` of virtual time. */
  const later = (seconds: number, t: Track, fn: () => Promise<unknown>) => {
    pending++;
    setTimeout(
      () => {
        fn()
          .catch((err: unknown) => t.errors.push(err instanceof Error ? err.message : String(err)))
          .finally(() => pending--);
      },
      Math.max(0, seconds * 1000 * scale),
    );
  };
  const deliverChecked = async (t: Track, payload: Parameters<typeof world.deliver>[0]) => {
    const res = await world.deliver(payload);
    if (res.status !== 200 || res.body.failed)
      t.errors.push(`webhook ${res.status} ${JSON.stringify(res.body)}`);
    return res;
  };
  const sendPhoto = (t: Track) => {
    const mediaId = `lt-${runId}-${t.site.index}-photo-${++wamidSeq}`;
    world.registerPhoto(mediaId);
    return deliverChecked(
      t,
      readdress(webhookFixture('image-with-caption.json'), {
        from: t.site.phone,
        id: wamid(t),
        at: clock.now(),
        mediaId,
      }),
    );
  };
  const press = (t: Track, button: { id: string; title: string }, contextId: string | null) =>
    deliverChecked(
      t,
      buttonReplyPayload(button, { from: t.site.phone, id: wamid(t), at: clock.now(), contextId }),
    );

  world.wa.onSend = (e: WaEvent) => {
    const t = byPhone.get(e.to);
    if (!t) return;
    const at = e.at.getTime();
    if (e.kind === 'document') {
      t.pdfAt ??= at;
      return;
    }
    if (e.kind === 'text') {
      if (/^Got it, /.test(e.body ?? '')) t.ackAt ??= at;
      if (/^Got the photos\./.test(e.body ?? '') && t.receivedAt !== null) t.photosOnly++;
      if (/^Tell me in a voice note or text/.test(e.body ?? ''))
        later(sample(o.think), t, () =>
          deliverChecked(
            t,
            textPayload('5 guys, full day', { from: t.site.phone, id: wamid(t), at: clock.now() }),
          ),
        );
      return;
    }
    if (e.kind !== 'buttons' || !e.buttons) return;
    const ok = e.buttons.find((b) => /^draft:.+:ok$/.test(b.id));
    if (ok) {
      t.draftAt ??= at;
      t.firstReplyAt ??= at;
      t.drafts++;
      later(sample(o.think), t, async () => {
        t.okAt = clock.now().getTime();
        await press(t, ok, e.waMessageId);
      });
      return;
    }
    const options = e.buttons.filter((b) => b.id.startsWith('q:'));
    if (options.length) {
      t.firstReplyAt ??= at;
      t.questions.push(e.body ?? '');
      if (/photo/i.test(e.body ?? '')) {
        later(sample(o.think), t, () => sendPhoto(t));
      } else {
        const pick = options.find((b) => !b.id.endsWith(':other')) ?? options[0]!;
        later(sample(o.think), t, () => press(t, pick, e.waMessageId));
      }
      return;
    }
    t.unhandled.push(e.buttons.map((b) => b.title).join(' / '));
  };

  // Arrivals ---------------------------------------------------------------------------------------
  const windowS = o.windowMin * 60;
  const offsets = tracks.map(() => rng() * windowS).sort((a, b) => a - b);
  tracks.forEach((t, i) => {
    const c = lib.get(t.caseId);
    const mediaId = `lt-${runId}-${t.site.index}-audio`;
    world.registerVoiceNote(mediaId, c.id, Math.max(c.durationS, 150));
    later(offsets[i]!, t, async () => {
      t.receivedAt = clock.now().getTime();
      await deliverChecked(
        t,
        readdress(webhookFixture('audio-note.json'), {
          from: t.site.phone,
          id: wamid(t),
          at: clock.now(),
          mediaId,
        }),
      );
      if (o.photoDelay) later(sample(o.photoDelay), t, () => sendPhoto(t));
    });
  });

  // Workers --------------------------------------------------------------------------------------
  const runners: Runner[] = instanceDbs.map((db, k) =>
    createRunner(
      { ...world.ctx, db },
      {
        concurrency: o.concurrency,
        pollIntervalMs: Math.max(2, Math.round(o.pollMs * scale)),
        sweepIntervalMs: 24 * 3600_000, // timeouts run on DB wall-clock timestamps: off
        jobTimeoutMs: Math.max(30_000, Math.round(5 * 60_000 * scale)),
        workerId: `loadtest-${k}`,
      },
    ),
  );
  const wallStart = Date.now();
  for (const r of runners) r.start();
  out(
    `pushing ${o.reports} reports over ${o.windowMin} min (virtual) · scale ${scale} · ` +
      `${o.instances} instance(s) × ${o.concurrency} · ${pglite ? 'PGlite' : 'Postgres'} · cases: ${lib.ids.length}`,
  );

  // Wait until every reporter is done and the queue is idle (or the timeout).
  let maxQueued = 0;
  let maxRunning = 0;
  let idleChecks = 0;
  let lastProgress = 0;
  let timedOut = false;
  const deadline = start.getTime() + (windowS + o.timeoutMin * 60) * 1000;
  for (;;) {
    await sleep(200);
    const q = await instanceDbs[0]!.queueStats();
    maxQueued = Math.max(maxQueued, q.queued);
    maxRunning = Math.max(maxRunning, q.running);
    const active = runners.reduce((a, r) => a + r.active, 0);
    const done = tracks.filter((t) => t.pdfAt !== null).length;
    if (Date.now() - lastProgress > 10_000) {
      lastProgress = Date.now();
      out(
        `  virtual ${clock.now().toISOString().slice(11, 19)}Z · delivered PDFs ${done}/${o.reports} · queued ${q.queued} · running ${q.running}`,
      );
    }
    const allArrived = tracks.every((t) => t.receivedAt !== null);
    if (allArrived && pending === 0 && q.queued === 0 && q.running === 0 && active === 0) {
      if (++idleChecks >= 3) break;
    } else idleChecks = 0;
    if (clock.now().getTime() > deadline) {
      out('  timeout reached; stopping');
      timedOut = true;
      break;
    }
  }
  await Promise.all(runners.map((r) => r.stop()));
  const wallSeconds = (Date.now() - wallStart) / 1000;

  // Results ----------------------------------------------------------------------------------------
  for (const t of tracks) t.emailAt = emailAt.get(t.site.recipient) ?? null;
  const reports = await adminSql<
    Array<{
      site_id: string;
      status: string;
      kind: string;
      filed_at: string | null;
      confirmed_at: string | null;
      needs_review: boolean;
    }>
  >`select site_id, status::text as status, kind, filed_at, confirmed_at, needs_review
    from reports where org_id = ${orgId} and status <> 'void'
    order by status in ('filed', 'signed_off'), created_at`; // the filed one wins in reportBySite
  const reportBySite = new Map(reports.map((r) => [r.site_id, r]));
  const reportsPerSite = new Map<string, number>();
  for (const r of reports) reportsPerSite.set(r.site_id, (reportsPerSite.get(r.site_id) ?? 0) + 1);
  const siteDayRows = await adminSql<Array<{ site_id: string; status: string }>>`
    select sd.site_id, sd.status::text as status from site_days sd join sites s on s.id = sd.site_id
    where s.org_id = ${orgId}`;
  const dayBySite = new Map(siteDayRows.map((d) => [d.site_id, d.status]));
  const CLOSED = new Set(['filed', 'weather_day', 'no_work']);
  const isClosed = (t: Track) => CLOSED.has(dayBySite.get(t.site.siteId) ?? '');
  const siteDays: Record<string, number> = {};
  for (const t of tracks) {
    const st = dayBySite.get(t.site.siteId) ?? 'none';
    siteDays[st] = (siteDays[st] ?? 0) + 1;
  }
  const questionRows = await adminSql<Array<{ field: string; n: number }>>`
    select q.field, count(*)::int as n from questions q join reports r on r.id = q.report_id
    where r.org_id = ${orgId} group by q.field order by q.field`;
  // Every job of the run, attributed to its site (reportId → report, messageId → reporter → site).
  const jobs = await adminSql<
    Array<{
      type: string;
      status: string;
      attempts: number;
      last_error: string | null;
      latency_ms: number | null;
      site_id: string | null;
    }>
  >`select j.type, j.status::text as status, j.attempts, j.last_error,
           (j.payload->'metrics'->>'latencyMs')::float8 as latency_ms,
           coalesce(r.site_id, sr.site_id) as site_id
    from jobs j
    left join reports r on r.id = case when j.payload->>'reportId' ~ '^[0-9a-f-]{36}$'
                                       then (j.payload->>'reportId')::uuid end
    left join messages m on r.id is null and m.id = case when j.payload->>'messageId' ~ '^[0-9a-f-]{36}$'
                                                         then (j.payload->>'messageId')::uuid end
    left join conversations c on c.id = m.conversation_id
    left join site_reporters sr on sr.reporter_id = c.reporter_id
    where j.id > ${jobMark}`;

  const sec = (a: number | null, b: number | null) =>
    a !== null && b !== null ? (b - a) / 1000 : NaN;
  const filed = reports.filter((r) => r.status === 'filed' || r.status === 'signed_off');
  const closed = tracks.filter(isClosed).length;
  const byCase: LoadTestResult['reports']['byCase'] = {};
  for (const t of tracks) {
    const c = (byCase[t.caseId] ??= { pushed: 0, closed: 0, questions: 0, outcomes: {} });
    c.pushed++;
    if (isClosed(t)) c.closed++;
    c.questions += t.questions.length;
    const st = dayBySite.get(t.site.siteId) ?? 'none';
    c.outcomes[st] = (c.outcomes[st] ?? 0) + 1;
  }
  const notClosed = tracks
    .filter((t) => !isClosed(t))
    .map((t) => ({
      site: `LT-${pad(t.site.index + 1)}`,
      case: t.caseId,
      status: dayBySite.get(t.site.siteId) ?? null,
      notes: [
        `report ${reportBySite.get(t.site.siteId)?.status ?? 'none'}`,
        ...t.unhandled.map((u) => `unanswered buttons: ${u}`),
        ...t.errors,
      ],
    }));

  const byType: LoadTestResult['jobs']['byType'] = {};
  for (const j of jobs) {
    const b = (byType[j.type] ??= { n: 0, retries: 0, dead: 0, runMsP50: null, runMsP95: null });
    b.n++;
    b.retries += Math.max(0, j.attempts - 1);
    if (j.status === 'dead') b.dead++;
  }
  for (const [type, b] of Object.entries(byType)) {
    const p = percentiles(
      jobs.filter((j) => j.type === type && j.latency_ms !== null).map((j) => j.latency_ms!),
    );
    b.runMsP50 = p.p50 === null ? null : Math.round(p.p50);
    b.runMsP95 = p.p95 === null ? null : Math.round(p.p95);
  }
  const errors: Record<string, number> = {};
  for (const j of jobs) {
    if (!j.last_error) continue;
    const key = j.last_error.replace(/[0-9a-f-]{36}/g, '…').slice(0, 120);
    errors[key] = (errors[key] ?? 0) + 1;
  }

  // Projection to scale 1: a report holds a worker slot for its jobs' wall time; of that, the
  // simulated waits (share f of all job time) last 1/scale longer at scale 1 and the rest (CPU,
  // database) stays. Only the jobs of closed site-days count, so a run cut short by the timeout
  // still projects from complete reports.
  const jobMsTotal = jobs.reduce((a, j) => a + (j.latency_ms ?? 0), 0);
  const simShare = jobMsTotal > 0 ? Math.min(1, sim.stats.simulatedMs / jobMsTotal) : 0;
  const closedSites = new Set(tracks.filter(isClosed).map((t) => t.site.siteId));
  const closedJobMs = jobs
    .filter((j) => j.site_id && closedSites.has(j.site_id))
    .reduce((a, j) => a + (j.latency_ms ?? 0), 0);
  const completed = Math.max(1, closed);
  const realOverheadMs = closedJobMs * (1 - simShare);
  const slotSeconds = (realOverheadMs + (closedJobMs * simShare) / scale) / 1000 / completed;
  const slots = o.instances * o.concurrency;
  const per30 = (slots * 1800) / slotSeconds;
  const lat = {
    ack: percentiles(tracks.map((t) => sec(t.receivedAt, t.ackAt))),
    firstResponse: percentiles(tracks.map((t) => sec(t.receivedAt, t.firstReplyAt))),
    draftNoQuestion: percentiles(
      tracks.filter((t) => t.questions.length === 0).map((t) => sec(t.receivedAt, t.draftAt)),
    ),
    draftAll: percentiles(tracks.map((t) => sec(t.receivedAt, t.draftAt))),
    confirmToPdf: percentiles(tracks.map((t) => sec(t.okAt, t.pdfAt))),
    confirmToEmail: percentiles(tracks.map((t) => sec(t.okAt, t.emailAt))),
    receivedToFiled: percentiles(
      tracks.map((t) => {
        const r = reportBySite.get(t.site.siteId);
        return sec(t.receivedAt, r?.filed_at ? new Date(r.filed_at).getTime() : null);
      }),
    ),
  };
  const virtualMinutes = (clock.now().getTime() - start.getTime()) / 60_000;
  const { databaseUrl: _url, ...shown } = o;
  const result: LoadTestResult = {
    options: { ...shown, database: pglite ? 'pglite' : 'postgres' },
    wallSeconds,
    timedOut,
    reports: {
      pushed: o.reports,
      siteDays,
      closed,
      filedByConfirm: filed.filter((r) => r.confirmed_at).length,
      notClosed,
      withQuestions: tracks.filter((t) => t.questions.length > 0).length,
      questionsByField: Object.fromEntries(questionRows.map((q) => [q.field, q.n])),
      extractionsPerReport: jobs.filter((j) => j.type === 'extract_report').length / o.reports,
      siteDaysWithSeveralReports: [...reportsPerSite.values()].filter((n) => n > 1).length,
      photosOnlyAfterVoiceNote: tracks.filter((t) => t.photosOnly > 0).length,
      extractionsWithoutTranscript: world.claude.calls.filter((c) => c.noContent).length,
      needsReview: filed.filter((r) => r.needs_review).length,
      byCase,
      inconsistentCases: Object.entries(byCase)
        .filter(([, c]) => Object.keys(c.outcomes).length > 1)
        .map(([id, c]) => ({ case: id, outcomes: c.outcomes })),
    },
    latencySeconds: lat,
    throughput: {
      closedPerWallMinute: closed / (wallSeconds / 60),
      closedPerVirtualMinute: closed / Math.max(1e-9, virtualMinutes),
    },
    jobs: {
      total: jobs.length,
      byType,
      retries: jobs.reduce((a, j) => a + Math.max(0, j.attempts - 1), 0),
      dead: jobs.filter((j) => j.status === 'dead').length,
      pendingRetry: jobs.filter((j) => j.status === 'queued' && j.last_error).length,
      errors,
      maxQueued,
      maxRunning,
    },
    external: { calls: sim.stats.calls, failures: sim.stats.failures },
    projection: {
      slots,
      slotSecondsPerReportAtScale1: slotSeconds,
      realMsPerReport: realOverheadMs / completed,
      reportsPer30MinAtScale1: per30,
      slotsFor500In30Min: Math.ceil((500 * slotSeconds) / 1800),
      slotsFor500In30MinAt70Pct: Math.ceil((500 * slotSeconds) / 1800 / 0.7),
      meets500In30Min: per30 >= 500,
      meetsDraftTargets:
        (lat.firstResponse.p50 ?? Infinity) <= DRAFT_TARGET_S.p50 &&
        (lat.firstResponse.p95 ?? Infinity) <= DRAFT_TARGET_S.p95,
    },
    privacy: { phoneLeaksToClaude: world.claude.phoneLeaks.length },
  };

  if (o.databaseUrl && !o.keep) {
    await adminSql`delete from audit_log where org_id = ${orgId}`;
    await adminSql`delete from orgs where id = ${orgId}`;
  }
  if (pglite) await pglite.close();
  else {
    await adminSql.end({ timeout: 5 });
    await Promise.all(instanceDbs.map((d) => d.close()));
  }
  globalThis.fetch = realFetch;
  return result;
}

// ───────────────────────────── Report ─────────────────────────────

const f1 = (n: number | null) => (n === null || !Number.isFinite(n) ? '—' : n.toFixed(1));

export function formatResult(r: LoadTestResult): string {
  const o = r.options;
  const L = r.latencySeconds;
  const row = (name: string, p: Percentiles, target = '') =>
    `  ${name.padEnd(28)} ${String(p.n).padStart(5)} ${f1(p.p50).padStart(8)} ${f1(p.p95).padStart(8)} ${f1(p.max).padStart(8)}  ${target}`;
  const lines = [
    '',
    `SiteLog load test · ${o.reports} reports · window ${o.windowMin} min · scale ${o.timeScale} · ${o.instances}×${o.concurrency} slots · ${o.database}`,
    `  wall time ${r.wallSeconds.toFixed(1)} s · site-days closed ${r.reports.closed}/${r.reports.pushed} ` +
      `${JSON.stringify(r.reports.siteDays)} · filed after OK ${r.reports.filedByConfirm} · needs review ${r.reports.needsReview}`,
    ...(r.timedOut
      ? [
          `  STOPPED AT THE TIMEOUT (${o.timeoutMin} virtual min after the window): the worker did not keep up`,
        ]
      : []),
    `  throughput ${r.throughput.closedPerWallMinute.toFixed(1)} closed / wall min · ${r.throughput.closedPerVirtualMinute.toFixed(1)} / virtual min`,
    `  reports with questions ${r.reports.withQuestions} ${JSON.stringify(r.reports.questionsByField)} · ` +
      `extractions per report ${r.reports.extractionsPerReport.toFixed(2)}`,
    `  intake races: site-days with > 1 report ${r.reports.siteDaysWithSeveralReports} · ` +
      `"Got the photos…" after a delivered voice note ${r.reports.photosOnlyAfterVoiceNote} · ` +
      `extractions without the transcript ${r.reports.extractionsWithoutTranscript} · ` +
      `cases with mixed outcomes ${r.reports.inconsistentCases.length}`,
    ...r.reports.inconsistentCases.map((c) => `    ${c.case}: ${JSON.stringify(c.outcomes)}`),
    '',
    '  Latency (virtual s = scale-1 seconds;    n      p50      p95      max',
    '  real CPU/DB time stretched by 1/scale)',
    row('received → ack', L.ack, 'target < 5 s (F5)'),
    row(
      'received → question/draft',
      L.firstResponse,
      `target p50 ${DRAFT_TARGET_S.p50} / p95 ${DRAFT_TARGET_S.p95} (§15.1)`,
    ),
    row('received → draft (no question)', L.draftNoQuestion),
    row('received → draft (all)', L.draftAll, 'incl. question round trips'),
    row('OK → PDF on WhatsApp', L.confirmToPdf, 'target < 60 s (F7)'),
    row('OK → email sent', L.confirmToEmail, 'target < 120 s (F7)'),
    row('received → filed', L.receivedToFiled, 'incl. reporter think time'),
    '',
    `  Jobs: ${r.jobs.total} · retries ${r.jobs.retries} · dead ${r.jobs.dead} · waiting for retry ${r.jobs.pendingRetry} · max queued ${r.jobs.maxQueued} · max running ${r.jobs.maxRunning}`,
    '  type                    n  retries  dead  run p50 ms  run p95 ms (wall)',
    ...Object.entries(r.jobs.byType)
      .sort((a, b) => b[1].n - a[1].n)
      .map(
        ([t, b]) =>
          `  ${t.padEnd(20)} ${String(b.n).padStart(5)} ${String(b.retries).padStart(8)} ${String(b.dead).padStart(5)} ${String(b.runMsP50 ?? '—').padStart(11)} ${String(b.runMsP95 ?? '—').padStart(11)}`,
      ),
    ...(Object.keys(r.jobs.errors).length
      ? ['  errors:', ...Object.entries(r.jobs.errors).map(([e, n]) => `    ${n} × ${e}`)]
      : []),
    `  external calls ${JSON.stringify(r.external.calls)}${Object.keys(r.external.failures).length ? ` · injected failures ${JSON.stringify(r.external.failures)}` : ''}`,
    ...(r.reports.notClosed.length
      ? [
          `  not closed: ${r.reports.notClosed.length}`,
          ...r.reports.notClosed
            .slice(0, 10)
            .map(
              (s) =>
                `    ${s.site} ${s.case} site-day=${s.status ?? 'none'} · ${s.notes.join(' | ')}`,
            ),
        ]
      : []),
    '',
    `  At scale 1: ${r.projection.slotSecondsPerReportAtScale1.toFixed(1)} slot-seconds per report ` +
      `(${(r.projection.realMsPerReport / 1000).toFixed(2)} s of it real CPU/DB) → ` +
      `${r.projection.slots} slots file ≈ ${Math.floor(r.projection.reportsPer30MinAtScale1)} reports / 30 min`,
    `  500 reports in 30 min: ${r.projection.meets500In30Min ? 'MET' : 'NOT MET'} with ${r.projection.slots} slots ` +
      `(needs ≥ ${r.projection.slotsFor500In30Min} slots at 100 % busy, ≥ ${r.projection.slotsFor500In30MinAt70Pct} at 70 %)`,
    `  §15.1 draft p50 ≤ ${DRAFT_TARGET_S.p50} s and p95 ≤ ${DRAFT_TARGET_S.p95} s in this run: ${r.projection.meetsDraftTargets ? 'MET' : 'NOT MET'}`,
    `  phone numbers sent to Claude: ${r.privacy.phoneLeaksToClaude}`,
    '',
  ];
  return lines.join('\n');
}

async function main(): Promise<void> {
  const o = parseArgs(process.argv.slice(2));
  const result = await runLoadTest(o);
  console.log(formatResult(result));
  if (o.json) {
    writeFileSync(o.json, JSON.stringify(result, null, 2));
    console.log(`  JSON written to ${o.json}`);
  }
  process.exit(0);
}

if (process.argv[1] && /loadtest\.(ts|js)$/.test(process.argv[1]) && !process.env.VITEST) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
