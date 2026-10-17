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
  type PackExcerpt,
  type PdfImage,
  type PdfPhoto,
  type ReportPdfInput,
} from '@sitelog/pdf';
import {
  isVoiceSourceKind,
  packClaimReady,
  packConfirmation,
  packSections,
  readReportData,
  reportLanguageFor,
  versionPdfStatus,
  versionPhotos,
  versionSignedOff as signedOffAt,
  type DailyReportData,
  type EvidencePackRow,
  type ReportRow,
  type ReportVersionRow,
  type StoredReportData,
  type TranscriptRow,
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

/**
 * Whether the PDF of `version` prints the report's sign-off: only the current version of a
 * signed-off report (the shared `versionSignedOff`, which the panel's browser PDF uses too). Pure.
 */
export function versionSignedOff(
  report: Pick<ReportRow, 'status' | 'current_version'>,
  version: Pick<ReportVersionRow, 'version'>,
): boolean {
  return signedOffAt(
    { status: report.status, currentVersion: report.current_version },
    version.version,
  );
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
  const signedOff = versionSignedOff(report, version);
  const signer =
    signedOff && report.signed_off_by ? await ctx.db.getUserContact(report.signed_off_by) : null;
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
      // An older version of a signed-off report was filed, not signed off.
      status: versionPdfStatus(
        { status: report.status, currentVersion: report.current_version },
        version.version,
      ),
      kind: report.kind as ReportPdfInput['report']['kind'],
      filedAt: report.filed_at,
      confirmedAt: report.confirmed_at,
      signedOffAt: signedOff ? report.signed_off_at : null,
      signedOffByName: signedOff ? (signer?.display_name ?? signer?.email ?? null) : null,
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

/** A clip a pack day quotes: a voice note (by media id) or a call, with its segments. */
export interface PackClip {
  kind: 'voice_note' | 'call';
  /** The voice note's media id (upload, else message) or the call id. */
  id: string;
  /** Its number among the day's clips of that kind, when there is more than one. */
  clipNo: number | null;
  /** A call's segments are the reporter's lane only (never the agent's). */
  segments: Array<{ start: number; end: number; text: string }>;
}

/** A call segment's speaker lane (§6.3 `dialog_log` / Deepgram): the reporter, or SiteLog. */
function speakerOf(value: unknown): 'reporter' | 'agent' | null {
  if (value === 'reporter' || value === 'user' || value === 'caller') return 'reporter';
  if (value === 'agent' || value === 'assistant') return 'agent';
  return null;
}

/**
 * The reporter's lane of a call transcript: segments marked reporter, or unmarked when none is
 * marked (a one-lane transcript); the agent's lines never become evidence.
 */
export function reporterSegments(
  transcript: TranscriptRow,
): Array<{ start: number; end: number; text: string }> {
  const raw = Array.isArray(transcript.segments)
    ? (transcript.segments as Array<Record<string, unknown>>)
    : [];
  const segs = raw.map((s) => ({
    start: Number(s.start) || 0,
    end: Number(s.end) || 0,
    text: String(s.text ?? ''),
    speaker: speakerOf(s.speaker ?? s.role),
  }));
  const marked = segs.some((s) => s.speaker === 'reporter');
  return segs
    .filter((s) => (marked ? s.speaker === 'reporter' : s.speaker !== 'agent'))
    .map(({ start, end, text }) => ({ start, end, text }));
}

export async function buildEvidencePackInput(
  ctx: Ctx,
  pack: EvidencePackRow,
  site: SiteContext,
): Promise<EvidencePackInput> {
  const sections = packSections(pack.sections);
  const wants = new Set<string>(sections);
  const reports = await ctx.db.listReportsForSitePeriod(
    site.site.id,
    pack.period_start,
    pack.period_end,
  );
  const events = await ctx.db.listWeatherEvents(site.site.id, pack.period_start, pack.period_end);
  const signers = new Map<string, string | null>();
  const signerName = async (userId: string | null) => {
    if (!userId) return null;
    if (!signers.has(userId)) {
      const u = await ctx.db.getUserContact(userId);
      signers.set(userId, u?.display_name ?? u?.email ?? null);
    }
    return signers.get(userId) ?? null;
  };
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
    const voice = sources.filter((s) => isVoiceSourceKind(s.kind) && s.media_id);
    const callIds = Array.from(new Set(sources.flatMap((s) => (s.call_id ? [s.call_id] : []))));
    const siteDay = await ctx.db.getSiteDay(r.site_day_id);
    const observed = siteDayWeatherOf(siteDay?.weather);
    // The version's photos (data.photos): counted for the evidence marks and claim-ready whether
    // or not the Photos section prints, downloaded only when it does.
    const shown = versionPhotos(data.photos, sources);
    const photos = wants.has('photos') ? await loadPhotos(ctx, shown, 4) : [];
    const audioCount = voice.length + callIds.length;
    const transcriptExcerpts = wants.has('transcripts')
      ? weatherExcerpts(data, await packClips(ctx, voice, callIds))
      : [];
    const confirmation = packConfirmation(r);
    const signedOff = r.status === 'signed_off';
    // §19 Q134: the delay record's evidence (voice note or call, photo, observed weather), on a
    // report the site manager confirmed or the office signed off.
    const evidenceReady =
      dayEvents.some((e) => e.claim_ready) || (audioCount > 0 && shown.length > 0 && !!observed);
    days.push({
      date: data.reportDate,
      reportNo: r.report_no,
      version: r.current_version,
      signedOff,
      signedOffByName: signedOff ? await signerName(r.signed_off_by) : null,
      signedOffAt: signedOff ? r.signed_off_at : null,
      confirmation,
      typed: !r.reporter_id,
      confirmedAt: r.confirmed_at,
      filedAt: r.filed_at,
      data,
      lostHours: lost,
      fullDay,
      claimReady: packClaimReady(evidenceReady, confirmation, signedOff),
      transcriptExcerpts,
      photos,
      observed,
      photoCount: shown.length,
      audioCount,
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
    // F20: the org's report language and units (§9.6, §10.11), its paper (§12).
    language: reportLanguageFor(site.org.locale),
    units: site.org.units,
    periodStart: pack.period_start,
    periodEnd: pack.period_end,
    sections,
    days,
    settings: { paper: site.settings.pdf_paper === 'a4' ? 'a4' : 'letter' },
    generatedAt: ctx.now().toISOString(),
    requestedBy: requester?.display_name ?? requester?.email ?? null,
  };
}

/** The day's clips with their segments: voice notes in order, then calls (reporter lane). */
async function packClips(
  ctx: Ctx,
  voice: ReadonlyArray<Pick<ReportSourceWithMessage, 'media_id'>>,
  callIds: string[],
): Promise<PackClip[]> {
  const mediaIds = voice.map((v) => v.media_id!);
  const [notes, calls] = await Promise.all([
    ctx.db.listTranscripts(mediaIds),
    ctx.db.listCallTranscripts(callIds),
  ]);
  const byMedia = new Map(notes.map((t) => [t.upload_id ?? t.message_id, t]));
  const number = (i: number, n: number) => (n > 1 ? i + 1 : null);
  return [
    ...mediaIds.map((id, i) => ({
      kind: 'voice_note' as const,
      id,
      clipNo: number(i, mediaIds.length),
      segments: transcriptSegments(id, byMedia.get(id) ?? null).map(({ start, end, text }) => ({
        start,
        end,
        text,
      })),
    })),
    ...callIds.map((id, i) => {
      const t = calls.find((c) => c.call_id === id);
      return {
        kind: 'call' as const,
        id,
        clipNo: number(i, callIds.length),
        segments: t ? reporterSegments(t) : [],
      };
    }),
  ];
}

/**
 * The excerpts a pack day quotes (F20): for each second a weather period cites (a voice note's
 * or a call's), the segment of THAT clip at that second with its neighbours in the same clip,
 * never a segment of another clip (audit "Evidence-pack transcript excerpts match timestamps
 * across different voice notes"); a call quotes its reporter's lane only. With no cited second
 * that matches a clip, the first segments of the first clip that has any. Pure.
 */
export function weatherExcerpts(
  data: DailyReportData,
  clips: readonly PackClip[],
  max = 6,
): PackExcerpt[] {
  type Cite = { kind: PackClip['kind']; id: string; start: number };
  const cites = data.weather.periods.flatMap((p) =>
    p.source.flatMap((s): Cite[] =>
      s.type === 'voice_note'
        ? [{ kind: 'voice_note', id: s.uploadId, start: s.start }]
        : s.type === 'call'
          ? [{ kind: 'call', id: s.callId, start: s.start }]
          : [],
    ),
  );
  const picked: Array<{ clip: number; seg: number }> = [];
  const seen = new Set<string>();
  const pick = (clip: number, seg: number) => {
    const key = `${clip}:${seg}`;
    if (seen.has(key)) return;
    seen.add(key);
    picked.push({ clip, seg });
  };
  for (const c of cites) {
    const ci = clips.findIndex((x) => x.kind === c.kind && x.id === c.id);
    if (ci < 0) continue;
    const segs = clips[ci]!.segments;
    let i = segs.findIndex((s) => c.start >= s.start && c.start <= s.end + 0.5);
    if (i < 0) i = segs.findIndex((s) => s.start >= c.start);
    if (i < 0) continue;
    for (const j of [i - 1, i, i + 1]) if (j >= 0 && j < segs.length) pick(ci, j);
  }
  if (picked.length === 0) {
    const ci = clips.findIndex((x) => x.segments.length > 0);
    if (ci >= 0) clips[ci]!.segments.slice(0, 3).forEach((_, j) => pick(ci, j));
  }
  return picked
    .sort((a, b) => a.clip - b.clip || a.seg - b.seg)
    .slice(0, max)
    .map(({ clip, seg }) => {
      const c = clips[clip]!;
      const s = c.segments[seg]!;
      return { clip: c.kind, clipNo: c.clipNo, start: s.start, end: s.end, text: s.text };
    });
}
