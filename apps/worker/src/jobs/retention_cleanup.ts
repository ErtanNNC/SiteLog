import type { JobHandler } from './types';

export const RETENTION_BATCH = 200;
/** Finished jobs are kept this long (cost per report and /ops read them), then deleted. */
export const JOB_RETENTION_DAYS = 30;

/** §15 privacy — delete audio and photos (and their transcripts) older than AUDIO_RETENTION_DAYS; reports + PDFs are kept. */
export const retentionCleanup: JobHandler<'retention_cleanup'> = async (ctx, payload) => {
  const before = payload.before
    ? new Date(payload.before)
    : new Date(ctx.now().getTime() - ctx.config.AUDIO_RETENTION_DAYS * 86_400_000);
  let purged = 0;
  let failed = 0;
  for (let round = 0; round < 50; round++) {
    const batch = await ctx.db.listExpiredMedia(before, RETENTION_BATCH);
    if (batch.length === 0) break;
    for (const m of batch) {
      try {
        await ctx.storage.remove(m.type === 'audio' ? 'audio' : 'photos', [m.storage_path]);
        await ctx.db.purgeMessageMedia(m.message_id, ctx.now());
        purged++;
      } catch (err) {
        failed++;
        ctx.log.warn('retention: purge failed', { err, message_id: m.message_id });
        // Avoid looping forever on the same row: mark it purged in the DB anyway.
        await ctx.db.purgeMessageMedia(m.message_id, ctx.now());
      }
    }
    if (batch.length < RETENTION_BATCH) break;
  }
  // The queue table only grows otherwise (load test): drop done jobs after JOB_RETENTION_DAYS.
  const jobsBefore = new Date(ctx.now().getTime() - JOB_RETENTION_DAYS * 86_400_000);
  let jobsDeleted = 0;
  for (let round = 0; round < 50; round++) {
    const n = await ctx.db.purgeFinishedJobs(jobsBefore, 5_000);
    jobsDeleted += n;
    if (n < 5_000) break;
  }
  await ctx.db.logAudit({
    org_id: null,
    actor_type: 'system',
    action: 'retention.cleanup',
    entity: 'messages',
    diff: { before: before.toISOString(), purged, failed, jobs_deleted: jobsDeleted },
  });
  ctx.metrics.add({ purged, failed, jobsDeleted });
  ctx.log.info('retention cleanup done', {
    before: before.toISOString(),
    purged,
    failed,
    jobs_deleted: jobsDeleted,
  });
};
