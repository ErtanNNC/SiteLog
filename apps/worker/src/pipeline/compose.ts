import type {
  DailyReportData,
  DailyReportDataV1,
  QuestionRow,
  ReportRow,
  ReporterLocale,
  ReporterRow,
  SiteDayWeather,
  TranscriptRow,
} from '@sitelog/shared';
import { REPORTER_LOCALES, firstName, isVoiceSourceKind } from '@sitelog/shared';
import type {
  ExtractionInput,
  ExtractionInputV2,
  ExtractionSegment,
  ExtractionSegmentV2,
} from '../ai/extract';
import type { Ctx } from '../context';
import type { SiteContext } from '../db';

/**
 * Gather everything the extraction call needs (§10.4 user message): transcript segments from every
 * audio source, text sources, photos, earlier answers, the previous draft (when merging) and the
 * observed weather of the site-day.
 */

export interface ComposeOptions {
  previousDraft?: DailyReportDataV1 | null;
  reportDate: string;
  observedWeather?: SiteDayWeather | null;
}

export function transcriptSegments(
  messageId: string,
  transcript: TranscriptRow | null,
): ExtractionSegment[] {
  if (!transcript) return [];
  const segs = Array.isArray(transcript.segments)
    ? (transcript.segments as Array<{ start: number; end: number; text: string }>)
    : [];
  if (segs.length === 0 && transcript.text.trim())
    return [{ messageId, start: 0, end: 0, text: transcript.text }];
  return segs.map((s) => ({
    messageId,
    start: Number(s.start) || 0,
    end: Number(s.end) || 0,
    text: String(s.text ?? ''),
  }));
}

export async function composeExtractionInput(
  ctx: Ctx,
  report: ReportRow,
  site: SiteContext,
  reporter: ReporterRow | null,
  opts: ComposeOptions,
): Promise<ExtractionInput> {
  const sources = await ctx.db.listReportSources(report.id);
  // Voice notes and photos by media id (upload, else message: the id v1 data calls messageId).
  const audioIds = sources.flatMap((s) =>
    isVoiceSourceKind(s.kind) && s.media_id ? [s.media_id] : [],
  );
  const transcripts = await ctx.db.listTranscripts(audioIds);
  const byMedia = new Map(transcripts.map((t) => [t.upload_id ?? t.message_id, t]));

  const segments: ExtractionSegment[] = [];
  for (const id of audioIds) segments.push(...transcriptSegments(id, byMedia.get(id) ?? null));

  const texts = sources.flatMap((s) =>
    s.kind === 'text' && s.body?.trim() && s.message_id
      ? [{ messageId: s.message_id, text: s.body.trim() }]
      : [],
  );
  const photos = sources.flatMap((s) =>
    s.kind === 'photo' && s.media_id
      ? [
          {
            messageId: s.media_id,
            caption: s.caption ?? undefined,
            takenAt: s.taken_at ?? s.message_created_at,
          },
        ]
      : [],
  );

  const questions = await ctx.db.listQuestions(report.id);
  const previousAnswers = questions
    .filter((q) => q.answered_at && q.answer)
    .map((q) => ({
      field: q.field,
      question: q.prompt,
      answer: answerText(q.answer),
      messageId: q.answered_message_id ?? '',
    }));

  const glossary = site.glossary
    .filter(
      (g) => g.status === 'confirmed' || g.status === 'built_in' || g.status === 'auto_learned',
    )
    .filter((g) => g.official)
    .map((g) => ({ heard: g.heard, official: g.official!, kind: g.kind }));
  const rejectedMappings = site.glossary
    .filter((g) => g.status === 'rejected' && g.official)
    .map((g) => ({ heard: g.heard, official: g.official! }));

  return {
    site: {
      name: site.site.name,
      projectCode: site.site.project_code,
      timezone: site.site.timezone,
      workingHours: site.site.working_hours,
    },
    reportDate: opts.reportDate,
    defaultShiftHours: Number(site.settings.default_shift_hours),
    requiredFields: site.settings.required_fields,
    companies: site.companies.map((c) => ({
      id: c.id,
      name: c.name,
      trade: c.trade,
      aliases: c.aliases,
      isSelfPerform: c.is_self_perform,
    })),
    glossary,
    rejectedMappings,
    observedWeather: opts.observedWeather ?? null,
    previousAnswers,
    previousDraft: opts.previousDraft ?? null,
    photos,
    segments,
    texts,
    reporterFirstName: reporter ? firstName(reporter.name) : 'the site manager',
  };
}

/** An answer that came from the reporter (not resolved by a re-extraction, not given up on). */
export function reporterAnswered(q: Pick<QuestionRow, 'answered_at' | 'answer'>): boolean {
  if (!q.answered_at || !q.answer) return false;
  const a = q.answer as { resolved_by?: unknown; unanswered?: unknown };
  return !a.resolved_by && !a.unanswered;
}

