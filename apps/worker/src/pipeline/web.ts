import { randomUUID } from 'node:crypto';
import {
  applyAnswer,
  ensurePersonalLink,
  fieldLinkUrl,
  jobKeys,
  readReportData,
  sourceMediaId,
  type DailyReportData,
  type JobPayloads,
  type JobRow,
  type OrgSettingsRow,
  type CompanyRow,
  type QuestionRow,
  type AnswerValue,
  type QuestionField,
  type QuestionSpec,
  type ReportRow,
  type ReportSourceRow,
  type ReportStatus,
  type StoredReportData,
  type ValidationResult,
} from '@sitelog/shared';
import type { Ctx } from '../context';
import type { Json } from '../db';
import { workerLinkStore } from '../messaging';
import {
  TIMEOUT_POLICY_DEFAULTS,
  answerTimedOut,
  answerTimeoutAt,
  confirmationSchedule,
  type TimeoutPolicy,
} from './timeouts';
import { fileReport } from './file';
import { selectNextQuestion, validateDraft } from './validate';

/**
 * The web recorder's pipeline after extraction (W1-12; spec §7.2, §10.1 `decide_next`, §10.5):
 * report data v2, questions on the `web` channel, and the reporter told by the Notifier only when
 * they are not looking at the field app (GAP D25). The WhatsApp worker keeps its own pipeline
 * (`decide_next` for a report with no channel) until step 22.
 *
 * `decide_next` is split in two: `planWebNext` decides what comes next from the draft and the
 * questions (pure), and `decideNextWeb` applies it (the question row, the report status, audit),
 * starts the §7.2 clock and enqueues the one `notify` job. Every step is idempotent: a retry finds
 * the question it inserted open and waits for it, and every job is keyed (the text per question or
 * per decide job for the draft, the timeouts per question or per draft revision), so nothing is
 * sent, nudged or filed twice.
 *
 * W2-07 (§7.2 web rules, spec §19 Q61):
 * - The text is a `notify` job with a report guard (the question still open, the draft still
 *   unconfirmed at that revision), so a late failure falls back to the next channel (W2-01) only
 *   while it is still useful. While the reporter's device was seen in the last 30 s the job runs
 *   30 s later and sends only if no device of theirs was seen since (Q61: they left the recorder
 *   right after; one job per key, so it can never text twice).
 * - A question starts its 60-minute clock (a delayed decide_next, `timeout.step 'answer'`): the
 *   question is recorded unanswered and the draft built with the gap flagged, no text (F7).
 * - A draft starts the confirmation clock (`pipeline/timeouts.ts`): the nudge at +30 min (a
 *   delayed `notify`, Q78's key, through the quiet hours of Q77) and the filing at +2 h (a delayed
 *   decide_next, `timeout.step 'file'`, trigger `timeout`, reason `unconfirmed`), or the filing at
 *   +15 min with `filing_mode = 'auto_15min'`; keyed per version and draft revision, so a newer
 *   draft restarts the clock and the old steps find their draft gone.
 */

/** D25: no `question_ready` / `draft_ready` text while the field app was used this recently. */
export const DEVICE_ACTIVE_MS = 30_000;

/** Report statuses decide_next may move from (never a filed, signed-off or void report). */
const OPEN_STATUSES: readonly ReportStatus[] = [
  'collecting',
  'processing',
  'awaiting_answer',
  'awaiting_confirmation',
];

/** A report of the web recorder (field-api sets channel 'web'). */
export function isWebReport(report: Pick<ReportRow, 'channel'>): boolean {
  return report.channel === 'web';
}

/** The current draft in v2 terms (a v1 draft is read through the upgrade). */
export async function currentDraftV2(ctx: Ctx, report: ReportRow): Promise<DailyReportData | null> {
  const v = await ctx.db.getVersion(report.id, report.current_version || 1);
  return v?.data ? readReportData(v.data as StoredReportData) : null;
}

/**
 * Drafts are overwritten in place until filing (as the WhatsApp drafts). False, and nothing
 * written, when the report is no longer a draft (filed, signed off, void; a filing in progress
 * commits first): a filed version is never overwritten.
 */
