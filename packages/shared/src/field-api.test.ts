import { describe, expect, it } from 'vitest';
import {
  ConfirmRequestSchema,
  ConsentRequestSchema,
  DayStatusRequestSchema,
  DEVICE_COOKIE_MAX_AGE_S,
  FIELD_RATE_LIMITS,
  ConsentRevokeRequestSchema,
  PreferencesRequestSchema,
  UPLOAD_MAX_BYTES,
  UploadRequestSchema,
  VerifyRequestSchema,
  deviceCookieName,
  uploadBucket,
  uploadMediaType,
} from './field-api.ts';
import { JOB_TYPES } from './enums.ts';
import { parseJobPayload } from './schemas/jobs.ts';
import { sha256Hex } from './links.ts';
import { uploadStoragePath } from './report/numbering.ts';
import { REPORT_POLL, reportPollDelay } from './field-contract.ts';

/** The field-api contract (W1-07): what the field app sends and field-api accepts. */

describe('field-api contract', () => {
  it('keeps the spec numbers: 180-day cookie, 30/min per device, 5 sends and 5 checks an hour, 3 expired-link requests a day, 3 test recordings an hour', () => {
    expect(DEVICE_COOKIE_MAX_AGE_S).toBe(180 * 86_400);
    expect(FIELD_RATE_LIMITS).toEqual({
      device: { limit: 30, windowSeconds: 60 },
      codeSend: { limit: 5, windowSeconds: 3600 },
      codeVerify: { limit: 5, windowSeconds: 3600 },
      expiredLink: { limit: 3, windowSeconds: 86_400 },
      testClip: { limit: 3, windowSeconds: 3600 },
    });
  });

  it('polls Processing every 2 s at first, then slower, well under the device limit', () => {
    expect(reportPollDelay(0)).toBe(REPORT_POLL.fastMs);
    expect(reportPollDelay(19_999)).toBe(2_000);
    expect(reportPollDelay(20_000)).toBe(5_000);
    expect(reportPollDelay(59_999)).toBe(5_000);
    expect(reportPollDelay(60_000)).toBe(10_000);
    expect(reportPollDelay(3_600_000)).toBe(REPORT_POLL.maxMs);
    // The first minute: the first poll and those after it leave room for the clip's own calls.
    let at = 0;
    let polls = 1;
    while (at + reportPollDelay(at) < 60_000) {
      at += reportPollDelay(at);
      polls++;
    }
    expect(polls).toBeLessThanOrEqual(FIELD_RATE_LIMITS.device.limit - 10);
    // Then six a minute.
    expect(60_000 / reportPollDelay(60_000)).toBe(6);
  });

  it('maps the recorder media types to a kind and extension, parameters and case ignored', () => {
    expect(uploadMediaType('audio/webm;codecs=opus')).toEqual({
      mime: 'audio/webm',
      kind: 'audio',
      ext: 'webm',
    });
    expect(uploadMediaType('Audio/MP4')).toEqual({ mime: 'audio/mp4', kind: 'audio', ext: 'm4a' });
    expect(uploadMediaType('image/jpeg')).toMatchObject({ kind: 'photo', ext: 'jpg' });
    expect(uploadMediaType('image/heic')).toMatchObject({ kind: 'photo', ext: 'heic' });
    expect(uploadMediaType('video/mp4')).toBeNull();
    expect(uploadMediaType('')).toBeNull();
    expect(uploadBucket('audio')).toBe('audio');
    expect(uploadBucket('photo')).toBe('photos');
  });

  it('builds the upload path {org}/{site}/{date}/{id}.{ext}', () => {
    expect(uploadStoragePath('o', 's', '2026-10-09', 'u', 'webm')).toBe('o/s/2026-10-09/u.webm');
  });

  it('validates the requests', () => {
    expect(VerifyRequestSchema.safeParse({ code: ' 042917 ' }).data).toEqual({ code: '042917' });
    expect(VerifyRequestSchema.safeParse({ code: '42917' }).success).toBe(false);
    expect(
      ConsentRequestSchema.safeParse({
        types: ['recording', 'data_processing'],
        textVersion: 'US.consent.v1',
        contactPref: 'link',
        locale: 'es-US',
      }).success,
    ).toBe(true);
    expect(
      ConsentRequestSchema.safeParse({
        types: ['whatsapp'],
        textVersion: 'v1',
        contactPref: 'link',
        locale: 'en-US',
      }).success,
    ).toBe(false);
    const upload = { kind: 'audio', mime: 'audio/webm', bytes: 1000 };
    expect(UploadRequestSchema.safeParse(upload).success).toBe(true);
    expect(UploadRequestSchema.safeParse({ ...upload, bytes: UPLOAD_MAX_BYTES + 1 }).success).toBe(
      false,
    );
    expect(UploadRequestSchema.safeParse({ ...upload, extra: 1 }).success).toBe(false);
    expect(UploadRequestSchema.safeParse({ ...upload, date: '9 Oct' }).success).toBe(false);
    expect(
      DayStatusRequestSchema.safeParse({
        siteId: '11111111-0000-4000-8000-000000000001',
        status: 'weather_day',
        details: { since: 'never_started', workersBefore: 0 },
      }).success,
    ).toBe(true);
    expect(
      DayStatusRequestSchema.safeParse({
        siteId: '11111111-0000-4000-8000-000000000001',
        status: 'filed',
      }).success,
    ).toBe(false);
    // Appendix B's messageChannel (W2-02; null = the pack's order); noCallsToday (M8) not yet.
    expect(PreferencesRequestSchema.safeParse({ locale: 'tr-TR' }).success).toBe(true);
    expect(PreferencesRequestSchema.safeParse({}).success).toBe(false);
    expect(PreferencesRequestSchema.safeParse({ messageChannel: 'sms' }).success).toBe(true);
    expect(PreferencesRequestSchema.safeParse({ messageChannel: null }).success).toBe(true);
    expect(PreferencesRequestSchema.safeParse({ messageChannel: 'fax' }).success).toBe(false);
    expect(PreferencesRequestSchema.safeParse({ noCallsToday: true }).success).toBe(false);
    expect(ConsentRevokeRequestSchema.safeParse({ type: 'sms' }).success).toBe(true);
    expect(ConsentRevokeRequestSchema.safeParse({ type: 'whatsapp' }).success).toBe(false);
    expect(ConsentRevokeRequestSchema.safeParse({}).success).toBe(false);
    expect(ConfirmRequestSchema.safeParse({ draftRev: 1 }).success).toBe(true);
    expect(ConfirmRequestSchema.safeParse({ version: 2, draftRev: 3 }).data).toEqual({
      version: 2,
      draftRev: 3,
    });
    // The revision is required: a draft is overwritten in place, the version alone is not enough.
    expect(ConfirmRequestSchema.safeParse({}).success).toBe(false);
    expect(ConfirmRequestSchema.safeParse({ version: 2 }).success).toBe(false);
    expect(ConfirmRequestSchema.safeParse({ draftRev: 0 }).success).toBe(false);
    expect(ConfirmRequestSchema.safeParse({ version: 0, draftRev: 1 }).success).toBe(false);
    expect(ConfirmRequestSchema.safeParse({ version: 1, draftRev: 1, via: 'web' }).success).toBe(
      false,
    );
  });

  it('names one device cookie per reporter', () => {
    const marco = '11111111-0000-4000-8000-000000000101';
    expect(deviceCookieName(marco)).toBe(`sl_dev_${sha256Hex(marco).slice(0, 8)}`);
    expect(deviceCookieName(marco)).toMatch(/^sl_dev_[0-9a-f]{8}$/);
    expect(deviceCookieName('11111111-0000-4000-8000-000000000102')).not.toBe(
      deviceCookieName(marco),
    );
  });

  it('carries the confirmed version in file_report (optional for the WhatsApp confirm)', () => {
    const reportId = '11111111-0000-4000-8000-000000000003';
    expect(parseJobPayload('file_report', { reportId, trigger: 'confirm', version: 2 })).toEqual({
      reportId,
      trigger: 'confirm',
      version: 2,
    });
    expect(parseJobPayload('file_report', { reportId })).toEqual({ reportId, trigger: 'confirm' });
    expect(() => parseJobPayload('file_report', { reportId, version: 0 })).toThrow();
  });

  it('has the transcribe_upload job (handler W1-11) with an upload id', () => {
    expect(JOB_TYPES).toContain('transcribe_upload');
    const uploadId = '11111111-0000-4000-8000-000000000002';
    expect(parseJobPayload('transcribe_upload', { uploadId })).toEqual({ uploadId });
    expect(() => parseJobPayload('transcribe_upload', { messageId: uploadId })).toThrow();
  });
});
