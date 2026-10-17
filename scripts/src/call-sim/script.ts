/**
 * W3-15: a scripted call (`fixtures/calls/<id>.json`) as the call simulator reads it.
 *
 * A call fixture is W3-02's format (`start`, `routes`, `reporterTurns`, `agentTurns`; W3-09 adds
 * `extraction` and `answers`, W3-10 `filing` and `corrections`), which the voice agent's pytest
 * replays on its fakes. W3-15 adds two keys the agent never reads:
 *
 * - `queue`: field-api's error answers, in order, for a route whose answer is a refusal (W3-14's
 *   `schedule_callback` answers 400 `not_available`); a replay hands them to
 *   `FakeFieldApi.queue(route, status, body)`;
 * - `simulate`: the script for `pnpm simulate:call`: what the call is about on a fresh org of its
 *   own (`arrange`), the requests the agent sends to field-api in order (`steps`, with the answers
 *   expected), and what the call leaves behind (`expect`: the call, the report, the site-day, the
 *   reporter, the texts, the unknown contact, the call's audit trail).
 *
 * Pure: parsing and the listing only (no network, no database).
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import {
  CALL_OUTCOMES,
  CALL_TRANSPORTS,
  CONTACT_PREFS,
  REPORTER_LOCALES,
  REPORT_STATUSES,
  SITE_DAY_STATUSES,
  VOICE_TOOLS,
} from '@sitelog/shared';

/** The M7 / M8 suite's flow tags (PLAN_WEEK3 W3-15): one per script. */
export const SIM_FLOWS = ['F6', 'F7', 'F8', 'F10', 'F12', 'F13', 'F14', 'F15'] as const;
export type SimFlow = (typeof SIM_FLOWS)[number];

/** A site of the script's org; `key` names it in the steps (`$site.<key>`) and the checks. */
const SiteSchema = z.strictObject({
  key: z.string().regex(/^[a-z][a-z0-9-]*$/),
  name: z.string().min(1),
  projectCode: z.string().regex(/^[A-Z0-9]{1,6}$/),
  timezone: z.string().min(1).default('America/Chicago'),
});

const CrewSchema = z.strictObject({
  company: z.string().min(1),
  workers: z.number().int().min(0),
  hoursPerWorker: z.number().min(0).max(24),
});

/** A report filed before the call (F10: the day the reporter changes), on a day said as words. */
const FiledReportSchema = z.strictObject({
  site: z.string(),
  /** The day as the reporter says it (`resolveDayReference`, e.g. "Friday"). */
  day: z.string().min(1),
  reportNo: z.string().min(1),
  crew: z.array(CrewSchema).min(1),
});

const ArrangeSchema = z.strictObject({
  /** `unknown`: a number no reporter has (F13). */
  caller: z.enum(['reporter', 'unknown']).default('reporter'),
  /**
   * W4-07: the org's country pack (`orgs.country`), which presets its locale, units, currency,
   * time zone and paper (US: Letter, imperial; TR: A4, metric, tr-TR) and its company roster:
   * §18.1's for US, §18.2's (Demir Yapı) for TR.
   */
  country: z.enum(['US', 'TR']).default('US'),
  /** The org's name (`get_context.company`). */
  org: z.string().min(1).default('Kestrel Build Group'),
  reporter: z
    .strictObject({
      name: z.string().min(1),
      locale: z.enum(REPORTER_LOCALES),
      contactPref: z.enum(CONTACT_PREFS).default('call'),
    })
    .optional(),
  /** The reporter's sites; a Talk now call is about the first. */
  sites: z.array(SiteSchema).default([]),
  /** `org_settings.max_questions_per_report`. */
  maxQuestions: z.number().int().min(0).max(10).default(3),
  filedReports: z.array(FiledReportSchema).default([]),
});

