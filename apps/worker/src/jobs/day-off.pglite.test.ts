import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createConsoleSmsTransport, dayOffReportData, type JobPayloads } from '@sitelog/shared';
import { testConfig } from '../config';
import { createMetrics, type Ctx } from '../context';
import { silentLogger } from '../log';
import { createWorkerNotifier } from '../messaging';
import { startPgliteDatabase, type PgliteDatabase } from '../test/pglite';
import { fileReportJob } from './file_report';
import { notifyJob } from './notify';

/**
 * W2-08 (F12, spec §19 Q41) on PGlite: the recorder's *Site closed: weather* and *No work today*
 * as field-api's day-status writes them (field_report_day_off(), with the data built in code by
 * `dayOffReportData`), then the worker's file_report: the report filed with trigger
 * `weather_day` / `no_work`, its weather event and lost hours denormalised, the PDF queued (for a
 * no-work day only with `no_work_pdf`), no `filed` text, and the reminder ladder stopped (a
 * stage claimed before the tap sends nothing).
 */

let pg: PgliteDatabase;
let MARCO = '';
let SITE = '';
let ORG = '';

function ctxAt(now: Date): Ctx {
  const config = testConfig();
  return {
    config,
    db: pg.db,
    notifier: createWorkerNotifier(
      config,
      pg.db,
      () => createConsoleSmsTransport(() => randomUUID()),
      () => now,
    ),
    log: silentLogger,
    metrics: createMetrics(),
    now: () => now,
  } as unknown as Ctx;
}

async function dayOff(date: string, status: 'weather_day' | 'no_work', since?: string) {
  const q = { since: randomUUID(), workersBefore: randomUUID() };
  const data = dayOffReportData({
    kind: status,
    date,
    siteName: 'Riverside Lofts',
    org: { reportLanguage: 'en', units: 'imperial' },
    details: status === 'weather_day' ? { since, workersBefore: 12 } : {},
    questionIds: status === 'weather_day' ? q : { since: null, workersBefore: null },
    workingHours: '07:00–15:30',
    defaultShiftHours: 8,
  });
  const questions =
    status === 'weather_day'
      ? [
          {
            id: q.since,
            field: 'weather.impact',
            prompt: 'Since when?',
            target: { path: 'weather.periods[0]' },
            answer: { text: since, parsed: { since }, via: 'web' },
          },
          {
            id: q.workersBefore,
            field: 'manpower.workers',
            prompt: 'How many were on site before?',
            target: { path: 'manpower.workers:site_crew' },
            answer: { text: '12', parsed: { workers: 12 }, via: 'web' },
          },
        ]
      : [];
  const [row] = await pg.q<{
    r: { siteDayId: string; report: { id: string; reportNo: string } | null };
  }>(`select field_report_day_off($1, $2, $3, $4, '{}', $5, $6) as r`, [
    MARCO,
    SITE,
    date,
    status,
    JSON.stringify(questions),
    JSON.stringify(data),
  ]);
  return { ...row!.r, questionIds: q };
}

async function fileJob(reportId: string) {
  const [job] = await pg.q<{ payload: JobPayloads['file_report'] }>(
    `select payload from jobs where type = 'file_report' and payload ->> 'reportId' = $1`,
    [reportId],
  );
  return job!.payload;
}

beforeAll(async () => {
  pg = await startPgliteDatabase({ seed: true });
  const [m] = await pg.q<{ id: string; site_id: string; org_id: string }>(
    `select r.id, sr.site_id, r.org_id from reporters r join site_reporters sr on sr.reporter_id = r.id
      where r.phone_e164 = '+15550143378' and sr.is_primary limit 1`,
  );
  MARCO = m!.id;
  SITE = m!.site_id;
  ORG = m!.org_id;
});

afterAll(async () => {
  await pg?.close();
});

