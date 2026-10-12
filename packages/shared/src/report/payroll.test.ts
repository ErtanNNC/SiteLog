import { describe, expect, it } from 'vitest';
import { isPayrollColumn, normalizePayrollColumns, PAYROLL_COLUMNS } from './payroll.ts';

describe('payroll columns', () => {
  it('keeps the §F15 default order', () => {
    expect([...PAYROLL_COLUMNS]).toEqual([
      'date',
      'site',
      'project_code',
      'company',
      'trade',
      'workers',
      'hours',
      'report_no',
      'version',
    ]);
    expect(normalizePayrollColumns(null)).toEqual([...PAYROLL_COLUMNS]);
    expect(normalizePayrollColumns(undefined)).toEqual([...PAYROLL_COLUMNS]);
    expect(normalizePayrollColumns([])).toEqual([...PAYROLL_COLUMNS]);
  });

  it('honours a stored order, drops unknown / duplicate names and appends missing columns', () => {
    expect(
      normalizePayrollColumns(['company', 'hours', 'ssn', 'company', 'date', 'site', 'version']),
    ).toEqual([
      'company',
      'hours',
      'date',
      'site',
      'version',
      'project_code',
      'trade',
      'workers',
      'report_no',
    ]);
  });

  it('recognises column names', () => {
    expect(isPayrollColumn('report_no')).toBe(true);
    expect(isPayrollColumn('phone')).toBe(false);
    expect(isPayrollColumn(3)).toBe(false);
  });
});
