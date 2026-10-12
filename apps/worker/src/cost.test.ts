import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Sentry from '@sentry/node';
import {
  deadlineInstant,
  emptyReportData,
  type ReportCostRow,
  type ReportRow,
} from '@sitelog/shared';
import {
  COST_ALERT_MIN_SAMPLE,
  costUsdAcrossAttempts,
  estimateReportCost,
  isCostOutlier,
  median,
  recordReportCost,
  usdToCents,
} from './cost';
import { registry } from './jobs/registry';
import { createLogger } from './log';
import { fileReport } from './pipeline/file';
import { runJob } from './runner';
import {
  createHarness,
  ORG_ID,
  REPORTER_MARCO,
  SITE_RIVERSIDE,
  type Harness,
} from './test/harness';

vi.mock(import('@sentry/node'), async (importOriginal) => ({
  ...(await importOriginal()),
  captureMessage: vi.fn(),
  captureException: vi.fn(),
}));

const FILED_AT = '2026-10-09T22:31:00Z';

describe('cost math', () => {
  it('median: middle value, mean of the two middle values, null when empty', () => {
    expect(median([])).toBeNull();
    expect(median([7])).toBe(7);
    expect(median([9, 1, 5])).toBe(5);
    expect(median([4, 6, 5, 7])).toBe(5.5);
    expect(median([3, 100, 4, 6, 5, 7])).toBe(5.5);
  });

  it('usdToCents rounds to integer cents and never goes negative', () => {
    expect(usdToCents(0.354)).toBe(35);
    expect(usdToCents(0.355)).toBe(36);
    expect(usdToCents(0.0049)).toBe(0);
    expect(usdToCents(-1)).toBe(0);
    expect(usdToCents(Number.NaN)).toBe(0);
  });

  it('estimates AI + WhatsApp templates in cents', () => {
    expect(
      estimateReportCost({ aiUsd: 0.1168, jobCount: 4, waTemplates: 3 }, { waTemplateUsd: 0.004 }),
    ).toEqual({ costCents: 13, aiUsd: 0.1168, waUsd: 0.012 });
    expect(
      estimateReportCost({ aiUsd: 0, jobCount: 0, waTemplates: 0 }, { waTemplateUsd: 0.004 }),
    ).toEqual({ costCents: 0, aiUsd: 0, waUsd: 0 });
  });

  it('flags only costs strictly above 3× a median of at least 20 reports', () => {
    const base = { medianCents: 5, sample: 20 };
    expect(isCostOutlier(16, base)).toBe(true);
    expect(isCostOutlier(15, base)).toBe(false); // exactly 3×
    expect(isCostOutlier(500, { medianCents: 5, sample: 19 })).toBe(false);
    expect(isCostOutlier(500, { medianCents: null, sample: 0 })).toBe(false);
    expect(isCostOutlier(1, { medianCents: 0, sample: 40 })).toBe(false);
    expect(isCostOutlier(11, { medianCents: 5, sample: 3 }, { multiplier: 2, minSample: 3 })).toBe(
      true,
    );
  });

  it('carries the cost of earlier attempts into retries', () => {
    const job = (attempts: number, metrics: Record<string, unknown> | null) =>
      ({ attempts, payload: { reportId: 'r', ...(metrics ? { metrics } : {}) } }) as never;
    expect(costUsdAcrossAttempts(job(1, null), 0.02)).toBeNull();
    expect(costUsdAcrossAttempts(job(2, { estCostUsd: 0.01 }), 0.02)).toBe(0.03);
    expect(costUsdAcrossAttempts(job(3, { estCostUsd: 0.02, costUsdTotal: 0.03 }), 0.02)).toBe(
      0.05,
    );
    expect(costUsdAcrossAttempts(job(2, null), 0.02)).toBe(0.02); // crashed attempt: nothing saved
  });
});

// ─── recordReportCost + filing hook on the fake Db ───

let h: Harness;
let warnings: Array<Record<string, unknown>>;

beforeEach(() => {
  h = createHarness();
  warnings = [];
  h.ctx.log = createLogger(
    {},
    {
      level: 'warn',
      write: (line) => warnings.push(JSON.parse(line) as Record<string, unknown>),
    },
  );
  vi.mocked(Sentry.captureMessage).mockClear();
});

afterEach(() => vi.restoreAllMocks());

/** `n` filed reports of the same kind in the 30 days before FILED_AT. */
function seedBaseline(n: number, cents: (i: number) => number, kind = 'daily', daysBack = 0) {
  for (let i = 0; i < n; i++) {
    const at = new Date(Date.parse(FILED_AT) - (daysBack * 24 + (i + 1) * 20) * 3_600_000);
    const row: ReportCostRow = {
      report_id: randomUUID(),
      org_id: ORG_ID,
      kind,
      filed_at: at.toISOString(),
      cost_cents: cents(i),
      median_cents: null,
      sample: 0,
      outlier: false,
      detail: {},
      computed_at: at.toISOString(),
    };
    h.db.data.reportCosts.set(row.report_id, row);
  }
}

