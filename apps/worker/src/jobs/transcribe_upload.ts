import {
  JOB_MAX_ATTEMPTS,
  jobKeys,
  photosAddedNote,
  type JobRow,
  type UploadRow,
} from '@sitelog/shared';
import { buildTranscriptionPrompt } from '../ai/transcribe';
import { buildKeyterms, transcriptionLanguage } from '../ai/transcriber';
import type { Ctx } from '../context';
import {
  analyzeAudio,
  UPLOAD_PEAK_BUCKETS,
  withTempDir,
  writeTemp,
  type AudioAnalysis,
} from '../media/ffmpeg';
import { mimeExtension } from '../storage';
import { PermanentJobError, type JobHandler } from './types';

/**
 * §10.1 `transcribe_upload(upload_id)` (W1-11): a voice note of the web recorder. field-api
 * enqueues it when an upload completes (`field_complete_upload()`, dedupe
 * `transcribe_upload:<upload>`), and the job runs under the report's lock key.
 *
 * 1. The file from the `audio` bucket (service role), sent to the transcriber as the browser
 *    recorded it (webm/mp4, no conversion, §10.2).
 * 2. ffmpeg measures it: the duration and about 600 peaks for the players. A file ffmpeg cannot
 *    decode still gets its transcript (the provider's duration, no peaks).
 * 3. One transaction: `transcripts` (upload_id, no message), the upload's duration and peaks, and
 *    the `transcript.created` audit row. A retry finds the transcript and never calls the provider
 *    again or writes a second one.
 * 4. Once every kept voice note of the report has its transcript, `extract_report` keyed by the
 *    report and its latest voice upload (`jobKeys.extractUpload`): a retry, or the transcription of
 *    an earlier note finishing last, finds the key taken; a later voice note is a new key.
 *
 * Latency and audio seconds go to the job's metrics (jobs.payload.metrics) and the `transcribed`
 * log line.
 *
 * `purpose: 'caption'` (F9, W2-04): the voice caption of photos added after filing (an upload of
 * a batch). Its transcript is the photos' caption: once stored, the batch is attached as the
 * filed report's next version (`field_attach_photos`, "2 photos added" in the report language);
 * nothing is extracted. A caption that cannot be transcribed (on the last attempt, or a failure
 * no retry fixes) does not hold the photos back: they go in without it.
 */
export const transcribeUploadJob: JobHandler<'transcribe_upload'> = async (ctx, payload, job) => {
  const upload = await ctx.db.getUpload(payload.uploadId);
  if (!upload) throw new PermanentJobError(`upload ${payload.uploadId} not found`);
  if (upload.kind !== 'audio') throw new PermanentJobError(`upload ${upload.id} is not audio`);
  if (!upload.report_id)
    throw new PermanentJobError(`upload ${upload.id} is not attached to a report`);
  const log = ctx.log.child({ upload_id: upload.id, report_id: upload.report_id });

  if (payload.purpose === 'caption' || upload.batch_id) {
    await captionThenAttach(ctx, upload, job, log);
    return;
  }

  if (!(await ctx.db.getUploadTranscript(upload.id))) {
    if (upload.purged_at) throw new PermanentJobError(`upload ${upload.id} was purged`);
    await transcribe(ctx, upload, log);
  }
  await extractWhenAllTranscribed(ctx, upload.report_id, log);
};