/**
 * One request the agent sends. `body` is the request without `callId` (the simulator adds it);
 * a string value `$name` is a value of the call so far (`resolveVars`). The answer expected:
 * `recorded` (the default for a 2xx), the route's next recorded answer in `routes` (`pending`
 * answers skipped: timing, not behaviour), ids and keys aside (`VOLATILE_KEYS`); or an object,
 * matched as a subset (`matchSubset`). A refusal names its HTTP `status` and `error` code.
 */
const StepSchema = z.strictObject({
  route: z.enum(VOICE_TOOLS),
  body: z.record(z.string(), z.unknown()).default({}),
  expect: z.union([z.literal('recorded'), z.record(z.string(), z.unknown())]).optional(),
  status: z.number().int().min(200).max(599).default(200),
  error: z.string().optional(),
});
export type SimStep = z.infer<typeof StepSchema>;

const ReportExpectSchema = z.strictObject({
  site: z.string(),
  /** The report's day: "today" (the call's day) or the day reference of a filed report. */
  day: z.string().default('today'),
  status: z.enum(REPORT_STATUSES).optional(),
  version: z.number().int().min(1).optional(),
  /** `reports.channel` (`voice` for a report a call made). */
  channel: z.string().optional(),
  confirmedVia: z.string().optional(),
  /** The current version's totals, recomputed in code (`computeTotals`). */
  crewOnSite: z.number().int().min(0).optional(),
  totalHours: z.number().min(0).optional(),
  /** W4-07: `reports.language` and the current version's units (a TR report: tr, metric). */
  language: z.enum(['en', 'tr']).optional(),
  units: z.enum(['imperial', 'metric']).optional(),
  /** W4-07: the current version's PDF is rendered, on the org's paper (`org_settings.pdf_paper`). */
  pdfPaper: z.enum(['letter', 'a4']).optional(),
});

const ExpectSchema = z.strictObject({
  call: z.strictObject({
    outcome: z.enum(CALL_OUTCOMES),
    /** §9.4 rule 9: the call switched to the simple recording mode. */
    fallback: z.boolean().default(false),
  }),
  /** The report of a site and day; `null` = none (other than void) on that site today. */
  report: ReportExpectSchema.nullable().optional(),
  siteDay: z.strictObject({ site: z.string(), status: z.enum(SITE_DAY_STATUSES) }).optional(),
  reporter: z.strictObject({ contactPref: z.enum(CONTACT_PREFS) }).optional(),
  /** Copy keys of texts to the reporter (any status: a real org's console row is `failed`). */
  messages: z.array(z.string()).default([]),
  /** F13: the call's `unknown_contacts` row (channel voice) and the start of its snippet. */
  unknownContact: z.strictObject({ snippetStartsWith: z.string().min(1) }).optional(),
  /** Audit actions on the call (`audit_log`, entity `call`), the worker's included. */
  audits: z.array(z.string()).default([]),
});

export const SimulateSchema = z.strictObject({
  title: z.string().min(1).max(120),
  milestone: z.enum(['m7', 'm8']),
  flow: z.enum(SIM_FLOWS),
  arrange: ArrangeSchema,
  steps: z.array(StepSchema).min(1),
  expect: ExpectSchema,
});
export type Simulate = z.infer<typeof SimulateSchema>;

