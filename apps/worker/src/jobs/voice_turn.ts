import {
  QUESTION_FIELDS,
  applyCorrectionOps,
  correctionNote,
  readReportData,
  voiceCorrectionLines,
  type ApplyCorrectionResult,
  type StoredReportData,
  answerConfirmation,
  applyAnswer,
  callRequiredFields,
  languageOf,
  readBack,
  reapplyCrewFixes,
  spokenQuestion,
  validateReport,
  voiceAnswerConfirmation,
  renderVoice,
  type AnswerConfirmation,
  type AnswerValue,
  type CallRow,
  type DailyReportData,
  type Language,
  type QuestionField,
  type QuestionRow,
  type QuestionSpec,
  type RecordAnswerResult,
  type ReportRow,
  type ReporterRow,
  type ReportStatus,
  type Source,
  type VoiceDraftState,
  type VoiceTurnRow,
} from '@sitelog/shared';
import { answerRefusal, parseAnswerWithModel } from '../ai/answer';
import { parseCorrectionV2 } from '../ai/correction';
import { runReportExtraction } from '../ai/extract';
import type { Ctx } from '../context';
import type { Json, SiteContext } from '../db';
import type { Logger } from '../log';
import { composeReportExtractionInput, siteDayWeatherOf } from '../pipeline/compose';
import { skippedForConsent } from '../pipeline/consent';
import { learnTerms } from '../pipeline/glossary';
import { requiredFieldsOf } from '../pipeline/validate';
import {
  appliedFixes,
  currentDraftV2,
  planWebNext,
  reapplyAnswers,
  storeWebDraft,
  withReportPhotos,
} from '../pipeline/web';
import { PermanentJobError, type JobHandler } from './types';

/**
 * §10.4 live mode on a call (W3-09; spec §4.3 B step 3, §9.4 `update_draft` / `record_answer`,
 * F7 on a call, §19 Q117): one live tool turn of a call (`voice_turns`, voice_turn_submit()),
 * run with the worker's prompts, validation and code-computed totals while field-api waits for
 * its answer (≤ VOICE_TOOL_WAIT_MS) and the agent covers the wait with a filler line.
 *
 * - `update_draft`: extraction v2 on everything the report has (the call's reporter lane so far
 *   with `CHANNEL: call`, the day's voice notes and earlier calls, §7.2), every value citing the
 *   call second (`{type:'call', callId, start, end}`); answers and the reporter's crew fixes
 *   re-applied in code; then the call's decision: one question (§10.5 priority and limit, the
 *   photo never asked on a call), else the read-back code writes (§19 Q118). No text is sent and
 *   no web clock starts: the reporter is on the line (the hang-up's clocks are W3-11's).
 * - `record_answer`: `parse_answer` (the fast model) on the words as said; code applies the value
 *   (`answerRefusal`: ≥ 0.7, this question's field, every number one the words state) with the
 *   answer and the call second as its sources, totals recomputed, and F7's spoken confirmation
 *   from code's numbers; unclear → asked once more with the choices; unclear twice → recorded
 *   unanswered, the report flagged `unanswered:<field>`, the draft moves on (F7).
 *
 * The model never files and never decides: it extracts or reads the answer; code decides what is
 * asked and what is read back. The words are data (§10.12; `callTool` takes phone numbers out).
 *
 * A turn never waits on the queue's retries (30 s and up, useless to a caller on the line): any
 * failure settles it `failed` and the job finishes; the agent's next request with the same words
 * runs it again (voice_turn_submit(), the next attempt). A run after a failed one finds what the
 * first wrote (the open question, the answer recorded with this turn's id) and goes on from it.
 */
