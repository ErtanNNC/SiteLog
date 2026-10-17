import { randomUUID } from 'node:crypto';
import {
  SourceSchema,
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
  type AppliedFix,
  type CorrectionChange,
  type DraftCorrectionRow,
  type QuestionField,
  type QuestionSpec,
  type ReportRow,
  type ReportSourceRow,
  type ReportStatus,
  type Source,
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
import {
  CONSENT_REVIEW_REASON,
  revokedProcessingConsents,
  type ProcessingConsent,
} from './consent';
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
 * - A timer never ends the clock by finding the report busy: the answer timeout that fires while
 *   an extraction runs, a clip waits for its transcript or the report processes more audio is
 *   armed again a few minutes on (`rearmGraceMs`), and a question or draft shown with no live
 *   timer (one finished without acting, a re-extraction wrote the same draft) gets a new one
 *   (`jobKeys.rearm`, since a key names one job for good).
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

/**
 * A v1.2 report: the web recorder's (field-api sets channel 'web') or, W3-09, a call's (channel
 * 'voice', voice_turn_submit()). Both are report data v2; a call report's later voice notes,
 * photos and answers on the recorder (§7.2: one report per site-day) run the web pipeline, while
 * the call's own turns run in `voice_turn`. The WhatsApp worker's reports have no channel.
 */
export function isWebReport(report: Pick<ReportRow, 'channel'>): boolean {
  return report.channel === 'web' || report.channel === 'voice';
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
    const answer = q.answer as { parsed?: AnswerValue; voice?: Source } | null;
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
      // W2-09: a spoken answer's clip stays a source of the value; W3-09: an answer said on a
      // call keeps its call second.
      ...(answer.voice?.type === 'voice_note' || answer.voice?.type === 'call'
        ? { extraSources: [answer.voice] }
        : {}),
    }).data;
    reapplied.push(q.id);
  }
  return { data: out, reapplied };
}

/**
 * The fixes saved on a draft (W2-10, `draft_corrections` applied: spoken, typed or a stepper) as
 * `reapplyCrewFixes` takes them (spec §19 Q96): their crew changes and the source they cited. A
 * row without both is skipped. Pure.
 */