export async function storeWebDraft(
  ctx: Ctx,
  report: ReportRow,
  data: DailyReportData,
): Promise<boolean> {
  const stored = await ctx.db.storeDraftVersion({
    report_id: report.id,
    version: report.current_version || 1,
    data,
    summary: data.summary || null,
    author: 'agent',
    author_message_id: null,
    change_note: null,
  });
  if (!stored)
    ctx.log.info('draft not stored: the report is no longer a draft', { report_id: report.id });
  return stored !== null;
}

/**
 * Photos are added to the draft by code, not the model (§10.4): a photo of the report the draft
 * does not list yet is appended. Pure; null when nothing changed.
 */
export function withReportPhotos(
  data: DailyReportData,
  sources: ReadonlyArray<
    Pick<ReportSourceRow, 'message_id' | 'upload_id' | 'kind' | 'caption' | 'taken_at'> & {
      message_created_at?: string;
    }
  >,
  now: Date,
): DailyReportData | null {
  const have = new Set(data.photos.map((p) => p.uploadId));
  const missing = sources.flatMap((s) => {
    const id = sourceMediaId(s);
    return s.kind === 'photo' && id && !have.has(id) ? [{ ...s, id }] : [];
  });
  if (missing.length === 0) return null;
  return {
    ...data,
    photos: [
      ...data.photos,
      ...missing.map((s) => ({
        uploadId: s.id,
        ...(s.caption ? { caption: s.caption } : {}),
        takenAt: s.taken_at ?? s.message_created_at ?? now.toISOString(),
      })),
    ],
  };
}

/**
 * After a re-extraction (more audio, a photo on the draft), the reporter's answers still stand: an
 * answered question whose gap the new draft has again gets its stored answer applied again, in
 * code (the model is told the answers too, §10.4 rule 7, but code does not rely on it). The crew
 * is found by name, since a new extraction may order the crews differently. Pure.
 */
export function reapplyAnswers(
  data: DailyReportData,
  questions: ReadonlyArray<Pick<QuestionRow, 'id' | 'field' | 'target' | 'answer' | 'answered_at'>>,
  gapPaths: ReadonlySet<string>,
  ctx: { defaultShiftHours: number; workingHours: string | null },
): { data: DailyReportData; reapplied: string[] } {
  let out = data;
  const reapplied: string[] = [];
  for (const q of questions) {
    const answer = q.answer as { parsed?: AnswerValue } | null;
    if (!q.answered_at || !answer?.parsed || !gapPaths.has(questionPath(q))) continue;
    const target = { ...((q.target ?? {}) as QuestionSpec['target']) };
    if (target.manpowerIndex !== undefined) {
      const name = target.companyName ?? target.companyNameHeard;
      const index = out.manpower.findIndex(
        (m) => m.companyName === name || m.companyNameHeard === target.companyNameHeard,
      );
      if (index < 0) continue;
      target.manpowerIndex = index;
    }
    out = applyAnswer(out, { field: q.field as QuestionField, target }, answer.parsed, {
      defaultShiftHours: ctx.defaultShiftHours,
      workingHours: ctx.workingHours,
      source: { type: 'answer', questionId: q.id },
    }).data;
    reapplied.push(q.id);
  }
  return { data: out, reapplied };
}

/** questions.target carries the gap path. */
export function questionPath(q: Pick<QuestionRow, 'target' | 'field'>): string {
  return ((q.target ?? {}) as { path?: string }).path ?? q.field;
}

export type WebPlan =
  /** The open question still asks for a gap: keep waiting for its answer. */
  | { kind: 'wait'; question: QuestionRow }
  /** Ask the next question; `resolve` is an open question a re-extraction answered. */
  | { kind: 'ask'; spec: QuestionSpec; resolve: string | null }
  /** Nothing left to ask (or the limit reached): show the draft. */
  | { kind: 'draft'; resolve: string | null };

