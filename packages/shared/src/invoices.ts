/**
 * Sub invoices (F19, P8): when the office is told about an invoice gap, and where an invoice's
 * file is stored. Pure; the SQL `invoice_gap_check()` (migration 20261016000270) applies the same
 * policy to the database and the demo store applies it in memory.
 */

/** `sub_invoices.status` (§6.3, with the check of 20261011000002). */
export type SubInvoiceStatus = 'open' | 'queried' | 'resolved';

/**
 * Spec §19 Q133 (open with the owner; W3-06 builds the recommended default) as a parameter: one
 * `invoice_gap` panel notice (§13: ops and accounts, admin by §2.2) per invoice, when it is saved
 * or when a new report version changes the hours behind it, while the gap is at least
 * `minGapHours` either way; again only when the gap has moved by `minChangeHours` or more since the
 * last notice; never for an invoice in `silentStatuses`. The SQL copies these numbers
 * (`invoice_gap_check()`); `supabase/db-tests` compares them.
 */
export const INVOICE_GAP_POLICY = {
  minGapHours: 1,
  minChangeHours: 1,
  silentStatuses: ['queried', 'resolved'] as readonly SubInvoiceStatus[],
} as const;

export type InvoiceGapPolicy = typeof INVOICE_GAP_POLICY;

/** Hours to two decimals, as `numeric(8,2)` stores them. */
export function roundHours(h: number): number {
  return Math.round(h * 100) / 100;
}

/**
 * Whether an invoice's gap (invoiced − reported, hours) is notified now: the invoice is not
 * queried or resolved, the gap is at least the policy's minimum either way, and it was never
 * notified or has moved by the policy's step since (`lastNotified`, `sub_invoices.gap_notified`).
 */
export function shouldNotifyInvoiceGap(
  input: { status: SubInvoiceStatus; gap: number; lastNotified: number | null },
  policy: InvoiceGapPolicy = INVOICE_GAP_POLICY,
): boolean {
  if (policy.silentStatuses.includes(input.status)) return false;
  const gap = roundHours(input.gap);
  if (Math.abs(gap) < policy.minGapHours) return false;
  if (input.lastNotified === null) return true;
  return Math.abs(gap - roundHours(input.lastNotified)) >= policy.minChangeHours;
}

/**
 * An invoice's hours: its total, else the sum of its daily lines (as the Crew hours page and the
 * SQL read it).
 */
export function invoiceHours(invoice: {
  total_hours: number | string | null;
  lines: unknown;
}): number {
  if (invoice.total_hours !== null && invoice.total_hours !== undefined)
    return Number(invoice.total_hours);
  if (!Array.isArray(invoice.lines)) return 0;
  return invoice.lines.reduce<number>((sum, l) => {
    const h =
      l && typeof l === 'object' ? Number((l as { hours?: unknown }).hours ?? 0) : Number.NaN;
    return Number.isFinite(h) ? sum + h : sum;
  }, 0);
}

/**
 * The storage key of an uploaded invoice file (`invoices` bucket): the org's folder first, so the
 * "members upload invoices" policy still matches, then a uuid and a slug of the file name in safe
 * characters only. A raw name with "#", "%", "[" or a non-ASCII letter ("Rechnung_März.pdf") is
 * refused by Storage or stored under another key (audit `:878`). "Rechnung_März.pdf" →
 * `{org}/{uuid}-Rechnung_Marz.pdf`.
 */
export function invoiceUploadPath(orgId: string, fileName: string, uuid: string): string {
  const m = /^(.*)\.([A-Za-z0-9]{1,8})$/.exec(fileName);
  const base = m && m[1] ? m[1] : fileName;
  const safe = (s: string) =>
    s
      .replace(/ı/g, 'i')
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^A-Za-z0-9._-]+/g, '_')
      .replace(/_+/g, '_')
      .replace(/\.{2,}/g, '.')
      .replace(/^[._-]+|[._-]+$/g, '');
  const slug = safe(base).slice(0, 60) || 'invoice';
  const extension = m && m[1] ? m[2]!.toLowerCase() : 'pdf';
  return `${orgId}/${uuid}-${slug}.${extension}`;
}
