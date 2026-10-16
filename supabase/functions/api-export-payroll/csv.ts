/**
 * Payroll CSV (§F15 step 5, §P8). Pure: rows in, text out. RFC 4180 quoting, CRLF line endings,
 * and text that starts like a spreadsheet formula prefixed with `'` (OWASP CSV injection, W3-06).
 */

import {
  csvCell,
  normalizePayrollColumns,
  PAYROLL_COLUMNS,
  type PayrollColumn,
} from '@sitelog/shared/report/payroll.ts';

export { normalizePayrollColumns, PAYROLL_COLUMNS, type PayrollColumn };

export interface ManpowerInput {
  date: string;
  site_id: string;
  company_id: string | null;
  company_name: string | null;
  company_name_heard: string | null;
  trade: string | null;
  workers: number;
  hours: number;
  report_no: string;
  version: number;
}

export interface SiteRef {
  id: string;
  name: string;
  project_code: string;
}

export interface CompanyRef {
  id: string;
  name: string;
  trade: string | null;
  status: string;
}

export interface PayrollRow {
  date: string;
  site: string;
  project_code: string;
  company: string;
  trade: string;
  workers: number;
  hours: string;
  report_no: string;
  version: number;
}

export type CsvValue = string | number | null | undefined;

/**
 * One cell: `csvCell` (packages/shared/src/report/payroll.ts), so a company, site or trade named
 * `=HYPERLINK(…)`, `+1`, `-1` or `@SUM(…)` opens as text, and numbers stay numbers.
 */
export function csvEscape(value: CsvValue): string {
  return csvCell(value);
}

export function toCsv(
  columns: readonly string[],
  rows: ReadonlyArray<ReadonlyArray<CsvValue>>,
): string {
  const lines = [columns.map(csvEscape).join(',')];
  for (const row of rows) lines.push(row.map(csvEscape).join(','));
  return `${lines.join('\r\n')}\r\n`;
}

/** 44 → "44", 3.5 → "3.5", 1/3 → "0.33" (two decimals max, no trailing zeros). */
export function formatHours(hours: number): string {
  const rounded = Math.round(hours * 100) / 100;
  return Number.isInteger(rounded) ? String(rounded) : String(rounded);
}

/**
 * Joins current-version manpower entries with sites and companies. Companies without a record
 * (unknown) or with status `unconfirmed` are dropped unless `includeUnconfirmed` is set
 * (org_settings.include_unconfirmed_in_payroll).
 */
export function buildPayrollRows(
  entries: readonly ManpowerInput[],
  sites: readonly SiteRef[],
  companies: readonly CompanyRef[],
  opts: { includeUnconfirmed: boolean },
): PayrollRow[] {
  const siteById = new Map(sites.map((s) => [s.id, s]));
  const companyById = new Map(companies.map((c) => [c.id, c]));
  const rows: PayrollRow[] = [];
  for (const e of entries) {
    const company = e.company_id ? companyById.get(e.company_id) : undefined;
    const confirmed = company !== undefined && company.status === 'confirmed';
    if (!confirmed && !opts.includeUnconfirmed) continue;
    const site = siteById.get(e.site_id);
    rows.push({
      date: e.date,
      site: site?.name ?? '',
      project_code: site?.project_code ?? '',
      company: company?.name ?? e.company_name ?? e.company_name_heard ?? 'Unknown',
      trade: e.trade ?? company?.trade ?? '',
      workers: e.workers,
      hours: formatHours(e.hours),
      report_no: e.report_no,
      version: e.version,
    });
  }
  return rows.sort(
    (a, b) =>
      a.date.localeCompare(b.date) ||
      a.site.localeCompare(b.site) ||
      a.company.localeCompare(b.company) ||
      a.trade.localeCompare(b.trade),
  );
}

/**
 * Columns follow the org's order (org_settings.payroll_columns, §P12), normalised so every §F15
 * column is present exactly once; the default is the spec order.
 */
export function payrollCsv(
  rows: readonly PayrollRow[],
  order: readonly string[] | null | undefined = PAYROLL_COLUMNS,
): string {
  const columns = normalizePayrollColumns(order);
  return toCsv(
    columns,
    rows.map((r) => columns.map((c) => r[c])),
  );
}

export function payrollFileName(isoWeek: string): string {
  return `payroll_${isoWeek}.csv`;
}