export const voiceTurnJob: JobHandler<'voice_turn'> = async (ctx, payload) => {
  const turn = await ctx.db.getVoiceTurn(payload.turnId);
  if (!turn) throw new PermanentJobError(`voice turn ${payload.turnId} not found`);
  const log = ctx.log.child({
    turn_id: turn.id,
    call_id: turn.call_id,
    report_id: turn.report_id,
    kind: turn.kind,
  });
  if (turn.status !== 'pending') {
    log.info('voice turn settled before', { status: turn.status });
    return;
  }
  const startedAt = Date.now();
  let outcome: { result: Json } | { error: TurnError };
  try {
    const scope = await turnScope(ctx, turn);
    if ('error' in scope) outcome = scope;
    else
      outcome =
        turn.kind === 'update_draft'
          ? await updateDraft(ctx, turn, scope, log)
          : turn.kind === 'record_answer'
            ? await recordAnswer(ctx, turn, scope, log)
            : await applyCorrectionOnCall(ctx, turn, scope, log);
  } catch (err) {
    // Never the words or a phone number in the log: the error's name and message only.
    log.error('voice turn failed', {
      error: err instanceof Error ? `${err.name}: ${err.message}`.slice(0, 300) : 'unknown',
    });
    outcome = { error: 'turn_failed' };
  }
  const settled =
    'result' in outcome
      ? await ctx.db.settleVoiceTurn(turn.id, { status: 'done', result: outcome.result })
      : await ctx.db.settleVoiceTurn(turn.id, { status: 'failed', error: outcome.error });
  const ms = Date.now() - startedAt;
  ctx.metrics.add({ voiceTurnMs: ms, voiceTurn: 'result' in outcome ? 'done' : outcome.error });
  log.info('voice turn settled', {
    outcome: 'result' in outcome ? 'done' : outcome.error,
    settled,
    turn_ms: ms,
  });
};

/** The error codes a turn settles with; field-api answers them (409, or 503 `turn_failed`). */
type TurnError = 'report_closed' | 'question_closed' | 'consent_required' | 'turn_failed';

interface TurnScope {
  call: CallRow;
  report: ReportRow;
  reporter: ReporterRow;
  site: SiteContext;
  /** The call language (§9.6: the reporter's, fixed when the call starts). */
  language: Language;
}

const CLOSED: readonly ReportStatus[] = ['filed', 'signed_off', 'void'];
/** Report statuses the call's decision may move from (as decide_next's). */
const OPEN_STATUSES: readonly ReportStatus[] = [
  'collecting',
  'processing',
  'awaiting_answer',
  'awaiting_confirmation',
];

async function turnScope(ctx: Ctx, turn: VoiceTurnRow): Promise<TurnScope | { error: TurnError }> {
  const [call, report] = await Promise.all([
    ctx.db.getCall(turn.call_id),
    ctx.db.getReport(turn.report_id),
  ]);
  if (!call || !report || !call.reporter_id)
    throw new PermanentJobError(`voice turn ${turn.id}: call or report not found`);
  if (CLOSED.includes(report.status)) return { error: 'report_closed' };
  const reporter = await ctx.db.getReporter(call.reporter_id);
  if (!reporter) throw new PermanentJobError(`voice turn ${turn.id}: reporter not found`);
  // F15, spec §19 Q95: nothing of the report goes to a model once a processing consent is off.
  if (
    await skippedForConsent(ctx, {
      jobType: 'voice_turn',
      reporterId: reporter.id,
      report,
      detail: { call_id: call.id, turn_id: turn.id },
    })
  )
    return { error: 'consent_required' };
  const site = await ctx.db.siteContext(report.site_id);
  if (!site) throw new PermanentJobError(`site ${report.site_id} not found`);
  return { call, report, reporter, site, language: languageOf(call.language ?? reporter.locale) };
}

// ───────────────────────────── update_draft ─────────────────────────────

