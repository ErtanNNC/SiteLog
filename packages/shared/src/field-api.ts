import { z } from 'zod';
import { CONSENT_TYPES, CONTACT_PREFS, UPLOAD_KINDS } from './enums.ts';
import { DEVICE_COOKIE_PREFIX, UPLOAD_MAX_BYTES, VERIFY_CODE_LENGTH } from './field-contract.ts';
import { sha256Hex } from './links.ts';
import { REPORTER_LOCALES } from './locale.ts';

/**
 * The request schemas of `field-api` (W1-07; spec Appendix B). The routes' answers, error codes and
 * shared constants are `field-contract.ts`, re-exported here.
 */
export * from './field-contract.ts';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');

/** The reporter's device cookie name: `sl_dev_` + 8 hex of the SHA-256 of the reporter id. */
export function deviceCookieName(reporterId: string): string {
  return `${DEVICE_COOKIE_PREFIX}${sha256Hex(reporterId).slice(0, 8)}`;
}

// ───────────────────────────── Requests ─────────────────────────────

/** `POST resolve` (F4 step 1). */
export const ResolveRequestSchema = z.object({ code: z.string().trim().min(4).max(32) });

/** `POST device/verify` (F4 step 2). `device/send-code` takes no body. */
export const VerifyRequestSchema = z.object({
  code: z
    .string()
    .trim()
    .regex(new RegExp(`^\\d{${VERIFY_CODE_LENGTH}}$`), `${VERIFY_CODE_LENGTH} digits`),
});

/**
 * `POST consent` (F4 step 3, Field-02): the consents the reporter ticked (`recording` and
 * `data_processing` are the required box), the version of the wording shown (the pack's consent
 * key when set, spec §19 Q28), the preference and the language (one of the pack's field locales).
 */
export const ConsentRequestSchema = z.object({
  types: z.array(z.enum(CONSENT_TYPES)).min(1).max(CONSENT_TYPES.length),
  textVersion: z.string().trim().min(1).max(64),
  contactPref: z.enum(CONTACT_PREFS),
  locale: z.enum(REPORTER_LOCALES),
});

/**
 * `POST uploads` (F5 step 3): a voice note or a photo for a site and day. `siteId` defaults to the
 * link's site (or the reporter's only active site); `date` to the link's report date, else today
 * in the site's time zone (one of `TodayResponse.allowedDates`: before 12:00 site time a personal
 * link may also name the previous working day, F5). Answers `{uploadId, bucket, path, signedUrl,
 * token}`.
 */
export const UploadRequestSchema = z.strictObject({
  kind: z.enum(UPLOAD_KINDS),
  mime: z.string().trim().min(3).max(100),
  bytes: z.number().int().positive().max(UPLOAD_MAX_BYTES),
  siteId: z.uuid().optional(),
  date: isoDate.optional(),
  /** The phone's clock when recording started (§6.3 uploads.recorded_at). */
  recordedAt: z.iso.datetime({ offset: true }).optional(),
});

/**
 * `POST reports/:id/confirm` (F8): the draft the reporter saw: its version
 * (`ReportView.currentVersion`; omitted, the current one) and its revision (`ReportView.draftRev`,
 * required: a draft is overwritten in place, so the version alone cannot tell a newer draft).
 */
export const ConfirmRequestSchema = z.strictObject({
  version: z.number().int().min(1).optional(),
  draftRev: z.number().int().min(1),
});

/**
 * `POST reports/:id/answer` (F7, Field-05; W1-12): the open question's answer, as an option the
 * reporter tapped (`optionId`, one of `ReportView.question.options`) or, D28, a number they typed
 * (`value`: the headcount, hours per worker or lost hours the question asks for), with the hours
 * for a headcount (`hours`: a number, or `'full_day'`, the field app's default). Exactly one of
 * `optionId` and `value`. _Other…_ (a spoken or typed free answer, Appendix B's `uploadId`) comes
 * with M6 and is refused until then.
 */
export const AnswerRequestSchema = z
  .strictObject({
    questionId: z.uuid(),
    optionId: z.string().trim().min(1).max(20).optional(),
    value: z.number().min(0).max(9999).optional(),
    hours: z.union([z.number().min(0).max(24), z.literal('full_day')]).optional(),
  })
  .refine((a) => (a.optionId === undefined) !== (a.value === undefined), {
    message: 'optionId or value, not both',
  })
  .refine((a) => a.hours === undefined || a.value !== undefined, {
    message: 'hours goes with value',
  });

/**
 * `POST day-status` (F12, the Today buttons): no work today, or site closed for weather. The F12
 * details are stored with the change; what they become (weather_events, lost hours) is spec §19
 * Q41.
 */
export const DayStatusRequestSchema = z.strictObject({
  siteId: z.uuid(),
  status: z.enum(['no_work', 'weather_day']),
  date: isoDate.optional(),
  details: z
    .strictObject({
      /** "Since when?": a time chip (`07:00`), or `never_started`. */
      since: z.union([z.string().regex(/^\d{2}:\d{2}$/), z.literal('never_started')]).optional(),
      /** "How many were on site before?" */
      workersBefore: z.number().int().min(0).max(9999).optional(),
    })
    .optional(),
});

/**
 * `PATCH preferences` (F15). Appendix B also lists `noCallsToday` (outbound calls, M8) and
 * `messageChannel` (week 2, spec §19 Q21): not accepted before then.
 */
export const PreferencesRequestSchema = z
  .strictObject({
    contactPref: z.enum(CONTACT_PREFS).optional(),
    locale: z.enum(REPORTER_LOCALES).optional(),
  })
  .refine((p) => p.contactPref !== undefined || p.locale !== undefined, 'nothing to change');

export type ResolveRequest = z.infer<typeof ResolveRequestSchema>;
export type VerifyRequest = z.infer<typeof VerifyRequestSchema>;
export type ConsentRequest = z.infer<typeof ConsentRequestSchema>;
export type UploadRequest = z.infer<typeof UploadRequestSchema>;
export type ConfirmRequest = z.infer<typeof ConfirmRequestSchema>;
export type AnswerRequest = z.infer<typeof AnswerRequestSchema>;
export type DayStatusRequest = z.infer<typeof DayStatusRequestSchema>;
export type PreferencesRequest = z.infer<typeof PreferencesRequestSchema>;
