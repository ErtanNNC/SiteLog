import { describe, expect, it } from 'vitest';
import { renderEvidencePackPdf, renderReportPdf, weatherExcerpts } from './render';
import { sampleEvidencePackInput, sampleReportInput } from './sample-data';

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

  it('renders the evidence pack with cover, summary and one page per day', async () => {
    const pdf = await renderEvidencePackPdf(sampleEvidencePackInput);
    expect(pdf.subarray(0, 4).toString()).toBe('%PDF');
    expect(pageCount(pdf)).toBeGreaterThanOrEqual(4);
  }, 60_000);
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
            source: [{ type: 'audio' as const, messageId: 'm', start: 41 }],
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
