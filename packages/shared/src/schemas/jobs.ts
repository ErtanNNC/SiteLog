import { z } from 'zod';
import { SMS_KEYS, TWO_WAY_SMS_KEYS } from '../copy/sms.ts';
import { FIELD_CHANNELS, SITE_DAY_STATUSES, type JOB_TYPES } from '../enums.ts';

/**
 * A web report's re-check before a `notify` job sends (W2-07): `question_ready` while the question
 * is still open, `draft_ready` (and the 30-minute nudge, spec §19 Q78) while the draft is still
 * unconfirmed at that version and revision. Exported for the late fallback (W2-01), which carries
 * it on.
 */
export const NotifyReportGuardSchema = z.object({
  reportId: z.string().uuid(),
  status: z.enum(['awaiting_answer', 'awaiting_confirmation']),
  /** `question_ready`: the question must still be open (unanswered, not timed out). */
  questionId: z.string().uuid().optional(),
  /** `draft_ready` and the nudge: the draft must still be this version … */
  version: z.number().int().min(1).optional(),
  /** … at this revision (`report_versions.draft_rev`): a newer draft is a new text. */
  draftRev: z.number().int().min(1).optional(),
  /**
   * Spec §19 Q61 (decided: the second): decide_next found the reporter's device active and
   * deferred the text 30 s; it goes out only if no device of theirs was seen after this instant
   * (else `notify.skipped`, `device_active`: they saw it on the recorder).
   */
  deviceNotSeenAfter: z.string().datetime({ offset: true }).optional(),
  /**
   * The nudge is a reminder, not an answer to the reporter's action: it passes through the quiet
   * hours (spec §19 Q77, the org's call window at the site).
   */
  quietHours: z.boolean().optional(),
});

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
  /**
   * §9.5 report keywords (W2-12): the inbound text `messageId` (a Twilio text, or a Demo phone
   * reply) was OK, NO WORK, WEATHER or EDIT from a two-way pack; the worker answers it (the draft
   * link, the day sheet link, EDIT's preview). With `correctionId`: the EDIT's preview settled
   * (apply_correction), so the reply is the preview with its confirm link, or why there is none.
   */
  sms_keyword: z.object({ messageId: uuid, correctionId: uuid.optional() }),
  transcribe_audio: z.object({
    messageId: uuid,
    reportId: uuid.optional(),
    testMode: z.boolean().optional(),
  }),
  /**
   * §10.1: a voice note of the web recorder (field-api uploads/:id/complete, W1-07; handler W1-11).
   * `purpose: 'caption'` (F9, W2-04): the voice caption of photos added after filing: transcribed
   * into the photos' caption, then the batch is attached as a new version; never extracted.
   */
  transcribe_upload: z.object({
    uploadId: uuid,
    purpose: z.enum(['report', 'caption']).optional(),
  }),
  extract_report: z.object({ reportId: uuid, reason: z.string().optional() }),
  /**
   * §10.7 (W2-09, F7 *Other…*): the answer clip `uploadId` the reporter spoke for the open web
   * question `questionId` (field_answer_question_voice()): transcribed, parsed by `parse_answer`,
   * then applied in code (≥ 0.7) or asked once more; unclear twice → recorded unanswered.
   */
  parse_answer: z.object({ reportId: uuid, questionId: uuid, uploadId: uuid }),
  /**
   * F4's test recording (W2-13; field_test_clip_complete(), `test_clip:<id>`): transcribed into
   * the Welcome screen's snippet; the file is deleted once transcribed. Never a report source.
   */
  transcribe_test_clip: z.object({ testClipId: uuid }),
  /**
   * F4: the backstop 10 minutes after the test recording was made (field_test_clip_create(),
   * `test_clip:<id>:delete`): the file and the words go, read or not.
   */
  delete_test_clip: z.object({ testClipId: uuid }),
  /**
   * §10.6 (W2-10, F8 *Fix by voice*; field_request_correction(), `correction:<id>`): the
   * correction `correctionId` of the draft of `reportId`: transcribed (a clip), parsed by
   * `apply_correction`, applied in code to the draft into a preview (`draft_corrections`). The
   * draft changes only when the reporter saves the preview (`reports/:id/correction/:cid/apply`).
   */
  apply_correction: z.object({ reportId: uuid, correctionId: uuid }),
  /**
   * §10.1 decide_next. `timeout` (W2-07, §7.2 web rules): a step of the web clock, enqueued
   * delayed by decide_next itself (`run_after`) and checked again when it runs:
   * - `answer`: the open question unanswered for 60 min → recorded unanswered, the draft is
   *   built with the gap flagged (`unanswered:<field>`), no text (F7);
   * - `file`: the draft at that version and revision still unconfirmed → filed with trigger
   *   `timeout` (reason `unconfirmed`, +2 h) or `auto` (`filing_mode = 'auto_15min'`, +15 min).
   */
  decide_next: z.object({
    reportId: uuid,
    timeout: z
      .discriminatedUnion('step', [
        z.object({ step: z.literal('answer'), questionId: uuid }),
        z.object({
          step: z.literal('file'),
          trigger: z.enum(['timeout', 'auto']),
          version: z.number().int().min(1),
          draftRev: z.number().int().min(1),
        }),
      ])
      .optional(),
  }),
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
    /**
     * The draft revision of that version the reporter confirmed (`report_versions.draft_rev`,
     * field_confirm_report() since 20261015000070): drafts are overwritten in place, so the worker
     * files only while the version is still at that revision. Absent: no revision check (the
     * WhatsApp confirm, the timeouts, a web confirm queued before the migration).
     */
    draftRev: z.number().int().min(1).optional(),
    /**
     * §10.1 `file_report(report_id, via)`: the channel the reporter confirmed on, stored as
     * `reports.confirmed_via` (W1-15; field_confirm_report() sends `web`). The WhatsApp confirm
     * (v1.0, `confirmMessageId`) and the timeouts send none.
     */
    via: z.enum(FIELD_CHANNELS).optional(),
  }),
  render_pdf: z.object({
    reportId: uuid,
    version: z.number().int().min(1),
    /** v1.0 WhatsApp delivery: still accepted so queued jobs parse, ignored since W1-15. */
    sendToWhatsApp: z.boolean().default(false),
    emailRecipients: z.boolean().default(false),
    changeNote: z.string().optional(),
    /** v1.0 office-edit notice on WhatsApp (D31): accepted and ignored since W1-15. */
    notifyReporter: z.boolean().optional(),
    /**
     * F10 (W2-11, field_save_filed_correction()): the user who had signed the report off before
     * this version reopened it; the "Updated" email goes to them too (§13 "Recipients + signer"),
     * since `reports.signed_off_by` is cleared by then.
     */
    signerId: uuid.optional(),
    /**
     * F10 (W2-11): the reporter changed the filed report on the web; once the "Updated" email is
     * queued, render_pdf queues their `edit_applied` text (§9.2) through the Notifier, once
     * (`jobKeys.editApplied`). `weekday` and `change` are in the reporter's language (field-api).
     */
    editApplied: z
      .object({
        reporterId: uuid,
        weekday: z.string().min(1).max(40),
        change: z.string().min(1).max(300),
      })
      .optional(),
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
    /** `report_updated` (W2-11): the signer of the version it replaced, emailed too (§13). */
    signerId: uuid.optional(),
    /**
     * `report_missing` (W2-06): how many reminders (R1, R2) reached the reporter that day, from
     * mark_site_day_missing(); absent or 0 = none, so the email words it without reminders (§19 Q55).
     */
    reminders: z.number().int().nonnegative().optional(),
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
   * enqueue nor a retry sends it twice. `vars` are the key's §9.2 variables. `afterMessageId`
   * marks the fallback after a late `failed` / `undeliverable` status callback on that attempt
   * (W2-01, spec §19 Q22): the same message, its key's guard run again, then the next channel
   * (job key `jobKeys.notifyAfter`).
   */
  notify: z.object({
    reporterId: uuid,
    key: z.enum(NOTIFY_KEYS),
    vars: z.record(z.string(), z.union([z.string(), z.number()])).default({}),
    dedupeKey: z.string().min(1).max(200),
    afterMessageId: uuid.optional(),
    /**
     * The reminder ladder's re-check before sending (W2-06): the message goes out only while the
     * site-day is in one of `statuses` (a day filed, `processing`, `no_work` or `weather_day` since
     * the stage was claimed sends nothing, `notify.skipped` `stale_stage`), its reminders are not
     * paused, and, when `notAfter` is set, before that instant (the call window's end, spec §19 Q77:
     * `quiet_hours`). claim_site_day_reminder() writes it; the late fallback carries it on.
     */
    guard: z
      .object({
        siteDayId: uuid,
        statuses: z.array(z.enum(SITE_DAY_STATUSES)).min(1),
        notAfter: z.string().datetime({ offset: true }).optional(),
      })
      .optional(),
    /** W2-07: the web report re-check (`NotifyReportGuardSchema`); the late fallback carries it on. */
    reportGuard: NotifyReportGuardSchema.optional(),
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
   * The extraction after a photo completed on a draft awaiting confirmation (W1-12, §7.2 "more
   * photos": field_complete_upload() moves the report back to processing): per report and photo,
   * and a photo completes once.
   */
  extractPhoto: (reportId: string, uploadId: string) => `extract:${reportId}:photo:${uploadId}`,
  /**
   * The web pipeline's decide_next after an extraction (W1-12): per report and the extract job
   * that wrote the draft. A retry of that job finds its key taken; every new extraction is a new
   * job id.
   */
  decideAfterExtract: (reportId: string, extractJobId: number) =>
    `decide:${reportId}:extract-job:${extractJobId}`,
  /**
   * decide_next after a web answer (field_answer_question(), SQL, W1-12): per report and question;
   * a question is answered once.
   */
  decideAnswer: (reportId: string, questionId: string) => `decide:${reportId}:answer:${questionId}`,
  /**
   * A spoken answer's parse (W2-09, §10.7; field_answer_question_voice(), SQL): per question and
   * answer clip. A clip is spoken once and answers one question; a second try is a new clip.
   */
  parseAnswer: (questionId: string, uploadId: string) => `answer:${questionId}:${uploadId}`,
  /**
   * A correction's preview (W2-10, §10.6; field_request_correction(), SQL): per correction, and a
   * correction is made once (a second try is a new correction).
   */
  applyCorrection: (correctionId: string) => `correction:${correctionId}`,
  /**
   * decide_next after a fix saved on the draft (W2-10, §7.2 `awaiting_confirmation → processing`):
   * a spoken or typed fix per correction (`field_apply_correction()`), a stepper per draft revision
   * it changed (`field_edit_draft()`, `edit:v<version>:r<rev>`): each is saved once.
   */
  decideCorrection: (reportId: string, correctionId: string) =>
    `decide:${reportId}:correction:${correctionId}`,
  decideEdit: (reportId: string, version: number, draftRev: number) =>
    `decide:${reportId}:edit:v${version}:r${draftRev}`,
  /**
   * The `question_ready` text (W1-12): the `notify` job's key and the Notifier's, per question, so
   * a retried decide_next never texts twice and a new question is a new text (D25). Since W2-07 a
   * `notify` job sends it, at once or 30 s later when the reporter's device was active (spec §19
   * Q61): one job per key either way, so it can never text twice.
   */
  questionReady: (questionId: string) => `notify:question_ready:${questionId}`,
  /**
   * The `draft_ready` text: the `notify` job's key and the Notifier's, per decide_next job that
   * showed the draft, so a retry never texts twice and a draft shown again after more audio or
   * photos is a new text (as `questionReady`, W2-07).
   */
  draftReady: (reportId: string, decideJobId: number) =>
    `notify:draft_ready:${reportId}:${decideJobId}`,
  /**
   * The 30-minute nudge on an unconfirmed web draft (§7.2, W2-07; its copy is `draft_ready` until
   * spec §19 Q78 says otherwise): the `notify` job's key and the Notifier's, per report, version and
   * draft revision, so a newer draft restarts the clock and a retry never nudges twice.
   */
  draftNudge: (reportId: string, version: number, draftRev: number) =>
    `notify:draft_nudge:${reportId}:v${version}:r${draftRev}`,
  /**
   * The answer timeout of a web question (§7.2, W2-07): a delayed decide_next per report and
   * question (the WhatsApp sweep's key shape), and a question is asked once.
   */
  decideTimeout: (reportId: string, questionId: string) =>
    `decide:${reportId}:timeout:${questionId}`,
  /**
   * The confirmation timeout of a web draft (§7.2, W2-07): a delayed decide_next that files it,
   * per report, version and draft revision, so a newer draft restarts the clock and a retry never
   * files twice (a filing that finds the report filed does nothing).
   */
  decideFileTimeout: (reportId: string, version: number, draftRev: number) =>
    `decide:${reportId}:file-timeout:v${version}:r${draftRev}`,
  /**
   * The nth arming of a re-armable timer (W2-07: `decideTimeout`, `decideFileTimeout`,
   * `draftNudge`): the base key first, then `<base>:re<n>`. A key names one job for good, so a
   * timer that fired while the report was busy (an extraction running, a clip not transcribed, a
   * spoken answer being read) and changed nothing is armed again under the next key; the web
   * pipeline arms one only while no job of the timer is queued or running.
   */
  rearm: (baseKey: string, n: number) => (n === 0 ? baseKey : `${baseKey}:re${n}`),
  /**
   * The `filed` text of a report (§9.2, F8; W1-15): the `notify` job's dedupe key and the
   * Notifier's. A report is filed once, so a retried or repeated filing never texts twice.
   */
  filed: (reportId: string) => `notify:filed:${reportId}`,
  /**
   * The `notify` job that carries a message to its next channel after a late `failed` /
   * `undeliverable` status callback on one attempt (W2-01, spec §19 Q22): per logical message and
   * failed attempt, so a repeated callback queues one job and each failed attempt its own.
   */
  notifyAfter: (dedupeKey: string, messageId: string) => `${dedupeKey}:after:${messageId}`,
  /**
   * The `render_pdf` job of a report version (file_report, create_report_version, the WhatsApp
   * edits): one PDF per version.
   */
  renderPdf: (reportId: string, version: number) => `render_pdf:${reportId}:${version}`,
  /**
   * The reporter's `edit_applied` text after their change of a filed report (F10, W2-11; render_pdf
   * of the version it made): the `notify` job's key and the Notifier's, per report and version, and
   * a version is made once, so a retried render never texts twice.
   */
  editApplied: (reportId: string, version: number) => `notify:edit_applied:${reportId}:v${version}`,
  /**
   * W2-12: the `sms_keyword` job of an inbound text's report keyword (OK, NO WORK, WEATHER, EDIT;
   * `processInboundSms`): per text, and a text is received once (`messages` per provider id).
   */
  smsKeyword: (messageId: string) => `sms_keyword:${messageId}`,
  /**
   * W2-12: the `sms_keyword` job that answers an SMS EDIT once its preview settled
   * (apply_correction): per text and correction, and a correction settles once.
   */
  smsEditPreview: (messageId: string, correctionId: string) =>
    `sms_keyword:${messageId}:${correctionId}`,
  /** The `send_email` job of a report version (render_pdf): one email per kind and version. */
  reportEmail: (kind: 'report_filed' | 'report_updated', reportId: string, version: number) =>
    `email:${kind}:${reportId}:${version}`,
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