async function transcribe(ctx: Ctx, upload: UploadRow, log: Ctx['log']): Promise<void> {
  const site = await ctx.db.siteContext(upload.site_id);
  if (!site) throw new PermanentJobError(`site ${upload.site_id} not found`);
  const reporter = upload.reporter_id ? await ctx.db.getReporter(upload.reporter_id) : null;
  const mime = upload.mime ?? 'audio/webm';

  const audio = await ctx.storage.download('audio', upload.storage_path);
  ctx.signal.throwIfAborted();
  const analysis = await measure(ctx, audio, mime, log);
  ctx.signal.throwIfAborted();

  // §10.2: the reporter's language and hints; with no reporter the org's locale stands in.
  const language = transcriptionLanguage({
    locale: reporter?.locale ?? site.org.locale,
    languages: reporter?.languages ?? [],
  });
  const vocabulary = {
    siteName: site.site.name,
    companies: site.companies,
    glossary: site.glossary,
    languages: reporter?.languages ?? [],
  };
  const areas = site.glossary
    .filter((g) => g.kind === 'area' && (g.status === 'confirmed' || g.status === 'built_in'))
    .map((g) => g.official ?? g.heard);
  const started = Date.now();
  const result = await ctx.ai.transcriber.transcribe({
    audio,
    mime,
    language,
    keyterms: buildKeyterms(vocabulary),
    prompt: buildTranscriptionPrompt({ ...vocabulary, areas }),
    ...(analysis ? { durationS: analysis.durationS } : {}),
    signal: ctx.signal,
  });
  // Saved even when the job timed out meanwhile: the provider's work is not thrown away.
  const latencyMs = Date.now() - started;

  const durationS = analysis?.durationS || result.durationS;
  const { created } = await ctx.db.saveUploadTranscript({
    uploadId: upload.id,
    language: result.language,
    text: result.text,
    segments: result.segments,
    model: result.model,
    durationS: durationS || null,
    peaks: analysis?.peaks ?? null,
    audit: {
      provider: result.provider,
      model: result.model,
      language: result.language,
      requested_language: language,
      seconds: durationS,
      segments: result.segments.length,
    },
  });
  ctx.metrics.add({
    audioSeconds: durationS,
    estCostUsd: result.estCostUsd,
    transcribeLatencyMs: latencyMs,
    transcribeProvider: result.provider,
  });
  log.info('transcribed', {
    provider: result.provider,
    model: result.model,
    language: result.language,
    requested_language: language,
    audio_seconds: durationS,
    latency_ms: latencyMs,
    segments: result.segments.length,
    peaks: analysis?.peaks.length ?? 0,
    created,
  });
}

/** F9: the caption's transcript (or none it could get), then the batch as the next version. */
async function captionThenAttach(
  ctx: Ctx,
  upload: UploadRow,
  job: Pick<JobRow, 'attempts'> | undefined,
  log: Ctx['log'],
): Promise<void> {
  const batchId = upload.batch_id;
  const reportId = upload.report_id!;
  if (!batchId) throw new PermanentJobError(`caption upload ${upload.id} has no batch`);
  let caption: string | null = null;
  try {
    let transcript = await ctx.db.getUploadTranscript(upload.id);
    if (!transcript && !upload.purged_at) {
      await transcribe(ctx, upload, log);
      transcript = await ctx.db.getUploadTranscript(upload.id);
    }
    caption = transcript?.text.trim() || null;
  } catch (err) {
    const last = err instanceof PermanentJobError || (job?.attempts ?? 1) >= JOB_MAX_ATTEMPTS;
    if (!last) throw err;
    log.warn('caption not transcribed; adding the photos without it', { err });
  }
  const report = await ctx.db.getReport(reportId);
  if (!report) throw new PermanentJobError(`report ${reportId} not found`);
  const photos = await ctx.db.countBatchPhotos(batchId);
  const result = await ctx.db.attachPhotos(
    reportId,
    batchId,
    photosAddedNote(report.language, photos),
    caption,
  );
  log.info('photos added after filing', {
    batch_id: batchId,
    photos,
    caption: caption !== null,
    version: result.version,
    already_attached: result.alreadyAttached,
  });
}

/** Duration and peaks with ffmpeg; null (logged) when the file does not decode. */
async function measure(
  ctx: Ctx,
  audio: Buffer,
  mime: string,
  log: Ctx['log'],
): Promise<AudioAnalysis | null> {
  try {
    return await withTempDir(async (dir) => {
      const path = await writeTemp(dir, `in.${mimeExtension(mime, 'webm')}`, audio);
      return analyzeAudio(ctx.ffmpeg, path, UPLOAD_PEAK_BUCKETS);
    });
  } catch (err) {
    log.warn('voice note not measured (no peaks); transcribing it anyway', { err });
    return null;
  }
}

async function extractWhenAllTranscribed(
  ctx: Ctx,
  reportId: string,
  log: Ctx['log'],
): Promise<void> {
  const report = await ctx.db.getReport(reportId);
  if (!report || report.status !== 'processing') {
    // Filed, voided or moved on meanwhile: the transcript stays a source, nothing is extracted.
    log.info('transcript kept; report not processing, no extraction', {
      status: report?.status ?? null,
    });
    return;
  }
  const voices = await ctx.db.listReportVoiceUploads(report.id);
  const pending = voices.filter((v) => !v.transcribed);
  if (pending.length > 0) {
    // The last of them to be transcribed starts the extraction.
    log.info('waiting for the other voice notes of the report', { pending: pending.length });
    return;
  }
  const latest = voices.at(-1);
  if (!latest) return;
  await ctx.db.enqueueJob(
    'extract_report',
    { reportId: report.id, reason: `upload:${latest.id}` },
    { dedupeKey: jobKeys.extractUpload(report.id, latest.id) },
  );
}