describe('W2-08: No work and Weather as reports, filed by the worker', () => {
  it('Weather from 09:00 with 12 on site: filed weather_day, 6.5 h lost, sources the two answers, PDF, no text', async () => {
    const { report, siteDayId, questionIds } = await dayOff('2030-06-03', 'weather_day', '09:00');
    const payload = await fileJob(report!.id);
    expect(payload).toEqual({ reportId: report!.id, trigger: 'weather_day' });
    await fileReportJob(ctxAt(new Date('2030-06-03T15:00:00Z')), payload, {} as never);

    const [r] = await pg.q<{ status: string; needs_review: boolean; confirmed_at: string | null }>(
      `select status::text, needs_review, confirmed_at from reports where id = $1`,
      [report!.id],
    );
    expect(r).toEqual({ status: 'filed', needs_review: false, confirmed_at: null });
    const [day] = await pg.q<{ status: string; report_id: string }>(
      `select status::text, report_id from site_days where id = $1`,
      [siteDayId],
    );
    expect(day).toEqual({ status: 'weather_day', report_id: report!.id });
    const [ev] = await pg.q<{ lost: number; full_day: boolean }>(
      `select lost_hours::float as lost, full_day from weather_events where report_id = $1`,
      [report!.id],
    );
    expect(ev).toEqual({ lost: 6.5, full_day: false });
    const sources = await pg.q<{ question_id: string }>(
      `select question_id from report_sources where report_id = $1 and kind = 'answer' order by created_at`,
      [report!.id],
    );
    expect(new Set(sources.map((s) => s.question_id))).toEqual(
      new Set([questionIds.since, questionIds.workersBefore]),
    );
    const [filed] = await pg.q<{ diff: { trigger: string } }>(
      `select diff from audit_log where action = 'report.filed' and entity_id = $1`,
      [report!.id],
    );
    expect(filed!.diff.trigger).toBe('weather_day');
    expect(
      await pg.q(`select 1 from jobs where dedupe_key = $1`, [`render_pdf:${report!.id}:1`]),
    ).toHaveLength(1);
    expect(
      await pg.q(`select 1 from jobs where dedupe_key = $1`, [`notify:filed:${report!.id}`]),
    ).toEqual([]);
  });

  it('No work: a report with its PDF when no_work_pdf is on, the site-day only when it is off', async () => {
    await pg.q(`update org_settings set no_work_pdf = true where org_id = $1`, [ORG]);
    const { report } = await dayOff('2030-06-04', 'no_work');
    await fileReportJob(
      ctxAt(new Date('2030-06-04T15:00:00Z')),
      await fileJob(report!.id),
      {} as never,
    );
    const [r] = await pg.q<{ status: string; kind: string }>(
      `select status::text, kind from reports where id = $1`,
      [report!.id],
    );
    expect(r).toEqual({ status: 'filed', kind: 'no_work' });
    expect(
      await pg.q(`select 1 from jobs where dedupe_key = $1`, [`render_pdf:${report!.id}:1`]),
    ).toHaveLength(1);
    await pg.q(`update org_settings set no_work_pdf = false where org_id = $1`, [ORG]);
    const plain = await dayOff('2030-06-05', 'no_work');
    expect(plain.report).toBeNull();
  });

  it('stops the ladder: a reminder claimed before the tap sends nothing', async () => {
    const [d] = await pg.q<{ id: string }>(
      `insert into site_days (site_id, date, deadline_at) values ($1, '2030-06-06', '2030-06-06T22:30:00Z') returning id`,
      [SITE],
    );
    const messages = [
      {
        reporterId: MARCO,
        key: 'reminder_1',
        vars: { site: 'Riverside Lofts', link: 'https://go.sitelog.app/r/ABCDEFGHJKMN' },
      },
    ];
    await pg.q(`select claim_site_day_reminder($1, 'reminder_1', $2::jsonb, '[]'::jsonb) as ok`, [
      d!.id,
      JSON.stringify(messages),
    ]);
    const [job] = await pg.q<{ payload: JobPayloads['notify'] }>(
      `select payload from jobs where dedupe_key = $1`,
      [`notify:reminder_1:${d!.id}:${MARCO}`],
    );
    await dayOff('2030-06-06', 'weather_day', 'never_started');
    await notifyJob(ctxAt(new Date('2030-06-06T22:46:00Z')), job!.payload, {} as never);
    expect(
      await pg.q(`select 1 from messages where payload ->> 'dedupe_key' = $1`, [
        `notify:reminder_1:${d!.id}:${MARCO}`,
      ]),
    ).toEqual([]);
    const [skip] = await pg.q<{ diff: { reason: string } }>(
      `select diff from audit_log where action = 'notify.skipped' and diff ->> 'dedupe_key' = $1`,
      [`notify:reminder_1:${d!.id}:${MARCO}`],
    );
    expect(skip!.diff.reason).toBe('stale_stage');
  });
});
