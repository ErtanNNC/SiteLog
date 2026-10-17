import {
  QUESTION_FIELDS,
  answerConfirmation,
  applyAnswer,
  readReportData,
  type AnswerValue,
  type QuestionField,
  type QuestionSpec,
  type QuestionRow,
  type Source,
  type StoredReportData,
} from '@sitelog/shared';
import { answerRefusal, parseAnswerWithModel } from '../ai/answer';
import type { Json, SettleVoiceAnswerResult } from '../db';
import { skippedForConsent } from '../pipeline/consent';
import { transcribe } from './transcribe_upload';
import { PermanentJobError, type JobHandler } from './types';

/**
 * §10.7 `parse_answer` (W2-09, F7 *Other…*): the clip a reporter spoke for the open web question
 * (field_answer_question_voice() enqueued it, `answer:<question>:<upload>`; it runs under the
 * report's lock key).
 *
 * 1. The clip is transcribed like a voice note (`transcripts.upload_id`; a retry reuses it), but it
 *    is never report material: no report source, nothing extracted from it.
 * 2. `parse_answer` (the fast model; the transcript is data, phone numbers are taken out by
 *    `callTool`, §10.12) reads `{field, value, confidence}`.
 * 3. Code decides (`answerRefusal`): at 0.7 or more, for this question's field, with every number
 *    one the answer states, the value is applied in code (`applyAnswer`: totals recomputed; the
 *    sources are the answer and the clip, `voice_note` with its seconds) and
 *    field_settle_voice_answer() stores the draft, answers the question and enqueues decide_next.
 *    Otherwise the try is `unclear`: the question is asked once more with its choices ("I didn't
 *    catch that"), and unclear twice it is recorded unanswered and flagged `unanswered:<field>`
 *    (F7 "then move on and flag").
 *
 * The model never files and never decides: it only reads the answer. A try settled before, or a
 * question answered meanwhile (a tap, the 60-minute timeout), changes nothing.
 */
