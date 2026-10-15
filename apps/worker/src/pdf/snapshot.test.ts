import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
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
