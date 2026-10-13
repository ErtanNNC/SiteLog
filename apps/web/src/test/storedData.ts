import type { DailyReportDataV1 } from '@sitelog/shared/schemas/report.ts';
import type { ReportDetail } from '@/data/types';

/**
 * The viewed version as stored, for tests that write a new version from it (as the office editor
 * does). Every demo and seeded version is v1 until the writers move to v2 (W1-12).
 */
export function storedV1(detail: Pick<ReportDetail, 'storedData'>): DailyReportDataV1 {
  if (detail.storedData.schemaVersion !== 1)
    throw new Error(`expected stored v1 data, got v${detail.storedData.schemaVersion}`);
  return detail.storedData;
}