async function updateDraft(
  ctx: Ctx,
  turn: VoiceTurnRow,
  scope: TurnScope,
  log: Logger,
): Promise<{ result: Json } | { error: TurnError }> {
  const { report, reporter, site, call } = scope;
  const siteDay = await ctx.db.getSiteDay(report.site_day_id);
  const previousDraft = await currentDraftV2(ctx, report);
  const input = await composeReportExtractionInput(ctx, report, site, reporter, {
    previousDraft,
    reportDate:
      siteDay?.date ??
      previousDraft?.reportDate ??
      (call.started_at ?? ctx.now().toISOString()).slice(0, 10),
    observedWeather: siteDayWeatherOf(siteDay?.weather),
    channel: 'call',
  });
  if (!ctx.ai.claude) throw new Error('ANTHROPIC_API_KEY is required for extraction');
  const result = await runReportExtraction(ctx.ai.claude, ctx.config.CLAUDE_MODEL, input, log);
  ctx.metrics.add({
    tokens: result.call.usage,
    estCostUsd: result.call.estCostUsd,
    extractionLatencyMs: result.call.latencyMs,
    extractionRetried: result.call.retried,
  });
  const latest = await ctx.db.getReport(report.id);
  if (!latest || CLOSED.includes(latest.status)) return { error: 'report_closed' };

  // The reporter's answers and crew fixes stand through the live re-extraction (as on the web).
  const sources = await ctx.db.listReportSources(report.id);
  const photos = sources.filter((s) => s.kind === 'photo').length;
  const gaps = validateReport(result.data, {
    requiredFields: callRequiredFields(requiredFieldsOf(site.settings)),
    photoCount: photos,
  }).gaps;
  const answered = reapplyAnswers(
    result.data,
    await ctx.db.listQuestions(report.id),
    new Set(gaps.map((g) => g.path)),
    {
      defaultShiftHours: Number(site.settings.default_shift_hours),
      workingHours: site.site.working_hours,
    },
  );
  const fixed = reapplyCrewFixes(
    answered.data,
    appliedFixes(await ctx.db.listAppliedCorrections(report.id)),
  );
  const data = withReportPhotos(fixed.data, sources, ctx.now()) ?? fixed.data;
  if (!(await storeWebDraft(ctx, latest, data))) return { error: 'report_closed' };
  await ctx.db.logAudit({
    org_id: report.org_id,
    actor_type: 'agent',
    action: 'report.extracted',
    entity: 'report',
    entity_id: report.id,
    diff: {
      model: result.call.model,
      schema_version: 2,
      mode: 'live',
      call_id: call.id,
      turn_id: turn.id,
      sources: sources.length,
      discrepancies: result.discrepancies,
      dropped_sources: result.droppedSources,
      answers_reapplied: answered.reapplied,
      fixes_reapplied: fixed.reapplied,
      languages: result.data.languageDetected,
      merged: !!previousDraft,
    },
  });
  await learnTerms(ctx, {
    orgId: report.org_id,
    siteId: report.site_id,
    reporterId: report.reporter_id,
    terms: result.data.newTerms,
    companies: site.companies,
    glossary: site.glossary,
    counted: previousDraft?.newTerms,
  });
  const state = await decideOnCall(ctx, scope, latest, data);
  return { result: state as unknown as Json };
}

// ───────────────────────────── The call's decision (§10.5 on a call) ─────────────────────────────

/**
 * §10.5 steps 4–6 on a call: the open question this call asked while its gap stands, else the
 * next one (priority, `max_questions_per_report`, the photo never asked on a call), else the
 * read-back (§19 Q118). An open question asked elsewhere (the recorder, an earlier call) is
 * resolved by this call: the reporter is on the line, so the call asks what it needs itself.
 * Writes the question and the report status (audited); sends no text and starts no web clock.
 */
async function decideOnCall(
  ctx: Ctx,
  scope: TurnScope,
  report: ReportRow,
  data: DailyReportData,
): Promise<VoiceDraftState> {
  const { call, site, reporter, language } = scope;
  const now = ctx.now();
  const sources = await ctx.db.listReportSources(report.id);
  const validation = validateReport(data, {
    requiredFields: callRequiredFields(requiredFieldsOf(site.settings)),
    photoCount: sources.filter((s) => s.kind === 'photo').length,
  });
  let questions = await ctx.db.listQuestions(report.id);
  for (const q of questions.filter((x) => !x.answered_at && x.call_id !== call.id)) {
    await ctx.db.updateQuestion(q.id, {
      answered_at: now,
      answer: { resolved_by: 'call', call_id: call.id },
    });
    await ctx.db.logAudit({
      org_id: report.org_id,
      actor_type: 'agent',
      action: 'report.question_resolved',
      entity: 'report',
      entity_id: report.id,
      diff: { question_id: q.id, by: 'call', call_id: call.id },
    });
  }
  // A question resolved by a call is no question asked: its gap may be asked on this call.
  questions = (await ctx.db.listQuestions(report.id)).filter(
    (q) => (q.answer as { resolved_by?: unknown } | null)?.resolved_by !== 'call',
  );
  const plan = planWebNext({
    data,
    validation,
    questions,
    settings: site.settings,
    companies: site.companies,
    language: reporter.locale,
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
      diff: { question_id: plan.resolve, by: 'extraction', call_id: call.id },
    });
  }
  let question: QuestionRow | null = plan.kind === 'wait' ? plan.question : null;
  if (plan.kind === 'ask') {
    question = await ctx.db.insertQuestion({
      report_id: report.id,
      field: plan.spec.field,
      target: { ...plan.spec.target, path: plan.spec.path } as Json,
      prompt: plan.spec.prompt,
      options: plan.spec.options as unknown as Json,
      asked_at: now,
      channel: 'voice',
      call_id: call.id,
    });
    await ctx.db.logAudit({
      org_id: report.org_id,
      actor_type: 'agent',
      action: 'report.question_asked',
      entity: 'report',
      entity_id: report.id,
      diff: {
        question_id: question.id,
        field: plan.spec.field,
        channel: 'voice',
        call_id: call.id,
        options: plan.spec.options.length,
      },
    });
  }
  const to: ReportStatus = question ? 'awaiting_answer' : 'awaiting_confirmation';
  const fresh = await ctx.db.getReport(report.id);
  if (fresh && fresh.status !== to && (await ctx.db.setReportStatus(report.id, to, OPEN_STATUSES)))
    await ctx.db.logAudit({
      org_id: report.org_id,
      actor_type: 'agent',
      action: 'report.status_changed',
      entity: 'report',
      entity_id: report.id,
      diff: { from: fresh.status, to, question_id: question?.id ?? null, call_id: call.id },
    });
  const version = await ctx.db.getVersion(report.id, report.current_version || 1);
  return {
    reportId: report.id,
    draftRev: version?.draft_rev ?? 1,
    missing: validation.missingRequired.slice(0, 20).map((m) => m.slice(0, 100)),
    question: question
      ? {
          id: question.id,
          ...spokenQuestion({ prompt: question.prompt, options: optionList(question.options) }),
        }
      : null,
    readBack: question ? null : readBack(data, language),
  };
}

