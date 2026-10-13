import { z } from 'zod';
import { REPORT_LANGUAGES, UNIT_SYSTEMS, type ReportLanguage, type UnitSystem } from '../locale.ts';

/**
 * Daily report data: the JSON stored in report_versions.data (§10.3). The Zod schemas are the
 * single source of truth: the Claude tool input schema, the worker validation and the panel types
 * are all derived from them.
 *
 * Two versions live side by side (GAP D20):
 * - `DailyReportData` (`schemaVersion: 2`) is the canonical shape of spec v1.2 §10.3. Everything
 *   that reads a stored version (panel views, PDF, email, evidence pack) reads this shape, through
 *   `readReportData()` / `upgradeV1toV2()` (report/upgrade.ts).
 * - `DailyReportDataV1` (`schemaVersion: 1`) is the WhatsApp-era shape: every version stored before
 *   v1.2, and what the writers (worker extraction, `create_office_report`, the office editor for a
 *   v1 version) still write until W1-12. Stored v1 versions are never rewritten.
 *
 * `StoredReportDataSchema` accepts either, discriminated on `schemaVersion`. The Claude tool
 * (`ExtractionOutputSchema`, `extractionToolInputSchema()`) stays v1 until W1-12.
 */

// ───────────────────────────── Lists both versions share ─────────────────────────────

export const WORK_STATUSES = ['complete', 'in_progress', 'started', 'stopped', 'planned'] as const;
export type WorkStatus = (typeof WORK_STATUSES)[number];

export const INCIDENT_SEVERITIES = ['near_miss', 'first_aid', 'recordable', 'lost_time'] as const;
export type IncidentSeverity = (typeof INCIDENT_SEVERITIES)[number];

export const NEW_TERM_KINDS = ['term', 'company', 'area', 'unit'] as const;

export const QUESTION_FIELDS = [
  'manpower.workers',
  'manpower.hours',
  'company.unknown',
  'weather.impact',
  'safety',
  'photo',
] as const;
export type QuestionField = (typeof QUESTION_FIELDS)[number];

const HHMM = /^\d{2}:\d{2}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

// ───────────────────────────── v2: spec v1.2 §10.3 ─────────────────────────────

export const SourceSchema = z
  .discriminatedUnion('type', [
    z.object({
      type: z.literal('voice_note'),
      uploadId: z.string().describe('uploads.id of the voice note'),
      start: z.number().min(0).describe('Transcript segment start, seconds'),
      end: z.number().min(0).optional().describe('Transcript segment end, seconds'),
    }),
    z.object({
      type: z.literal('call'),
      callId: z.string().describe('calls.id of the phone call'),
      start: z.number().min(0).describe('Reporter-channel segment start, seconds'),
      end: z.number().min(0).optional().describe('Reporter-channel segment end, seconds'),
    }),
    z.object({ type: z.literal('answer'), questionId: z.string() }),
    z.object({ type: z.literal('office_edit'), userId: z.string(), at: z.string() }),
    z.object({ type: z.literal('weather_api') }),
  ])
  .describe(
    'Where a value came from: voice note or call second, answer, office edit or weather API',
  );
export type Source = z.infer<typeof SourceSchema>;

export const SourcesSchema = z.array(SourceSchema);

/** Observed weather in the report's `units`: in, °F, mph (imperial) or mm, °C, km/h (metric). */
export const ObservedWeatherSchema = z.object({
  precip: z.number().min(0),
  tempMin: z.number(),
  tempMax: z.number(),
  wind: z.number().min(0),
  gust: z.number().min(0).optional(),
  provider: z.string(),
});
export type ObservedWeather = z.infer<typeof ObservedWeatherSchema>;

export const WeatherPeriodSchema = z.object({
  start: z.string().regex(HHMM).optional().describe('Local time HH:MM'),
  end: z.string().regex(HHMM).optional().describe('Local time HH:MM'),
  condition: z.string().min(1).describe('e.g. "Light rain", "High wind"'),
  impact: z
    .string()
    .optional()
    .describe('Effect on work, e.g. "Exterior masonry stopped; crew moved to interior blockwork"'),
  lostHours: z
    .number()
    .min(0)
    .describe('Hours work was stopped or reassigned because of weather. 0 if no stoppage'),
  fullDay: z.boolean().optional().describe('true when the crew never started because of weather'),
  source: SourcesSchema,
});
export type WeatherPeriod = z.infer<typeof WeatherPeriodSchema>;

