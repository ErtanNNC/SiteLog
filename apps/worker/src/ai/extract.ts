import {
  DailyReportDataSchema,
  DailyReportDataV1Schema,
  ExtractionOutputSchema,
  ReportExtractionSchema,
  extractionToolInputSchema,
  hoursFromEndTime,
  recomputeManpowerTotals,
  reportExtractionToolInputSchema,
  toObserved,
  toObservedIn,
  type DailyReportData,
  type DailyReportDataV1,
  type ExtractionOutput,
  type HoursDiscrepancy,
  type ManpowerEntry,
  type ManpowerEntryV1,
  type ReportExtraction,
  type Source,
} from '@sitelog/shared';
import type { Logger } from '../log';
import { callTool, type MessagesClient, type ToolCallResult } from './claude';
import {
  buildExtractionUserMessage,
  buildOrgContextBlock,
  EXTRACTION_SOURCE_NOTE,
  EXTRACTION_SYSTEM_PROMPT,
  type ExtractionCompany,
  type ExtractionInput,
} from './prompts/extraction';

import {
  buildExtractionUserMessageV2,
  EXTRACTION_V2_SOURCE_NOTE,
  extractionSystemPromptV2,
  type ExtractionInputV2,
} from './prompts/extraction.v2';

export type { ExtractionInput, ExtractionSegment, ExtractionCompany } from './prompts/extraction';
export type { ExtractionInputV2, ExtractionSegmentV2 } from './prompts/extraction.v2';

export const EXTRACTION_TOOL = {
  name: 'submit_daily_report',
  description:
    'Submit the structured daily site report extracted from the voice note transcript, photo captions and earlier answers. ' +
    'Every number must come from the input and carry a source; unknown values are null and listed in missingRequired.',
} as const;

export interface ExtractionResult {
  data: DailyReportDataV1;
  raw: ExtractionOutput;
  discrepancies: HoursDiscrepancy[];
  call: Omit<ToolCallResult<ExtractionOutput>, 'data'>;
}

/**
 * The v1.0 extraction (prompt v1, data v1): the WhatsApp worker's, until step 22 retires it. The
 * web recorder's reports use `runReportExtraction` (v2).
 */
export async function runExtraction(
  client: MessagesClient,
  model: string,
  input: ExtractionInput,
  log?: Logger,
): Promise<ExtractionResult> {
  const result = await callTool(
    client,
    {
      model,
      system: [
        { text: `${EXTRACTION_SYSTEM_PROMPT}\n\n${EXTRACTION_SOURCE_NOTE}`, cache: true },
        { text: buildOrgContextBlock(input), cache: true },
      ],
      messages: [{ role: 'user', content: buildExtractionUserMessage(input) }],
      tool: { ...EXTRACTION_TOOL, inputSchema: extractionToolInputSchema() },
      schema: ExtractionOutputSchema,
      maxTokens: 12_000,
      effort: 'medium',
    },
    log,
  );
  const { data: raw, ...call } = result;
  const { data, discrepancies } = postProcessExtraction(raw, input);
  return { data, raw, discrepancies, call };
}