function optionList(options: QuestionRow['options']): Array<{ id: string; label: string }> {
  if (!Array.isArray(options)) return [];
  return options.flatMap((o, i) =>
    o && typeof o === 'object' && !Array.isArray(o) && typeof o.label === 'string'
      ? [{ id: typeof o.id === 'string' ? o.id : `o${i + 1}`, label: o.label }]
      : [],
  );
}

// ───────────────────────────── record_answer ─────────────────────────────

/** F7 on a call: an answer unclear this many times is left for the office (as on the web). */
const UNCLEAR_LIMIT = 2;

interface CallTry {
  via: 'call';
  turnId: string;
  status: 'applied' | 'unclear';
  at: string;
  start: number;
  reason?: string;
}

function callTries(q: Pick<QuestionRow, 'voice_answers'>): CallTry[] {
  const tries: unknown[] = Array.isArray(q.voice_answers) ? q.voice_answers : [];
  return tries.filter(
    (t): t is CallTry =>
      !!t && typeof t === 'object' && !Array.isArray(t) && (t as { via?: unknown }).via === 'call',
  );
}

async function recordAnswer(
  ctx: Ctx,
  turn: VoiceTurnRow,
  scope: TurnScope,
  log: Logger,
): Promise<{ result: Json } | { error: TurnError }> {
  const { call, report, site, language } = scope;
  const input = turn.input as {
    questionId: string;
    utterance: string;
    start: number;
    end?: number;
  };
  const question = await ctx.db.getQuestion(input.questionId);
  if (!question || question.report_id !== report.id || question.call_id !== call.id)
    return { error: 'question_closed' };
  if (!(QUESTION_FIELDS as readonly string[]).includes(question.field))
    throw new PermanentJobError(`question ${question.id} has field ${question.field}`);
  const field = question.field as QuestionField;
  const target = (question.target ?? {}) as QuestionSpec['target'] & { path?: string };
  const tries = callTries(question);
  const mine = tries.find((t) => t.turnId === turn.id);
  const answer = question.answer as {
    turnId?: string;
    confirmation?: AnswerConfirmation;
    unanswered?: boolean;
  } | null;

  // A run after a failed one: what the first run recorded stands.
  if (question.answered_at && answer?.turnId === turn.id) {
    const data = await draftOf(ctx, report);
    const state = await decideOnCall(ctx, scope, report, data);
    const result: RecordAnswerResult = answer.unanswered
      ? { status: 'skipped', confirmation: renderVoice('answer_skipped', language), draft: state }
      : {
          status: 'applied',
          confirmation: answer.confirmation
            ? voiceAnswerConfirmation(answer.confirmation, language)
            : null,
          draft: state,
        };
    return { result: result as unknown as Json };
  }
  if (question.answered_at || report.status !== 'awaiting_answer')
    return { error: 'question_closed' };
  if (mine?.status === 'unclear') return unclearResult(ctx, scope, report);

  // 1. The model reads the answer (the fast model; the words are data).
  const draft = await draftOf(ctx, report);
  if (!ctx.ai.claude) throw new Error('ANTHROPIC_API_KEY is required for parse_answer');
  const companies = site.companies.map((c) => ({ id: c.id, name: c.name, aliases: c.aliases }));
  const defaultShiftHours = Number(site.settings.default_shift_hours);
  const parsed = await parseAnswerWithModel(
    ctx.ai.claude,
    ctx.config.CLAUDE_MODEL_FAST,
    {
      question: {
        field,
        prompt: question.prompt,
        options: optionList(question.options).map((o) => o.label),
        target,
      },
      replyText: input.utterance,
      companies,
      defaultShiftHours,
      via: 'voice',
    },
    log,
  );
  ctx.metrics.add({ tokens: parsed.usage, estCostUsd: parsed.estCostUsd });

  // 2. Code decides.
  const now = ctx.now();
  const refusal = answerRefusal(field, parsed.data, input.utterance, target.path);
  let value: AnswerValue = parsed.data.value;
  const reviewReasons: string[] = [];
  let unclear: string | null = refusal;
  if (!unclear && field === 'company.unknown') {
    const known = value.companyId ? companies.find((c) => c.id === value.companyId) : undefined;
    const entry =
      target.manpowerIndex !== undefined ? draft.manpower[target.manpowerIndex] : undefined;
    if (value.companyAction === 'map' && !known && !target.closestCompanyId)
      unclear = 'unknown_company';
    else if (value.companyAction === 'add') {
      const name = (value.companyName ?? entry?.companyName ?? target.companyName ?? '').trim();
      if (!entry || !name) unclear = 'unknown_company';
      else {
        // "Add <company>" said on the call (F7): an unconfirmed company for the office to review.
        const company = await ctx.db.insertCompany(site.org.id, name, 'unconfirmed');
        await ctx.db.logAudit({
          org_id: site.org.id,
          actor_type: 'reporter',
          actor_id: scope.reporter.id,
          action: 'company.added_unconfirmed',
          entity: 'company',
          entity_id: company.id,
          diff: { report_id: report.id, question_id: question.id, via: 'voice', call_id: call.id },
        });
        companies.push({ id: company.id, name: company.name, aliases: company.aliases });
        value = {
          ...value,
          companyAction: 'map',
          companyId: company.id,
          companyName: company.name,
        };
        reviewReasons.push(`unknown_company:${company.name}`);
      }
    }
  }
  if (unclear) {
    const attempt: CallTry = {
      via: 'call',
      turnId: turn.id,
      status: 'unclear',
      at: now.toISOString(),
      start: input.start,
      reason: unclear,
    };
    const all = [...(Array.isArray(question.voice_answers) ? question.voice_answers : []), attempt];
    const unclearCount = tries.filter((t) => t.status === 'unclear').length + 1;
    if (unclearCount >= UNCLEAR_LIMIT) {
      // F7: "if unclear, ask once more with the choices; then move on and flag".
      await ctx.db.updateQuestion(question.id, {
        voice_answers: all as unknown as Json,
        answered_at: now,
        answer: { unanswered: true, unclear: true, via: 'call', turnId: turn.id } as Json,
      });
      await flagReport(ctx, report, [`unanswered:${field}`]);
      await ctx.db.logAudit({
        org_id: report.org_id,
        actor_type: 'agent',
        action: 'report.question_unanswered',
        entity: 'report',
        entity_id: report.id,
        diff: {
          question_id: question.id,
          field,
          reason: 'unclear',
          via: 'voice',
          call_id: call.id,
        },
      });
      const state = await decideOnCall(ctx, scope, report, draft);
      const result: RecordAnswerResult = {
        status: 'skipped',
        confirmation: renderVoice('answer_skipped', language),
        draft: state,
      };
      return { result: result as unknown as Json };
    }
    await ctx.db.updateQuestion(question.id, { voice_answers: all as unknown as Json });
    await ctx.db.logAudit({
      org_id: report.org_id,
      actor_type: 'agent',
      action: 'report.answer_unclear',
      entity: 'report',
      entity_id: report.id,
      diff: {
        question_id: question.id,
        reason: unclear,
        confidence: parsed.data.confidence,
        via: 'voice',
        call_id: call.id,
      },
    });
    return unclearResult(ctx, scope, report);
  }

  // 3. Applied in code: the answer and the call second are the value's sources, totals recomputed.
  const said: Source = {
    type: 'call',
    callId: call.id,
    start: input.start,
    ...(input.end !== undefined ? { end: input.end } : {}),
  };
  const applied = applyAnswer(draft, { field, target }, value, {
    defaultShiftHours,
    workingHours: site.site.working_hours,
    source: { type: 'answer', questionId: question.id },
    extraSources: [said],
    confidence: parsed.data.confidence,
    companies,
  });
  if (!(await storeWebDraft(ctx, report, applied.data))) return { error: 'report_closed' };
  const confirmation = answerConfirmation(field, target, applied.data, value);
  await ctx.db.updateQuestion(question.id, {
    voice_answers: [
      ...(Array.isArray(question.voice_answers) ? question.voice_answers : []),
      {
        via: 'call',
        turnId: turn.id,
        status: 'applied',
        at: now.toISOString(),
        start: input.start,
      } satisfies CallTry,
    ] as unknown as Json,
    answered_at: now,
    answer: {
      text: input.utterance,
      parsed: value,
      confidence: parsed.data.confidence,
      voice: said,
      confirmation,
      via: 'call',
      turnId: turn.id,
    } as unknown as Json,
    answer_source: { type: 'answer', questionId: question.id } as Json,
  });
  if (reviewReasons.length) await flagReport(ctx, report, reviewReasons);
  await ctx.db.logAudit({
    org_id: report.org_id,
    actor_type: 'reporter',
    actor_id: scope.reporter.id,
    action: 'report.question_answered',
    entity: 'report',
    entity_id: report.id,
    diff: {
      question_id: question.id,
      field,
      via: 'voice',
      call_id: call.id,
      confidence: parsed.data.confidence,
    },
  });
  const state = await decideOnCall(ctx, scope, report, applied.data);
  const result: RecordAnswerResult = {
    status: 'applied',
    confirmation: voiceAnswerConfirmation(confirmation, language),
    draft: state,
  };
  return { result: result as unknown as Json };
}

