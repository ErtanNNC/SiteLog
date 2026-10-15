import { describe, expect, it } from 'vitest';
import { loadLogo, renderEvidencePackPdf, renderReportPdf, weatherExcerpts } from './render';
import {
  demirReportInput,
  sampleEvidencePackInput,
  sampleReportInput,
} from '@sitelog/pdf/sample-data.ts';
import { fmtPhotoTime } from '@sitelog/pdf/components.tsx';

function pageCount(pdf: Buffer): number {
  return (pdf.toString('latin1').match(/\/Type\s*\/Page(?!s)/g) ?? []).length;
}

describe('PDF rendering (smoke)', () => {
  it('renders the §18 hero report as a 2-page Letter PDF with embedded fonts and footer', async () => {
    const pdf = await renderReportPdf(sampleReportInput);
    expect(pdf.subarray(0, 4).toString()).toBe('%PDF');
    expect(pageCount(pdf)).toBe(2);
    const text = pdf.toString('latin1');
    expect(text).toContain('/MediaBox [0 0 612 792]');
    expect(text).toMatch(/FontFile2|FontFile3/);
  }, 60_000);

  it('renders A4 when the org setting says so', async () => {
    const pdf = await renderReportPdf({
      ...sampleReportInput,
      settings: { ...sampleReportInput.settings, paper: 'a4' },
    });
    expect(pdf.toString('latin1')).toMatch(/\/MediaBox \[0 0 595\.2\d* 841\.8\d*\]/);
  }, 60_000);

  it('renders the Turkish v2 sample (Demir Yapı) as a 2-page A4 PDF', async () => {
    const pdf = await renderReportPdf(demirReportInput);
    expect(pdf.subarray(0, 4).toString()).toBe('%PDF');
    expect(pageCount(pdf)).toBe(2);
    expect(pdf.toString('latin1')).toMatch(/\/MediaBox \[0 0 595\.2\d* 841\.8\d*\]/);
  }, 60_000);

  it('renders a WhatsApp-era report (no channel) and a call report confirmed by voice', async () => {
    for (const report of [
      { ...sampleReportInput.report, channel: null, confirmedVia: null },
      { ...sampleReportInput.report, channel: 'voice' as const, confirmedVia: 'voice' as const },
    ]) {
      const pdf = await renderReportPdf({ ...sampleReportInput, report });
      expect(pageCount(pdf)).toBe(2);
    }
  }, 60_000);

  it('renders a report typed in the panel (prepared by the office, no voice source)', async () => {
    const pdf = await renderReportPdf({
      ...sampleReportInput,
      reporterName: null,
      enteredBy: 'Lena Ortiz',
      report: {
        ...sampleReportInput.report,
        confirmedAt: null,
        channel: 'office',
        confirmedVia: null,
      },
      sources: { ...sampleReportInput.sources, audioCount: 0, totalAudioSeconds: 0, textCount: 0 },
      photos: [],
    });
    expect(pdf.subarray(0, 4).toString()).toBe('%PDF');
    expect(pageCount(pdf)).toBe(2);
  }, 60_000);

  it('renders the evidence pack with cover, summary and one page per day', async () => {
    const pdf = await renderEvidencePackPdf(sampleEvidencePackInput);
    expect(pdf.subarray(0, 4).toString()).toBe('%PDF');
    expect(pageCount(pdf)).toBeGreaterThanOrEqual(4);
  }, 60_000);
});

describe('fmtPhotoTime', () => {
  const tz = 'America/Chicago';
  it('prints the time of a photo taken on the report’s day (site time zone)', () => {
    expect(fmtPhotoTime('2026-10-09T21:30:00Z', tz, '2026-10-09')).toBe('16:30');
    // 03:30 UTC on the 10th is still the 9th in Chicago.
    expect(fmtPhotoTime('2026-10-10T03:30:00Z', tz, '2026-10-09')).toBe('22:30');
    expect(fmtPhotoTime('2026-10-10T03:30:00Z', tz)).toBe('22:30');
  });

  it('adds the date when the photo was taken another day', () => {
    expect(fmtPhotoTime('2026-10-10T19:05:00Z', tz, '2026-10-09')).toBe('Oct 10, 14:05');
    expect(fmtPhotoTime('2026-10-08T19:05:00Z', tz, '2026-10-09')).toBe('Oct 8, 14:05');
  });
});

describe('weatherExcerpts', () => {
  it('picks the segments the weather period sources point at, with neighbours', () => {
    const segs = Array.from({ length: 10 }, (_, i) => ({
      start: i * 6,
      end: i * 6 + 6,
      text: `s${i}`,
    }));
    const data = {
      ...sampleReportInput.data,
      weather: {
        ...sampleReportInput.data.weather,
        periods: [
          {
            condition: 'Rain',
            lostHours: 1,
            source: [{ type: 'voice_note' as const, uploadId: 'm', start: 41 }],
          },
        ],
      },
    };
    expect(weatherExcerpts(data, segs).map((s) => s.text)).toEqual(['s5', 's6', 's7']);
    expect(
      weatherExcerpts({ ...data, weather: { ...data.weather, periods: [] } }, segs),
    ).toHaveLength(3);
  });
});

describe('loadLogo', () => {
  const log = { warn: () => undefined } as unknown as Parameters<typeof loadLogo>[0]['log'];
  const storageWith = (paths: string[], seen: string[]) =>
    ({
      download: async (_bucket: string, path: string) => {
        seen.push(path);
        if (!paths.includes(path)) throw new Error('not found');
        return Buffer.from('png');
      },
    }) as unknown as Parameters<typeof loadLogo>[0]['storage'];

  it('embeds a PNG logo as is', async () => {
    const seen: string[] = [];
    const logo = await loadLogo({ storage: storageWith(['o/logo.png'], seen), log }, 'o/logo.png');
    expect(logo?.format).toBe('png');
    expect(seen).toEqual(['o/logo.png']);
  });

  it('uses the PNG rendition the panel uploads next to an SVG logo', async () => {
    const seen: string[] = [];
    const logo = await loadLogo({ storage: storageWith(['o/logo.png'], seen), log }, 'o/logo.svg');
    expect(logo?.format).toBe('png');
    expect(seen).toEqual(['o/logo.png']);
  });

  it('falls back to the company name when an SVG has no rendition', async () => {
    const logo = await loadLogo({ storage: storageWith([], []), log }, 'o/logo.svg');
    expect(logo).toBeNull();
  });
});
