/**
 * Renders the §12 report PDF in the browser with the worker's own document (@sitelog/pdf), for
 * reports typed in the panel and versions the worker has not rendered. Heavy (react-pdf, fonts):
 * load it with `import('@/lib/reportPdf')` when a PDF is actually needed.
 */
import { pdf } from '@react-pdf/renderer';
import { createElement, type ReactElement } from 'react';
import type { DocumentProps } from '@react-pdf/renderer';
import {
  ReportDocument,
  setFontSource,
  type FontFile,
  type PdfImage,
  type ReportPdfInput,
} from '@sitelog/pdf';
import archivoBold from '@sitelog/pdf/fonts/Archivo-Bold.ttf?url';
import archivoExtraBold from '@sitelog/pdf/fonts/Archivo-ExtraBold.ttf?url';
import archivoMedium from '@sitelog/pdf/fonts/Archivo-Medium.ttf?url';
import archivoRegular from '@sitelog/pdf/fonts/Archivo-Regular.ttf?url';
import archivoSemiBold from '@sitelog/pdf/fonts/Archivo-SemiBold.ttf?url';
import archivoExpandedBold from '@sitelog/pdf/fonts/ArchivoExpanded-Bold.ttf?url';
import archivoExpandedExtraBold from '@sitelog/pdf/fonts/ArchivoExpanded-ExtraBold.ttf?url';
import plexMonoMedium from '@sitelog/pdf/fonts/IBMPlexMono-Medium.ttf?url';
import plexMonoRegular from '@sitelog/pdf/fonts/IBMPlexMono-Regular.ttf?url';
import plexMonoSemiBold from '@sitelog/pdf/fonts/IBMPlexMono-SemiBold.ttf?url';
import { buildReportPdfInput, imageFormatOf } from '@/data/pdfInput';
import type { ReportDetail, SettingsData } from '@/data/types';
import { rasterizeSvgLogo } from '@/lib/logo';

const FONT_URLS: Record<FontFile, string> = {
  'Archivo-Regular.ttf': archivoRegular,
  'Archivo-Medium.ttf': archivoMedium,
  'Archivo-SemiBold.ttf': archivoSemiBold,
  'Archivo-Bold.ttf': archivoBold,
  'Archivo-ExtraBold.ttf': archivoExtraBold,
  'ArchivoExpanded-Bold.ttf': archivoExpandedBold,
  'ArchivoExpanded-ExtraBold.ttf': archivoExpandedExtraBold,
  'IBMPlexMono-Regular.ttf': plexMonoRegular,
  'IBMPlexMono-Medium.ttf': plexMonoMedium,
  'IBMPlexMono-SemiBold.ttf': plexMonoSemiBold,
};
setFontSource((file) => new URL(FONT_URLS[file], document.baseURI).href);

/** The letterhead logo; SVG logos are rasterised (react-pdf cannot embed SVG). */
async function loadLogo(
  settings: SettingsData,
): Promise<{ image: PdfImage | null; revoke: () => void }> {
  const none = { image: null, revoke: () => undefined };
  const { logoUrl, logoPath } = settings.org;
  if (!logoUrl) return none;
  if (/\.svg$/i.test(logoPath ?? '')) {
    try {
      const svg = await (await fetch(logoUrl)).blob();
      const png = await rasterizeSvgLogo(svg);
      if (!png) return none;
      const url = URL.createObjectURL(png);
      return { image: { url, format: 'png' }, revoke: () => URL.revokeObjectURL(url) };
    } catch {
      return none;
    }
  }
  const format = imageFormatOf(logoPath) ?? 'png';
  return { image: { url: logoUrl, format }, revoke: () => undefined };
}

export async function renderReportPdf(input: ReportPdfInput): Promise<Blob> {
  return pdf(
    createElement(ReportDocument, { input }) as unknown as ReactElement<DocumentProps>,
  ).toBlob();
}

/** The PDF of the version a report page shows, as the worker would render it. */
export async function renderReportDetailPdf(
  detail: ReportDetail,
  settings: SettingsData,
  now: Date,
): Promise<Blob> {
  const logo = await loadLogo(settings);
  try {
    return await renderReportPdf(buildReportPdfInput(detail, settings, { logo: logo.image, now }));
  } finally {
    logo.revoke();
  }
}