async function makeReport(
  status: ReportRow['status'],
  reportNo = 'RL-2041-0187',
): Promise<ReportRow> {
  const siteDay = await h.db.getOrCreateSiteDay(
    SITE_RIVERSIDE,
    '2026-10-09',
    deadlineInstant('2026-10-09', '17:30', 'America/Chicago'),
  );
  const report = await h.db.insertReport({
    org_id: ORG_ID,
    site_id: SITE_RIVERSIDE,
    site_day_id: siteDay.id,
    report_no: reportNo,
    reporter_id: REPORTER_MARCO,
    received_at: '2026-10-09T22:00:00Z',
    kind: 'daily',
    status,
  });
  if (status === 'filed') return h.db.updateReport(report.id, { filed_at: FILED_AT });
  return report;
}

async function template(siteDayId: string, status: 'sent' | 'failed' = 'sent') {
  const convo = await h.conversation('idle');
  await h.db.insertOutboundMessage({
    conversation_id: convo.id,
    type: 'template',
    body: 'Reminder',
    payload: { kind: 'sitelog_reminder_1', siteDayId },
    template_name: 'sitelog_reminder_1',
    wa_message_id: `wamid.${randomUUID()}`,
    status,
  });
}

describe('recordReportCost', () => {
  it('stores the cost in cents, flags a 3× outlier once, logs a structured warning and tells Sentry', async () => {
    h.ctx.config = { ...h.ctx.config, SENTRY_DSN: 'https://key@o0.ingest.sentry.io/1' };
    seedBaseline(24, (i) => [4, 5, 6][i % 3]!);
    const report = await makeReport('filed');
    await h.db.enqueueJob('extract_report', { reportId: report.id, metrics: { estCostUsd: 0.35 } });
    await h.db.enqueueJob('send_email', { kind: 'report_filed', reportId: report.id });
    await template(report.site_day_id);
    await template(report.site_day_id, 'failed');

    const first = (await recordReportCost(h.ctx, report.id))!;
    expect(first).toMatchObject({ alerted: true, changed: true });
    expect(h.db.data.reportCosts.get(report.id)).toMatchObject({
      org_id: ORG_ID,
      kind: 'daily',
      filed_at: FILED_AT,
      cost_cents: 35, // $0.35 AI + 1 template × $0.004
      median_cents: 5,
      sample: 24,
      outlier: true,
      detail: { aiUsd: 0.35, waTemplates: 1, waTemplateUsd: 0.004, jobs: 2 },
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({
      level: 'warn',
      msg: 'report cost outlier',
      org_id: ORG_ID,
      report_id: report.id,
      report_no: 'RL-2041-0187',
      cost_cents: 35,
      median_cents: 5,
      sample: 24,
      multiplier: 3,
    });
    expect(Sentry.captureMessage).toHaveBeenCalledTimes(1);
    expect(Sentry.captureMessage).toHaveBeenCalledWith(
      'Report cost outlier: RL-2041-0187',
      expect.objectContaining({ level: 'warning' }),
    );

    // A later job adds cost: refreshed, still an outlier, no second alert.
    await h.db.enqueueJob('parse_reply', {
      reportId: report.id,
      messageId: randomUUID(),
      metrics: { estCostUsd: 0.05 },
    });
    const second = (await recordReportCost(h.ctx, report.id))!;
    expect(second).toMatchObject({ alerted: false, changed: true });
    expect(h.db.data.reportCosts.get(report.id)!.cost_cents).toBe(40);
    // Nothing new: nothing written.
    expect(await recordReportCost(h.ctx, report.id)).toMatchObject({ changed: false });
    expect(warnings).toHaveLength(1);
    expect(Sentry.captureMessage).toHaveBeenCalledTimes(1);
  });

  it('flags and logs without Sentry when SENTRY_DSN is not set', async () => {
    seedBaseline(COST_ALERT_MIN_SAMPLE, () => 5);
    const report = await makeReport('filed');
    await h.db.enqueueJob('extract_report', { reportId: report.id, metrics: { estCostUsd: 0.2 } });
    expect(await recordReportCost(h.ctx, report.id)).toMatchObject({ alerted: true });
    expect(warnings.map((w) => w.msg)).toEqual(['report cost outlier']);
    expect(Sentry.captureMessage).not.toHaveBeenCalled();
  });

  it('does not alert below the minimum sample, at a normal cost or against other kinds / old reports', async () => {
    seedBaseline(COST_ALERT_MIN_SAMPLE - 1, () => 5);
    seedBaseline(30, () => 1, 'no_work');
    seedBaseline(30, () => 1, 'daily', 31);
    const report = await makeReport('filed');
    await h.db.enqueueJob('extract_report', { reportId: report.id, metrics: { estCostUsd: 2 } });
    expect(await recordReportCost(h.ctx, report.id)).toMatchObject({ alerted: false });
    expect(h.db.data.reportCosts.get(report.id)).toMatchObject({
      cost_cents: 200,
      median_cents: null,
      sample: COST_ALERT_MIN_SAMPLE - 1,
      outlier: false,
    });

    seedBaseline(5, () => 5);
    const normal = await makeReport('filed', 'RL-2041-0188');
    await h.db.enqueueJob('extract_report', { reportId: normal.id, metrics: { estCostUsd: 0.06 } });
    expect(await recordReportCost(h.ctx, normal.id)).toMatchObject({ alerted: false });
    expect(h.db.data.reportCosts.get(normal.id)).toMatchObject({
      cost_cents: 6,
      median_cents: 5,
      outlier: false,
    });
    expect(warnings).toEqual([]);
  });

  it('skips reports that are not filed', async () => {
    const report = await makeReport('collecting');
    await h.db.enqueueJob('extract_report', { reportId: report.id, metrics: { estCostUsd: 0.2 } });
    expect(await recordReportCost(h.ctx, report.id)).toBeNull();
    expect(h.db.data.reportCosts.size).toBe(0);
  });
});

describe('filing hook', () => {
  it('fileReport records the cost of the transcription, extraction and reminder templates', async () => {
    seedBaseline(24, () => 5);
    const report = await makeReport('awaiting_confirmation');
    await h.db.insertVersion({
      report_id: report.id,
      version: 1,
      data: emptyReportData('2026-10-09'),
      summary: null,
      author: 'agent',
    });
    const convo = await h.conversation('awaiting_confirmation', { active_report_id: report.id });
    const audio = await h.inbound(convo, { type: 'audio' });
    await h.db.insertReportSource({ report_id: report.id, message_id: audio.id, kind: 'audio' });
    // Intake job of the voice note (source message), transcription and extraction (report).
    await h.db.enqueueJob('inbound_message', {
      messageId: audio.id,
      metrics: { audioSeconds: 168 },
    });
    await h.db.enqueueJob('transcribe_audio', {
      messageId: audio.id,
      reportId: report.id,
      metrics: { audioSeconds: 168, estCostUsd: 0.0168 },
    });
    await h.db.enqueueJob('extract_report', {
      reportId: report.id,
      metrics: { estCostUsd: 0.031 },
    });
    await template(report.site_day_id);
    await template(report.site_day_id);

    const res = await fileReport(h.ctx, report.id, { trigger: 'confirm' });
    expect(res.alreadyFiled).toBe(false);
    expect(h.db.data.reportCosts.get(report.id)).toMatchObject({
      cost_cents: 6, // 0.0168 + 0.031 + 2 × 0.004 = $0.0558
      median_cents: 5,
      sample: 24,
      outlier: false,
      detail: { waTemplates: 2, jobs: 4 }, // + the render_pdf job filing just enqueued
    });
    expect(warnings).toEqual([]);
  });

  it('a failing cost estimate never fails filing', async () => {
    const report = await makeReport('awaiting_confirmation');
    await h.db.insertVersion({
      report_id: report.id,
      version: 1,
      data: emptyReportData('2026-10-09'),
      summary: null,
      author: 'agent',
    });
    vi.spyOn(h.db, 'reportCostInputs').mockRejectedValue(new Error('db down'));
    const res = await fileReport(h.ctx, report.id, { trigger: 'confirm' });
    expect(res.report.status).toBe('filed');
    expect(warnings.map((w) => w.msg)).toContain('report cost not recorded');
  });

  it('the runner refreshes a filed report after each job and keeps the cost of failed attempts', async () => {
    seedBaseline(24, () => 5);
    const report = await makeReport('filed');
    const done = await h.db.enqueueJob('extract_report', {
      reportId: report.id,
      metrics: { estCostUsd: 0.04 },
    });
    await h.db.completeJob(done);
    await recordReportCost(h.ctx, report.id);
    expect(h.db.data.reportCosts.get(report.id)!.cost_cents).toBe(4);

    const original = registry.parse_reply;
    registry.parse_reply = async (ctx) => {
      ctx.metrics.add({ estCostUsd: 0.2 });
      throw new Error('model timeout');
    };
    try {
      const id = await h.db.enqueueJob('parse_reply', {
        messageId: randomUUID(),
        reportId: report.id,
      });
      const [first] = await h.db.claimJobs('w1', 1);
      expect(first!.id).toBe(id);
      expect(await runJob(h.ctx, first!, 5_000)).toMatchObject({ ok: false });
      expect((h.db.data.jobs.get(id)!.payload as { metrics: object }).metrics).toMatchObject({
        estCostUsd: 0.2,
      });
      expect(h.db.data.reportCosts.get(report.id)!.cost_cents).toBe(24);

      h.db.data.jobs.get(id)!.run_after = h.now.toISOString();
      const [second] = await h.db.claimJobs('w1', 1);
      expect(second!.attempts).toBe(2);
      await runJob(h.ctx, second!, 5_000);
      expect((h.db.data.jobs.get(id)!.payload as { metrics: object }).metrics).toMatchObject({
        estCostUsd: 0.2,
        costUsdTotal: 0.4,
      });
      expect(h.db.data.reportCosts.get(report.id)).toMatchObject({
        cost_cents: 44,
        outlier: true,
      });
      expect(warnings.map((w) => w.msg)).toContain('report cost outlier');
    } finally {
      registry.parse_reply = original;
    }
  });
});
