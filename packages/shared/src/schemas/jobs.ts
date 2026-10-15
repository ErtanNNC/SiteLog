import { z } from 'zod';
import { SMS_KEYS, TWO_WAY_SMS_KEYS } from '../copy/sms.ts';
import type { JOB_TYPES } from '../enums.ts';

const uuid = z.string().uuid();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/** The Notifier's keys (`NotifierKey`): every SMS key but the two-way replies sms-webhook sends. */
type NotifyKey = Exclude<(typeof SMS_KEYS)[number], (typeof TWO_WAY_SMS_KEYS)[number]>;
const NOTIFY_KEYS: readonly NotifyKey[] = SMS_KEYS.filter(
  (k): k is NotifyKey => !(TWO_WAY_SMS_KEYS as readonly string[]).includes(k),
);

/** Payloads for the `jobs` table, by type (§10.1). */
export const JobPayloadSchemas = {
  inbound_message: z.object({ messageId: uuid }),
  /** §9.5: an inbound text sms-webhook stored (`messages`, channel sms, direction in), W1-08. */
  sms_inbound: z.object({ messageId: uuid }),
  transcribe_audio: z.object({
    messageId: uuid,
    reportId: uuid.optional(),
    testMode: z.boolean().optional(),
  }),
  /** §10.1: a voice note of the web recorder (field-api uploads/:id/complete, W1-07; handler W1-11). */
  transcribe_upload: z.object({ uploadId: uuid }),
  extract_report: z.object({ reportId: uuid, reason: z.string().optional() }),
  decide_next: z.object({ reportId: uuid }),
  parse_reply: z.object({ messageId: uuid, reportId: uuid }),
  file_report: z.object({
    reportId: uuid,
    trigger: z
      .enum(['confirm', 'auto', 'timeout', 'office', 'weather_day', 'no_work'])
      .default('confirm'),
    confirmMessageId: uuid.optional(),
    /**
     * The draft version a field-api confirm was for (field_confirm_report()): the worker files
     * only while the report is still awaiting confirmation at that version.
     */
    version: z.number().int().min(1).optional(),
  }),
  render_pdf: z.object({
    reportId: uuid,
    version: z.number().int().min(1),
    sendToWhatsApp: z.boolean().default(false),
    emailRecipients: z.boolean().default(false),
    changeNote: z.string().optional(),
    notifyReporter: z.boolean().optional(),
  }),
  send_email: z.object({
    kind: z.enum([
      'report_filed',
      'report_updated',
      'report_missing',
      'invoice_query',
      'evidence_pack_ready',
      'weekly_digest',
      'unknown_contact',
      'report_edited_after_signoff',
    ]),
    reportId: uuid.optional(),
    version: z.number().int().optional(),
    siteDayId: uuid.optional(),
    siteId: uuid.optional(),
    orgId: uuid.optional(),
    packId: uuid.optional(),
    invoiceId: uuid.optional(),
    unknownContactId: uuid.optional(),
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
  /**
   * §10.1 `notify(reporter_id, key, vars, dedupe_key)` (D48; W1-10): one message to a field
   * reporter through the Notifier (§4.5). `dedupeKey` is the logical message's key (e.g.
   * `notify:filed:{report_id}`): the job's dedupe key and the Notifier's, so neither a second
   * enqueue nor a retry sends it twice. `vars` are the key's §9.2 variables.
   */
  notify: z.object({
    reporterId: uuid,
    key: z.enum(NOTIFY_KEYS),
    vars: z.record(z.string(), z.union([z.string(), z.number()])).default({}),
    dedupeKey: z.string().min(1).max(200),
  }),
} as const satisfies Record<(typeof JOB_TYPES)[number], z.ZodType>;

export type JobPayloads = {
  [K in keyof typeof JobPayloadSchemas]: z.infer<(typeof JobPayloadSchemas)[K]>;
};
export type JobTypeKey = keyof JobPayloads;

export function parseJobPayload<K extends JobTypeKey>(type: K, payload: unknown): JobPayloads[K] {
  return JobPayloadSchemas[type].parse(payload) as JobPayloads[K];
}

/**
 * Dedupe keys of jobs a caller needs again for a later occurrence (GAP D16, W1-10). A key names one
 * job for good (`jobs.dedupe_key` unique, `enqueue_job … on conflict do nothing`), so a key that
 * must start a second job carries what makes the occurrence new.
 */
export const jobKeys = {
  /**
   * The filing of one confirm occurrence. Drafts are overwritten in place, so a report keeps
   * `current_version` (usually 1) until it is filed: a key per version alone would let a filing
   * that finished without filing (a stale confirm, `report.confirm_stale`; a job ops discarded)
   * swallow every later confirm of the report. So each confirm or timeout names its occurrence:
   * field_confirm_report() (SQL, 20261015000001) uses `file:<report>:v<version>` for the first web
   * confirm of a version and `…:c<n>` after a finished one; the WhatsApp confirm `…:m<message id>`
   * (`fileReportOn(…, 'm' + id)`), the confirmation timeouts `…:t<draft sent at, ms>`. Two filings
   * of one report run one after the other (lock key `report:<id>`), and the second finds the
   * report filed and does nothing.
   */
  fileReport: (reportId: string, version: number) => `file:${reportId}:v${version}`,
  /** `file:<report>:v<version>:<occurrence>` (see `fileReport`). */
  fileReportOn: (reportId: string, version: number, occurrence: string) =>
    `file:${reportId}:v${version}:${occurrence}`,
  /**
   * The extraction after the web recorder's voice notes (W1-11, `transcribe_upload`): per report
   * and its latest voice upload. It is enqueued once every voice upload of the report has its
   * transcript, so the key names the set of notes up to that upload; a later voice note is a new
   * latest upload and a new key, and a retried transcription finds its key taken.
   */
  extractUpload: (reportId: string, uploadId: string) => `extract:${reportId}:upload:${uploadId}`,
  /**
   * The welcome of the office's nth invite of a reporter (api-invite-reporter): a double submit
   * reads the same count and enqueues once; a later invite (a disabled reporter invited again) is
   * a new welcome.
   */
  welcomeInvite: (reporterId: string, invite: number) => `welcome:${reporterId}:invite:${invite}`,
  /** The welcome of the nth "Re-send welcome" (api-invite-reporter, `canResend`). */
  welcomeResend: (reporterId: string, resend: number) => `welcome:${reporterId}:resend:${resend}`,
  /** The welcome of a reporter linked from an unknown WhatsApp sender (api-link-unknown-sender). */
  welcomeLinked: (reporterId: string, unknownSenderId: string) =>
    `welcome:${reporterId}:linked:${unknownSenderId}`,
} as const;

/**
 * Backoff per §10.1 (GAP D17): a failed attempt waits 30 s, 2 min, 10 min, 30 min, then 2 h before
 * the next one, so a job runs at most six times and the sixth failure makes it dead. The same
 * schedule as `fail_job()` (supabase/migrations/20261015000001_worker_runtime.sql).
 */
export const JOB_BACKOFF_SECONDS = [30, 120, 600, 1800, 7200] as const;
export const JOB_MAX_ATTEMPTS = JOB_BACKOFF_SECONDS.length + 1;

/**
 * Seconds to wait after failed attempt number `attempt` (1-based, `jobs.attempts`); null when that
 * failure makes the job dead.
 */
export function backoffSeconds(attempt: number): number | null {
  if (attempt >= JOB_MAX_ATTEMPTS) return null;
  return JOB_BACKOFF_SECONDS[Math.max(0, attempt - 1)] ?? null;
}
