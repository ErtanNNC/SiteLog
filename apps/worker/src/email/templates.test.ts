import { describe, expect, it } from 'vitest';
import { deriveTotals } from '@sitelog/shared';
import { heroReportData } from '@sitelog/pdf/sample-data.ts';
import {
  evidencePackReadyEmail,
  invoiceQueryEmail,
  reportEditedAfterSignoffEmail,
  reportFiledEmail,
  reportMissingEmail,
  unknownContactEmail,
  weeklyDigestEmail,
} from './templates';

const EMOJI = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u;

describe('email templates', () => {
  it('report_filed uses the §13 subject and lists crew, hours, weather', () => {
    const e = reportFiledEmail({
      kind: 'report_filed',
      orgName: 'Kestrel Build Group',
      siteName: 'Riverside Lofts — Block B',
      reportNo: 'RL-2041-0187',
      reportDate: '2026-10-09',
      version: 1,
      changeNote: null,
      summary: heroReportData.summary,
      totals: deriveTotals(heroReportData),
      reviewReasons: [],
      isLate: false,
      reporterFirstName: 'Marco',
      url: 'https://app.sitelog.app/reports/x',
    });
    expect(e.subject).toBe('Daily report · Riverside Lofts · Fri Oct 9 · RL-2041-0187');
    expect(e.text).toContain('Crew: 24 on site · 5 subs');
    expect(e.text).toContain('Hours: 192 h');
    expect(e.html).toContain('Open in SiteLog');
    expect(e.html).not.toMatch(EMOJI);
  });

  it('report_updated shows the change note and review reasons', () => {
    const e = reportFiledEmail({
      kind: 'report_updated',
      orgName: 'K',
      siteName: 'Oakmont Medical Center',
      reportNo: 'OM-1187-0120',
      reportDate: '2026-10-09',
      version: 2,
      changeNote: 'Apex Concrete 6 → 7 workers',
      summary: 's',
      totals: deriveTotals(heroReportData),
      reviewReasons: ['unknown_company:Ridgeway'],
      isLate: true,
      reporterFirstName: null,
      url: 'u',
    });
    expect(e.subject).toContain('Updated: OM-1187-0120');
    expect(e.text).toContain('Updated: Apex Concrete 6 → 7 workers');
    expect(e.text).toContain('Unknown subcontractor: Ridgeway');
    expect(e.html).toContain('Needs review');
    expect(e.html).toContain('Late');
  });

  it('other kinds render subject, text and html without emoji', () => {
    const all = [
      reportMissingEmail({
        orgName: 'K',
        siteName: 'Elm St. Townhomes',
        date: '2026-10-09',
        reporterFirstName: 'Priya',
        reporterPhone: '+15550147719',
        url: 'u',
      }),
      invoiceQueryEmail({
        orgName: 'K',
        companyName: 'BrightLine Electric',
        invoiceNo: 'BL-3381',
        periodStart: '2026-10-05',
        periodEnd: '2026-10-09',
        invoicedHours: 212,
        reportedHours: 196,
        url: 'u',
      }),
      evidencePackReadyEmail({
        orgName: 'K',
        siteName: 'Riverside Lofts — Block B',
        periodStart: '2026-10-01',
        periodEnd: '2026-10-09',
        downloadUrl: 'https://x/signed',
        panelUrl: 'u',
      }),
      weeklyDigestEmail({
        orgName: 'K',
        weekStart: '2026-10-05',
        weekEnd: '2026-10-11',
        stats: {
          siteDays: 30,
          filed: 29,
          onTime: 27,
          weatherHoursBySite: [{ siteName: 'Riverside', hours: 7 }],
          unsigned: [{ reportNo: 'RL-2041-0187', siteName: 'Riverside', date: '2026-10-09' }],
          invoiceGaps: [{ companyName: 'BrightLine Electric', gap: 16 }],
        },
        url: 'u',
      }),
      unknownContactEmail({
        orgName: 'K',
        phone: '+15550194410',
        snippet: 'this is Luis, covering Elm St. today',
        url: 'u',
      }),
      reportEditedAfterSignoffEmail({
        orgName: 'K',
        reportNo: 'RL-2041-0187',
        changeNote: 'Apex 6 → 7',
        version: 2,
        url: 'u',
      }),
    ];
    for (const e of all) {
      expect(e.subject.length).toBeGreaterThan(5);
      expect(e.text.length).toBeGreaterThan(20);
      expect(e.html).toContain('<!doctype html>');
      expect(e.html).not.toMatch(EMOJI);
      expect(e.text).not.toMatch(EMOJI);
    }
    expect(all[0]!.text).toContain("Priya hasn't sent the report for");
    expect(all[0]!.text).toContain('the deadline has passed');
    expect(all[0]!.text).not.toContain('reminder');
    expect(all[1]!.text).toContain('Difference: +16 h');
    expect(all[3]!.subject).toContain('90% on time');
  });
});