export const WeatherSchema = z.object({
  observed: ObservedWeatherSchema.optional(),
  conditionsText: z.string().describe('Short description, e.g. "Light rain AM, overcast PM"'),
  periods: z.array(WeatherPeriodSchema),
});
export type Weather = z.infer<typeof WeatherSchema>;

export const HOURS_BASES = [
  'stated',
  'full_day_default',
  'answer',
  'office_edit',
  'unknown',
] as const;
export type HoursBasis = (typeof HOURS_BASES)[number];

export const ManpowerEntrySchema = z.object({
  companyId: z.string().nullable().describe('COMPANIES id, or null when no company matches'),
  companyNameHeard: z.string().describe('The words the manager used, e.g. "the Delta guys"'),
  companyName: z.string().describe('Official company name (from COMPANIES, or best guess)'),
  trade: z.string().optional(),
  area: z.string().optional().describe('Normalised area, e.g. "Level 2"'),
  workers: z.number().int().min(0).nullable().describe('Headcount. null when not stated'),
  hoursPerWorker: z.number().min(0).max(24).nullable(),
  totalHours: z.number().min(0).nullable().describe('workers × hoursPerWorker; null when unknown'),
  hoursBasis: z.enum(HOURS_BASES),
  confidence: z.number().min(0).max(1),
  source: SourcesSchema,
});
export type ManpowerEntry = z.infer<typeof ManpowerEntrySchema>;

export const WorkItemSchema = z.object({
  area: z.string().describe('"Level 4" | "Exterior — south elevation"'),
  activity: z.string().min(1).describe('"Slab pour", "Electrical rough-in"'),
  status: z.enum(WORK_STATUSES),
  percentComplete: z.number().int().min(0).max(100).optional(),
  quantity: z
    .object({
      value: z.number(),
      unit: z.string().describe('In the report\'s units, e.g. "yd³" or "m³"'),
      heardAs: z.string().optional().describe('Spoken words, e.g. "sixty-eight yards"'),
    })
    .optional(),
  source: SourcesSchema,
});
export type WorkItem = z.infer<typeof WorkItemSchema>;

export const DeliverySchema = z.object({
  item: z.string().min(1),
  quantity: z.string().optional(),
  supplier: z.string().optional(),
  time: z.string().optional().describe('Local time HH:MM if stated'),
  source: SourcesSchema,
});
export type Delivery = z.infer<typeof DeliverySchema>;

export const EquipmentSchema = z.object({
  item: z.string().min(1),
  note: z.string().optional(),
  source: SourcesSchema,
});
export type Equipment = z.infer<typeof EquipmentSchema>;

export const IncidentSchema = z.object({
  description: z.string().min(1),
  severity: z.enum(INCIDENT_SEVERITIES),
  source: SourcesSchema,
});
export type Incident = z.infer<typeof IncidentSchema>;

export const SafetySchema = z.object({
  toolboxTalk: z.string().optional().describe('Topic of the toolbox talk, if one was held'),
  incidents: z.array(IncidentSchema),
  noIncidentsStated: z
    .boolean()
    .describe('true ONLY if the manager explicitly said there were no incidents'),
  visitors: z.array(z.string()),
  source: SourcesSchema,
});
export type Safety = z.infer<typeof SafetySchema>;

export const IssueSchema = z.object({
  description: z.string().min(1),
  impact: z.string().optional(),
  source: SourcesSchema,
});
export type Issue = z.infer<typeof IssueSchema>;

export const NextWorkdaySchema = z.object({ item: z.string().min(1), source: SourcesSchema });
export type NextWorkday = z.infer<typeof NextWorkdaySchema>;

export const PhotoSchema = z.object({
  uploadId: z.string().describe('uploads.id of the photo'),
  caption: z.string().optional(),
  takenAt: z.string().describe('ISO timestamp'),
});
export type Photo = z.infer<typeof PhotoSchema>;

export const NewTermSchema = z.object({
  heard: z.string().min(1).describe('Exact words heard, e.g. "the Ridgeway crew"'),
  heardLanguage: z.string().min(1).describe('ISO 639-1 code of the words heard, e.g. "es"'),
  proposedOfficial: z.string().min(1).describe('Official construction term or company name'),
  kind: z.enum(NEW_TERM_KINDS),
  confidence: z.number().min(0).max(1),
});
export type NewTerm = z.infer<typeof NewTermSchema>;

