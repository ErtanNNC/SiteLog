import { fileReport } from '../pipeline/file';
import type { JobHandler } from './types';

export const fileReportJob: JobHandler<'file_report'> = async (ctx, payload) => {
  const result = await fileReport(ctx, payload.reportId, {
    trigger: payload.trigger,
    confirmMessageId: payload.confirmMessageId ?? null,
    ...(payload.version !== undefined ? { version: payload.version } : {}),
  });
  if (result.stale) {
    ctx.log.info('confirm stale: not filed', {
      report_id: payload.reportId,
      confirmed_version: payload.version,
      current_version: result.report.current_version,
      status: result.report.status,
    });
    return;
  }
  ctx.log.info(result.alreadyFiled ? 'report already filed' : 'report filed', {
    report_id: payload.reportId,
    trigger: payload.trigger,
    reasons: result.reasons,
  });
};
