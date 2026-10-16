import { describe, expect, it } from 'vitest';
import type { DailyReportData, TranscriptRow } from '@sitelog/shared';
import {
  loadLogo,
  renderEvidencePackPdf,
  renderReportPdf,
  reporterSegments,
  weatherExcerpts,
  type PackClip,
} from './render';
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
  const seg = (prefix: string, n: number) =>
    Array.from({ length: n }, (_, i) => ({ start: i * 6, end: i * 6 + 6, text: `${prefix}${i}` }));
  const withSources = (source: DailyReportData['weather']['periods'][number]['source']) => ({
    ...sampleReportInput.data,
    weather: {
      ...sampleReportInput.data.weather,
      periods: [{ condition: 'Rain', lostHours: 1, source }],
    },
  });
  const note = (id: string, n: number, clipNo: number | null = null): PackClip => ({
    kind: 'voice_note',
    id,
    clipNo,
    segments: seg(`${id}:`, n),
  });

  it('picks the segments the weather period sources point at, with neighbours', () => {
    const data = withSources([{ type: 'voice_note', uploadId: 'm', start: 41 }]);
    expect(weatherExcerpts(data, [note('m', 10)]).map((s) => s.text)).toEqual([
      'm:5',
      'm:6',
      'm:7',
    ]);
    expect(
      weatherExcerpts({ ...data, weather: { ...data.weather, periods: [] } }, [note('m', 10)]),
    ).toHaveLength(3);
  });

  it('quotes the cited clip only, never the same second of another voice note', () => {
    // Note A is the crew (0–60 s), note B the rain at 5–12 s: the period cites B at 5 s.
    const data = withSources([{ type: 'voice_note', uploadId: 'B', start: 5 }]);
    const out = weatherExcerpts(data, [note('A', 10, 1), note('B', 3, 2)]);
    expect(out.map((e) => e.text)).toEqual(['B:0', 'B:1']);
    expect(out.every((e) => e.clip === 'voice_note' && e.clipNo === 2)).toBe(true);
  });

  it('quotes a call from the reporter’s lane at the cited second', () => {
    const data = withSources([{ type: 'call', callId: 'c1', start: 135 }]);
    const call = reporterSegments({
      segments: [
        { start: 120, end: 128, text: 'Was there any weather today?', speaker: 'agent' },
        {
          start: 130,
          end: 140,
          text: 'rain stopped the facade for two and a half hours',
          speaker: 'reporter',
        },
        { start: 140, end: 146, text: 'Got it. Anything else?', speaker: 'agent' },
      ],
    } as unknown as TranscriptRow);
    const out = weatherExcerpts(data, [
      note('m', 2),
      { kind: 'call', id: 'c1', clipNo: null, segments: call },
    ]);
    expect(out).toEqual([
      {
        clip: 'call',
        clipNo: null,
        start: 130,
        end: 140,
        text: 'rain stopped the facade for two and a half hours',
      },
    ]);
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
