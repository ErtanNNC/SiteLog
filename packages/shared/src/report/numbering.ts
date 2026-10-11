/** Report numbers: project code + zero-padded sequence (§F5). "RL-2041-0187" */
export function formatReportNo(projectCode: string, seq: number): string {
  return `${projectCode}-${String(seq).padStart(4, '0')}`;
}

/** PDF file name (§12): `{report_no}_{YYYY-MM-DD}_v{version}.pdf` */
export function pdfFileName(reportNo: string, reportDate: string, version: number): string {
  return `${reportNo}_${reportDate}_v${version}.pdf`;
}

/** Storage path for a report PDF: pdfs/{org}/{site}/{report_no}_v{n}.pdf (§F7) */
export function pdfStoragePath(
  orgId: string,
  siteId: string,
  reportNo: string,
  version: number,
): string {
  return `${orgId}/${siteId}/${reportNo}_v${version}.pdf`;
}

/** Storage path for inbound audio: audio/{org}/{site}/{date}/{message_id}.ogg (§4.3) */
export function audioStoragePath(
  orgId: string,
  siteId: string,
  date: string,
  messageId: string,
  ext = 'ogg',
): string {
  return `${orgId}/${siteId}/${date}/${messageId}.${ext}`;
}

export function photoStoragePath(
  orgId: string,
  siteId: string,
  date: string,
  messageId: string,
  ext = 'jpg',
): string {
  return `${orgId}/${siteId}/${date}/${messageId}.${ext}`;
}

export function evidencePackStoragePath(
  orgId: string,
  siteId: string,
  periodStart: string,
  periodEnd: string,
): string {
  return `${orgId}/${siteId}/eot_${periodStart}_${periodEnd}.pdf`;
}
