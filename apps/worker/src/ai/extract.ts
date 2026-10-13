import {
  DailyReportDataV1Schema,
  ExtractionOutputSchema,
  extractionToolInputSchema,
  hoursFromEndTime,
  recomputeManpowerTotals,
  toObserved,
  type DailyReportDataV1,
  type ExtractionOutput,
  type HoursDiscrepancy,
  type ManpowerEntryV1,
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

export type { ExtractionInput, ExtractionSegment, ExtractionCompany } from './prompts/extraction';

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

/** The full Claude call (§10.4). */
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
  entry: Pick<ManpowerEntryV1, 'companyId' | 'companyName' | 'companyNameHeard'>,
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