/** In the reporter's locale; at most 2 options of at most 20 characters. */
export const ProposedQuestionSchema = z.object({
  field: z
    .string()
    .describe(
      'Which gap this fills: manpower.workers | manpower.hours | company.unknown | weather.impact | safety | photo',
    ),
  question: z
    .string()
    .min(1)
    .max(300)
    .describe('One short question a busy site manager can answer with a tap'),
  options: z
    .array(z.string().max(20))
    .max(2)
    .describe(
      'At most 2 likely answers, each ≤ 20 characters (an "Other…" button is added by code)',
    ),
});
export type ProposedQuestion = z.infer<typeof ProposedQuestionSchema>;

export const DailyReportDataSchema = z.object({
  schemaVersion: z.literal(2),
  reportDate: z.string().regex(ISO_DATE).describe('YYYY-MM-DD in site time zone'),
  reportLanguage: z.enum(REPORT_LANGUAGES),
  units: z.enum(UNIT_SYSTEMS),
  languageDetected: z.array(z.string()).describe('ISO 639-1 codes heard, e.g. ["es","en"]'),
  summary: z
    .string()
    .max(700)
    .describe('≤ 80 words, official terms, past tense, in reportLanguage'),
  workingHours: z.object({ start: z.string(), end: z.string() }).optional(),
  weather: WeatherSchema,
  manpower: z.array(ManpowerEntrySchema),
  workPerformed: z.array(WorkItemSchema),
  deliveries: z.array(DeliverySchema),
  equipment: z.array(EquipmentSchema),
  safety: SafetySchema,
  issues: z.array(IssueSchema),
  nextWorkday: z.array(NextWorkdaySchema),
  photos: z.array(PhotoSchema),
  newTerms: z.array(NewTermSchema),
  missingRequired: z
    .array(z.string())
    .describe(
      'Paths of required values that were not stated, e.g. "manpower.workers:Delta Mechanical"',
    ),
  lowConfidence: z.array(z.object({ path: z.string(), reason: z.string() })),
  proposedQuestions: z.array(ProposedQuestionSchema),
});
export type DailyReportData = z.infer<typeof DailyReportDataSchema>;

/** An empty, valid v2 report skeleton in the org's report language and units. */
export function emptyReportData(
  reportDate: string,
  org: { reportLanguage: ReportLanguage; units: UnitSystem },
): DailyReportData {
  return {
    schemaVersion: 2,
    reportDate,
    reportLanguage: org.reportLanguage,
    units: org.units,
    languageDetected: [],
    summary: '',
    weather: { conditionsText: '', periods: [] },
    manpower: [],
    workPerformed: [],
    deliveries: [],
    equipment: [],
    safety: { incidents: [], noIncidentsStated: false, visitors: [], source: [] },
    issues: [],
    nextWorkday: [],
    photos: [],
    newTerms: [],
    missingRequired: [],
    lowConfidence: [],
    proposedQuestions: [],
  };
}

// ──────────── v1: stored before spec v1.2, still written until W1-12 (WhatsApp era) ────────────

export const SourceV1Schema = z
  .discriminatedUnion('type', [
    z.object({
      type: z.literal('audio'),
      messageId: z.string().describe('messages.id of the voice note'),
      start: z.number().min(0).describe('Transcript segment start, seconds'),
      end: z.number().min(0).optional().describe('Transcript segment end, seconds'),
    }),
    z.object({ type: z.literal('text'), messageId: z.string() }),
    z.object({ type: z.literal('reply'), messageId: z.string() }),
    z.object({ type: z.literal('office_edit'), userId: z.string(), at: z.string() }),
    z.object({ type: z.literal('weather_api') }),
  ])
  .describe('Where a value came from: audio second, reply message, office edit or weather API');
export type SourceV1 = z.infer<typeof SourceV1Schema>;

export const SourcesV1Schema = z.array(SourceV1Schema);

export const ObservedWeatherV1Schema = z.object({
  precipIn: z.number().min(0),
  tempMinF: z.number(),
  tempMaxF: z.number(),
  windMph: z.number().min(0),
  gustMph: z.number().min(0).optional(),
  provider: z.string(),
});
export type ObservedWeatherV1 = z.infer<typeof ObservedWeatherV1Schema>;

export const WeatherPeriodV1Schema = z.object({
  start: z
    .string()
    .regex(/^\d{2}:\d{2}$/)
    .optional()
    .describe('Local time HH:MM'),
  end: z
    .string()
    .regex(/^\d{2}:\d{2}$/)
    .optional()
    .describe('Local time HH:MM'),
  condition: z.string().min(1).describe('e.g. "Light rain", "High wind"'),
  impact: z
    .string()
    .optional()
    .describe('Effect on work, e.g. "Exterior masonry stopped; crew moved to interior blockwork"'),
  lostHours: z
    .number()
    .min(0)
    .describe('Hours work was stopped or reassigned because of weather. 0 if no stoppage'),
  fullDay: z.boolean().optional().describe('true when the crew never started because of weather'),
  source: SourcesV1Schema,
});
export type WeatherPeriodV1 = z.infer<typeof WeatherPeriodV1Schema>;

