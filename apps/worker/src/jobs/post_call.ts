import {
  CALL_UNRECONCILED,
  VOICE_RECORDING_GRACE_S,
  buildKeyterms,
  callMismatchReason,
  draftHasReportValue,
  jobKeys,
  noticeData,
  readReportData,
  reconcileCall,
  type CallRow,
  type ReportRow,
  type StoredReportData,
  type TranscriptRow,
} from '@sitelog/shared';
import { runReportExtraction } from '../ai/extract';
import { buildTranscriptionPrompt } from '../ai/transcribe';
import { transcriptionLanguage } from '../ai/transcriber';
import type { Ctx } from '../context';
import type { Json, ReviewNotice } from '../db';
import type { Logger } from '../log';
import {
  analyzeCall,
  reporterLane,
  withTempDir,
  writeTemp,
  type CallAnalysis,
} from '../media/ffmpeg';
import { callSegments, composeReportExtractionInput, siteDayWeatherOf } from '../pipeline/compose';
import { revokedProcessingConsents } from '../pipeline/consent';
import { currentDraftV2 } from '../pipeline/web';
import { PermanentJobError, type JobHandler } from './types';

/**
 * §10.1 `post_call_reconcile` (W3-11; spec §7.2, §7.3, F6, §10.2 "Calls", §10.9, §19 Q122, Q123,
 * Q152, Q162, Q176): everything after a call, once per call (`post_call:<call>`: voice_call_end()
 * and voice-events' backstop queue it for a known caller), under the call's report's lock key.
 *
 * 1. **The hang-up** (outcome `draft_saved` or `abandoned`, or `filed` whose yes filed nothing):
 *    §19 Q122, before and without the recording. A draft with a report value continues on the
 *    web: post_call_settle() makes the outcome `draft_saved` and hands the call's open question to
 *    the web, then decide_next with `afterCall` sends the one `finish_report` text of the call and
 *    starts the §7.2 clocks from the hang-up (the nudge at +30 min, the filing at +2 h as
 *    `unconfirmed`). Too little said: `abandoned`, a report the call alone made is voided and the
 *    day's ladder runs on, no text.
 * 2. **The recording** (`calls/{org}/{call}.ogg`, reporter left, agent right; §9.4): only once the
 *    disclosure was played and with the recording and processing consents; ffmpeg splits the
 *    channels into the two-lane peaks (`{reporter, agent}`) and the duration, and the reporter
 *    lane alone (mono WAV) goes to the transcriber (Deepgram batch, word timestamps; fake in
 *    tests); its transcript replaces the live row (§19 Q162). The agent uploads at the end of the
 *    call, so a recording not there yet is waited for (the job's retries) for
 *    `VOICE_RECORDING_GRACE_S`; after that the call has none. A call with no recording (Talk now
 *    dropped, the agent crashed) still settles in step 1.
 * 3. **By outcome**:
 *    - `fallback_recording` (F6 failure handling): the reporter's recording is a voice note of
 *      today's report (post_call_fallback_report(): created or merged, the call one source,
 *      `extract_report` as a web note); the web flow then texts `draft_ready` with the link.
 *    - `filed`: the reconcile (§10.9, §19 Q123): the reporter lane extracted again in batch mode
 *      (the call alone: no previous draft, no answers), compared in code with the confirmed
 *      version (`reconcileCall`); what agrees gets its precise seconds as `report_sources` rows,
 *      what differs `call_mismatch:<path>:<heard>:<confirmed>` and the §13 review notice. The
 *      confirmed version never changes. A reconcile that cannot run (no recording, no disclosure,
 *      a consent off, nothing heard) adds `call_unreconciled`, as does this job dying
 *      (`dead-jobs.ts`).
 *
 * The transcript is data (§10.12): the extraction's prompt treats it so, and nothing in it files,
 * changes or confirms anything. Retries are safe: every write is keyed or settles once, and a
 * recording already transcribed is not sent to the provider again.
 */
