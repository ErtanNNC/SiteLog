import type { DailyReportData, DailyReportDataV1 } from '@sitelog/shared/schemas/report.ts';
import type { ReportDetail } from '@/data/types';

/**
 * The viewed version as stored, for tests that write a new version from it (as the office editor
 * does). Seeded history is stored v1; the §18.1 Oct 9 reports are stored v2 (W1-06).
 */
export function storedV1(detail: Pick<ReportDetail, 'storedData'>): DailyReportDataV1 {
  if (detail.storedData.schemaVersion !== 1)
    throw new Error(`expected stored v1 data, got v${detail.storedData.schemaVersion}`);
  return detail.storedData;
}

export function storedV2(detail: Pick<ReportDetail, 'storedData'>): DailyReportData {
  if (detail.storedData.schemaVersion !== 2)
    throw new Error(`expected stored v2 data, got v${detail.storedData.schemaVersion}`);
  return detail.storedData;
}
