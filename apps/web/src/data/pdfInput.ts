/**
 * The §12 report PDF's input, built in the panel from what the report page already loaded — the
 * same fields the worker's buildReportPdfInput (apps/worker/src/pdf/render.ts) reads from the
 * database, so both render the same document.
 */
import type { PdfImage, PdfPhoto, ReportPdfInput } from '@sitelog/pdf';
import type { ReportDetail, SettingsData } from './types';

export function imageFormatOf(
  path: string | null | undefined,
  mime?: string | null,
): 'png' | 'jpg' | null {
  const ext = (path ?? '').split('?')[0]!.split('.').pop()?.toLowerCase();
  if (ext === 'png' || mime === 'image/png') return 'png';
  if (ext === 'jpg' || ext === 'jpeg' || mime === 'image/jpeg') return 'jpg';
  return null;
}

/** Typed in the panel (create_office_report): no reporter, version 1 by an office user. */
export function officeEntryAuthor(detail: ReportDetail): string | null {
  const first = detail.versions.find((v) => v.version === 1);
  if (detail.reporter || first?.author !== 'office_user') return null;
  return first.authorName || 'Office';
}

/** Answered questions by id and by answering message, as the worker's buildReportPdfInput. */
function answersOf(detail: ReportDetail): NonNullable<ReportPdfInput['answers']> {
  const out: NonNullable<ReportPdfInput['answers']> = {};
  for (const q of detail.questions) {
    if (!q.answeredAt) continue;
    const a = { answeredAt: q.answeredAt, field: q.field };
    out[q.id] = a;
    if (q.answeredMessageId) out[q.answeredMessageId] = a;
  }
  return out;
}

export function buildReportPdfInput(
  detail: ReportDetail,
  settings: SettingsData,
  opts: { logo: PdfImage | null; now: Date },
): ReportPdfInput {
  const s = settings.settings;
  const r = detail.report;
  const voiceNotes = detail.clips.filter((c) => c.kind === 'voice_note');
  const maxPhotos = s.pdf_max_photos;
  const photos: PdfPhoto[] = [];
  // The version's photos in its order, as the worker's loadPhotos: react-pdf embeds JPEG and PNG
  // only, so another type (a WebP from WhatsApp) is left out rather than printed as a blank cell.
  for (const p of detail.photos) {
    if (!p.url || photos.length >= maxPhotos) continue;
    const format = imageFormatOf(p.storagePath, p.mime);
    if (!format) continue;
    photos.push({
      url: p.url,
      format,
      takenAt: p.takenAt ?? r.receivedAt ?? opts.now.toISOString(),
      caption: p.caption,
    });
  }
  const languages = detail.data.languageDetected.length
    ? detail.data.languageDetected
    : detail.transcript?.language
      ? detail.transcript.language.split('+').filter(Boolean)
      : [];
  return {
    org: {
      name: settings.org.name,
      address: settings.org.address,
      licenseNo: settings.org.licenseNo,
      taxNo: settings.org.taxNo,
      letterheadLines: s.letterhead_lines ?? [],
      logo: opts.logo,
    },
    site: {
      name: detail.site.name,
      projectCode: detail.site.projectCode,
      address: detail.site.address,
      workingHours: detail.site.workingHours,
      timezone: detail.site.timezone,
    },
    report: {
      reportNo: r.reportNo,
      version: detail.version,
      status: r.status,
      kind: r.kind === 'weather_day' || r.kind === 'no_work' ? r.kind : 'daily',
      filedAt: r.filedAt,
      confirmedAt: r.confirmedAt,
      signedOffAt: r.signedOffAt,
      signedOffByName: r.signedOffByName,
      isLate: r.isLate,
      reviewReasons: r.reviewReasons,
      channel: r.channel,
      confirmedVia: r.confirmedVia,
    },
    data: detail.data.languageDetected.length
      ? detail.data
      : { ...detail.data, languageDetected: languages },
    reporterName: detail.reporter?.name ?? null,
    enteredBy: officeEntryAuthor(detail),
    sources: {
      // Every voice note of the report (W1-17 loads them all), as the worker counts its sources.
      audioCount: voiceNotes.length,
      totalAudioSeconds: voiceNotes.reduce((a, c) => a + c.durationS, 0),
      languages,
      receivedAt: r.receivedAt,
      textCount: detail.messages.filter((m) => m.direction === 'in' && m.type === 'text').length,
    },
    photos,
    companies: detail.companies.map((c) => ({
      id: c.id,
      name: c.name,
      status: c.status,
      isSelfPerform: c.isSelfPerform,
    })),
    edits: detail.versions.map((v) => ({
      version: v.version,
      author: v.author,
      changeNote: v.changeNote,
      createdAt: v.createdAt,
    })),
    answers: answersOf(detail),
    settings: {
      paper: s.pdf_paper === 'a4' ? 'a4' : 'letter',
      footerEnabled: s.pdf_footer_enabled,
      maxPhotos,
    },
    generatedAt: opts.now.toISOString(),
  };
}