export interface WebPlanInput {
  data: DailyReportData;
  validation: ValidationResult;
  questions: QuestionRow[];
  settings: Pick<OrgSettingsRow, 'max_questions_per_report'>;
  companies: CompanyRow[];
  /** The reporter's locale, for the fallback questions. */
  language: string | null;
}

/** §10.5 steps 4–6 for the web: one question at a time, then the draft. Pure. */
export function planWebNext(input: WebPlanInput): WebPlan {
  const open = input.questions.find((q) => !q.answered_at) ?? null;
  let questions = input.questions;
  if (open) {
    if (input.validation.gaps.some((g) => g.path === questionPath(open)))
      return { kind: 'wait', question: open };
    // A re-extraction closed the gap: the question counts as asked and answered.
    questions = questions.map((q) =>
      q.id === open.id ? { ...q, answered_at: new Date(0).toISOString() } : q,
    );
  }
  const spec = selectNextQuestion(
    input.data,
    input.validation,
    questions,
    input.settings,
    input.companies,
    input.language,
  );
  return spec
    ? { kind: 'ask', spec, resolve: open?.id ?? null }
    : { kind: 'draft', resolve: open?.id ?? null };
}

/** D25: was a device of the reporter seen within `DEVICE_ACTIVE_MS` of `now`? Pure. */
export function deviceActive(lastSeen: string | null, now: Date): boolean {
  if (!lastSeen) return false;
  return now.getTime() - new Date(lastSeen).getTime() < DEVICE_ACTIVE_MS;
}

