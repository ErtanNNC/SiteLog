import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  heroReportData,
  heroReportDataV1,
  sampleEvidencePackInput,
  sampleReportInput,
} from '@sitelog/pdf/sample-data.ts';
import { renderEvidencePackPdf, renderReportPdf } from './render';

/**
 * The §18 hero sample (the PDFs `pnpm --filter @sitelog/worker render-sample-pdf` writes) as
 * pdftotext prints it, page by page. Its report data is stored as v1 and read through
 * upgradeV1toV2 like every stored version: the snapshots were taken before report data v2
 * (W1-02 step 4) and must not change while v1 data is read through the upgrade.
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
  it('prints the v1 hero report as before v2: same text, 2 pages', async () => {
    expect(heroReportDataV1.schemaVersion).toBe(1);
    expect(sampleReportInput.data).toBe(heroReportData);
    const text = pdfText(await renderReportPdf(sampleReportInput));
    expect(pagesOf(text)).toBe(2);
    await expect(normaliseLayout(text)).toMatchFileSnapshot('./__snapshots__/hero-report.pdf.txt');
  }, 60_000);

  it('prints the v1 hero evidence pack as before v2: same text, 6 pages', async () => {
    const text = pdfText(await renderEvidencePackPdf(sampleEvidencePackInput));
    expect(pagesOf(text)).toBe(6);
    await expect(normaliseLayout(text)).toMatchFileSnapshot(
      './__snapshots__/hero-evidence-pack.pdf.txt',
    );
  }, 60_000);

  it('prints observed weather in the units of a metric v2 report', async () => {
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
      'Observed: 10.2 mm precipitation · 14–18 °C · wind 15 km/h · gusts 29 km/h',
    );
  }, 60_000);
});