const conditionsText = z.string().describe('Short description, e.g. "Light rain AM, overcast PM"');
const periods = z.array(WeatherPeriodV1Schema);

export const WeatherV1Schema = z.object({
  observed: ObservedWeatherV1Schema.optional(),
  conditionsText,
  periods,
});
export type WeatherV1 = z.infer<typeof WeatherV1Schema>;

export const HOURS_BASES_V1 = [
  'stated',
  'full_day_default',
  'reply',
  'office_edit',
  'unknown',
] as const;
export type HoursBasisV1 = (typeof HOURS_BASES_V1)[number];

export const ManpowerEntryV1Schema = z.object({
  companyId: z.string().nullable().describe('COMPANIES id, or null when no company matches'),
  companyNameHeard: z.string().describe('The words the manager used, e.g. "the Delta guys"'),
  companyName: z.string().describe('Official company name (from COMPANIES, or best guess)'),
  trade: z.string().optional(),
  area: z.string().optional().describe('Normalised area, e.g. "Level 2"'),
  workers: z.number().int().min(0).nullable().describe('Headcount. null when not stated'),
  hoursPerWorker: z.number().min(0).max(24).nullable(),
  totalHours: z.number().min(0).nullable().describe('workers × hoursPerWorker; null when unknown'),
  hoursBasis: z.enum(HOURS_BASES_V1),
  confidence: z.number().min(0).max(1),
  source: SourcesV1Schema,
});
export type ManpowerEntryV1 = z.infer<typeof ManpowerEntryV1Schema>;

export const WorkItemV1Schema = z.object({
  area: z.string().describe('"Level 4" | "Exterior — south elevation"'),
  activity: z.string().min(1).describe('"Slab pour", "Electrical rough-in"'),
  status: z.enum(WORK_STATUSES),
  percentComplete: z.number().int().min(0).max(100).optional(),
  quantity: z
    .object({
      value: z.number(),
      unit: z.string(),
      heardAs: z.string().optional().describe('Spoken words, e.g. "sixty-eight yards"'),
    })
    .optional(),
  source: SourcesV1Schema,
});
export type WorkItemV1 = z.infer<typeof WorkItemV1Schema>;

export const DeliveryV1Schema = z.object({
  item: z.string().min(1),
  quantity: z.string().optional(),
  supplier: z.string().optional(),
  time: z.string().optional().describe('Local time HH:MM if stated'),
  source: SourcesV1Schema,
});
export type DeliveryV1 = z.infer<typeof DeliveryV1Schema>;

export const EquipmentV1Schema = z.object({
  item: z.string().min(1),
  note: z.string().optional(),
  source: SourcesV1Schema,
});
export type EquipmentV1 = z.infer<typeof EquipmentV1Schema>;

export const IncidentV1Schema = z.object({
  description: z.string().min(1),
  severity: z.enum(INCIDENT_SEVERITIES),
  source: SourcesV1Schema,
});
export type IncidentV1 = z.infer<typeof IncidentV1Schema>;

export const SafetyV1Schema = z.object({
  toolboxTalk: z.string().optional().describe('Topic of the toolbox talk, if one was held'),
  incidents: z.array(IncidentV1Schema),
  noIncidentsStated: z
    .boolean()
    .describe('true ONLY if the manager explicitly said there were no incidents'),
  visitors: z.array(z.string()),
  source: SourcesV1Schema,
});
export type SafetyV1 = z.infer<typeof SafetyV1Schema>;

export const IssueV1Schema = z.object({
  description: z.string().min(1),
  impact: z.string().optional(),
  source: SourcesV1Schema,
});
export type IssueV1 = z.infer<typeof IssueV1Schema>;

export const NextWorkdayV1Schema = z.object({ item: z.string().min(1), source: SourcesV1Schema });
export type NextWorkdayV1 = z.infer<typeof NextWorkdayV1Schema>;

export const PhotoV1Schema = z.object({
  messageId: z.string(),
  caption: z.string().optional(),
  takenAt: z.string().describe('ISO timestamp'),
});
export type PhotoV1 = z.infer<typeof PhotoV1Schema>;

