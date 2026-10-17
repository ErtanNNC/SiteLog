/**
 * W3-15: the call simulator on a local Supabase stack: field-api's `/voice/*` over HTTP with the
 * voice agent's bearer secret (`VOICE_AGENT_TOOL_SECRET`), and the database (`SUPABASE_DB_URL`)
 * for what a script needs before the call and what the call leaves behind.
 *
 * Each run makes an org of its own (a real org, `is_demo` false: a SIP call only finds reporters
 * of real orgs, §19 Q44), with the §18.1 company roster (the roster the recorded answers were made
 * on), the script's sites, its reporter with a random +1 555 number and the recording, processing
 * and texts consents, and the reports it files before the call (F10). A Talk now call's row comes
 * from `field_talk_now_start()` as field-api's `voice/token` makes it (LiveKit aside); a SIP call
 * dials the pack's voice number (`countries.voice_number`, set per database with
 * `pnpm countries:set`). Nothing is deleted afterwards: a local stack only (`refuseTarget`).
 *
 * Texts: no pack has a sender id on a local stack, so a real org's text is a masked `failed` row
 * (`console_real_org`): the checks read the copy keys, never a delivery.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  computeTotals,
  emptyReportData,
  localDate,
  readReportData,
  resolveDayReference,
  type DailyReportData,
  type StoredReportData,
} from '@sitelog/shared';
import { kestrelDemo } from '@sitelog/shared/demo/kestrel.ts';
import { isLocalDbHost } from '../countries-set.ts';
import type { Arranged, SimStack, VoiceHttp } from './run.ts';

/** A SQL runner (`postgres`' `unsafe`), so the checks are tested without a database. */
export type Query = <T = Record<string, unknown>>(text: string, params?: unknown[]) => Promise<T[]>;

/** How long a check waits for the worker (a filing, a post-call job, a text). */
export const CHECK_WAIT_MS = 60_000;

/** Why the simulator must not run against this target, or null. Local stacks only. */
export function refuseTarget(dbUrl: string | undefined, fieldApiUrl: string): string | null {
  if (!dbUrl)
    return 'SUPABASE_DB_URL is not set: the DB_URL of `supabase status -o env` (a local stack)';
  const local = (u: string) => {
    try {
      return isLocalDbHost(new URL(u).hostname);
    } catch {
      return false;
    }
  };
  if (!local(dbUrl)) return 'SUPABASE_DB_URL is not a local database: the simulator makes orgs';
  if (!local(fieldApiUrl)) return `FIELD_API_URL ${fieldApiUrl} is not a local stack`;
  return null;
}