export interface ComposeOptionsV2 {
  previousDraft?: DailyReportData | null;
  reportDate: string;
  observedWeather?: SiteDayWeather | null;
  /** §10.4 `CHANNEL`: `call` for a call's live turn (W3-09), else `web`. */
  channel?: 'web' | 'call';
}

/**
 * W3-09: the reporter's lane of each call of the report (its live transcript, `transcripts.call_id`;
 * an agent line, should a transcript hold one, is left out: the transcript the model reads is the
 * reporter's speech only, §10.4), as segments keyed by call id, seconds from the call's start.
 */
export function callSegments(
  callId: string,
  transcript: TranscriptRow | null,
): ExtractionSegmentV2[] {
  if (!transcript) return [];
  const segs = Array.isArray(transcript.segments)
    ? (transcript.segments as Array<{ start: number; end: number; text: string; speaker?: string }>)
    : [];
  return segs
    .filter((s) => s.speaker !== 'agent' && String(s.text ?? '').trim())
    .map((s) => ({
      callId,
      start: Number(s.start) || 0,
      end: Number(s.end) || 0,
      text: String(s.text),
    }));
}

/**
 * The v2 extraction input (§10.4, W1-12) of a web recorder report: the transcript segments of its
 * voice uploads (keyed by upload id), its photos, the answers the reporter gave (keyed by question
 * id), the previous draft, and the org's report language and units with the reporter's locale.
 */
export async function composeReportExtractionInput(
  ctx: Ctx,
  report: ReportRow,
  site: SiteContext,
  reporter: ReporterRow | null,
  opts: ComposeOptionsV2,
): Promise<ExtractionInputV2> {
  const sources = await ctx.db.listReportSources(report.id);
  const voiceIds = sources.flatMap((s) =>
    isVoiceSourceKind(s.kind) && s.upload_id ? [s.upload_id] : [],
  );
  const transcripts = await ctx.db.listTranscripts(voiceIds);
  const byUpload = new Map(transcripts.map((t) => [t.upload_id, t]));
  const voiceSegments: ExtractionSegmentV2[] = voiceIds.flatMap((id) =>
    transcriptSegments(id, byUpload.get(id) ?? null).map(({ messageId, ...s }) => ({
      uploadId: messageId,
      ...s,
    })),
  );
  // W3-09: the report's calls (a call and a voice note of one site-day are one report, §7.2),
  // in the order they joined the report.
  const callIds = [
    ...new Set(sources.flatMap((s) => (s.kind === 'call' && s.call_id ? [s.call_id] : []))),
  ];
  const callTranscripts = callIds.length ? await ctx.db.listCallTranscripts(callIds) : [];
  const byCall = new Map(callTranscripts.map((t) => [t.call_id, t]));
  const segments: ExtractionSegmentV2[] = [
    ...voiceSegments,
    ...callIds.flatMap((id) => callSegments(id, byCall.get(id) ?? null)),
  ];
  const photos = sources.flatMap((s) =>
    s.kind === 'photo' && s.upload_id
      ? [
          {
            uploadId: s.upload_id,
            caption: s.caption ?? undefined,
            takenAt: s.taken_at ?? s.message_created_at,
          },
        ]
      : [],
  );
  const questions = await ctx.db.listQuestions(report.id);
  const previousAnswers = questions.filter(reporterAnswered).map((q) => ({
    field: q.field,
    question: q.prompt,
    answer: answerText(q.answer),
    questionId: q.id,
  }));
  const base = await composeExtractionInput(ctx, report, site, reporter, {
    reportDate: opts.reportDate,
    observedWeather: opts.observedWeather,
  });
  const locale = reporter?.locale ?? '';
  const reporterLocale: ReporterLocale = (REPORTER_LOCALES as readonly string[]).includes(locale)
    ? (locale as ReporterLocale)
    : site.org.locale;
  return {
    site: base.site,
    reportDate: opts.reportDate,
    reportLanguage: report.language,
    units: site.org.units,
    reporterLocale,
    channel: opts.channel ?? 'web',
    defaultShiftHours: base.defaultShiftHours,
    requiredFields: base.requiredFields,
    companies: base.companies,
    glossary: base.glossary,
    rejectedMappings: base.rejectedMappings,
    observedWeather: opts.observedWeather ?? null,
    previousAnswers,
    previousDraft: opts.previousDraft ?? null,
    photos,
    segments,
    reporterFirstName: base.reporterFirstName,
  };
}

function answerText(answer: unknown): string {
  if (typeof answer === 'string') return answer;
  if (answer && typeof answer === 'object') {
    const a = answer as Record<string, unknown>;
    if (typeof a.text === 'string') return a.text;
    return JSON.stringify(a);
  }
  return String(answer ?? '');
}

/** Site-day weather JSON → typed, or null when absent/malformed. */
export function siteDayWeatherOf(weather: unknown): SiteDayWeather | null {
  if (!weather || typeof weather !== 'object') return null;
  const w = weather as Partial<SiteDayWeather>;
  if (!w.summary || !Array.isArray(w.hours)) return null;
  return w as SiteDayWeather;
}
