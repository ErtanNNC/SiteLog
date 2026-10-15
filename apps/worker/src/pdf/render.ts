import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToBuffer } from '@react-pdf/renderer';
import type { DocumentProps } from '@react-pdf/renderer';
import type { ReactElement } from 'react';
import {
  EvidencePack,
  ReportDocument,
  setFontSource,
  type EvidenceDay,
  type EvidencePackInput,
  type PdfImage,
  type PdfPhoto,
  type ReportPdfInput,
} from '@sitelog/pdf';
import {
  isVoiceSourceKind,
  readReportData,
  versionPhotos,
  type DailyReportData,
  type EvidencePackRow,
  type ReportRow,
  type ReportVersionRow,
  type StoredReportData,
  type VersionPhoto,
} from '@sitelog/shared';
import type { Ctx } from '../context';
import type { ReportSourceWithMessage, SiteContext } from '../db';
import { siteDayWeatherOf, transcriptSegments } from '../pipeline/compose';

/**
 * The embedded TTFs ship in packages/pdf/src/fonts and are copied to dist/fonts by the build;
 * both locations are tried.
 */
export function fontsDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [join(here, 'fonts'), join(here, '..', 'fonts')];
  try {
    const pkg = createRequire(import.meta.url).resolve('@sitelog/pdf/package.json');
    candidates.push(join(dirname(pkg), 'src', 'fonts'));
  } catch {
    // Bundled build without node_modules: dist/fonts only.
  }
  for (const c of candidates) if (existsSync(join(c, 'Archivo-Regular.ttf'))) return c;
  throw new Error(`PDF fonts not found; looked in ${candidates.join(', ')}`);
}

let fontsReady = false;
function useNodeFonts(): void {
  if (fontsReady) return;
  const dir = fontsDir();
  setFontSource((file) => join(dir, file));
  fontsReady = true;
}

/** `renderToBuffer` wrappers + the loaders that turn DB rows into the document inputs. */

export async function renderReportPdf(input: ReportPdfInput): Promise<Buffer> {
  useNodeFonts();
  return renderToBuffer(
    createElement(ReportDocument, { input }) as unknown as ReactElement<DocumentProps>,
  );
}

export async function renderEvidencePackPdf(input: EvidencePackInput): Promise<Buffer> {
  useNodeFonts();
  return renderToBuffer(
    createElement(EvidencePack, { input }) as unknown as ReactElement<DocumentProps>,
  );
}

export function imageFormat(
  path: string | null | undefined,
  mime?: string | null,
): 'png' | 'jpg' | null {
  const ext = (path ?? '').split('.').pop()?.toLowerCase();
  if (ext === 'png' || mime === 'image/png') return 'png';
  if (ext === 'jpg' || ext === 'jpeg' || mime === 'image/jpeg') return 'jpg';
  return null;
}

export async function loadLogo(
  ctx: Pick<Ctx, 'storage' | 'log'>,
  logoPath: string | null,
): Promise<PdfImage | null> {
  if (!logoPath) return null;
  // react-pdf cannot embed SVG files: the web panel uploads a PNG rendition next to an SVG logo.
  const path = /\.svg$/i.test(logoPath) ? logoPath.replace(/\.svg$/i, '.png') : logoPath;
  const format = imageFormat(path);
  if (!format) return null;
  try {
    return { data: await ctx.storage.download('logos', path), format };
  } catch (err) {
    // No rendition (or a storage error): the letterhead falls back to the company name.
    ctx.log.warn('logo not loaded', { err, path });
    return null;
  }
}

type PhotoSource = Pick<
  ReportSourceWithMessage,
  | 'message_id'
  | 'upload_id'
  | 'kind'
  | 'caption'
  | 'taken_at'
  | 'storage_path'
  | 'media_mime'
  | 'message_created_at'
>;

/**
 * Downloads up to `max` of the photos a version shows (versionPhotos: its data.photos, in order,
 * with the captions of that version). One that is missing or not JPEG/PNG (react-pdf) is skipped.
 */
