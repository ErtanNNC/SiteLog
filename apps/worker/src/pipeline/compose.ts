import type {
  DailyReportDataV1,
  ReportRow,
  ReporterRow,
  SiteDayWeather,
  TranscriptRow,
} from '@sitelog/shared';
import { firstName } from '@sitelog/shared';
import type { ExtractionInput, ExtractionSegment } from '../ai/extract';
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
  const audioIds = sources.filter((s) => s.kind === 'audio').map((s) => s.message_id);
  const transcripts = await ctx.db.listTranscripts(audioIds);
  const byMessage = new Map(transcripts.map((t) => [t.message_id, t]));

  const segments: ExtractionSegment[] = [];
  for (const id of audioIds) segments.push(...transcriptSegments(id, byMessage.get(id) ?? null));

  const texts = sources
    .filter((s) => s.kind === 'text' && s.body?.trim())
    .map((s) => ({ messageId: s.message_id, text: s.body!.trim() }));
  const photos = sources
    .filter((s) => s.kind === 'photo')
    .map((s) => ({
      messageId: s.message_id,
      caption: s.caption ?? undefined,
      takenAt: s.taken_at ?? s.message_created_at,
    }));

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
