import { fileReport } from '../pipeline/file';
import type { JobHandler } from './types';

export const fileReportJob: JobHandler<'file_report'> = async (ctx, payload) => {
  const result = await fileReport(ctx, payload.reportId, {
    trigger: payload.trigger,
    confirmMessageId: payload.confirmMessageId ?? null,
  });
  ctx.log.info(result.alreadyFiled ? 'report already filed' : 'report filed', {
    report_id: payload.reportId,
    trigger: payload.trigger,
    reasons: result.reasons,
  });
};