export const postCallReconcileJob: JobHandler<'post_call_reconcile'> = async (ctx, payload) => {
  const call = await ctx.db.getCall(payload.callId);
  if (!call) throw new PermanentJobError(`call ${payload.callId} not found`);
  if (!call.ended_at) throw new Error(`call ${call.id} has not ended yet`);
  const log = ctx.log.child({ call_id: call.id, report_id: call.report_id, outcome: call.outcome });
  if (!call.reporter_id) {
    log.info('post-call: unknown caller, nothing to do');
    return;
  }
  // W3-14 (F3 on a call, §19 Q120): the reporter said no to the consent question. Nothing of the
  // call is processed (no recording to the transcriber, no reconcile, no hand-over to the web);
  // a recording that arrived anyway is deleted. The call keeps the outcome the agent ended it with.
  if (call.consent_declined_at) {
    if (call.recording_path) {
      try {
        await ctx.storage.remove('calls', [call.recording_path]);
      } catch (err) {
        log.warn('post-call: the declined call’s recording was not deleted', { err });
      }
    }
    log.info('post-call: consent declined on the call; nothing processed');
    return;
  }

  // 1. The hang-up (§19 Q122): no recording needed.
  const report = call.report_id ? await ctx.db.getReport(call.report_id) : null;
  let outcome = call.outcome;
  if (outcome === 'filed' && report && !isClosed(report)) {
    // The yes is still being filed: the reconcile waits for it (a retry).
    if (await ctx.db.hasActiveReportJob('file_report', report.id))
      throw new Error(`the filing of report ${report.id} is still running`);
    // The yes filed nothing (the draft changed under it): the call ended before a filing.
    outcome = 'draft_saved';
  }
  if (outcome === 'draft_saved' || outcome === 'abandoned')
    await afterHangUp(ctx, call, report, log);

  // 2. The recording.
  const heard = await processRecording(ctx, call, log);

  // 3. By outcome.
  if (call.outcome === 'fallback_recording') await fallbackReport(ctx, call, heard, log);
  else if (outcome === 'filed') await reconcile(ctx, call, heard, log);
};

const isClosed = (r: Pick<ReportRow, 'status'>) =>
  r.status === 'filed' || r.status === 'signed_off' || r.status === 'void';

// ───────────────────────────── 1. The hang-up ─────────────────────────────

async function afterHangUp(
  ctx: Ctx,
  call: CallRow,
  report: ReportRow | null,
  log: Logger,
): Promise<void> {
  const draft = report && !isClosed(report) ? await currentDraftV2(ctx, report) : null;
  const hasValue = !!draft && draftHasReportValue(draft);
  const settled = await ctx.db.postCallSettle(call.id, hasValue);
  log.info('post-call: hang-up settled', {
    action: settled.action,
    settled_outcome: settled.outcome,
    handed: settled.handed ?? 0,
  });
  if (!settled.reportId) return;
  if (settled.action === 'continue')
    // §19 Q122: the draft continues on the web, one `finish_report` text, clocks from the hang-up.
    await ctx.db.enqueueJob(
      'decide_next',
      { reportId: settled.reportId, afterCall: { callId: call.id, endedAt: call.ended_at! } },
      { dedupeKey: jobKeys.decideAfterCall(settled.reportId, call.id) },
    );
  else if (settled.action === 'kept')
    // The call said nothing for the report, which has other sources: the web flow goes on as if
    // the call had not happened (its own texts and clocks).
    await ctx.db.enqueueJob(
      'decide_next',
      { reportId: settled.reportId },
      { dedupeKey: jobKeys.decideAfterCall(settled.reportId, call.id) },
    );
}

// ───────────────────────────── 2. The recording ─────────────────────────────

/** The reporter lane as heard after the call, or why there is none. */
type Heard =
  | { ok: true; transcript: TranscriptRow | StoredTranscript }
  | { ok: false; reason: 'no_recording' | 'no_disclosure' | 'consent_revoked' };

interface StoredTranscript {
  call_id: string;
  language: string | null;
  text: string;
  segments: Array<{ start: number; end: number; speaker: 'reporter'; text: string }>;
  model: string;
}

