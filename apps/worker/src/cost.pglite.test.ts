import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import type { Sql } from 'postgres';
import { bootDatabase } from '../../../supabase/db-tests/src/harness.ts';
import { testConfig } from './config';
import { createMetrics, type Ctx } from './context';
import { recordReportCost } from './cost';
import { connectSql, createDb, type Db } from './db';
import { silentLogger } from './log';

/**
 * The cost-per-report path of the real `createDb` (postgres.js) against PGlite with every
 * migration: report_cost_inputs() / report_cost_baseline() / report_costs through db.ts, and
 * recordReportCost end to end (numeric parsing, jsonb, upsert).
 */

let pg: PGlite;
let server: PGLiteSocketServer;
let sql: Sql;
let db: Db;
let org = '';
let site = '';

const q = async <T = Record<string, unknown>>(text: string, params: unknown[] = []) =>
  (await pg.query<T>(text, params)).rows;

async function filedReport(date: string, no: string, filedAt: string) {
  const [sd] = await q<{ id: string }>(
    `insert into site_days (site_id, date, deadline_at, status) values ($1, $2, $3, 'filed') returning id`,
    [site, date, `${date}T22:30:00Z`],
  );
  const [r] = await q<{ id: string }>(
    `insert into reports (org_id, site_id, site_day_id, report_no, status, kind, filed_at)
     values ($1, $2, $3, $4, 'filed', 'daily', $5) returning id`,
    [org, site, sd!.id, no, filedAt],
  );
  return { id: r!.id, siteDayId: sd!.id };
}

beforeAll(async () => {
  pg = await bootDatabase();
  server = new PGLiteSocketServer({ db: pg, host: '127.0.0.1', port: 0 });
  await server.start();
  sql = connectSql(`postgres://postgres:postgres@${server.getServerConn()}/postgres`, { max: 1 });
  db = createDb(sql);
  [{ id: org }] = (await q<{ id: string }>(
    `insert into orgs (name) values ('Kestrel Build Group') returning id`,
  )) as [{ id: string }];
  [{ id: site }] = (await q<{ id: string }>(
    `insert into sites (org_id, name, project_code, timezone) values ($1, 'Riverside Lofts', 'RL-2041', 'America/Chicago') returning id`,
    [org],
  )) as [{ id: string }];
});

afterAll(async () => {
  await db?.close();
  await server?.stop();
  await pg?.close();
});

describe('cost per report on PGlite', () => {
  it('reads inputs and the baseline, upserts the row, and recordReportCost flags an outlier', async () => {
    // 20 earlier reports at 4–6 cents.
    for (let i = 0; i < 20; i++) {
      const at = new Date(Date.parse('2026-10-09T22:00:00Z') - (i + 1) * 86_400_000);
      const r = await filedReport(
        at.toISOString().slice(0, 10),
        `RL-2041-${1000 + i}`,
        at.toISOString(),
      );
      await db.upsertReportCost({
        report_id: r.id,
        org_id: org,
        kind: 'daily',
        filed_at: at.toISOString(),
        cost_cents: [4, 5, 6][i % 3]!,
        median_cents: null,
        sample: 0,
        outlier: false,
        detail: {},
      });
    }
    const report = await filedReport('2026-10-09', 'RL-2041-0187', '2026-10-09T22:31:00Z');
    await db.enqueueJob('extract_report', { reportId: report.id, metrics: { estCostUsd: 0.25 } });
    const [convo] = await q<{ id: string }>(
      `insert into conversations (org_id, phone_e164, state) values ($1, '+15550143378', 'idle') returning id`,
      [org],
    );
    await db.insertOutboundMessage({
      conversation_id: convo!.id,
      type: 'template',
      body: 'Reminder',
      payload: { kind: 'sitelog_reminder_1', siteDayId: report.siteDayId },
      template_name: 'sitelog_reminder_1',
      status: 'sent',
    });

    expect(await db.reportCostInputs(report.id)).toEqual({
      aiUsd: 0.25,
      jobCount: 1,
      waTemplates: 1,
    });
    expect(
      await db.reportCostBaseline({
        kind: 'daily',
        before: '2026-10-09T22:31:00Z',
        excludeReportId: report.id,
        days: 30,
      }),
    ).toEqual({ medianCents: 5, sample: 20 });
    expect(await db.getReportCost(report.id)).toBeNull();

    const ctx = {
      config: testConfig(),
      db,
      log: silentLogger,
      now: () => new Date('2026-10-09T22:40:00Z'),
      metrics: createMetrics(),
    } as unknown as Ctx;
    const res = (await recordReportCost(ctx, report.id))!;
    expect(res).toMatchObject({ alerted: true, changed: true });
    const row = (await db.getReportCost(report.id))!;
    expect(row).toMatchObject({
      report_id: report.id,
      org_id: org,
      kind: 'daily',
      filed_at: '2026-10-09T22:31:00.000Z',
      cost_cents: 25, // $0.25 + $0.004
      median_cents: 5,
      sample: 20,
      outlier: true,
      detail: { aiUsd: 0.25, waTemplates: 1, waTemplateUsd: 0.004, jobs: 1 },
    });
    expect(row.computed_at).toMatch(/Z$/);
  });
});