/** The part of a call fixture the simulator reads (the rest is the agent's). */
export const CallScriptSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9-]+$/),
    locale: z.enum(REPORTER_LOCALES),
    extraction: z.string().optional(),
    start: z.object({
      request: z.object({ transport: z.enum(CALL_TRANSPORTS) }).loose(),
      response: z.record(z.string(), z.unknown()),
    }),
    routes: z.record(z.string(), z.array(z.unknown())).default({}),
    queue: z
      .array(z.strictObject({ route: z.string(), status: z.number().int(), body: z.unknown() }))
      .default([]),
    reporterTurns: z.array(z.string()).default([]),
    agentTurns: z.array(z.record(z.string(), z.unknown())).default([]),
    simulate: SimulateSchema.optional(),
  })
  .loose()
  .superRefine((s, ctx) => {
    const sim = s.simulate;
    if (!sim) return;
    const keys = new Set(sim.arrange.sites.map((x) => x.key));
    const site = (k: string, path: (string | number)[]) => {
      if (!keys.has(k)) ctx.addIssue({ code: 'custom', message: `no site "${k}"`, path });
    };
    if (sim.arrange.caller === 'reporter') {
      if (!sim.arrange.reporter)
        ctx.addIssue({
          code: 'custom',
          message: 'a reporter call names its reporter',
          path: ['simulate', 'arrange'],
        });
      if (sim.arrange.sites.length === 0)
        ctx.addIssue({
          code: 'custom',
          message: 'a reporter call needs a site',
          path: ['simulate', 'arrange'],
        });
    }
    sim.arrange.filedReports.forEach((r, i) =>
      site(r.site, ['simulate', 'arrange', 'filedReports', i]),
    );
    if (sim.expect.report) site(sim.expect.report.site, ['simulate', 'expect', 'report']);
    if (sim.expect.siteDay) site(sim.expect.siteDay.site, ['simulate', 'expect', 'siteDay']);
    sim.steps.forEach((step, i) => {
      if (step.status >= 400 && !step.error)
        ctx.addIssue({
          code: 'custom',
          message: 'a refusal names its error',
          path: ['simulate', 'steps', i],
        });
      for (const v of varsIn(step.body)) {
        const m = /^\$site\.(.+)$/.exec(v);
        if (m) site(m[1]!, ['simulate', 'steps', i, 'body']);
        else if (!SIM_VARS.includes(v as SimVar))
          ctx.addIssue({
            code: 'custom',
            message: `unknown variable ${v}`,
            path: ['simulate', 'steps', i, 'body'],
          });
        if (v === '$segments' && !s.extraction)
          ctx.addIssue({
            code: 'custom',
            message: '$segments needs `extraction`',
            path: ['simulate', 'steps', i],
          });
      }
    });
  });
export type CallScript = z.infer<typeof CallScriptSchema>;
/** A call fixture with its `simulate` block. */
export type SimScript = CallScript & { simulate: Simulate };

/**
 * The values a step's body may name (`$name`, the whole string): the extraction case's
 * transcript segments, the latest draft the call holds (its report, its revision, its open
 * question), the report `load_report` found, the latest `confirmKey` and `correctionId`.
 */
export const SIM_VARS = [
  '$segments',
  '$draft.reportId',
  '$draft.draftRev',
  '$draft.questionId',
  '$loaded.reportId',
  '$confirmKey',
  '$correctionId',
] as const;
export type SimVar = (typeof SIM_VARS)[number];

/** Every `$…` string in a value. */
export function varsIn(value: unknown): string[] {
  if (typeof value === 'string') return value.startsWith('$') ? [value] : [];
  if (Array.isArray(value)) return value.flatMap(varsIn);
  if (value && typeof value === 'object') return Object.values(value).flatMap(varsIn);
  return [];
}

/** A fixture's JSON → its script; throws with the file and the issues. */
export function parseCallScript(json: unknown, label = 'call fixture'): CallScript {
  const parsed = CallScriptSchema.safeParse(json);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`${label} is not a valid call script:\n${issues}`);
  }
  return parsed.data;
}

export function loadCallScript(path: string): CallScript {
  return parseCallScript(JSON.parse(readFileSync(path, 'utf8')) as unknown, path);
}

export function isSimScript(s: CallScript): s is SimScript {
  return s.simulate !== undefined;
}

/** The scripts of a directory (`fixtures/calls`) that have a `simulate` block, by id. */
export function listSimScripts(dir: string): SimScript[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => loadCallScript(join(dir, f)))
    .filter(isSimScript);
}

/** The Playwright tags of a script: its milestone and its flow (`@m7 @F6`). */
export function simTags(s: SimScript): string[] {
  return [`@${s.simulate.milestone}`, `@${s.simulate.flow}`];
}

/** The language of the call (`es-US` → `es`). */
export function scriptLanguage(s: CallScript): string {
  return s.locale.slice(0, 2);
}
