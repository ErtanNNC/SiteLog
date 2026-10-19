import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  demirEvidencePackInput,
  demirReportInput,
  heroReportData,
  heroReportDataV1,
  sampleEvidencePackInput,
  sampleReportInput,
} from '@sitelog/pdf/sample-data.ts';
import { renderEvidencePackPdf, renderReportPdf } from './render';

/**
 * The §18 hero sample and the Turkish Demir Yapı sample (the PDFs `pnpm --filter @sitelog/worker
 * render-sample-pdf` writes) as pdftotext prints them, page by page. The hero's report data is
 * stored as v1 and read through upgradeV1toV2 like every stored version; the Turkish sample is v2
 * as written. A snapshot changes only with a deliberate change to the document (W1-14: the v1.2
 * copy, EN/TR labels and the Report-P1/P2 layout).
 *
 * pdftotext comes with poppler-utils, which CI installs (.github/workflows/ci.yml). A machine
 * without it skips these checks; CI never does.
 */
const hasPdftotext = !spawnSync('pdftotext', ['-v']).error;
const enabled = hasPdftotext || !!process.env.CI;

function pdfText(pdf: Buffer): string {
  const dir = mkdtempSync(join(tmpdir(), 'sitelog-pdf-'));
  try {
    const file = join(dir, 'doc.pdf');
    writeFileSync(file, pdf);
    return execFileSync('pdftotext', ['-layout', file, '-'], { encoding: 'utf8' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** pdftotext ends every page with a form feed. */
const pagesOf = (text: string) => text.split('\f').length - 1;

/**
 * `-layout` pads columns with spaces, and the padding can move between poppler releases (the
 * `ubuntu-latest` runner image updates poppler with the OS). The snapshots therefore hold the text
 * with each run of whitespace collapsed and blank lines dropped: the words, their order, the lines
 * and the page breaks still prove the PDF unchanged; the column padding does not count.
 */
function normaliseLayout(text: string): string {
  return text
    .split('\f')
    .map((page) =>
      page
        .split('\n')
        .map((line) => line.replace(/\s+/g, ' ').trim())
        .filter((line) => line !== '')
        .join('\n'),
    )
    .join('\n\f\n');
}

describe.skipIf(!enabled)('PDF text snapshots (pdftotext)', () => {
  it('prints the v1 hero report (web recorder, v1.2 copy): same text, 2 pages', async () => {
    expect(heroReportDataV1.schemaVersion).toBe(1);
    expect(sampleReportInput.data).toBe(heroReportData);
    const text = pdfText(await renderReportPdf(sampleReportInput));
    expect(pagesOf(text)).toBe(2);
    await expect(normaliseLayout(text)).toMatchFileSnapshot('./__snapshots__/hero-report.pdf.txt');
  }, 60_000);

  it('prints the v1 hero evidence pack: same text, 6 pages', async () => {
    const text = pdfText(await renderEvidencePackPdf(sampleEvidencePackInput));
    expect(pagesOf(text)).toBe(6);
    await expect(normaliseLayout(text)).toMatchFileSnapshot(
      './__snapshots__/hero-evidence-pack.pdf.txt',
    );
  }, 60_000);

  it('prints the hero evidence pack with each day’s confirmation (spec §19 Q134)', async () => {
    const flat = pdfText(await renderEvidencePackPdf(sampleEvidencePackInput)).replace(/\s+/g, ' ');
    expect(flat).toContain('Confirmed by the site manager on WhatsApp at 17:41.');
    expect(flat).toContain('Confirmed by the site manager on the recorder at 18:12.');
    expect(flat).toContain('Signed off in TalkOlog by Sam Kowalski · Oct 5, 08:30.');
    expect(flat).toContain('voice note 0:41–0:47');
    expect(flat).not.toMatch(/Each report was confirmed/);
  }, 60_000);

  it('prints the Demir Yapı pack in Turkish, A4 and metric, with a call excerpt', async () => {
    const pdf = await renderEvidencePackPdf(demirEvidencePackInput);
    expect(pdf.toString('latin1')).toMatch(/\/MediaBox \[0 0 595\.\d+ 841\.\d+\]/);
    const text = pdfText(pdf);
    const flat = text.replace(/\s+/g, ' ');
    expect(flat).toContain('HAVA MUHALEFETİ KANITLARI');
    expect(flat).toContain('GÜNLERE GÖRE GECİKME ÖZETİ');
    expect(flat).toContain('arama 2:15–2:22');
    expect(flat).toContain('Şantiye şefi raporu görüşmede sesli olarak onayladı (saat 18:46).');
    expect(flat).toContain(
      'Rapor, şantiye şefinin onayı olmadan otomatik olarak dosyalandı (saat 20:45). Ofis onaylayana kadar talebe hazır sayılmaz.',
    );
    // Observed weather in the org's units: 0.15 in → 3.8 mm, 57 °F → 14 °C, 11 mph → 18 km/h.
    expect(flat).toContain('YAĞIŞ (MM)');
    expect(flat).toMatch(/08:00 3,8 14 18 34/);
    expect(flat).not.toMatch(/Evidence pack|Confirmed by|WhatsApp/);
    await expect(normaliseLayout(text)).toMatchFileSnapshot(
      './__snapshots__/demir-evidence-pack.pdf.txt',
    );
  }, 60_000);

  it('prints only the sections the office ticked', async () => {
    const flat = pdfText(
      await renderEvidencePackPdf({ ...sampleEvidencePackInput, sections: ['summary', 'weather'] }),
    ).replace(/\s+/g, ' ');
    expect(flat).toContain('DELAY SUMMARY BY DAY');
    expect(flat).toContain('OBSERVED WEATHER (HOURLY)');
    expect(flat).not.toMatch(/TRANSCRIPT EXCERPTS|llovió|MANPOWER ON SITE|PHOTOS/);
    const summaryOnly = pdfText(
      await renderEvidencePackPdf({ ...sampleEvidencePackInput, sections: ['summary'] }),
    );
    // No day page at all when no day section is ticked: the cover and the summary.
    expect(pagesOf(summaryOnly)).toBe(2);
  }, 60_000);

  it('prints the Turkish v2 sample in Turkish on 2 pages, with ğ ş ı İ intact', async () => {
    expect(demirReportInput.data.schemaVersion).toBe(2);
    const text = pdfText(await renderReportPdf(demirReportInput));
    expect(pagesOf(text)).toBe(2);
    // The embedded fonts carry the Turkish letters: each comes back out of the PDF as itself.
    for (const ch of ['ğ', 'ş', 'ı', 'İ', 'Ş', 'Ü', 'ç', 'ö']) expect(text).toContain(ch);
    const flat = text.replace(/\s+/g, ' ');
    expect(flat).toContain('GÜNLÜK ŞANTİYE RAPORU');
    expect(flat).toContain('Cuma, 9 Ekim 2026');
    expect(flat).toContain('ŞANTİYEDEKİ İŞGÜCÜ');
    expect(flat).toContain('Sayfa 1 / 2');
    expect(flat).not.toMatch(/WhatsApp|Daily Site Report|DAILY SITE REPORT/);
    await expect(normaliseLayout(text)).toMatchFileSnapshot('./__snapshots__/demir-report.pdf.txt');
  }, 60_000);

  it('prints observed weather in the units and language of a metric Turkish v2 report', async () => {
    const text = pdfText(
      await renderReportPdf({
        ...sampleReportInput,
        data: {
          ...heroReportData,
          reportLanguage: 'tr',
          units: 'metric',
          weather: {
            ...heroReportData.weather,
            observed: {
              precip: 10.2,
              tempMin: 14,
              tempMax: 18,
              wind: 15,
              gust: 29,
              provider: 'Open-Meteo',
            },
          },
        },
      }),
    );
    expect(text.replace(/\s+/g, ' ')).toContain(
      'Ölçülen: 10,2 mm yağış · 14–18 °C · rüzgâr 15 km/h · hamle 29 km/h',
    );
  }, 60_000);
});