/** §10.1 decide_next for a web report: state changes, the §7.2 clock, then at most one text. */
export async function decideNextWeb(
  ctx: Ctx,
  report: ReportRow,
  job: JobRow,
  timeout?: JobPayloads['decide_next']['timeout'],
  policy: TimeoutPolicy = TIMEOUT_POLICY_DEFAULTS,
): Promise<void> {
  if (timeout?.step === 'file') return fileTimeoutWeb(ctx, report, timeout);
  // A newer extraction (another voice note, a photo on the draft) decides after it.
  if (await ctx.db.hasActiveReportJob('extract_report', report.id)) {
    ctx.log.info('decide_next: an extraction is pending; it decides', { report_id: report.id });
    return;
  }
  const voice = await ctx.db.listReportVoiceUploads(report.id);
  if (voice.some((u) => !u.transcribed)) {
    ctx.log.info('decide_next: a voice note is not transcribed yet', { report_id: report.id });
    return;
  }
  const site = await ctx.db.siteContext(report.site_id);
  if (!site) throw new Error(`site ${report.site_id} not found`);
  const reporter = report.reporter_id ? await ctx.db.getReporter(report.reporter_id) : null;
  let data = await currentDraftV2(ctx, report);
  if (!data) throw new Error(`report ${report.id} has no draft`);

  const sources = await ctx.db.listReportSources(report.id);
  const withPhotos = withReportPhotos(data, sources, ctx.now());
  if (withPhotos) {
    data = withPhotos;
    if (!(await storeWebDraft(ctx, report, data))) return;
  }
  const photoCount = sources.filter((s) => s.kind === 'photo').length;
  const validation = validateDraft(data, site.settings, photoCount);
  const now = ctx.now();
  // §7.2 / F7: the open question unanswered for 60 min → recorded unanswered, then the draft.
  const timedOut =
    timeout?.step === 'answer' ? await answerTimeoutWeb(ctx, report, timeout.questionId) : null;
  if (timeout?.step === 'answer' && !timedOut) return;
  const questions = await ctx.db.listQuestions(report.id);
  const plan: WebPlan = timedOut
    ? { kind: 'draft', resolve: null }
    : planWebNext({
        data,
        validation,
        questions,
        settings: site.settings,
        companies: site.companies,
        language: reporter?.locale ?? site.org.locale,
      });

  if (plan.kind !== 'wait' && plan.resolve) {
    await ctx.db.updateQuestion(plan.resolve, {
      answered_at: now,
      answer: { resolved_by: 'extraction' },
    });
    await ctx.db.logAudit({
      org_id: report.org_id,
      actor_type: 'agent',
      action: 'report.question_resolved',
      entity: 'report',
      entity_id: report.id,
      diff: { question_id: plan.resolve, by: 'extraction' },
    });
  }

  let questionId: string | null = plan.kind === 'wait' ? plan.question.id : null;
  if (plan.kind === 'ask') {
    const q = await ctx.db.insertQuestion({
      report_id: report.id,
      field: plan.spec.field,
      target: { ...plan.spec.target, path: plan.spec.path } as Json,
      prompt: plan.spec.prompt,
      options: plan.spec.options as unknown as Json,
      asked_at: now,
      channel: 'web',
    });
    questionId = q.id;
    await ctx.db.logAudit({
      org_id: report.org_id,
      actor_type: 'agent',
      action: 'report.question_asked',
      entity: 'report',
      entity_id: report.id,
      diff: {
        question_id: q.id,
        field: plan.spec.field,
        channel: 'web',
        options: plan.spec.options.length,
      },
    });
  }

  const to: ReportStatus = plan.kind === 'draft' ? 'awaiting_confirmation' : 'awaiting_answer';
  const changed = await ctx.db.setReportStatus(report.id, to, OPEN_STATUSES);
  if (changed && report.status !== to) {
    const latest = voice.reduce<string | null>(
      (a, u) => (u.received_at && (!a || u.received_at > a) ? u.received_at : a),
      null,
    );
    const sinceUploadMs = latest ? now.getTime() - new Date(latest).getTime() : null;
    ctx.metrics.add({ uploadToDecisionMs: sinceUploadMs, decided: plan.kind });
    ctx.log.info(plan.kind === 'draft' ? 'draft ready' : 'question ready', {
      report_id: report.id,
      upload_to_decision_ms: sinceUploadMs,
    });
    await ctx.db.logAudit({
      org_id: report.org_id,
      actor_type: 'agent',
      action: 'report.status_changed',
      entity: 'report',
      entity_id: report.id,
      diff: { from: report.status, to, question_id: questionId },
    });
  }
  if (!changed) {
    ctx.log.info('decide_next: report closed meanwhile', { report_id: report.id });
    return;
  }

  // The §7.2 clock of what the reporter now has in front of them.
  let guard: NotifyReportGuard;
  if (plan.kind === 'draft') {
    const version = report.current_version || 1;
    const draftRev = (await ctx.db.getVersion(report.id, version))?.draft_rev ?? 1;
    guard = { reportId: report.id, status: 'awaiting_confirmation', version, draftRev };
    await startConfirmationClock(ctx, report, reporter?.id ?? null, site.settings, {
      version,
      draftRev,
      shownAt: now,
      policy,
    });
  } else {
    const question = plan.kind === 'wait' ? plan.question : await ctx.db.getQuestion(questionId!);
    guard = { reportId: report.id, status: 'awaiting_answer', questionId: questionId! };
    if (question) await startAnswerClock(ctx, report, question);
  }

  if (!reporter) return;
  if (timedOut) {
    // F7: the reporter sees the draft next time they open the link; the nudge may follow.
    ctx.log.info('decide_next: question timed out, draft without a text', {
      report_id: report.id,
      question_id: timedOut.id,
    });
    return;
  }
  const notice: Notice =
    plan.kind === 'draft'
      ? { key: 'draft_ready', dedupeKey: jobKeys.draftReady(report.id, job.id) }
      : { key: 'question_ready', dedupeKey: jobKeys.questionReady(questionId!) };
  const lastSeen = await ctx.db.reporterDeviceLastSeen(reporter.id);
  const active = deviceActive(lastSeen, now);
  const delayMs = active ? DEVICE_ACTIVE_MS : 0;
  if (active) {
    // D25 and spec §19 Q61: the reporter is on the recorder and sees it there; if they leave
    // right after (no device seen in the next 30 s), the text goes out then.
    await ctx.db.logAudit({
      org_id: report.org_id,
      actor_type: 'system',
      action: 'notify.deferred',
      entity: 'report',
      entity_id: report.id,
      diff: {
        key: notice.key,
        reason: 'device_active',
        last_seen_at: lastSeen,
        dedupe_key: notice.dedupeKey,
        delay_ms: delayMs,
      },
    });
  }
  await enqueueReporterText(
    ctx,
    reporter.id,
    report.org_id,
    notice,
    {
      ...guard,
      ...(active ? { deviceNotSeenAfter: now.toISOString() } : {}),
    },
    delayMs,
  );
}

