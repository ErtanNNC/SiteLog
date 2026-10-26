import { PermanentJobError, type JobHandler } from './types';
import { reviewNotice } from './post_call';

/**
 * §10.5 step 2 (W3-11): "for call reports the photo requirement is deferred: never asked on the
 * call; the photos link is texted and the report gets `review_reasons += 'no_photo'` if none
 * arrive by 23:59". Queued delayed at filing for a report with a call source when the org
 * requires a photo (`no_photo:<report>`, run at 23:59 site time of the report's day, at once when
 * that has passed). report_no_photo_check() (SQL) flags it, with the §13 review notice, only if no
 * photo is a source of the report and its current version lists none; once (the reason already
 * there changes nothing). A void report, or one with no call, is left alone.
 */
export const noPhotoCheckJob: JobHandler<'no_photo_check'> = async (ctx, payload) => {
  const report = await ctx.db.getReport(payload.reportId);
  if (!report) throw new PermanentJobError(`report ${payload.reportId} not found`);
  const result = await ctx.db.reportNoPhotoCheck(
    report.id,
    reviewNotice(report.report_no, ['no_photo']),
  );
  ctx.log.info(
    result.flagged ? 'call report flagged no_photo' : 'no_photo check: nothing to flag',
    {
      report_id: report.id,
      reason: result.reason,
    },
  );
};