export const parseAnswerJob: JobHandler<'parse_answer'> = async (ctx, payload) => {
  const [report, question, upload] = await Promise.all([
    ctx.db.getReport(payload.reportId),
    ctx.db.getQuestion(payload.questionId),
    ctx.db.getUpload(payload.uploadId),
  ]);
  if (!report || !question || !upload)
    throw new PermanentJobError('parse_answer: report, question or clip not found');
  if (
    question.report_id !== report.id ||
    upload.question_id !== question.id ||
    upload.report_id !== report.id ||
    upload.kind !== 'audio'
  ) {
    throw new PermanentJobError(`upload ${upload.id} is not an answer clip of ${question.id}`);
  }
  if (!(QUESTION_FIELDS as readonly string[]).includes(question.field))
    throw new PermanentJobError(`question ${question.id} has field ${question.field}`);
  const log = ctx.log.child({
    report_id: report.id,
    question_id: question.id,
    upload_id: upload.id,
  });
  const tried = voiceTry(question, upload.id);
  if (!tried) throw new PermanentJobError(`clip ${upload.id} was not handed to parse_answer`);
  if (tried.status !== 'listening') {
    log.info('parse_answer: settled before', { status: tried.status });
    return;
  }
  const settle = async (
    outcome: 'applied' | 'unclear',
    detail: Record<string, unknown>,
    extra: { base?: Json; data?: Json; answer?: Json } = {},
  ): Promise<SettleVoiceAnswerResult> => {
    const res = await ctx.db.settleVoiceAnswer({
      questionId: question.id,
      uploadId: upload.id,
      outcome,
      detail,
      ...extra,
    });
    log.info('spoken answer settled', { outcome, ...detail, ...res });
    ctx.metrics.add({ answerOutcome: res.settled ? res.status : `not_settled:${res.status}` });
    return res;
  };
  if (question.answered_at || report.status !== 'awaiting_answer') {
    await settle('unclear', { reason: 'stale' });
    return;
  }

  // F15, spec §19 Q95: the clip goes to no provider once the reporter turned consent off; the
  // try is settled unclear, so the recorder stops listening.
  if (
    await skippedForConsent(ctx, {
      jobType: 'parse_answer',
      reporterId: report.reporter_id,
      report,
      detail: { question_id: question.id, upload_id: upload.id },
    })
  ) {
    await settle('unclear', { reason: 'consent_revoked' });
    return;
  }

  // 1. The transcript (a retry finds it and calls no provider).
  let transcript = await ctx.db.getUploadTranscript(upload.id);
  if (!transcript) {
    if (upload.purged_at) throw new PermanentJobError(`upload ${upload.id} was purged`);
    await transcribe(ctx, upload, log, 'answer');
    transcript = await ctx.db.getUploadTranscript(upload.id);
  }
  const text = transcript?.text.trim() ?? '';
  if (!text) {
    await settle('unclear', { reason: 'silent' });
    return;
  }
  const segments = (transcript?.segments ?? []) as Array<{ end?: number }>;
  const end = segments.at(-1)?.end ?? Number(upload.duration_s ?? 0);

  // 2. The model reads the answer.
  const site = await ctx.db.siteContext(report.site_id);
  if (!site) throw new Error(`site ${report.site_id} not found`);
  const version = await ctx.db.getVersion(report.id, report.current_version || 1);
  if (!version?.data) throw new Error(`report ${report.id} has no draft`);
  const draft = readReportData(version.data as StoredReportData);
  if (!ctx.ai.claude) throw new Error('ANTHROPIC_API_KEY is required for parse_answer');
  const field = question.field as QuestionField;
  const target = (question.target ?? {}) as QuestionSpec['target'];
  const companies = site.companies.map((c) => ({ id: c.id, name: c.name, aliases: c.aliases }));
  const defaultShiftHours = Number(site.settings.default_shift_hours);
  const parsed = await parseAnswerWithModel(
    ctx.ai.claude,
    ctx.config.CLAUDE_MODEL_FAST,
    {
      question: {
        field,
        prompt: question.prompt,
        options: optionLabels(question.options),
        target,
      },
      replyText: text,
      companies,
      defaultShiftHours,
      via: 'voice',
    },
    log,
  );
  ctx.metrics.add({ tokens: parsed.usage, estCostUsd: parsed.estCostUsd });

  // 3. Code decides.
  const targetPath = (question.target as { path?: unknown } | null)?.path;
  const refusal = answerRefusal(
    field,
    parsed.data,
    text,
    typeof targetPath === 'string' ? targetPath : undefined,
  );
  if (refusal) {
    await settle('unclear', { reason: refusal, confidence: parsed.data.confidence });
    return;
  }
  let value: AnswerValue = parsed.data.value;
  const reviewReasons: string[] = [];
  if (field === 'company.unknown') {
    const known = value.companyId ? companies.find((c) => c.id === value.companyId) : undefined;
    if (value.companyAction === 'map' && !known && !target.closestCompanyId) {
      await settle('unclear', { reason: 'unknown_company', confidence: parsed.data.confidence });
      return;
    }
    if (value.companyAction === 'add') {
      const entry =
        target.manpowerIndex !== undefined ? draft.manpower[target.manpowerIndex] : undefined;
      const name = (value.companyName ?? entry?.companyName ?? target.companyName ?? '').trim();
      if (!entry || !name) {
        await settle('unclear', { reason: 'unknown_company', confidence: parsed.data.confidence });
        return;
      }
      // "Add <company>" said (F7): an unconfirmed company of the org, for the office to review.
      const company = await ctx.db.insertCompany(site.org.id, name, 'unconfirmed');
      await ctx.db.logAudit({
        org_id: site.org.id,
        actor_type: 'reporter',
        actor_id: upload.reporter_id,
        action: 'company.added_unconfirmed',
        entity: 'company',
        entity_id: company.id,
        diff: { report_id: report.id, question_id: question.id, via: 'voice' },
      });
      companies.push({ id: company.id, name: company.name, aliases: company.aliases });
      value = { ...value, companyAction: 'map', companyId: company.id, companyName: company.name };
      reviewReasons.push(`unknown_company:${company.name}`);
    }
  }
  const clip: Source = { type: 'voice_note', uploadId: upload.id, start: 0, end };
  const applied = applyAnswer(draft, { field, target }, value, {
    defaultShiftHours,
    workingHours: site.site.working_hours,
    source: { type: 'answer', questionId: question.id },
    extraSources: [clip],
    confidence: parsed.data.confidence,
    companies,
  });
  const confirmation = answerConfirmation(field, target, applied.data, value);
  try {
    await settle(
      'applied',
      { confidence: parsed.data.confidence, ...(reviewReasons.length ? { reviewReasons } : {}) },
      {
        base: version.data as Json,
        data: applied.data as unknown as Json,
        answer: {
          text,
          parsed: value,
          confidence: parsed.data.confidence,
          voice: clip,
          confirmation,
          via: 'web',
        } as unknown as Json,
      },
    );
  } catch (err) {
    // The draft changed under the parse (a voice note's re-extraction): the job runs again on it.
    if (/draft_changed/.test(String((err as Error).message))) {
      log.info('parse_answer: the draft changed; retrying on the new one');
    }
    throw err;
  }
};

function voiceTry(
  question: Pick<QuestionRow, 'voice_answers'>,
  uploadId: string,
): { uploadId: string; status: string } | null {
  const tries = Array.isArray(question.voice_answers) ? question.voice_answers : [];
  for (const t of tries) {
    if (t && typeof t === 'object' && !Array.isArray(t) && t.uploadId === uploadId) {
      return { uploadId, status: String(t.status) };
    }
  }
  return null;
}

/** The labels of a question's stored options (`[{id, label, value?}]`), for the model. */
function optionLabels(options: QuestionRow['options']): string[] {
  if (!Array.isArray(options)) return [];
  return options.flatMap((o) =>
    o && typeof o === 'object' && !Array.isArray(o) && typeof o.label === 'string' ? [o.label] : [],
  );
}