/** field-api's voice routes over fetch, with the agent's bearer secret. */
export function fetchVoiceHttp(baseUrl: string, toolSecret: string): VoiceHttp {
  const base = baseUrl.replace(/\/+$/, '');
  return {
    async post(path, body, callToken) {
      const res = await fetch(`${base}${path}`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${toolSecret}`,
          'content-type': 'application/json',
          // As the agent: one id per request (a re-ask after `pending` is a new request).
          'x-request-id': randomUUID().replace(/-/g, ''),
          ...(callToken ? { 'x-call-token': callToken } : {}),
        },
        body: JSON.stringify(body),
      });
      const text = await res.text();
      let parsed: unknown = text;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        /* a non-JSON answer stays text */
      }
      return { status: res.status, body: parsed };
    },
  };
}

/** The extraction case's transcript segments (what `update_draft` sends, as the worker test). */
export function transcriptSegments(
  fixturesDir: string,
): (id: string) => Array<{ start: number; end: number; text: string }> {
  return (id) => {
    const t = JSON.parse(readFileSync(join(fixturesDir, 'transcripts', `${id}.json`), 'utf8')) as {
      segments: Array<{ start: number; end: number; text: string }>;
    };
    return t.segments.map(({ start, end, text }) => ({ start, end, text }));
  };
}

/** A fresh +1 555 01xx-style number nobody on the stack has. */
function randomPhone(): string {
  return `+1555${String(Math.floor(Math.random() * 9_000_000) + 1_000_000)}`;
}

export interface StackOptions {
  q: Query;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  waitMs?: number;
}

export function sqlSimStack(opts: StackOptions): SimStack {
  const { q } = opts;
  const now = opts.now ?? (() => new Date());
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const waitMs = opts.waitMs ?? CHECK_WAIT_MS;

  /** Polls `probe` until it answers null (no failure) or the wait is over (its last failure). */
  async function eventually(probe: () => Promise<string | null>): Promise<string | null> {
    const until = Date.now() + waitMs;
    for (;;) {
      const problem = await probe();
      if (problem === null || Date.now() >= until) return problem;
      await sleep(1000);
    }
  }

  return {
    async arrange(script) {
      const a = script.simulate.arrange;
      const transport = script.start.request.transport;
      const voiceNumber = async () => {
        const [pack] = await q<{ voice_number: string | null }>(
          `select voice_number from countries where code = 'US'`,
        );
        if (!pack?.voice_number)
          throw new Error(
            'the US pack has no voice number on this stack: set one first, e.g. `pnpm countries:set -- --code US --voice +15550142290`',
          );
        return pack.voice_number;
      };

      if (a.caller === 'unknown') {
        const id = randomUUID();
        return {
          orgId: null,
          reporterId: null,
          siteIds: {},
          start: {
            room: `call-${id}`,
            transport: 'pstn',
            from: randomPhone(),
            to: await voiceNumber(),
          },
        };
      }

      const reporter = a.reporter!;
      const [org] = await q<{ id: string }>(
        `insert into orgs (name, is_demo, country, locale, units, currency, timezone)
         values ($1, false, 'US', 'en-US', 'imperial', 'USD', 'America/Chicago') returning id`,
        [a.org],
      );
      const orgId = org!.id;
      // Every day a working day, so a script runs the same on a weekend (as the M6 specs do).
      await q(
        `update org_settings set max_questions_per_report = $2, working_days = '{1,2,3,4,5,6,7}'
          where org_id = $1`,
        [orgId, a.maxQuestions],
      );
      // The §18.1 roster in place of the one a new org gets (its own "<name> self-perform").
      await q(`delete from companies where org_id = $1`, [orgId]);
      const companyIds: Record<string, string> = {};
      for (const c of kestrelDemo().companies) {
        const [row] = await q<{ id: string }>(
          `insert into companies (org_id, name, trade, aliases, is_self_perform, status)
           values ($1, $2, $3, $4, $5, $6) returning id`,
          [orgId, c.name, c.trade, c.aliases, c.is_self_perform, c.status],
        );
        companyIds[c.name] = row!.id;
      }
      const siteIds: Record<string, string> = {};
      for (const s of a.sites) {
        const [row] = await q<{ id: string }>(
          `insert into sites (org_id, name, project_code, timezone) values ($1, $2, $3, $4) returning id`,
          [orgId, s.name, s.projectCode, s.timezone],
        );
        siteIds[s.key] = row!.id;
      }
      const phone = randomPhone();
      const [rep] = await q<{ id: string }>(
        `insert into reporters (org_id, name, phone_e164, status, locale, languages, contact_pref, activated_at)
         values ($1, $2, $3, 'active', $4, $5, $6, now()) returning id`,
        [
          orgId,
          reporter.name,
          phone,
          reporter.locale,
          [reporter.locale.slice(0, 2)],
          reporter.contactPref,
        ],
      );
      const reporterId = rep!.id;
      for (const siteId of Object.values(siteIds))
        await q(
          `insert into site_reporters (site_id, reporter_id, is_primary) values ($1, $2, true)`,
          [siteId, reporterId],
        );
      for (const type of ['recording', 'data_processing', 'sms'])
        await q(
          `insert into consents (reporter_id, type, method, text_version, evidence)
           values ($1, $2, 'office_attested', 'simulate-call', '{"by":"simulate-call"}'::jsonb)`,
          [reporterId, type],
        );

      for (const f of a.filedReports) {
        const site = a.sites.find((s) => s.key === f.site)!;
        const date = resolveDayReference(f.day, now(), site.timezone);
        if (!date) throw new Error(`filedReports: "${f.day}" is not a day`);
        const [day] = await q<{ id: string }>(
          `insert into site_days (site_id, date, status, deadline_at)
           values ($1, $2::date, 'filed', now()) returning id`,
          [siteIds[f.site], date],
        );
        const [report] = await q<{ id: string }>(
          `insert into reports (org_id, site_id, site_day_id, report_no, status, current_version,
                                reporter_id, channel, language, received_at, confirmed_at,
                                confirmed_via, filed_at)
           values ($1, $2, $3, $4, 'filed', 1, $5, 'web', 'en', now(), now(), 'web', now())
           returning id`,
          [orgId, siteIds[f.site], day!.id, f.reportNo, reporterId],
        );
        await q(`update site_days set report_id = $2 where id = $1`, [day!.id, report!.id]);
        const data: DailyReportData = {
          ...emptyReportData(date, { reportLanguage: 'en', units: 'imperial' }),
          summary: 'Filed before the call (simulate-call).',
          weather: { conditionsText: 'Dry', periods: [] },
          manpower: f.crew.map((c) => ({
            companyId: companyIds[c.company] ?? null,
            companyNameHeard: c.company,
            companyName: c.company,
            workers: c.workers,
            hoursPerWorker: c.hoursPerWorker,
            totalHours: c.workers * c.hoursPerWorker,
            hoursBasis: 'stated',
            confidence: 0.95,
            source: [],
          })) as DailyReportData['manpower'],
          safety: { incidents: [], noIncidentsStated: true, visitors: [], source: [] },
        };
        await q(
          `insert into report_versions (report_id, version, data, summary, author)
           values ($1, 1, $2::jsonb, $3, 'agent')`,
          [report!.id, JSON.stringify(data), data.summary],
        );
      }

      let start: Arranged['start'];
      if (transport === 'web') {
        // Talk now (W3-13): the row field-api's voice/token makes, before the agent joins.
        const firstSite = siteIds[a.sites[0]!.key]!;
        const [row] = await q<{ r: { callId: string; room: string } }>(
          `select field_talk_now_start($1, $2, null) as r`,
          [reporterId, firstSite],
        );
        start = { room: row!.r.room, transport: 'web', callId: row!.r.callId };
      } else {
        start = {
          room: `call-${randomUUID()}`,
          transport: 'pstn',
          from: phone,
          to: await voiceNumber(),
        };
      }
      return { orgId, reporterId, siteIds, start };
    },

    async check(script, { callId, arranged }) {
      const e = script.simulate.expect;
      const failures: string[] = [];
      const push = (p: string | null) => {
        if (p) failures.push(p);
      };
      const [call] = await q<{
        outcome: string | null;
        fallback: unknown;
        reporter_id: string | null;
        started_at: string;
        ended_at: string | null;
      }>(
        `select outcome::text, fallback, reporter_id, started_at, ended_at from calls where id = $1`,
        [callId],
      );
      if (!call) return [`call ${callId}: no row`];
      if (!call.ended_at) failures.push('call: not ended');
      if (call.outcome !== e.call.outcome)
        failures.push(`call.outcome: expected ${e.call.outcome}, got ${call.outcome}`);
      if (e.call.fallback !== (call.fallback !== null))
        failures.push(
          `call.fallback: expected ${e.call.fallback ? 'set' : 'none'}, got ${JSON.stringify(call.fallback)}`,
        );
      const startedAt = new Date(call.started_at);

      const siteDate = (key: string, day = 'today') => {
        const site = script.simulate.arrange.sites.find((s) => s.key === key)!;
        const date =
          day === 'today'
            ? localDate(startedAt, site.timezone)
            : resolveDayReference(day, startedAt, site.timezone);
        return { siteId: arranged.siteIds[key]!, date: date ?? 'invalid' };
      };

      if (e.report === null) {
        const site = script.simulate.arrange.sites[0]!;
        const { siteId, date } = siteDate(site.key);
        const rows = await q<{ status: string }>(
          `select r.status::text from reports r join site_days d on d.id = r.site_day_id
            where d.site_id = $1 and d.date = $2::date and r.status <> 'void'`,
          [siteId, date],
        );
        if (rows.length)
          failures.push(`report: expected none, got ${rows.map((r) => r.status).join(', ')}`);
      } else if (e.report) {
        const want = e.report;
        const { siteId, date } = siteDate(want.site, want.day);
        push(
          await eventually(async () => {
            const [r] = await q<{
              status: string;
              channel: string | null;
              confirmed_via: string | null;
              current_version: number;
              data: StoredReportData | null;
            }>(
              `select r.status::text, r.channel::text, r.confirmed_via::text, r.current_version, v.data
                 from reports r join site_days d on d.id = r.site_day_id
                 left join report_versions v on v.report_id = r.id and v.version = greatest(r.current_version, 1)
                where d.site_id = $1 and d.date = $2::date and r.status <> 'void'
                order by r.created_at desc limit 1`,
              [siteId, date],
            );
            if (!r) return `report of ${want.site} on ${date}: none`;
            const out: string[] = [];
            const eq = (what: string, w: unknown, got: unknown) => {
              if (w !== undefined && w !== got)
                out.push(`${what}: expected ${String(w)}, got ${String(got)}`);
            };
            eq('report.status', want.status, r.status);
            eq('report.version', want.version, r.current_version);
            eq('report.channel', want.channel, r.channel);
            eq('report.confirmedVia', want.confirmedVia, r.confirmed_via);
            if (want.crewOnSite !== undefined || want.totalHours !== undefined) {
              const totals = r.data ? computeTotals(readReportData(r.data)).totals : null;
              eq('report.crewOnSite', want.crewOnSite, totals?.crewOnSite);
              eq('report.totalHours', want.totalHours, totals?.totalHours);
            }
            return out.length ? out.join('; ') : null;
          }),
        );
      }

      if (e.siteDay) {
        const want = e.siteDay;
        const { siteId, date } = siteDate(want.site);
        push(
          await eventually(async () => {
            const [d] = await q<{ status: string }>(
              `select status::text from site_days where site_id = $1 and date = $2::date`,
              [siteId, date],
            );
            return d?.status === want.status
              ? null
              : `siteDay ${want.site} ${date}: expected ${want.status}, got ${d?.status ?? 'none'}`;
          }),
        );
      }

      if (e.reporter && arranged.reporterId) {
        const [r] = await q<{ contact_pref: string }>(
          `select contact_pref::text from reporters where id = $1`,
          [arranged.reporterId],
        );
        if (r?.contact_pref !== e.reporter.contactPref)
          failures.push(
            `reporter.contactPref: expected ${e.reporter.contactPref}, got ${r?.contact_pref}`,
          );
      }

      if (e.messages.length && arranged.reporterId) {
        push(
          await eventually(async () => {
            const rows = await q<{ copy_key: string | null }>(
              `select copy_key from messages where reporter_id = $1`,
              [arranged.reporterId],
            );
            const keys = new Set(rows.map((r) => r.copy_key));
            const missing = e.messages.filter((k) => !keys.has(k));
            return missing.length
              ? `messages: no ${missing.join(', ')} (got ${[...keys].join(', ') || 'none'})`
              : null;
          }),
        );
      }

      if (e.unknownContact) {
        const want = e.unknownContact.snippetStartsWith;
        const [u] = await q<{ snippet: string | null; channel: string | null }>(
          `select snippet, channel::text from unknown_contacts where call_id = $1`,
          [callId],
        );
        if (!u) failures.push('unknownContact: none for the call');
        else if (u.channel !== 'voice' || !(u.snippet ?? '').startsWith(want))
          failures.push(
            `unknownContact: expected voice "${want}…", got ${u.channel} "${u.snippet}"`,
          );
      }

      if (e.audits.length) {
        push(
          await eventually(async () => {
            const rows = await q<{ action: string }>(
              `select action from audit_log where entity = 'call' and entity_id = $1`,
              [callId],
            );
            const seen = new Set(rows.map((r) => r.action));
            const missing = e.audits.filter((a) => !seen.has(a));
            return missing.length
              ? `audits: no ${missing.join(', ')} (got ${[...seen].join(', ')})`
              : null;
          }),
        );
      }

      if (call.reporter_id && arranged.reporterId === null)
        failures.push('call: an unknown caller was matched to a reporter');
      if (!call.reporter_id && arranged.reporterId)
        failures.push('call: the reporter was not found by field-api');
      return failures;
    },
  };
}
