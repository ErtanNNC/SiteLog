/**
 * /ops in demo mode: a small fixed sample (two dead jobs, one cost outlier on a real Kestrel
 * report) so the page can be seen without Supabase. Retry / discard mutate it for the session
 * and keep an audit trail like ops_retry_job / ops_discard_job do.
 */
import { copy } from '@/copy/en';
import type { OpsCostOutlier, OpsData, OpsDeadJob, OpsQueueRow } from '../types';
import type { DemoStore } from './store';

export interface DemoOpsAuditRow {
  action: 'ops.job_retried' | 'ops.job_discarded';
  jobId: number;
  type: string;
  actorId: string;
  at: string;
}

const minutesBefore = (now: Date, min: number) =>
  new Date(now.getTime() - min * 60_000).toISOString();

/** The Monday of a date's ISO week (YYYY-MM-DD). */
function isoMonday(date: string): string {
  const d = new Date(`${date}T12:00:00Z`);
  const back = (d.getUTCDay() + 6) % 7;
  return new Date(d.getTime() - back * 86_400_000).toISOString().slice(0, 10);
}

export class DemoOps {
  readonly audit: DemoOpsAuditRow[] = [];
  private queue: OpsQueueRow[];
  private deadJobs: OpsDeadJob[];
  private outliers: OpsCostOutlier[];

  constructor(private readonly store: DemoStore) {
    const now = store.now;
    const rows = store.rows();
    const filed = rows.reports
      .filter((r) => r.kind === 'daily' && r.filed_at && r.status !== 'void')
      .sort((a, b) => (b.filed_at ?? '').localeCompare(a.filed_at ?? ''));
    const report = filed.find((r) => r.status === 'signed_off') ?? filed[0];
    const site = rows.sites.find((s) => s.id === report?.site_id);
    const day = rows.siteDays.find((d) => d.id === report?.site_day_id);

    this.queue = [
      { type: 'extract_report', queued: 1, running: 0, dead: 0, oldestDueSeconds: 6 },
      { type: 'inbound_message', queued: 0, running: 1, dead: 0, oldestDueSeconds: null },
      { type: 'render_pdf', queued: 0, running: 0, dead: 1, oldestDueSeconds: null },
      { type: 'send_template', queued: 3, running: 0, dead: 1, oldestDueSeconds: null },
      { type: 'transcribe_audio', queued: 2, running: 1, dead: 0, oldestDueSeconds: 14 },
    ];
    this.deadJobs = [
      {
        id: 48213,
        type: 'render_pdf',
        attempts: 5,
        lastError: 'StorageError: upload to pdfs timed out after 30000 ms',
        createdAt: minutesBefore(now, 190),
        finishedAt: minutesBefore(now, 22),
        payload: {
          ...(report ? { reportId: report.id } : {}),
          version: 1,
          sendToWhatsApp: true,
          emailRecipients: true,
        },
      },
      {
        id: 48190,
        type: 'send_template',
        attempts: 5,
        lastError: 'WhatsApp API error 132001: template sitelog_reminder_2 does not exist in en_US',
        createdAt: minutesBefore(now, 260),
        finishedAt: minutesBefore(now, 95),
        payload: {
          ...(day ? { siteDayId: day.id } : {}),
          template: 'sitelog_reminder_2',
          stage: 2,
        },
      },
    ];
    this.outliers =
      report && site
        ? [
            {
              reportId: report.id,
              reportNo: report.report_no,
              orgId: rows.org.id,
              orgName: rows.org.name,
              siteId: site.id,
              siteName: site.name,
              filedAt: report.filed_at!,
              costCents: 41,
              medianCents: 6,
              sample: 412,
              aiUsd: 0.392,
              waTemplates: 3,
            },
          ]
        : [];
  }

  snapshot(): OpsData {
    return structuredClone({
      queue: this.queue,
      deadJobs: this.deadJobs,
      costOutliers: this.outliers,
      outboundCalls: this.outboundCalls(),
    });
  }

  /**
   * W3-17 (M8): the seeded org's outbound calls per ISO week, as `ops_outbound_call_share()`
   * counts them: site-days with an outbound reminder or callback, and those filed on such a call.
   */
  private outboundCalls(): OpsData['outboundCalls'] {
    const rows = this.store.rows();
    const dayOf = new Map(rows.siteDays.map((d) => [d.id, d.date]));
    const weeks = new Map<string, Map<string, boolean>>();
    for (const c of rows.calls ?? []) {
      if (c.direction !== 'outbound' || !c.site_day_id) continue;
      if (c.purpose !== 'reminder' && c.purpose !== 'callback') continue;
      const date = dayOf.get(c.site_day_id);
      if (!date) continue;
      const week = isoMonday(date);
      const days = weeks.get(week) ?? new Map<string, boolean>();
      days.set(c.site_day_id, (days.get(c.site_day_id) ?? false) || c.outcome === 'filed');
      weeks.set(week, days);
    }
    return [...weeks.entries()]
      .sort(([a], [b]) => b.localeCompare(a))
      .map(([weekStart, days]) => ({
        orgId: rows.org.id,
        orgName: rows.org.name,
        isDemo: rows.org.is_demo,
        weekStart,
        callDays: days.size,
        filedByCall: [...days.values()].filter(Boolean).length,
      }));
  }

  retry(jobId: number, actorId: string): void {
    const job = this.take(jobId);
    const row = this.queue.find((q) => q.type === job.type);
    if (row) {
      row.dead = Math.max(0, row.dead - 1);
      row.queued += 1;
      row.oldestDueSeconds = row.oldestDueSeconds ?? 0;
    }
    this.log('ops.job_retried', job, actorId);
  }

  discard(jobId: number, actorId: string): void {
    const job = this.take(jobId);
    const row = this.queue.find((q) => q.type === job.type);
    if (row) row.dead = Math.max(0, row.dead - 1);
    this.log('ops.job_discarded', job, actorId);
  }

  private take(jobId: number): OpsDeadJob {
    const i = this.deadJobs.findIndex((j) => j.id === jobId);
    if (i < 0) throw new Error(copy.ops.notDead);
    return this.deadJobs.splice(i, 1)[0]!;
  }

  private log(action: DemoOpsAuditRow['action'], job: OpsDeadJob, actorId: string): void {
    this.audit.push({ action, jobId: job.id, type: job.type, actorId, at: this.store.nowIso() });
  }
}

const byStore = new WeakMap<DemoStore, DemoOps>();

/** One ops sample per demo store, so retries survive a DemoSource re-creation (org / role switch). */
export function demoOpsFor(store: DemoStore): DemoOps {
  let ops = byStore.get(store);
  if (!ops) {
    ops = new DemoOps(store);
    byStore.set(store, ops);
  }
  return ops;
}