// ───────────────────────────── apply_correction (F8 on a call) ─────────────────────────────

/**
 * F8 on a call (W3-10; §9.4 rule 5, §10.6): "No, Apex had seven, not six" after the read-back.
 * `apply_correction` (the model; the words are data) proposes operations on the call's draft;
 * code applies them (`applyCorrectionOps`: only what a fix may change, totals recomputed, every
 * number one the words state, each changed value citing the call second) and writes the draft at
 * once: on a call the spoken "Shall I file it?" after the change's read-back is the preview's
 * confirm (§7.2's `awaiting_confirmation → processing → read back` happens inside the turn). The
 * fix is recorded applied (`draft_corrections`, via voice) so a later re-extraction keeps it
 * (§19 Q96). Then the call's decision again (a new gap is asked; else the read-back of the change
 * only, then "Shall I file it?"). The model never files and never writes the draft.
 *
 * A run after a failed one finds the fix it applied (the same call second) and does not apply it
 * twice.
 */
async function applyCorrectionOnCall(
  ctx: Ctx,
  turn: VoiceTurnRow,
  scope: TurnScope,
  log: Logger,
): Promise<{ result: Json } | { error: TurnError }> {
  const { call, report, site, reporter, language } = scope;
  const input = turn.input as { utterance: string; start: number; end?: number };
  const said: Source = {
    type: 'call',
    callId: call.id,
    start: input.start,
    ...(input.end !== undefined ? { end: input.end } : {}),
  };
  const done =
    (status: ApplyCorrectionResult['status'], lines: string[], readBackText: string | null) =>
    async (data: DailyReportData): Promise<{ result: Json }> => {
      const fresh = (await ctx.db.getReport(report.id)) ?? report;
      const draft = await decideOnCall(ctx, scope, fresh, data);
      const result: ApplyCorrectionResult = {
        status,
        lines,
        readBack: draft.question ? null : readBackText,
        draft,
      };
      return { result: result as unknown as Json };
    };

  const earlier = appliedFixes(await ctx.db.listAppliedCorrections(report.id)).find(
    (f) =>
      f.source.type === 'call' && f.source.callId === call.id && f.source.start === input.start,
  );
  if (earlier) {
    const lines = voiceCorrectionLines(earlier.changes, language);
    return done(
      'applied',
      lines,
      [...lines, renderVoice('confirm_ask', language)].join(' '),
    )(await draftOf(ctx, report));
  }

  const version = await ctx.db.getVersion(report.id, report.current_version || 1);
  if (!version?.data) throw new Error(`report ${report.id} has no draft`);
  const draft = readReportData(version.data as StoredReportData);
  if (!ctx.ai.claude) throw new Error('ANTHROPIC_API_KEY is required for apply_correction');
  const companies = site.companies.map((c) => ({ id: c.id, name: c.name, aliases: c.aliases }));
  const defaultShiftHours = Number(site.settings.default_shift_hours);
  const parsed = await parseCorrectionV2(
    ctx.ai.claude,
    ctx.config.CLAUDE_MODEL,
    {
      data: draft,
      correctionText: input.utterance,
      via: 'voice',
      defaultShiftHours,
      companies,
      reporterLanguage: language,
    },
    log,
  );
  ctx.metrics.add({ tokens: parsed.usage, estCostUsd: parsed.estCostUsd });
  const refuse = async (reason: string) => {
    await ctx.db.logAudit({
      org_id: report.org_id,
      actor_type: 'agent',
      action: 'report.correction_unclear',
      entity: 'report',
      entity_id: report.id,
      diff: { reason, via: 'voice', call_id: call.id, turn_id: turn.id },
    });
    return done('not_understood', [renderVoice('correction_unclear', language)], null)(draft);
  };
  if (parsed.data.needsClarification) return refuse('clarification');
  const applied = applyCorrectionOps(draft, parsed.data.operations, {
    source: said,
    text: input.utterance,
    defaultShiftHours,
    companies,
  });
  if (!applied.ok) {
    if (applied.reason === 'no_change')
      return done('nothing_to_change', [renderVoice('correction_nothing', language)], null)(draft);
    return refuse(applied.reason);
  }
  if (applied.changes.length === 0)
    return done('nothing_to_change', [renderVoice('correction_nothing', language)], null)(draft);
  const stored = await ctx.db.applyCallCorrection({
    reportId: report.id,
    reporterId: reporter.id,
    orgId: report.org_id,
    baseVersion: version.version,
    baseRev: version.draft_rev ?? 1,
    data: applied.data,
    text: input.utterance,
    changes: applied.changes,
    operations: applied.operations,
    source: said,
    changeNote: correctionNote(applied.changes, applied.data.reportLanguage),
  });
  // The draft moved under the parse (a photo's re-extraction) or the yes went through: the turn
  // fails, and the agent's next request runs it again on the draft as it is then.
  if (!stored.applied) {
    const latest = await ctx.db.getReport(report.id);
    if (!latest || CLOSED.includes(latest.status)) return { error: 'report_closed' };
    throw new Error('the draft changed while the correction was read');
  }
  await ctx.db.logAudit({
    org_id: report.org_id,
    actor_type: 'reporter',
    actor_id: reporter.id,
    action: 'report.draft_corrected',
    entity: 'report',
    entity_id: report.id,
    diff: {
      correction_id: stored.correctionId,
      via: 'voice',
      call_id: call.id,
      turn_id: turn.id,
      changes: applied.changes,
      dropped_totals: applied.droppedTotals,
      draft_rev: stored.draftRev,
    },
  });
  const lines = voiceCorrectionLines(applied.changes, language);
  return done(
    'applied',
    lines,
    [...lines, renderVoice('confirm_ask', language)].join(' '),
  )(applied.data);
}

async function unclearResult(
  ctx: Ctx,
  scope: TurnScope,
  report: ReportRow,
): Promise<{ result: Json }> {
  const state = await decideOnCall(ctx, scope, report, await draftOf(ctx, report));
  const result: RecordAnswerResult = {
    status: 'not_understood',
    confirmation: renderVoice('answer_again', scope.language),
    draft: state,
  };
  return { result: result as unknown as Json };
}

async function draftOf(ctx: Ctx, report: ReportRow): Promise<DailyReportData> {
  const data = await currentDraftV2(ctx, report);
  if (!data) throw new Error(`report ${report.id} has no draft`);
  return data;
}

async function flagReport(ctx: Ctx, report: ReportRow, reasons: string[]): Promise<void> {
  const fresh = (await ctx.db.getReport(report.id)) ?? report;
  const next = [...new Set([...fresh.review_reasons, ...reasons])];
  if (next.length === fresh.review_reasons.length && fresh.needs_review) return;
  await ctx.db.updateReport(report.id, { needs_review: true, review_reasons: next });
}
