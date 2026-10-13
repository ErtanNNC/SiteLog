import { describe, expect, it } from 'vitest';
import { kestrelDemo } from '../demo/kestrel.ts';
import {
  audioStoragePath,
  evidencePackStoragePath,
  formatReportNo,
  logoStoragePath,
  pdfFileName,
  pdfStoragePath,
  photoStoragePath,
} from './numbering.ts';

describe('report numbering (§F5, §12)', () => {
  it('formats the report number as project code + 4-digit sequence', () => {
    expect(formatReportNo('RL-2041', 187)).toBe('RL-2041-0187');
    expect(formatReportNo('RL-2041', 1)).toBe('RL-2041-0001');
    expect(formatReportNo('AY-0412', 31)).toBe('AY-0412-0031');
    expect(formatReportNo('RL-2041', 9999)).toBe('RL-2041-9999');
    // Past 9999 the sequence grows; it is never cut.
    expect(formatReportNo('RL-2041', 12345)).toBe('RL-2041-12345');
  });

  it('names the PDF {report_no}_{YYYY-MM-DD}_v{version}.pdf', () => {
    expect(pdfFileName('RL-2041-0187', '2026-10-09', 2)).toBe('RL-2041-0187_2026-10-09_v2.pdf');
    expect(pdfFileName(formatReportNo('RL-2041', 187), '2026-10-09', 1)).toBe(
      'RL-2041-0187_2026-10-09_v1.pdf',
    );
  });

  it('builds storage paths', () => {
    expect(pdfStoragePath('org', 'site', 'RL-2041-0187', 2)).toBe('org/site/RL-2041-0187_v2.pdf');
    expect(audioStoragePath('org', 'site', '2026-10-09', 'wamid.1')).toBe(
      'org/site/2026-10-09/wamid.1.ogg',
    );
    expect(audioStoragePath('org', 'site', '2026-10-09', 'u1', 'webm')).toBe(
      'org/site/2026-10-09/u1.webm',
    );
    expect(photoStoragePath('org', 'site', '2026-10-09', 'p1')).toBe('org/site/2026-10-09/p1.jpg');
    expect(evidencePackStoragePath('org', 'site', '2026-10-01', '2026-10-09')).toBe(
      'org/site/eot_2026-10-01_2026-10-09.pdf',
    );
    expect(logoStoragePath('org', 'svg')).toBe('org/logo.svg');
  });

  it('matches every report number in the §18 demo data', () => {
    const demo = kestrelDemo();
    const reportNos = demo.reports.map((r) => r.report_no);
    expect(reportNos).toContain('RL-2041-0187');
    for (const no of reportNos) {
      const m = /^(.+)-(\d{4,})$/.exec(no);
      expect(m, no).not.toBeNull();
      expect(formatReportNo(m![1]!, Number(m![2]))).toBe(no);
    }
  });
});
