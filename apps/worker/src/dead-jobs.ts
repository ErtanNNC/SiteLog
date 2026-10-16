import * as Sentry from '@sentry/node';
import {
  JOB_MAX_ATTEMPTS,
  noticeData,
  type JobRow,
  type JobTypeKey,
  type NoticeData,
} from '@sitelog/shared';
import type { Ctx } from './context';
import { rawPayload } from './jobs/types';

/**
 * A job that died (spec §10.1: after the last retry → `dead`, Sentry alert, "office notified for
 * reporter-facing failures"; W1-10). Before W1-10 the reporter got a WhatsApp `error_retry`; now
 * the office is told in the panel and the death is audited:
 *
 * - a message to or from a reporter (`MESSAGE_JOB_TYPES`): `message_failed`, §13 "Message
 *   undeliverable / opted out" (ops, admin), linked to Team;
 * - a step of a report's processing (`REPORT_JOB_TYPES`): `processing_failed` (the office
 *   audience of needs_review and processing_delayed: admin, pm, ops), linked to the report;
 * - anything else (PDF, email, weather, packs, digest, retention) faces the office, not a reporter:
 *   Sentry and /ops only.
 *
 * Every dead job is audited `job.dead` (the org when the job names one). Which jobs count as
 * reporter-facing, and the notice's audience, are spec §19 Q54.
 */

export const MESSAGE_JOB_TYPES: readonly JobTypeKey[] = [
  'notify',
  'send_welcome',
  'sms_inbound',
  'sms_keyword',
  // W2-16: a WhatsApp text read as an answer (the message names the reporter).
  'whatsapp_answer',
  'send_message',
  'send_template',
  'inbound_message',
];

export const REPORT_JOB_TYPES: readonly JobTypeKey[] = [
  'transcribe_upload',
  'transcribe_audio',
  'extract_report',
  'decide_next',
  'parse_reply',
  'parse_answer',
  'apply_correction',
  'file_report',
];

export interface DeadJobSubject {
  orgId: string | null;
  reporter: { id: string; name: string } | null;
  report: { id: string; reportNo: string } | null;
  message: { id: string } | null;
}

export interface DeadJobNotice {
  kind: 'message_failed' | 'processing_failed';
  title: string;
  body: string;
  targetPath: string;
  /** What the panel renders in the reader's language; title and body are the English fallback. */
  data: NoticeData;
}

/** What the dead job was about: its org, reporter, report or message, from its payload. */
export async function deadJobSubject(ctx: Ctx, job: JobRow): Promise<DeadJobSubject> {
  const p = rawPayload(job);
  const str = (k: string) => (typeof p[k] === 'string' ? (p[k] as string) : null);
  const out: DeadJobSubject = { orgId: null, reporter: null, report: null, message: null };
  let reporterId = str('reporterId');
  let reportId = str('reportId');

  const uploadId = str('uploadId');
  if (uploadId) {
    const u = await ctx.db.getUploadOwner(uploadId);
    reportId ??= u?.report_id ?? null;
    reporterId ??= u?.reporter_id ?? null;
  }
  const messageId = str('messageId');
  if (messageId) {
    const m = await ctx.db.getMessage(messageId);
    if (m) {
      out.message = { id: m.id };
      out.orgId = m.org_id ?? null;
      reporterId ??= m.reporter_id ?? null;
    }
  }
  const conversationId = str('conversationId');
  if (conversationId && !reporterId) {
    const c = await ctx.db.getConversation(conversationId);
    out.orgId ??= c?.org_id ?? null;
    reporterId = c?.reporter_id ?? null;
  }
  if (reportId) {
    const r = await ctx.db.getReport(reportId);
    if (r) {
      out.report = { id: r.id, reportNo: r.report_no };
      out.orgId = r.org_id;
      reporterId ??= r.reporter_id ?? null;
    }
  }
  if (reporterId) {
    const rep = await ctx.db.getReporter(reporterId);
    if (rep) {
      out.reporter = { id: rep.id, name: rep.name };
      out.orgId ??= rep.org_id;
    }
  }
  out.orgId ??= str('orgId');
  return out;
}

/** The office's panel notice for a dead job, or null when the job faces no reporter. */
export function deadJobNotice(job: JobRow, s: DeadJobSubject): DeadJobNotice | null {
  const type = job.type as JobTypeKey;
  const tries = `SiteLog tried ${JOB_MAX_ATTEMPTS} times over about three hours and has stopped`;
  if (MESSAGE_JOB_TYPES.includes(type) && s.reporter) {
    const inbound = type === 'sms_inbound' || type === 'sms_keyword' || type === 'inbound_message';
    return {
      kind: 'message_failed',
      title: inbound
        ? `${s.reporter.name}: a message from them was not handled`
        : `${s.reporter.name}: a message to them was not sent`,
      body: `${tries} (${type}). They may be waiting for an answer; contact them directly if it matters today. SiteLog has been alerted.`,
      targetPath: '/team',
      data: noticeData(inbound ? 'message_not_handled' : 'message_not_sent', {
        name: s.reporter.name,
        job: type,
        tries: JOB_MAX_ATTEMPTS,
      }),
    };
  }
  if (REPORT_JOB_TYPES.includes(type) && s.report) {
    return {
      kind: 'processing_failed',
      title: `${s.report.reportNo}: processing stopped`,
      body: `${tries} (${type}). The reporter may be waiting for their draft. SiteLog has been alerted; open the report to check its sources.`,
      targetPath: `/reports/${s.report.id}`,
      data: noticeData('processing_failed', {
        reportNo: s.report.reportNo,
        job: type,
        tries: JOB_MAX_ATTEMPTS,
      }),
    };
  }
  return null;
}

/** Sentry, the office's notice (when the job faced a reporter) and the `job.dead` audit row. */
export async function onDeadJob(ctx: Ctx, job: JobRow, err: unknown): Promise<void> {
  ctx.log.error('job dead', { err });
  Sentry.captureException(err instanceof Error ? err : new Error(String(err)), {
    tags: { job_type: job.type },
    extra: { job_id: job.id, payload: job.payload },
  });
  try {
    const subject = await deadJobSubject(ctx, job);
    const notice = subject.orgId ? deadJobNotice(job, subject) : null;
    if (notice && subject.orgId) {
      await ctx.db.notifyOrg(
        subject.orgId,
        notice.kind,
        notice.title,
        notice.body,
        notice.targetPath,
        null,
        notice.data,
      );
    }
    const entity = subject.report
      ? { entity: 'report', entity_id: subject.report.id }
      : subject.reporter
        ? { entity: 'reporter', entity_id: subject.reporter.id }
        : subject.message
          ? { entity: 'message', entity_id: subject.message.id }
          : { entity: 'job', entity_id: null };
    await ctx.db.logAudit({
      org_id: subject.orgId,
      actor_type: 'system',
      action: 'job.dead',
      ...entity,
      diff: {
        job_id: job.id,
        type: job.type,
        attempts: job.attempts,
        notified: notice?.kind ?? null,
      },
    });
  } catch (noticeErr) {
    ctx.log.warn('dead-job notice failed', { err: noticeErr });
    Sentry.captureException(noticeErr);
  }
}
