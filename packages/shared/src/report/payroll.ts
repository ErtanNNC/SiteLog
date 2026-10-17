/**
 * Payroll CSV columns (§F15 step 5) and their per-org order (org_settings.payroll_columns, §P12).
 * Shared by the web panel (Settings, demo CSV) and the api-export-payroll edge function.
 */

/** §F15 columns in their default order. */
export const PAYROLL_COLUMNS = [
  'date',
  'site',
  'project_code',
  'company',
  'trade',
  'workers',
  'hours',
  'report_no',
  'version',
] as const;

export type PayrollColumn = (typeof PAYROLL_COLUMNS)[number];

export function isPayrollColumn(value: unknown): value is PayrollColumn {
  return typeof value === 'string' && (PAYROLL_COLUMNS as readonly string[]).includes(value);
}

/**
 * A stored order → a complete, valid order: unknown and duplicate names are dropped and any
 * missing column is appended in its default position, so every export carries all columns.
 */
export function normalizePayrollColumns(
  order: readonly string[] | null | undefined,
): PayrollColumn[] {
  const out: PayrollColumn[] = [];
  for (const col of order ?? []) {
    if (isPayrollColumn(col) && !out.includes(col)) out.push(col);
  }
  for (const col of PAYROLL_COLUMNS) if (!out.includes(col)) out.push(col);
  return out;
}

/** The first characters that make a spreadsheet read a cell as a formula (OWASP CSV injection). */
const FORMULA_START = /^[=+\-@\t\r]/;

/**
 * One CSV cell (RFC 4180): a text value that starts like a formula (`=`, `+`, `-`, `@`, tab or
 * CR) gets a leading `'` so Excel, Sheets and LibreOffice show it as text (OWASP "CSV
 * injection"); then a value with a quote, comma or line break is quoted. Numbers stay plain, so
 * `workers` and `version` remain numbers. Used by api-export-payroll and the demo's CSV.
 */
export function csvCell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '';
  let s = String(value);
  if (typeof value === 'string' && FORMULA_START.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