function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/^(the|los|las|el|la)\s+/, '')
    .replace(/\s+(guys|crew|team|people|boys|men)$/, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Map the model's company reference to a known company by id, name or alias (case-insensitive). */
export function matchCompany(
  entry: Pick<ManpowerEntry | ManpowerEntryV1, 'companyId' | 'companyName' | 'companyNameHeard'>,
  companies: ExtractionCompany[],
): ExtractionCompany | null {
  if (entry.companyId) {
    const byId = companies.find((c) => c.id === entry.companyId);
    if (byId) return byId;
  }
  const candidates = [entry.companyName, entry.companyNameHeard].filter(
    (s): s is string => !!s && s.trim().length > 0,
  );
  for (const cand of candidates) {
    const n = normalize(cand);
    if (!n) continue;
    for (const c of companies) {
      const names = [c.name, ...c.aliases].map(normalize);
      if (names.includes(n)) return c;
    }
  }
  // "Apex" inside "Apex Concrete": a whole-word prefix match on the official name.
  for (const cand of candidates) {
    const n = normalize(cand);
    if (n.length < 4) continue;
    const hits = companies.filter(
      (c) => normalize(c.name).split(' ')[0] === n || normalize(c.name).startsWith(`${n} `),
    );
    if (hits.length === 1) return hits[0]!;
  }
  return null;
}

/**
 * Code after the model (§10.4 / §10.5): totals are recomputed, schemaVersion / reportDate / photos /
 * observed weather are set by code, companies are resolved by name or alias.
 */
export function postProcessExtraction(
  raw: ExtractionOutput,
  input: ExtractionInput,
): { data: DailyReportDataV1; discrepancies: HoursDiscrepancy[] } {
  const manpower = raw.manpower.map((m) => {
    const company = matchCompany(m, input.companies);
    let entry: ManpowerEntryV1 = company
      ? {
          ...m,
          companyId: company.id,
          companyName: company.name,
          trade: m.trade ?? company.trade ?? undefined,
        }
      : { ...m, companyId: null };
    if (entry.hoursPerWorker === null && entry.hoursBasis === 'full_day_default') {
      entry = { ...entry, hoursPerWorker: input.defaultShiftHours };
    }
    if (entry.hoursPerWorker !== null && entry.hoursPerWorker > 24)
      entry = { ...entry, hoursPerWorker: null, totalHours: null, hoursBasis: 'unknown' };
    return entry;
  });
  const { entries, discrepancies } = recomputeManpowerTotals(manpower);

  // An explicit end time in the answers beats everything (§10.4 rule 2); handled by applyAnswer, kept here for drafts.
  void hoursFromEndTime;

  const data: DailyReportDataV1 = DailyReportDataV1Schema.parse({
    ...raw,
    schemaVersion: 1,
    reportDate: input.reportDate,
    manpower: entries,
    weather: {
      ...raw.weather,
      observed: input.observedWeather ? toObserved(input.observedWeather) : undefined,
      periods: raw.weather.periods.map((p) => ({
        ...p,
        lostHours: Math.round(p.lostHours * 100) / 100,
      })),
    },
    photos: input.photos,
    summary: raw.summary.trim(),
  });
  return { data, discrepancies };
}

// ───────────────────────────── v2: the web recorder (W1-12) ─────────────────────────────

export interface ReportExtractionResult {
  data: DailyReportData;
  raw: ReportExtraction;
  discrepancies: HoursDiscrepancy[];
  /** Sources the model cited that are not in the input (dropped, never kept). */
  droppedSources: number;
  call: Omit<ToolCallResult<ReportExtraction>, 'data'>;
}

/**
 * The full Claude call, v2 (§10.4; W1-12): system prompt v2 verbatim (extract.v2.md, cached), the
 * source-format note (cached), the org block (cached), the v2 user message. The model comes from
 * CLAUDE_MODEL (D23); callTool redacts phone numbers from every block.
 */
export async function runReportExtraction(
  client: MessagesClient,
  model: string,
  input: ExtractionInputV2,
  log?: Logger,
): Promise<ReportExtractionResult> {
  const result = await callTool(
    client,
    {
      model,
      system: [
        { text: extractionSystemPromptV2() },
        { text: EXTRACTION_V2_SOURCE_NOTE, cache: true },
        { text: buildOrgContextBlock(input), cache: true },
      ],
      messages: [{ role: 'user', content: buildExtractionUserMessageV2(input) }],
      tool: { ...EXTRACTION_TOOL, inputSchema: reportExtractionToolInputSchema() },
      schema: ReportExtractionSchema,
      maxTokens: 12_000,
      effort: 'medium',
    },
    log,
  );
  const { data: raw, ...call } = result;
  const { data, discrepancies, droppedSources } = postProcessReportExtraction(raw, input);
  return { data, raw, discrepancies, droppedSources, call };
}

/** Walks every `source` list of the data (§10.3) and keeps the sources `keep` accepts. */
function filterSources(
  value: unknown,
  keep: (s: Source) => boolean,
  dropped: { n: number },
): unknown {
  if (Array.isArray(value)) return value.map((v) => filterSources(v, keep, dropped));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([k, v]) => {
      if (k === 'source' && Array.isArray(v)) {
        const kept = (v as Source[]).filter(keep);
        dropped.n += v.length - kept.length;
        return [k, kept];
      }
      return [k, filterSources(v, keep, dropped)];
    }),
  );
}

/**
 * Code after the model, v2 (§10.4, §10.5): totals recomputed; companies resolved by name or alias;
 * `schemaVersion` 2, `reportDate`, `reportLanguage` and `units` (the org's), `photos` (the
 * report's) and `weather.observed` (in the org's units) set by code; a source the input does not
 * have (an upload or a question that is not there, an office edit or a call the model made up) is
 * dropped, so every source points at real input.
 */
export function postProcessReportExtraction(
  raw: ReportExtraction,
  input: ExtractionInputV2,
): { data: DailyReportData; discrepancies: HoursDiscrepancy[]; droppedSources: number } {
  const uploads = new Set(input.segments.map((s) => s.uploadId));
  const questions = new Set(input.previousAnswers.map((a) => a.questionId));
  const dropped = { n: 0 };
  const cleaned = filterSources(
    raw,
    (s) =>
      (s.type === 'voice_note' && uploads.has(s.uploadId)) ||
      (s.type === 'answer' && questions.has(s.questionId)) ||
      s.type === 'weather_api',
    dropped,
  ) as ReportExtraction;

  const manpower = cleaned.manpower.map((m) => {
    const company = matchCompany(m, input.companies);
    let entry: ManpowerEntry = company
      ? {
          ...m,
          companyId: company.id,
          companyName: company.name,
          trade: m.trade ?? company.trade ?? undefined,
        }
      : { ...m, companyId: null };
    if (entry.hoursPerWorker === null && entry.hoursBasis === 'full_day_default') {
      entry = { ...entry, hoursPerWorker: input.defaultShiftHours };
    }
    if (entry.hoursPerWorker !== null && entry.hoursPerWorker > 24)
      entry = { ...entry, hoursPerWorker: null, totalHours: null, hoursBasis: 'unknown' };
    return entry;
  });
  const { entries, discrepancies } = recomputeManpowerTotals(manpower);

  const data: DailyReportData = DailyReportDataSchema.parse({
    ...cleaned,
    schemaVersion: 2,
    reportDate: input.reportDate,
    reportLanguage: input.reportLanguage,
    units: input.units,
    manpower: entries,
    weather: {
      ...(input.observedWeather
        ? { observed: toObservedIn(input.observedWeather, input.units) }
        : {}),
      conditionsText: cleaned.weather.conditionsText,
      periods: cleaned.weather.periods.map((p) => ({
        ...p,
        lostHours: Math.round(p.lostHours * 100) / 100,
      })),
    },
    photos: input.photos,
    summary: cleaned.summary.trim(),
  });
  return { data, discrepancies, droppedSources: dropped.n };
}
