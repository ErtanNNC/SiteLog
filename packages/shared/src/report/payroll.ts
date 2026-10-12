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
