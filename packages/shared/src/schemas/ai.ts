import { z } from 'zod';

/** §10.6 — output of the `apply_correction` tool. RFC 6902 subset. */
export const PatchOperationSchema = z.object({
  op: z.enum(['replace', 'add', 'remove']),
  path: z
    .string()
    .regex(/^\/.+/)
    .describe('JSON pointer into the report data, e.g. "/manpower/0/workers"'),
  value: z.unknown().optional().describe('New value (replace/add)'),
  reason: z.string().optional().describe('The words that justify the change'),
});
export type PatchOperation = z.infer<typeof PatchOperationSchema>;

export const CorrectionResultSchema = z.object({
  operations: z.array(PatchOperationSchema),
  changeNote: z
    .string()
    .max(200)
    .describe('Human-readable note for the version history, e.g. "Apex Concrete 6 → 7 workers"'),
  needsClarification: z
    .string()
    .nullable()
    .describe('A question to ask when the correction is ambiguous; null otherwise'),
});
export type CorrectionResult = z.infer<typeof CorrectionResultSchema>;

/** §10.7 — output of the `parse_answer` tool. */
export const AnswerValueSchema = z.object({
  workers: z.number().int().min(0).nullable().optional(),
  hoursPerWorker: z.number().min(0).max(24).nullable().optional(),
  totalHours: z.number().min(0).nullable().optional(),
  fullDay: z.boolean().optional().describe('true when the manager said "full day" / "all day"'),
  halfDay: z
    .boolean()
    .optional()
    .describe('true when the manager said "half day": half of DEFAULT_SHIFT_HOURS'),
  endTime: z.string().optional().describe('HH:MM when the manager gave an end time ("till 3")'),
  impact: z.string().optional(),
  lostHours: z.number().min(0).nullable().optional(),
  start: z.string().optional(),
  end: z.string().optional(),
  noIncidentsStated: z.boolean().optional(),
  toolboxTalk: z.string().optional(),
  companyAction: z.enum(['add', 'map', 'other']).optional(),
  companyName: z.string().optional(),
  companyId: z.string().optional(),
  text: z.string().optional().describe('Free-text answer when nothing structured applies'),
});
export type AnswerValue = z.infer<typeof AnswerValueSchema>;

export const ParsedAnswerSchema = z.object({
  field: z.string(),
  value: AnswerValueSchema,
  confidence: z.number().min(0).max(1),
  note: z.string().optional(),
});
export type ParsedAnswer = z.infer<typeof ParsedAnswerSchema>;

/** §9.5 / §10.8 — reply intents. */
export const REPLY_INTENTS = [
  'confirm',
  'fix',
  'answer',
  'edit_request',
  'no_work',
  'weather_day',
  'help',
  'stop',
  'language',
  'new_report_content',
  'other',
] as const;
export type ReplyIntent = (typeof REPLY_INTENTS)[number];

export const ClassifiedReplySchema = z.object({
  intent: z.enum(REPLY_INTENTS),
  confidence: z.number().min(0).max(1),
  entities: z
    .object({
      dayReference: z
        .string()
        .nullable()
        .optional()
        .describe('e.g. "Friday", "yesterday", "Oct 9"'),
      numbers: z.array(z.number()).optional(),
      time: z
        .string()
        .nullable()
        .optional()
        .describe('HH:MM mentioned, e.g. crew released at 11:00'),
      language: z.string().nullable().optional(),
      fullDay: z.boolean().optional(),
    })
    .optional(),
  correctionText: z
    .string()
    .nullable()
    .optional()
    .describe('For fix / edit_request: the part of the message that describes the change'),
});
export type ClassifiedReply = z.infer<typeof ClassifiedReplySchema>;

/** §F10 — weather day / no work classification detail. */
export const DayOffClassificationSchema = z.object({
  kind: z.enum(['weather_day', 'no_work']),
  fullDay: z.boolean(),
  releasedAt: z.string().nullable().describe('HH:MM the crew was released, if stated'),
  cause: z.string().nullable().describe('e.g. "rain", "high wind", "holiday"'),
  workersThisMorning: z.number().int().nullable(),
  confidence: z.number().min(0).max(1),
});
export type DayOffClassification = z.infer<typeof DayOffClassificationSchema>;

export function toolInputSchema(schema: z.ZodType): Record<string, unknown> {
  const json = z.toJSONSchema(schema, { target: 'draft-7', io: 'input' }) as Record<
    string,
    unknown
  >;
  delete json.$schema;
  return json;
}