type NotifyReportGuard = NonNullable<JobPayloads['notify']['reportGuard']>;

/** One `question_ready` / `draft_ready` text and the key of its `notify` job and the Notifier's. */
interface Notice {
  key: 'question_ready' | 'draft_ready';
  dedupeKey: string;
}

/**
 * The text as a `notify` job (W2-07) with the reporter's personal link (the field app opens the
 * question or the draft) and the report guard the job checks before it sends.
 */
async function enqueueReporterText(
  ctx: Ctx,
  reporterId: string,
  orgId: string,
  notice: Notice,
  reportGuard: NotifyReportGuard,
  delayMs: number,
): Promise<void> {
  const { base, code } = await personalLinkCode(ctx, reporterId, orgId);
  await ctx.db.enqueueJob(
    'notify',
    {
      reporterId,
      key: notice.key,
      vars: { link: fieldLinkUrl(base, code) },
      dedupeKey: notice.dedupeKey,
      reportGuard,
    },
    { dedupeKey: notice.dedupeKey, delayMs },
  );
}

/**
 * F7's clock for an open web question: a delayed decide_next at asked + 60 min, keyed per
 * question (a retried decide_next finds it taken). Delays are measured from the database's clock
 * (`delayMs`), the one the queue reads.
 */
async function startAnswerClock(ctx: Ctx, report: ReportRow, question: QuestionRow) {
  const askedAt = new Date(question.asked_at ?? question.created_at);
  await ctx.db.enqueueJob(
    'decide_next',
    { reportId: report.id, timeout: { step: 'answer', questionId: question.id } },
    {
      dedupeKey: jobKeys.decideTimeout(report.id, question.id),
      delayMs: answerTimeoutAt(askedAt).getTime() - ctx.now().getTime(),
    },
  );
}

/**
 * §7.2's confirmation clock for a web draft shown at `shownAt`: the nudge (a delayed `notify` with
 * Q78's key, guarded by the draft and the quiet hours) and the filing (a delayed decide_next),
 * each keyed per version and draft revision.
 */
async function startConfirmationClock(
  ctx: Ctx,
  report: ReportRow,
  reporterId: string | null,
  settings: Pick<OrgSettingsRow, 'filing_mode'>,
  draft: { version: number; draftRev: number; shownAt: Date; policy: TimeoutPolicy },
): Promise<void> {
  const { version, draftRev } = draft;
  for (const step of confirmationSchedule(draft.shownAt, settings.filing_mode)) {
    if (step.kind === 'file') {
      await ctx.db.enqueueJob(
        'decide_next',
        {
          reportId: report.id,
          timeout: { step: 'file', trigger: step.trigger, version, draftRev },
        },
        {
          dedupeKey: jobKeys.decideFileTimeout(report.id, version, draftRev),
          delayMs: step.at.getTime() - draft.shownAt.getTime(),
        },
      );
    } else if (reporterId) {
      const { base, code } = await personalLinkCode(ctx, reporterId, report.org_id);
      const nudgeKey = jobKeys.draftNudge(report.id, version, draftRev);
      await ctx.db.enqueueJob(
        'notify',
        {
          reporterId,
          key: draft.policy.nudgeKey,
          vars: { link: fieldLinkUrl(base, code) },
          dedupeKey: nudgeKey,
          reportGuard: {
            reportId: report.id,
            status: 'awaiting_confirmation',
            version,
            draftRev,
            quietHours: true,
          },
        },
        { dedupeKey: nudgeKey, delayMs: step.at.getTime() - draft.shownAt.getTime() },
      );
    }
  }
}