async function processRecording(ctx: Ctx, call: CallRow, log: Logger): Promise<Heard> {
  // §9.4 "Recording": nothing that depends on the recording without the disclosure first.
  if (!call.disclosure_played) {
    log.info('post-call: the disclosure was not played; the recording is not processed');
    return { ok: false, reason: 'no_disclosure' };
  }
  // F15, §19 Q95, Q120: no audio to the transcriber once the reporter turned a consent off.
  if ((await revokedProcessingConsents(ctx, call.reporter_id)).length > 0) {
    log.info('post-call: a processing consent is off; the recording is not processed');
    return { ok: false, reason: 'consent_revoked' };
  }
  // A retry after the transcript was stored: the provider is not asked again.
  const [stored] = await ctx.db.listCallTranscripts([call.id]);
  if (stored && stored.model !== 'live' && call.peaks && !Array.isArray(call.peaks))
    return { ok: true, transcript: stored };

  const graceOver =
    ctx.now().getTime() - new Date(call.ended_at!).getTime() > VOICE_RECORDING_GRACE_S * 1000;
  if (!call.recording_path) {
    // The agent uploads at the end of the call (signed until the grace is over): wait for it.
    if (!graceOver) throw new Error(`the recording of call ${call.id} is not uploaded yet`);
    log.info('post-call: the call has no recording');
    return { ok: false, reason: 'no_recording' };
  }
  let audio: Buffer;
  try {
    audio = await ctx.storage.download('calls', call.recording_path);
  } catch (err) {
    if (!graceOver) throw err;
    log.warn('post-call: the recording never arrived', {
      err: err instanceof Error ? err.message : 'unknown',
    });
    return { ok: false, reason: 'no_recording' };
  }
  ctx.signal.throwIfAborted();

  // Two lanes: the peaks of both, the reporter lane alone for the transcriber.
  const split = await withTempDir(async (dir) => {
    const path = await writeTemp(dir, 'call.ogg', audio);
    const analysis = await analyzeCall(ctx.ffmpeg, path);
    return { analysis, lane: await reporterLane(ctx.ffmpeg, dir, path) };
  }).catch((err: unknown) => {
    // A file ffmpeg cannot read is still transcribed as recorded (no peaks).
    log.warn('post-call: the recording was not split; transcribing it as recorded', {
      err: err instanceof Error ? err.message.slice(0, 300) : 'unknown',
    });
    return null;
  });
  const analysis: CallAnalysis | null = split?.analysis ?? null;
  const lane = split ? { audio: split.lane, mime: 'audio/wav' } : { audio, mime: 'audio/ogg' };
  ctx.signal.throwIfAborted();

  const reporter = await ctx.db.getReporter(call.reporter_id!);
  const site = call.site_id ? await ctx.db.siteContext(call.site_id) : null;
  const glossary =
    site && reporter ? await ctx.db.listGlossary(site.org.id, site.site.id, reporter.id) : [];
  const vocabulary = {
    siteName: site?.site.name ?? '',
    companies: site?.companies ?? [],
    glossary,
    languages: reporter?.languages ?? [],
  };
  const language = transcriptionLanguage({
    locale: call.language ?? reporter?.locale ?? null,
    languages: reporter?.languages ?? [],
  });
  const started = Date.now();
  const result = await ctx.ai.transcriber.transcribe({
    audio: lane.audio,
    mime: lane.mime,
    language,
    keyterms: buildKeyterms(vocabulary),
    prompt: buildTranscriptionPrompt({ ...vocabulary, areas: [] }),
    ...(analysis ? { durationS: analysis.durationS } : {}),
    signal: ctx.signal,
    purpose: 'call',
  });
  const durationS = analysis?.durationS || result.durationS;
  const transcript: StoredTranscript = {
    call_id: call.id,
    language: result.language,
    text: result.text,
    // The reporter lane only (§10.2): every segment is the reporter's.
    segments: result.segments.map((s) => ({
      start: s.start,
      end: s.end,
      speaker: 'reporter' as const,
      text: s.text,
    })),
    model: result.model,
  };
  const saved = await ctx.db.postCallRecording({
    callId: call.id,
    peaks: analysis?.peaks ?? null,
    durationS: durationS || null,
    transcript: {
      language: transcript.language,
      text: transcript.text,
      segments: transcript.segments,
      model: transcript.model,
    },
  });
  ctx.metrics.add({
    audioSeconds: durationS,
    estCostUsd: result.estCostUsd,
    transcribeLatencyMs: Date.now() - started,
    transcribeProvider: result.provider,
  });
  log.info('post-call: recording processed', {
    provider: result.provider,
    audio_seconds: durationS,
    segments: transcript.segments.length,
    peaks: analysis !== null,
    replaced: saved.replaced,
  });
  return { ok: true, transcript };
}

// ───────────────────────────── 3a. The fallback recording (F6) ─────────────────────────────