async function loadPhotos(
  ctx: Pick<Ctx, 'storage' | 'log'>,
  photos: ReadonlyArray<VersionPhoto<PhotoSource>>,
  max: number,
): Promise<PdfPhoto[]> {
  const out: PdfPhoto[] = [];
  for (const { source: s, caption, takenAt } of photos) {
    if (!s.storage_path || out.length >= max) continue;
    const format = imageFormat(s.storage_path, s.media_mime);
    if (!format) continue;
    try {
      out.push({
        data: await ctx.storage.download('photos', s.storage_path),
        format,
        takenAt: takenAt ?? s.message_created_at,
        caption,
      });
    } catch (err) {
      ctx.log.warn('photo not loaded', { err, path: s.storage_path });
    }
  }
  return out;
}

/** `data`: the version's data as readers see it (§10.3 v2; `readReportData` of the stored JSON). */
export async function buildReportPdfInput(
  ctx: Ctx,
  args: { report: ReportRow; version: ReportVersionRow; site: SiteContext; data: DailyReportData },
): Promise<ReportPdfInput> {
  const { report, version, site, data } = args;
  // Files from the uploads, else the WhatsApp messages (listReportSources).
  const sources = await ctx.db.listReportSources(report.id);
  const audio = sources.filter((s) => isVoiceSourceKind(s.kind));
  const transcripts = await ctx.db.listTranscripts(
    audio.flatMap((a) => (a.media_id ? [a.media_id] : [])),
  );
  const languages = Array.from(
    new Set(transcripts.flatMap((t) => (t.language ?? '').split('+').filter(Boolean))),
  );
  const versions = await ctx.db.listVersions(report.id);
  const reporter = report.reporter_id ? await ctx.db.getReporter(report.reporter_id) : null;
  const signer = report.signed_off_by ? await ctx.db.getUserContact(report.signed_off_by) : null;
  // Typed in the panel (create_office_report): no reporter, version 1 by an office user.
  const first = versions.find((v) => v.version === 1);
  const enteredByUser =
    !report.reporter_id && first?.author === 'office_user' && first.author_user_id
      ? await ctx.db.getUserContact(first.author_user_id)
      : null;
  const enteredBy =
    !report.reporter_id && first?.author === 'office_user'
      ? (enteredByUser?.display_name ?? enteredByUser?.email ?? 'Office')
      : null;
  const [logo, photos, questions] = await Promise.all([
    loadLogo(ctx, site.org.logo_path),
    loadPhotos(ctx, versionPhotos(data.photos, sources), site.settings.pdf_max_photos),
    ctx.db.listQuestions(report.id),
  ]);
  // Answered questions for the manpower footnote, by id and (v1 data: a reply source carries the
  // reply's message id as its questionId) by the answering message.
  const answers: NonNullable<ReportPdfInput['answers']> = {};
  for (const q of questions) {
    if (!q.answered_at) continue;
    const a = { answeredAt: q.answered_at, field: q.field };
    answers[q.id] = a;
    if (q.answered_message_id) answers[q.answered_message_id] = a;
  }
  return {
    org: {
      name: site.org.name,
      address: site.org.address,
      licenseNo: site.org.license_no,
      taxNo: site.org.tax_no,
      letterheadLines: site.settings.letterhead_lines ?? [],
      logo,
    },
    site: {
      name: site.site.name,
      projectCode: site.site.project_code,
      address: site.site.address,
      workingHours: site.site.working_hours,
      timezone: site.site.timezone,
    },
    report: {
      reportNo: report.report_no,
      version: version.version,
      status: report.status,
      kind: report.kind as ReportPdfInput['report']['kind'],
      filedAt: report.filed_at,
      confirmedAt: report.confirmed_at,
      signedOffAt: report.signed_off_at,
      signedOffByName: signer?.display_name ?? signer?.email ?? null,
      isLate: report.is_late,
      reviewReasons: report.review_reasons,
      channel: report.channel,
      confirmedVia: report.confirmed_via,
    },
    data: data.languageDetected.length ? data : { ...data, languageDetected: languages },
    reporterName: reporter?.name ?? null,
    enteredBy,
    sources: {
      audioCount: audio.length,
      totalAudioSeconds: audio.reduce((a, s) => a + (s.duration_s ?? 0), 0),
      languages: data.languageDetected.length ? data.languageDetected : languages,
      receivedAt: report.received_at,
      textCount: sources.filter((s) => s.kind === 'text').length,
    },
    photos,
    companies: site.companies.map((c) => ({
      id: c.id,
      name: c.name,
      status: c.status,
      isSelfPerform: c.is_self_perform,
    })),
    edits: versions.map((v) => ({
      version: v.version,
      author: v.author,
      changeNote: v.change_note,
      createdAt: v.created_at,
    })),
    answers,
    settings: {
      paper: site.settings.pdf_paper === 'a4' ? 'a4' : 'letter',
      footerEnabled: site.settings.pdf_footer_enabled,
      maxPhotos: site.settings.pdf_max_photos,
    },
    generatedAt: ctx.now().toISOString(),
  };
}

