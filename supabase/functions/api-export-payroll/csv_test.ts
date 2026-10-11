import { assertEquals } from '@std/assert';
import {
  buildPayrollRows,
  csvEscape,
  formatHours,
  PAYROLL_COLUMNS,
  payrollCsv,
  payrollFileName,
  toCsv,
} from './csv.ts';

Deno.test('csvEscape quotes commas, quotes and newlines only', () => {
  assertEquals(csvEscape('Delta Mechanical'), 'Delta Mechanical');
  assertEquals(csvEscape('Riverside Lofts, Block B'), '"Riverside Lofts, Block B"');
  assertEquals(csvEscape('say "hi"'), '"say ""hi"""');
  assertEquals(csvEscape('a\nb'), '"a\nb"');
  assertEquals(csvEscape(7), '7');
  assertEquals(csvEscape(null), '');
  assertEquals(csvEscape(undefined), '');
});

Deno.test('toCsv writes a header and CRLF line endings', () => {
  assertEquals(
    toCsv(
      ['a', 'b'],
      [
        [1, 'x,y'],
        [null, 'z'],
      ],
    ),
    'a,b\r\n1,"x,y"\r\n,z\r\n',
  );
});

Deno.test('formatHours drops trailing zeros and rounds to 2 decimals', () => {
  assertEquals(formatHours(44), '44');
  assertEquals(formatHours(3.5), '3.5');
  assertEquals(formatHours(1 / 3), '0.33');
  assertEquals(formatHours(192.25), '192.25');
});

const sites = [
  { id: 's1', name: 'Riverside Lofts — Block B', project_code: 'RL-2041' },
  { id: 's2', name: 'Elm St. Townhomes', project_code: 'ES-310' },
];
const companies = [
  { id: 'c1', name: 'Delta Mechanical', trade: 'HVAC', status: 'confirmed' },
  { id: 'c2', name: 'Ridgeway', trade: null, status: 'unconfirmed' },
];
const entries = [
  {
    date: '2026-10-06',
    site_id: 's1',
    company_id: 'c1',
    company_name: 'Delta Mechanical',
    company_name_heard: 'the Delta guys',
    trade: null,
    workers: 6,
    hours: 48,
    report_no: 'RL-2041-0187',
    version: 2,
  },
  {
    date: '2026-10-05',
    site_id: 's2',
    company_id: 'c2',
    company_name: 'Ridgeway',
    company_name_heard: 'Ridgeway',
    trade: 'Framing',
    workers: 4,
    hours: 32,
    report_no: 'ES-310-0042',
    version: 1,
  },
  {
    date: '2026-10-05',
    site_id: 's1',
    company_id: null,
    company_name: null,
    company_name_heard: 'the painters',
    trade: 'Painting',
    workers: 2,
    hours: 7.5,
    report_no: 'RL-2041-0186',
    version: 1,
  },
  {
    date: '2026-10-05',
    site_id: 's1',
    company_id: 'c1',
    company_name: 'Delta Mechanical',
    company_name_heard: null,
    trade: 'HVAC',
    workers: 5,
    hours: 40,
    report_no: 'RL-2041-0186',
    version: 1,
  },
];

Deno.test('buildPayrollRows joins, sorts and resolves names; unconfirmed rows are optional', () => {
  const all = buildPayrollRows(entries, sites, companies, { includeUnconfirmed: true });
  assertEquals(
    all.map((r) => [r.date, r.site, r.company, r.trade, r.hours]),
    [
      ['2026-10-05', 'Elm St. Townhomes', 'Ridgeway', 'Framing', '32'],
      ['2026-10-05', 'Riverside Lofts — Block B', 'Delta Mechanical', 'HVAC', '40'],
      ['2026-10-05', 'Riverside Lofts — Block B', 'the painters', 'Painting', '7.5'],
      ['2026-10-06', 'Riverside Lofts — Block B', 'Delta Mechanical', 'HVAC', '48'],
    ],
  );
  const confirmedOnly = buildPayrollRows(entries, sites, companies, { includeUnconfirmed: false });
  assertEquals(
    confirmedOnly.map((r) => r.company),
    ['Delta Mechanical', 'Delta Mechanical'],
  );
});

Deno.test('payrollCsv has exactly the spec columns in order', () => {
  assertEquals(
    [...PAYROLL_COLUMNS],
    [
      'date',
      'site',
      'project_code',
      'company',
      'trade',
      'workers',
      'hours',
      'report_no',
      'version',
    ],
  );
  const rows = buildPayrollRows([entries[0]!], sites, companies, { includeUnconfirmed: false });
  assertEquals(
    payrollCsv(rows),
    'date,site,project_code,company,trade,workers,hours,report_no,version\r\n' +
      '2026-10-06,Riverside Lofts — Block B,RL-2041,Delta Mechanical,HVAC,6,48,RL-2041-0187,2\r\n',
  );
  assertEquals(payrollFileName('2026-W41'), 'payroll_2026-W41.csv');
});
