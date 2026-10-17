import type { ReportStatus, SiteDayStatus } from './enums.ts';

/** §7.1 display mapping for UI chips. Status is never conveyed by colour alone: label is always present. */
export type ChipVariant =
  | 'filed'
  | 'awaiting'
  | 'missing'
  | 'needs_review'
  | 'weather_day'
  | 'no_work'
  | 'signed_off'
  | 'pending';

export interface ChipSpec {
  variant: ChipVariant;
  label: string;
}

export function siteDayChip(
  siteDayStatus: SiteDayStatus,
  report?: { status: ReportStatus; needsReview?: boolean | null } | null,
): ChipSpec {
  switch (siteDayStatus) {
    case 'filed':
      if (report?.status === 'signed_off') return { variant: 'signed_off', label: 'Signed off' };
      if (report?.needsReview) return { variant: 'needs_review', label: 'Needs review' };
      return { variant: 'filed', label: 'Filed' };
    case 'processing':
      return { variant: 'awaiting', label: 'Awaiting' };
    case 'reminded':
      return { variant: 'awaiting', label: 'Awaiting' };
    case 'pending':
      return { variant: 'pending', label: 'Awaiting' };
    case 'missing':
      return { variant: 'missing', label: 'Missing' };
    case 'weather_day':
      return { variant: 'weather_day', label: 'Weather day' };
    case 'no_work':
      return { variant: 'no_work', label: 'No work' };
  }
}

export function reportChip(report: {
  status: ReportStatus;
  needsReview?: boolean | null;
}): ChipSpec {
  switch (report.status) {
    case 'signed_off':
      return { variant: 'signed_off', label: 'Signed off' };
    case 'filed':
      return report.needsReview
        ? { variant: 'needs_review', label: 'Needs review' }
        : { variant: 'filed', label: 'Filed' };
    case 'void':
      return { variant: 'no_work', label: 'Void' };
    default:
      return { variant: 'awaiting', label: 'Awaiting' };
  }
}

/** Sidebar / reports badge: reports that need office attention. */
export function needsAttention(report: {
  status: ReportStatus;
  needsReview?: boolean | null;
}): boolean {
  return report.status === 'filed' && !!report.needsReview;
}

/**
 * Whether the PDF of `version` prints the report's sign-off: only the current version of a
 * signed-off report. `reports.status` and `signed_off_*` describe the current version, so an
 * older version (rendered late by the worker, or opened in the panel with `?v=`) must not print a
 * sign-off that version never had. Pure; the worker's and the panel's PDF inputs both use it.
 */
export function versionSignedOff(
  report: { status: ReportStatus; currentVersion: number },
  version: number,
): boolean {
  return report.status === 'signed_off' && version === report.currentVersion;
}

/** The status the PDF of `version` prints: an older version of a signed-off report was filed. */
export function versionPdfStatus(
  report: { status: ReportStatus; currentVersion: number },
  version: number,
): ReportStatus {
  return report.status === 'signed_off' && !versionSignedOff(report, version)
    ? 'filed'
    : report.status;
}