async function fallbackReport(ctx: Ctx, call: CallRow, heard: Heard, log: Logger): Promise<void> {
  const nothing = !heard.ok ? heard.reason : heard.transcript.text.trim() ? null : 'nothing_said';
  if (nothing) {
    await ctx.db.logAudit({
      org_id: call.org_id,
      actor_type: 'system',
      action: 'call.fallback_unused',
      entity: 'call',
      entity_id: call.id,
      diff: { reason: nothing },
    });
    log.info('post-call: the fallback recording made no report', { reason: nothing });
    return;
  }
  const made = await ctx.db.postCallFallbackReport(call.id);
  log.info('post-call: the fallback recording is a voice note of the report', {
    status: made.status,
    report_id: made.reportId ?? null,
    job_id: made.jobId ?? null,
  });
}

// ───────────────────────────── 3b. The reconcile (§10.9) ─────────────────────────────

/** The §13 review notice of reasons a report gets (`needs_review`, as filing sends it). */
export function reviewNotice(reportNo: string, reasons: string[]): ReviewNotice {
  return {
    title: `${reportNo} needs review`,
    body: reasons.join(', '),
    data: noticeData('needs_review', { reportNo, reasons }),
  };
}

async function reconcile(ctx: Ctx, call: CallRow, heard: Heard, log: Logger): Promise<void> {
  const report = call.report_id ? await ctx.db.getReport(call.report_id) : null;
  if (!report) throw new PermanentJobError(`call ${call.id} was filed without a report`);
  const unreconciled = async (reason: string) => {
    const r = await ctx.db.postCallUnreconciled({
      callId: call.id,
      reason,
      notice: reviewNotice(report.report_no, [CALL_UNRECONCILED]),
    });
    log.info('post-call: not reconciled', { reason, changed: r.changed });
  };
  if (!heard.ok) return unreconciled(heard.reason);
  const segments = callSegments(call.id, heard.transcript as TranscriptRow);
  if (segments.length === 0) return unreconciled('nothing_heard');

  // The confirmed version: what the reporter said yes to (later versions add photos or edits).
  const version = await ctx.db.getVersion(report.id, report.current_version || 1);
  if (!version?.data) throw new PermanentJobError(`report ${report.id} has no version`);
  const confirmed = readReportData(version.data as StoredReportData);

  // Batch mode on the call alone (§10.4, §10.9): no previous draft and no answers, so the
  // recording is read on its own words.
  const site = await ctx.db.siteContext(report.site_id);
  if (!site) throw new PermanentJobError(`site ${report.site_id} not found`);
  const reporter = report.reporter_id ? await ctx.db.getReporter(report.reporter_id) : null;
  const siteDay = await ctx.db.getSiteDay(report.site_day_id);
  const input = await composeReportExtractionInput(ctx, report, site, reporter, {
    previousDraft: null,
    reportDate: siteDay?.date ?? confirmed.reportDate,
    observedWeather: siteDayWeatherOf(siteDay?.weather),
    channel: 'call',
  });
  if (!ctx.ai.claude) throw new Error('ANTHROPIC_API_KEY is required for the post-call reconcile');
  const result = await runReportExtraction(
    ctx.ai.claude,
    ctx.config.CLAUDE_MODEL,
    { ...input, segments, previousAnswers: [], previousDraft: null, photos: [] },
    log,
  );
  ctx.metrics.add({
    tokens: result.call.usage,
    estCostUsd: result.call.estCostUsd,
    extractionLatencyMs: result.call.latencyMs,
    extractionRetried: result.call.retried,
  });

  // Code compares (§19 Q123); the model never decides what differs.
  const r = reconcileCall(result.data, confirmed, call.id);
  const reasons = r.mismatches.map(callMismatchReason);
  const done = await ctx.db.postCallReconciled({
    callId: call.id,
    reportId: report.id,
    reasons,
    precise: r.precise,
    result: {
      version: version.version,
      model: result.call.model,
      mismatches: reasons,
      precise: r.precise.length,
      compared: r.compared,
    } as unknown as Json,
    notice: reviewNotice(report.report_no, reasons),
  });
  log.info('post-call: reconciled', {
    status: done.status,
    mismatches: reasons.length,
    added: done.added.length,
    precise: r.precise.length,
    repeat: done.repeat,
  });
}
