import { z } from 'zod';

/**
 * Canonical daily report data — the JSON stored in report_versions.data (§10.3).
 * The Zod schema is the single source of truth: the Claude tool input schema,
 * the worker validation and the web panel types are all derived from it.
 */

export const SourceSchema = z
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
export type Source = z.infer<typeof SourceSchema>;

export const SourcesSchema = z.array(SourceSchema);

export const ObservedWeatherSchema = z.object({
  precipIn: z.number().min(0),
  tempMinF: z.number(),
  tempMaxF: z.number(),
  windMph: z.number().min(0),
  gustMph: z.number().min(0).optional(),
  provider: z.string(),
});
export type ObservedWeather = z.infer<typeof ObservedWeatherSchema>;

export const WeatherPeriodSchema = z.object({
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
  source: SourcesSchema,
});
export type WeatherPeriod = z.infer<typeof WeatherPeriodSchema>;

const conditionsText = z.string().describe('Short description, e.g. "Light rain AM, overcast PM"');
const periods = z.array(WeatherPeriodSchema);

export const WeatherSchema = z.object({
  observed: ObservedWeatherSchema.optional(),
  conditionsText,
  periods,
});
export type Weather = z.infer<typeof WeatherSchema>;

export const HOURS_BASES = [
  'stated',
  'full_day_default',
  'reply',
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

export const WORK_STATUSES = ['complete', 'in_progress', 'started', 'stopped', 'planned'] as const;
export type WorkStatus = (typeof WORK_STATUSES)[number];

export const WorkItemSchema = z.object({
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

export const INCIDENT_SEVERITIES = ['near_miss', 'first_aid', 'recordable', 'lost_time'] as const;
export type IncidentSeverity = (typeof INCIDENT_SEVERITIES)[number];

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
  messageId: z.string(),
  caption: z.string().optional(),
  takenAt: z.string().describe('ISO timestamp'),
});
export type Photo = z.infer<typeof PhotoSchema>;

export const NEW_TERM_KINDS = ['term', 'company', 'area', 'unit'] as const;

export const NewTermSchema = z.object({
  heard: z.string().min(1).describe('Exact words heard, e.g. "the Ridgeway crew"'),
  proposedOfficial: z.string().min(1).describe('Official construction term or company name'),
  kind: z.enum(NEW_TERM_KINDS),
  confidence: z.number().min(0).max(1),
});
export type NewTerm = z.infer<typeof NewTermSchema>;

export const QUESTION_FIELDS = [
  'manpower.workers',
  'manpower.hours',
  'company.unknown',
  'weather.impact',
  'safety',
  'photo',
] as const;
export type QuestionField = (typeof QUESTION_FIELDS)[number];

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
  target: z
    .object({ companyNameHeard: z.string().optional(), manpowerIndex: z.number().int().optional() })
    .optional(),
});
export type ProposedQuestion = z.infer<typeof ProposedQuestionSchema>;

/** Shape the model is asked to produce. Code adds schemaVersion, reportDate, photos and observed weather. */
export const ExtractionOutputSchema = z.object({
  languageDetected: z.array(z.string()).describe('ISO 639-1 codes heard, e.g. ["es","en"]'),
  summary: z
    .string()
    .max(700)
    .describe('≤ 80 words, official English, past tense, key facts first'),
  workingHours: z.object({ start: z.string(), end: z.string() }).optional(),
  weather: z.object({ conditionsText, periods }),
  manpower: z.array(ManpowerEntrySchema),
  workPerformed: z.array(WorkItemSchema),
  deliveries: z.array(DeliverySchema),
  equipment: z.array(EquipmentSchema),
  safety: SafetySchema,
  issues: z.array(IssueSchema),
  nextWorkday: z.array(NextWorkdaySchema),
  newTerms: z.array(NewTermSchema),
  missingRequired: z
    .array(z.string())
    .describe(
      'Paths of required values that were not stated, e.g. "manpower.workers:Delta Mechanical"',
    ),
  lowConfidence: z.array(z.object({ path: z.string(), reason: z.string() })),
  proposedQuestions: z.array(ProposedQuestionSchema),
});
export type ExtractionOutput = z.infer<typeof ExtractionOutputSchema>;

export const DailyReportDataSchema = ExtractionOutputSchema.extend({
  schemaVersion: z.literal(1),
  reportDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .describe('YYYY-MM-DD in site time zone'),
  weather: WeatherSchema,
  photos: z.array(PhotoSchema),
});
export type DailyReportData = z.infer<typeof DailyReportDataSchema>;

/** An empty, valid report skeleton (used for weather days, no-work days and tests). */
export function emptyReportData(reportDate: string): DailyReportData {
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
