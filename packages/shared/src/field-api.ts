import { z } from 'zod';
import { CONSENT_TYPES, CONTACT_PREFS, MESSAGE_CHANNELS, UPLOAD_KINDS } from './enums.ts';
import {
  DEVICE_COOKIE_PREFIX,
  FILED_PHOTOS_MAX,
  UPLOAD_MAX_BYTES,
  VERIFY_CODE_LENGTH,
} from './field-contract.ts';
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
 *
 * F9 (W2-04): `addTo` names a filed report to add photos to (the Filed screen's *Add more
 * photos*): the report's site and date then stand (`siteId` and `date` are not sent), and the
 * upload belongs to the batch `batchId` of `photos` photos (1–4) and, with `caption`, one voice
 * caption (an `audio` upload). The batch becomes one new version when its last upload completes.
 */
export const AddToReportSchema = z.strictObject({
  reportId: z.uuid(),
  batchId: z.uuid(),
  photos: z.number().int().min(1).max(FILED_PHOTOS_MAX),
  caption: z.boolean(),
});

export const UploadRequestSchema = z
  .strictObject({
    kind: z.enum(UPLOAD_KINDS),
    mime: z.string().trim().min(3).max(100),
    bytes: z.number().int().positive().max(UPLOAD_MAX_BYTES),
    siteId: z.uuid().optional(),
    date: isoDate.optional(),
    /** The phone's clock when recording started (§6.3 uploads.recorded_at). */
    recordedAt: z.iso.datetime({ offset: true }).optional(),
    addTo: AddToReportSchema.optional(),
  })
  .refine((b) => !b.addTo || (b.siteId === undefined && b.date === undefined), {
    message: 'addTo takes the report’s site and date',
    path: ['addTo'],
  })
  .refine((b) => !b.addTo || b.kind === 'photo' || b.addTo.caption, {
    message: 'only a batch with a caption takes audio',
    path: ['kind'],
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
 * `POST day-status` (F12, the Today buttons): no work today, or site closed for weather. Since
 * W2-08 (spec §19 Q41) the details become a report: answered questions, a version built in code
 * (lost hours, crew hours) and its filing. A weather day needs "Since when?" (no lost hours are
 * invented without it).
 */
export const DayStatusRequestSchema = z
  .strictObject({
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
  })
  .refine((b) => b.status !== 'weather_day' || b.details?.since !== undefined, {
    message: 'a weather day needs details.since',
    path: ['details', 'since'],
  });

/**
 * `PATCH preferences` (F15, Settings; W2-02): the report mode, the language (one of the pack's
 * field locales) and the message channel (spec §19 Q21: one of the pack's built message channels,
 * else 400 `channel_not_offered`; null = the pack's order). Appendix B also lists `noCallsToday`
 * (outbound calls, M8): not accepted before then (400).
 */
export const PreferencesRequestSchema = z
  .strictObject({
    contactPref: z.enum(CONTACT_PREFS).optional(),
    locale: z.enum(REPORTER_LOCALES).optional(),
    messageChannel: z.enum(MESSAGE_CHANNELS).nullable().optional(),
  })
  .refine(
    (p) => p.contactPref !== undefined || p.locale !== undefined || p.messageChannel !== undefined,
    'nothing to change',
  );

/**
 * `POST consent/revoke` (F15, Settings; W2-02): turn one consent off (`consents.revoked_at`).
 * Revoking a consent that is not held changes nothing.
 */
export const ConsentRevokeRequestSchema = z.strictObject({ type: z.enum(CONSENT_TYPES) });

/**
 * `POST expired/daily-link` (F16 "Send me today's link"; W2-03): the expired daily link's code in
 * the body, as `resolve` takes it (the link no longer authenticates anything).
 */
export const ExpiredLinkRequestSchema = ResolveRequestSchema;

export type ResolveRequest = z.infer<typeof ResolveRequestSchema>;
export type VerifyRequest = z.infer<typeof VerifyRequestSchema>;
export type ConsentRequest = z.infer<typeof ConsentRequestSchema>;
export type UploadRequest = z.infer<typeof UploadRequestSchema>;
export type AddToReport = z.infer<typeof AddToReportSchema>;
export type ConfirmRequest = z.infer<typeof ConfirmRequestSchema>;
export type AnswerRequest = z.infer<typeof AnswerRequestSchema>;
export type DayStatusRequest = z.infer<typeof DayStatusRequestSchema>;
export type PreferencesRequest = z.infer<typeof PreferencesRequestSchema>;
export type ConsentRevokeRequest = z.infer<typeof ConsentRevokeRequestSchema>;
export type ExpiredLinkRequest = z.infer<typeof ExpiredLinkRequestSchema>;