export const NewTermV1Schema = z.object({
  heard: z.string().min(1).describe('Exact words heard, e.g. "the Ridgeway crew"'),
  proposedOfficial: z.string().min(1).describe('Official construction term or company name'),
  kind: z.enum(NEW_TERM_KINDS),
  confidence: z.number().min(0).max(1),
});
export type NewTermV1 = z.infer<typeof NewTermV1Schema>;

export const ProposedQuestionV1Schema = z.object({
  field: z
    .string()
    .describe(
      'Which gap this fills: manpower.workers | manpower.hours | company.unknown | weather.impact | safety | photo',
    ),
  question: z
    .string()
    .min(1)
    .max(300)
    .describe('One short question a busy site manager can answer with a tap'),
  options: z
    .array(z.string().max(20))
    .max(2)
    .describe(
      'At most 2 likely answers, each ≤ 20 characters (an "Other…" button is added by code)',
    ),
  target: z
    .object({ companyNameHeard: z.string().optional(), manpowerIndex: z.number().int().optional() })
    .optional(),
});
export type ProposedQuestionV1 = z.infer<typeof ProposedQuestionV1Schema>;

/** Shape the model is asked to produce (v1 until W1-12). Code adds schemaVersion, reportDate, photos and observed weather. */
export const ExtractionOutputSchema = z.object({
  languageDetected: z.array(z.string()).describe('ISO 639-1 codes heard, e.g. ["es","en"]'),
  summary: z
    .string()
    .max(700)
    .describe('≤ 80 words, official English, past tense, key facts first'),
  workingHours: z.object({ start: z.string(), end: z.string() }).optional(),
  weather: z.object({ conditionsText, periods }),
  manpower: z.array(ManpowerEntryV1Schema),
  workPerformed: z.array(WorkItemV1Schema),
  deliveries: z.array(DeliveryV1Schema),
  equipment: z.array(EquipmentV1Schema),
  safety: SafetyV1Schema,
  issues: z.array(IssueV1Schema),
  nextWorkday: z.array(NextWorkdayV1Schema),
  newTerms: z.array(NewTermV1Schema),
  missingRequired: z
    .array(z.string())
    .describe(
      'Paths of required values that were not stated, e.g. "manpower.workers:Delta Mechanical"',
    ),
  lowConfidence: z.array(z.object({ path: z.string(), reason: z.string() })),
  proposedQuestions: z.array(ProposedQuestionV1Schema),
});
export type ExtractionOutput = z.infer<typeof ExtractionOutputSchema>;

export const DailyReportDataV1Schema = ExtractionOutputSchema.extend({
  schemaVersion: z.literal(1),
  reportDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .describe('YYYY-MM-DD in site time zone'),
  weather: WeatherV1Schema,
  photos: z.array(PhotoV1Schema),
});
export type DailyReportDataV1 = z.infer<typeof DailyReportDataV1Schema>;

/** An empty, valid v1 report skeleton (weather days, no-work days, typed reports and tests). */
export function emptyReportDataV1(reportDate: string): DailyReportDataV1 {
  return {
    schemaVersion: 1,
    reportDate,
    languageDetected: [],
    summary: '',
    weather: { conditionsText: '', periods: [] },
    manpower: [],
    workPerformed: [],
    deliveries: [],
    equipment: [],
    safety: { incidents: [], noIncidentsStated: false, visitors: [], source: [] },
    issues: [],
    nextWorkday: [],
    photos: [],
    newTerms: [],
    missingRequired: [],
    lowConfidence: [],
    proposedQuestions: [],
  };
}

// ───────────────────────────── Stored data: either version ─────────────────────────────

/** What report_versions.data may hold: v1 or v2, discriminated on `schemaVersion`. */
export const StoredReportDataSchema = z.discriminatedUnion('schemaVersion', [
  DailyReportDataV1Schema,
  DailyReportDataSchema,
]);
export type StoredReportData = z.infer<typeof StoredReportDataSchema>;

// ───────────────────────────── Claude tool (v1 until W1-12) ─────────────────────────────

function toJson(schema: z.ZodType): Record<string, unknown> {
  const json = z.toJSONSchema(schema, { target: 'draft-7', io: 'input' }) as Record<
    string,
    unknown
  >;
  delete json.$schema;
  return json;
}

/** JSON Schema for the Claude `submit_daily_report` tool input (§10.4). */
export function extractionToolInputSchema(): Record<string, unknown> {
  return toJson(ExtractionOutputSchema);
}