export async function buildEvidencePackInput(
  ctx: Ctx,
  pack: EvidencePackRow,
  site: SiteContext,
): Promise<EvidencePackInput> {
  const reports = await ctx.db.listReportsForSitePeriod(
    site.site.id,
    pack.period_start,
    pack.period_end,
  );
  const events = await ctx.db.listWeatherEvents(site.site.id, pack.period_start, pack.period_end);
  const days: EvidenceDay[] = [];
  for (const r of reports) {
    const version = await ctx.db.getVersion(r.id, r.current_version);
    if (!version) continue;
    const data = readReportData(version.data as unknown as StoredReportData);
    const dayEvents = events.filter((e) => e.report_id === r.id);
    const lost =
      Math.round(
        (dayEvents.length
          ? dayEvents.reduce((a, e) => a + Number(e.lost_hours), 0)
          : data.weather.periods.reduce((a, p) => a + p.lostHours, 0)) * 100,
      ) / 100;
    const fullDay =
      dayEvents.some((e) => e.full_day) || data.weather.periods.some((p) => p.fullDay === true);
    if (lost <= 0 && !fullDay) continue;
    const sources = await ctx.db.listReportSources(r.id);
    const audio = sources.filter((s) => isVoiceSourceKind(s.kind));
    const transcripts = await ctx.db.listTranscripts(
      audio.flatMap((a) => (a.media_id ? [a.media_id] : [])),
    );
    const siteDay = await ctx.db.getSiteDay(r.site_day_id);
    const observed = siteDayWeatherOf(siteDay?.weather);
    const shown = versionPhotos(data.photos, sources);
    const photos = await loadPhotos(ctx, shown, 4);
    days.push({
      date: data.reportDate,
      reportNo: r.report_no,
      version: r.current_version,
      signedOff: r.status === 'signed_off',
      data,
      lostHours: lost,
      fullDay,
      claimReady:
        dayEvents.some((e) => e.claim_ready) ||
        (audio.length > 0 && photos.length > 0 && !!observed),
      transcriptExcerpts: weatherExcerpts(
        data,
        transcripts.flatMap((t) => {
          const mediaId = t.upload_id ?? t.message_id;
          return mediaId ? transcriptSegments(mediaId, t) : [];
        }),
      ),
      photos,
      observed,
      photoCount: shown.length,
      audioCount: audio.length,
    });
  }
  const requester = pack.created_by ? await ctx.db.getUserContact(pack.created_by) : null;
  return {
    org: { name: site.org.name, logo: await loadLogo(ctx, site.org.logo_path) },
    site: {
      name: site.site.name,
      projectCode: site.site.project_code,
      address: site.site.address,
      timezone: site.site.timezone,
    },
    periodStart: pack.period_start,
    periodEnd: pack.period_end,
    days,
    settings: { paper: site.settings.pdf_paper === 'a4' ? 'a4' : 'letter' },
    generatedAt: ctx.now().toISOString(),
    requestedBy: requester?.display_name ?? requester?.email ?? null,
  };
}

/** Segments the weather periods point at (± one neighbour), else the first few segments. */
export function weatherExcerpts(
  data: DailyReportData,
  segments: Array<{ start: number; end: number; text: string }>,
  max = 6,
): Array<{ start: number; end: number; text: string }> {
  if (segments.length === 0) return [];
  const starts = data.weather.periods.flatMap((p) =>
    p.source.flatMap((s) => (s.type === 'voice_note' ? [s.start] : [])),
  );
  const picked = new Set<number>();
  for (const st of starts) {
    const idx = segments.findIndex((s) => st >= s.start && st <= s.end + 0.5);
    const i = idx >= 0 ? idx : segments.findIndex((s) => s.start >= st);
    if (i < 0) continue;
    for (const j of [i - 1, i, i + 1]) if (j >= 0 && j < segments.length) picked.add(j);
  }
  const idxs = (picked.size ? Array.from(picked) : segments.slice(0, 3).map((_, i) => i))
    .sort((a, b) => a - b)
    .slice(0, max);
  return idxs.map((i) => segments[i]!);
}