export function appliedFixes(
  rows: ReadonlyArray<Pick<DraftCorrectionRow, 'changes' | 'source'>>,
): AppliedFix[] {
  return rows.flatMap((r) => {
    const source = SourceSchema.safeParse(r.source);
    if (!Array.isArray(r.changes) || !source.success) return [];
    return [{ changes: r.changes as unknown as CorrectionChange[], source: source.data }];
  });
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
  // A newer extraction (another voice note, a photo on the draft) decides after it. An answer
  // timeout that finds the report busy is armed again (a few minutes on), never dropped: the
  // decide_next after that extraction may well find the gap still open.
  const extracting = await ctx.db.hasActiveReportJob('extract_report', report.id);
  const voice = extracting ? [] : await ctx.db.listReportVoiceUploads(report.id);
  const busy = extracting
    ? 'an extraction is pending; it decides'
    : voice.some((u) => !u.transcribed)
      ? 'a voice note is not transcribed yet'
      : null;
  if (busy) {
    ctx.log.info(`decide_next: ${busy}`, { report_id: report.id });
    if (timeout?.step === 'answer')
      await rearmAnswerTimeout(ctx, report, timeout.questionId, job, busy);
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
    timeout?.step === 'answer'
      ? await answerTimeoutWeb(ctx, report, timeout.questionId, job)
      : null;
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
      exceptJobId: job.id,
    });
  } else {
    const question = plan.kind === 'wait' ? plan.question : await ctx.db.getQuestion(questionId!);
    guard = { reportId: report.id, status: 'awaiting_answer', questionId: questionId! };
    if (question) await startAnswerClock(ctx, report, question, job.id);
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

/** How many times a timer is armed again before it gives up (with the grace below, about a day). */
export const MAX_TIMER_REARMS = 48;
/** The first re-arm's wait; each next one doubles, up to `REARM_GRACE_MAX_MS`. */
export const REARM_GRACE_MS = 2 * 60_000;
export const REARM_GRACE_MAX_MS = 30 * 60_000;

/** The wait of the nth re-arm (n ≥ 1) of a timer that found the report busy. Pure. */
export function rearmGraceMs(n: number): number {
  return Math.min(REARM_GRACE_MS * 2 ** Math.max(0, n - 1), REARM_GRACE_MAX_MS);
}

/**
 * The generation to arm a re-armable timer under (`jobKeys.rearm(baseKey, n)`), or null when one
 * of its jobs other than `exceptJobId` is still queued or running (the live timer stands) or every
 * generation is used. A key names one job for good (D16), so a timer whose job finished without
 * acting needs the next generation's key to run again.
 */
async function timerGeneration(
  ctx: Ctx,
  baseKey: string,
  exceptJobId: number | null,
): Promise<number | null> {
  const keys = Array.from({ length: MAX_TIMER_REARMS + 1 }, (_, n) => jobKeys.rearm(baseKey, n));
  const jobs = await ctx.db.listJobsByKeys(keys);
  if (jobs.some((j) => j.id !== exceptJobId && (j.status === 'queued' || j.status === 'running')))
    return null;
  const taken = new Set(jobs.map((j) => j.dedupe_key));
  const n = keys.findIndex((k) => !taken.has(k));
  if (n < 0) {
    ctx.log.warn('timer not armed again: every re-arm is used', { base_key: baseKey });
    return null;
  }
  return n;
}

/**
 * F7's clock for an open web question: a delayed decide_next at asked + 60 min (at once when that
 * has passed), keyed per question and arming (a retried decide_next finds the live one; one that
 * finished without timing the question out is armed again, `jobKeys.rearm`). Delays are measured
 * from the database's clock (`delayMs`), the one the queue reads.
 */
async function startAnswerClock(
  ctx: Ctx,
  report: ReportRow,
  question: QuestionRow,
  exceptJobId: number | null,
) {
  const askedAt = new Date(question.asked_at ?? question.created_at);
  await armAnswerTimer(
    ctx,
    report,
    question.id,
    exceptJobId,
    () => answerTimeoutAt(askedAt).getTime() - ctx.now().getTime(),
  );
}

async function armAnswerTimer(
  ctx: Ctx,
  report: ReportRow,
  questionId: string,
  exceptJobId: number | null,
  delay: (generation: number) => number,
): Promise<number | null> {
  const n = await timerGeneration(ctx, jobKeys.decideTimeout(report.id, questionId), exceptJobId);
  if (n === null) return null;
  const timerKey = jobKeys.rearm(jobKeys.decideTimeout(report.id, questionId), n);
  await ctx.db.enqueueJob(
    'decide_next',
    { reportId: report.id, timeout: { step: 'answer', questionId } },
    { dedupeKey: timerKey, delayMs: Math.max(0, delay(n)) },
  );
  return n;
}

/**
 * The answer timeout found the question still open but the report busy (an extraction running, a
 * clip not transcribed, the report processing more audio): rather than finish having changed
 * nothing, which would leave the question open for good, it is armed again a few minutes on.
 */
async function rearmAnswerTimeout(
  ctx: Ctx,
  report: ReportRow,
  questionId: string,
  job: JobRow,
  reason: string,
): Promise<void> {
  const question = await ctx.db.getQuestion(questionId);
  if (
    !question ||
    question.report_id !== report.id ||
    question.answered_at ||
    !OPEN_STATUSES.includes(report.status)
  )
    return;
  const n = await armAnswerTimer(ctx, report, questionId, job.id, rearmGraceMs);
  ctx.log.info('answer timeout deferred: the report is busy', {
    report_id: report.id,
    question_id: questionId,
    reason,
    rearm: n,
  });
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
  draft: {
    version: number;
    draftRev: number;
    shownAt: Date;
    policy: TimeoutPolicy;
    exceptJobId: number | null;
  },
): Promise<void> {
  const { version, draftRev } = draft;
  // The filing timer leads: while it is live the clock stands (a retried decide_next); once it
  // finished without filing (it fired while more audio was processed and the re-extraction
  // wrote the same draft), the draft shown again gets a new clock, nudge included.
  const generation = await timerGeneration(
    ctx,
    jobKeys.decideFileTimeout(report.id, version, draftRev),
    draft.exceptJobId,
  );
  if (generation === null) return;
  for (const step of confirmationSchedule(draft.shownAt, settings.filing_mode)) {
    if (step.kind === 'file') {
      const timerKey = jobKeys.rearm(
        jobKeys.decideFileTimeout(report.id, version, draftRev),
        generation,
      );
      await ctx.db.enqueueJob(
        'decide_next',
        {
          reportId: report.id,
          timeout: { step: 'file', trigger: step.trigger, version, draftRev },
        },
        { dedupeKey: timerKey, delayMs: step.at.getTime() - draft.shownAt.getTime() },
      );
    } else if (reporterId) {
      const { base, code } = await personalLinkCode(ctx, reporterId, report.org_id);
      const nudgeKey = jobKeys.rearm(jobKeys.draftNudge(report.id, version, draftRev), generation);
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
 * changed, when the question was answered or the report moved on meanwhile; null too, with the
 * timer armed again (`rearmAnswerTimeout`), while the report processes more audio or a spoken
 * answer is being read.
 */
async function answerTimeoutWeb(
  ctx: Ctx,
  report: ReportRow,
  questionId: string,
  job: JobRow,
): Promise<QuestionRow | null> {
  const question = await ctx.db.getQuestion(questionId);
  const now = ctx.now();
  if (
    question &&
    question.report_id === report.id &&
    !question.answered_at &&
    (report.status === 'collecting' || report.status === 'processing')
  ) {
    // More audio arrived after the question: its decide_next comes, and this timer with it.
    await rearmAnswerTimeout(ctx, report, questionId, job, `report ${report.status}`);
    return null;
  }
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
  // W2-09: a spoken answer still being read (its parse_answer queued or running) is not thrown
  // away by the clock: the timeout waits for it (a dead parse no longer holds it up).
  if (
    latestVoiceTryListening(question) &&
    (await ctx.db.hasActiveReportJob('parse_answer', report.id))
  ) {
    await rearmAnswerTimeout(ctx, report, questionId, job, 'a spoken answer is being read');
    return null;
  }
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

/** The question's latest spoken try (`questions.voice_answers`) is still `listening`. Pure. */
export function latestVoiceTryListening(question: Pick<QuestionRow, 'voice_answers'>): boolean {
  const tries = Array.isArray(question.voice_answers) ? question.voice_answers : [];
  const last = tries.at(-1);
  return (
    !!last &&
    typeof last === 'object' &&
    !Array.isArray(last) &&
    (last as { status?: unknown }).status === 'listening'
  );
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
  // F15, spec §19 Q95: a reporter who turned a processing consent off is not filed for by the
  // clock; the report stays unfiled (flagged) and the office is told.
  const revoked = await revokedProcessingConsents(ctx, report.reporter_id);
  if (revoked.length > 0) {
    await leaveUnfiledForConsent(ctx, report, revoked, timeout.trigger);
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
 * The confirmation timeout found the reporter's processing consent off: no filing; the report is
 * flagged `consent_revoked`, audited `report.timeout_filing_skipped`, and the office gets the
 * `reporter_consent_revoked` notice again, pointing at the report.
 */
async function leaveUnfiledForConsent(
  ctx: Ctx,
  report: ReportRow,
  revoked: readonly ProcessingConsent[],
  trigger: string,
): Promise<void> {
  if (!report.review_reasons.includes(CONSENT_REVIEW_REASON)) {
    await ctx.db.updateReport(report.id, {
      needs_review: true,
      review_reasons: [...report.review_reasons, CONSENT_REVIEW_REASON],
    });
  }
  await ctx.db.logAudit({
    org_id: report.org_id,
    actor_type: 'system',
    action: 'report.timeout_filing_skipped',
    entity: 'report',
    entity_id: report.id,
    diff: { reason: 'consent_revoked', consents: [...revoked], trigger },
  });
  const reporter = report.reporter_id ? await ctx.db.getReporter(report.reporter_id) : null;
  const name = reporter?.name ?? 'A reporter';
  const type = revoked[0]!;
  await ctx.db.notifyOrg(
    report.org_id,
    'reporter_consent_revoked',
    `${name} turned off consent to the ${type === 'recording' ? 'recording' : 'processing'} of their reports`,
    'Their draft report was not filed automatically. Review it, or contact them if that is unexpected.',
    `/reports/${report.id}`,
    null,
    { key: 'reporter_consent_revoked', params: { name, type } },
  );
  ctx.log.info('confirmation timeout: not filed, the reporter turned consent off', {
    report_id: report.id,
    consents: revoked,
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
