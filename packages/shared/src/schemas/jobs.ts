import { z } from 'zod';
import type { JOB_TYPES } from '../enums.ts';

const uuid = z.string().uuid();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/** Payloads for the `jobs` table, by type (§10.1). */
export const JobPayloadSchemas = {
  inbound_message: z.object({ messageId: uuid }),
  transcribe_audio: z.object({
    messageId: uuid,
    reportId: uuid.optional(),
    testMode: z.boolean().optional(),
  }),
  extract_report: z.object({ reportId: uuid, reason: z.string().optional() }),
  decide_next: z.object({ reportId: uuid }),
  parse_reply: z.object({ messageId: uuid, reportId: uuid }),
  file_report: z.object({
    reportId: uuid,
    trigger: z
      .enum(['confirm', 'auto', 'timeout', 'office', 'weather_day', 'no_work'])
      .default('confirm'),
    confirmMessageId: uuid.optional(),
  }),
  render_pdf: z.object({
    reportId: uuid,
    version: z.number().int().min(1),
    sendToWhatsApp: z.boolean().default(false),
    emailRecipients: z.boolean().default(false),
    changeNote: z.string().optional(),
  }),
  send_email: z.object({
    kind: z.enum([
      'report_filed',
      'report_updated',
      'report_missing',
      'invoice_query',
      'evidence_pack_ready',
      'weekly_digest',
      'unknown_sender',
      'report_edited_after_signoff',
    ]),
    reportId: uuid.optional(),
    version: z.number().int().optional(),
    siteDayId: uuid.optional(),
    siteId: uuid.optional(),
    orgId: uuid.optional(),
    packId: uuid.optional(),
    invoiceId: uuid.optional(),
    unknownSenderId: uuid.optional(),
    to: z.array(z.string().email()).optional(),
    changeNote: z.string().optional(),
  }),
  fetch_weather: z.object({ siteId: uuid, date: isoDate }),
  send_welcome: z.object({
    reporterId: uuid,
    siteId: uuid.optional(),
    reinvite: z.boolean().default(false),
  }),
  send_template: z.object({
    conversationId: uuid,
    template: z.string(),
    vars: z.record(z.string(), z.string()),
    freeFormText: z.string().optional(),
    buttons: z.array(z.object({ id: z.string(), title: z.string() })).optional(),
    siteDayId: uuid.optional(),
    stage: z.number().int().optional(),
  }),
  send_message: z.object({
    conversationId: uuid,
    text: z.string(),
    buttons: z.array(z.object({ id: z.string(), title: z.string() })).optional(),
  }),
  build_evidence_pack: z.object({ packId: uuid }),
  retention_cleanup: z.object({ before: z.string().optional() }),
  weekly_digest: z.object({ orgId: uuid, weekStart: isoDate }),
} as const satisfies Record<(typeof JOB_TYPES)[number], z.ZodType>;

export type JobPayloads = {
  [K in keyof typeof JobPayloadSchemas]: z.infer<(typeof JobPayloadSchemas)[K]>;
};
export type JobTypeKey = keyof JobPayloads;

export function parseJobPayload<K extends JobTypeKey>(type: K, payload: unknown): JobPayloads[K] {
  return JobPayloadSchemas[type].parse(payload) as JobPayloads[K];
}

/** Exponential backoff per §10.1: 30 s, 2 min, 10 min, 30 min, 2 h; after 5 attempts → dead. */
export const JOB_BACKOFF_SECONDS = [30, 120, 600, 1800, 7200] as const;
export const JOB_MAX_ATTEMPTS = 5;

/** Seconds to wait before retry number `attempt` (1-based); null when the job should be marked dead. */
export function backoffSeconds(attempt: number): number | null {
  if (attempt >= JOB_MAX_ATTEMPTS) return null;
  return JOB_BACKOFF_SECONDS[Math.min(attempt - 1, JOB_BACKOFF_SECONDS.length - 1)] ?? null;
}
