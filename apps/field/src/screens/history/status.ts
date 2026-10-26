import type { ReportStatus } from '@sitelog/shared/enums.ts';
import type { HistoryResponse } from '@sitelog/shared/field-contract.ts';

/**
 * A report's chip on Past reports (W2-03): the token pair and dot of its group, beside the
 * status in words (`field.history.status.*`): never by colour alone. Pure.
 */
export function statusChip(status: ReportStatus): { chip: string; dot: string } {
  switch (status) {
    case 'filed':
    case 'signed_off':
      return { chip: 'bg-chip-filed-bg text-chip-filed-fg', dot: 'bg-filed' };
    case 'awaiting_answer':
    case 'awaiting_confirmation':
      return { chip: 'bg-chip-await-bg text-chip-await-fg', dot: 'bg-signal' };
    case 'void':
      return { chip: 'bg-chip-wx-bg text-chip-wx-fg', dot: 'bg-steel' };
    default:
      return { chip: 'bg-chip-review-bg text-chip-review-fg', dot: 'bg-level' };
  }
}

/** A report the reporter can still carry on with (`/report/:id`): not filed yet. */
export function inProgress(status: ReportStatus): boolean {
  return (
    status === 'collecting' ||
    status === 'processing' ||
    status === 'awaiting_answer' ||
    status === 'awaiting_confirmation'
  );
}

export type HistoryRow = HistoryResponse['reports'][number];

/**
 * The list grouped per site (F14: a multi-site reporter), in the order field-api answers (newest
 * first); groups in the order of their newest report. Pure.
 */
export function groupBySite(
  rows: readonly HistoryRow[],
): { siteId: string; siteName: string; rows: HistoryRow[] }[] {
  const groups = new Map<string, { siteId: string; siteName: string; rows: HistoryRow[] }>();
  for (const row of rows) {
    let g = groups.get(row.siteId);
    if (!g) {
      g = { siteId: row.siteId, siteName: row.siteName, rows: [] };
      groups.set(row.siteId, g);
    }
    g.rows.push(row);
  }
  return [...groups.values()];
}