/**
 * The answer timeout's re-check (§7.2, F7): the report still awaits that question, which is still
 * open and asked at least 60 min ago; then it is recorded unanswered (a guarded update: an answer
 * committing first wins), the report flagged `unanswered:<field>` and audited. Null, and nothing
 * changed, when the question was answered or the report moved on meanwhile.
 */
async function answerTimeoutWeb(
  ctx: Ctx,
  report: ReportRow,
  questionId: string,
): Promise<QuestionRow | null> {
  const question = await ctx.db.getQuestion(questionId);
  const now = ctx.now();
  if (
    report.status !== 'awaiting_answer' ||
    !question ||
    question.report_id !== report.id ||
    question.answered_at
  ) {
    ctx.log.info('answer timeout: the question is no longer open', {
      report_id: report.id,
      question_id: questionId,
      status: report.status,
    });
    return null;
  }
  // The job runs at asked + 60 min (run_after); one claimed early by a skewed clock retries.
  if (!answerTimedOut(new Date(question.asked_at ?? question.created_at), now))
    throw new Error(`question ${question.id} has not timed out yet`);
  if (!(await ctx.db.timeOutQuestion(question.id, now))) return null;
  const reason = `unanswered:${question.field}`;
  await ctx.db.updateReport(report.id, {
    needs_review: true,
    review_reasons: [...new Set([...report.review_reasons, reason])],
  });
  await ctx.db.logAudit({
    org_id: report.org_id,
    actor_type: 'system',
    action: 'report.question_timeout',
    entity: 'report',
    entity_id: report.id,
    diff: { question_id: question.id, field: question.field, channel: 'web', reason },
  });
  return question;
}

/**
 * The confirmation timeout (§7.2): files the draft only while it is still awaiting confirmation at
 * the version and revision whose clock this is (a confirm, a newer draft or more audio since leave
 * it alone; `fileReport` checks again in its transaction, `report.timeout_stale`).
 */
async function fileTimeoutWeb(
  ctx: Ctx,
  report: ReportRow,
  timeout: Extract<NonNullable<JobPayloads['decide_next']['timeout']>, { step: 'file' }>,
): Promise<void> {
  const current = await ctx.db.getVersion(report.id, report.current_version || 1);
  if (
    report.status !== 'awaiting_confirmation' ||
    (report.current_version || 1) !== timeout.version ||
    (current?.draft_rev ?? 1) !== timeout.draftRev
  ) {
    ctx.log.info('confirmation timeout: the draft moved on', {
      report_id: report.id,
      status: report.status,
      version: timeout.version,
      draft_rev: timeout.draftRev,
    });
    return;
  }
  const result = await fileReport(ctx, report.id, {
    trigger: timeout.trigger,
    version: timeout.version,
    draftRev: timeout.draftRev,
  });
  ctx.log.info(result.stale ? 'confirmation timeout: stale' : 'report filed by timeout', {
    report_id: report.id,
    trigger: timeout.trigger,
  });
}

/**
 * The reporter's personal link code (created and audited when they have none the secret can
 * derive) and the field app's base URL, for a text that carries the link (`question_ready`,
 * `draft_ready`, `filed`). Missing configuration throws: retried with backoff, then dead
 * (processing_failed) and in Sentry.
 */
export async function personalLinkCode(
  ctx: Ctx,
  reporterId: string,
  orgId: string,
): Promise<{ base: string; code: string }> {
  if (!ctx.config.LINK_SIGNING_SECRET) throw new Error('LINK_SIGNING_SECRET is not set');
  if (!ctx.config.FIELD_APP_URL) throw new Error('FIELD_APP_URL is not set');
  const link = await ensurePersonalLink(
    workerLinkStore(ctx.db),
    ctx.config.LINK_SIGNING_SECRET,
    reporterId,
    randomUUID,
  );
  if (link.created) {
    await ctx.db.logAudit({
      org_id: orgId,
      actor_type: 'system',
      action: 'field_link.created',
      entity: 'reporter',
      entity_id: reporterId,
      diff: { kind: 'personal', site_id: null, report_date: null },
    });
  }
  return { base: ctx.config.FIELD_APP_URL, code: link.code };
}
