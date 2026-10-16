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

/**
 * Storage path of a field upload (W1-07, `field-api` `uploads`): `{org}/{site}/{date}/{upload_id}.{ext}`
 * in bucket `audio` (voice notes) or `photos` (`uploadBucket`), `date` the report date
 * (`YYYY-MM-DD`, the site's day). field_complete_upload() reads the date back from the path.
 */
export function uploadStoragePath(
  orgId: string,
  siteId: string,
  date: string,
  uploadId: string,
  ext: string,
): string {
  return `${orgId}/${siteId}/${date}/${uploadId}.${ext}`;
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

/**
 * Where an EOT pack's PDF is stored (exports bucket): one file per pack id (W3-07), so a rebuild of
 * the same site and period, or a second pack built at the same time, never overwrites the PDF an
 * earlier pack sent (audit "EOT packs for the same site and period overwrite each other's PDF").
 * A retry of the same pack overwrites its own file. Packs built before W3-07 keep their
 * `eot_{start}_{end}.pdf`.
 */
export function evidencePackStoragePath(
  orgId: string,
  siteId: string,
  periodStart: string,
  periodEnd: string,
  packId: string,
): string {
  return `${orgId}/${siteId}/eot_${periodStart}_${periodEnd}_${packId}.pdf`;
}

/**
 * Whether a pack's stored `pdf_path` lies under its own org and site, where the worker stores it
 * (`evidencePackStoragePath`). Readers sign only such a path (api-evidence-pack, the worker's
 * send_email): until 20261014000001_queue_rls_fixes.sql a client could write a pack row with any
 * path, for example another org's PDF.
 */
export function isOwnEvidencePackPath(pack: {
  org_id: string;
  site_id: string | null;
  pdf_path: string | null;
}): boolean {
  const { org_id, site_id, pdf_path } = pack;
  if (!pdf_path || !site_id) return false;
  return pdf_path.startsWith(`${org_id}/${site_id}/`) && !pdf_path.split('/').includes('..');
}

/** Company logo in bucket `logos` (§F2, §F18): one object per org, PNG or SVG. */
export function logoStoragePath(orgId: string, ext: 'png' | 'svg'): string {
  return `${orgId}/logo.${ext}`;
}
