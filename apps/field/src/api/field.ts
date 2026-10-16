import type {
  AnswerResponse,
  CompleteResponse,
  ConfirmResponse,
  ConsentResponse,
  DayStatusResponse,
  ExpiredLinkResponse,
  FieldApiErrorBody,
  FieldApiErrorCode,
  HistoryResponse,
  PreferencesResponse,
  ReportView,
  ResolveResponse,
  SendCodeResponse,
  SignOutResponse,
  TestClipResponse,
  TestClipView,
  TodayResponse,
  UploadResponse,
  VerifyResponse,
} from '@sitelog/shared/field-contract.ts';
import type {
  AnswerRequest,
  ConfirmRequest,
  ConsentGrantRequest,
  ConsentRequest,
  ConsentRevokeRequest,
  DayStatusRequest,
  PreferencesRequest,
  TestClipRequest,
  UploadRequest,
} from '@sitelog/shared/field-api.ts';
import { fieldApi, FieldApiError, type FieldApiClient } from './client';

/**
 * The field-api routes the screens call (W1-09; spec Appendix B), typed by `field-contract.ts`.
 * `resolve` sends the link code in its body; every other route sends it as `X-Link-Code`
 * (`linkCode`). The device cookie goes along by itself (same origin, httpOnly).
 */
export function createFieldRoutes(api: FieldApiClient = fieldApi) {
  return {
    resolve: (code: string, signal?: AbortSignal) =>
      api.request<ResolveResponse>('resolve', { body: { code }, signal }),
    sendCode: (code: string) =>
      api.request<SendCodeResponse>('device/send-code', {
        method: 'POST',
        body: {},
        linkCode: code,
      }),
    verify: (code: string, otp: string) =>
      api.request<VerifyResponse>('device/verify', { body: { code: otp }, linkCode: code }),
    consent: (code: string, body: ConsentRequest) =>
      api.request<ConsentResponse>('consent', { body, linkCode: code }),
    today: (code: string, siteId?: string | null, signal?: AbortSignal) =>
      api.request<TodayResponse>(siteId ? `today?site=${encodeURIComponent(siteId)}` : 'today', {
        linkCode: code,
        signal,
      }),
    createUpload: (code: string, body: UploadRequest, signal?: AbortSignal) =>
      api.request<UploadResponse>('uploads', { body, linkCode: code, signal }),
    completeUpload: (code: string, uploadId: string, signal?: AbortSignal) =>
      api.request<CompleteResponse>(`uploads/${encodeURIComponent(uploadId)}/complete`, {
        method: 'POST',
        body: {},
        linkCode: code,
        signal,
      }),
    report: (code: string, reportId: string, signal?: AbortSignal) =>
      api.request<ReportView>(`reports/${encodeURIComponent(reportId)}`, {
        linkCode: code,
        signal,
      }),
    /** The open question's answer (W1-12; the Question screen, W1-13). */
    answer: (code: string, reportId: string, body: AnswerRequest) =>
      api.request<AnswerResponse>(`reports/${encodeURIComponent(reportId)}/answer`, {
        body,
        linkCode: code,
      }),
    /** Confirm & send (F8, W1-07; the Draft screen, W1-13): the draft version the reporter saw. */
    confirm: (code: string, reportId: string, body: ConfirmRequest) =>
      api.request<ConfirmResponse>(`reports/${encodeURIComponent(reportId)}/confirm`, {
        body,
        linkCode: code,
      }),
    dayStatus: (code: string, body: DayStatusRequest) =>
      api.request<DayStatusResponse>('day-status', { body, linkCode: code }),
    /** Past reports (F10, W2-03): the last 14 days of the link's sites. */
    history: (code: string, signal?: AbortSignal) =>
      api.request<HistoryResponse>('history', { linkCode: code, signal }),
    /**
     * F16 "Send me today's link" (W2-03): the expired daily link's code in the body (it
     * authenticates nothing); today's link is texted, never returned.
     */
    expiredDailyLink: (code: string) =>
      api.request<ExpiredLinkResponse>('expired/daily-link', { body: { code } }),
    /** Settings (F15, W2-02): what it shows. */
    preferences: (code: string, signal?: AbortSignal) =>
      api.request<PreferencesResponse>('preferences', { linkCode: code, signal }),
    updatePreferences: (code: string, body: PreferencesRequest) =>
      api.request<PreferencesResponse>('preferences', { method: 'PATCH', body, linkCode: code }),
    /** Turn off one consent. */
    revokeConsent: (code: string, body: ConsentRevokeRequest) =>
      api.request<PreferencesResponse>('consent/revoke', { body, linkCode: code }),
    /** Turn the texts consent back on (spec §19 Q86); refused for an opted-out phone. */
    grantConsent: (code: string, body: ConsentGrantRequest) =>
      api.request<PreferencesResponse>('consent/grant', { body, linkCode: code }),
    /**
     * F4's optional test recording (W2-13): a signed upload outside any report, then `complete`
     * (the worker transcribes it), then the snippet, answered once.
     */
    createTestClip: (code: string, body: TestClipRequest) =>
      api.request<TestClipResponse>('test-clip', { body, linkCode: code }),
    completeTestClip: (code: string, id: string) =>
      api.request<TestClipView>(`test-clip/${encodeURIComponent(id)}/complete`, {
        method: 'POST',
        body: {},
        linkCode: code,
      }),
    testClip: (code: string, id: string, signal?: AbortSignal) =>
      api.request<TestClipView>(`test-clip/${encodeURIComponent(id)}`, { linkCode: code, signal }),
    /** Sign out this phone: the device is revoked and its cookie cleared. */
    signOut: (code: string) =>
      api.request<SignOutResponse>('device/sign-out', { method: 'POST', body: {}, linkCode: code }),
  };
}

export type FieldRoutes = ReturnType<typeof createFieldRoutes>;

/** The app's routes, on the app's client. */
export const fieldRoutes: FieldRoutes = createFieldRoutes();

/** The JSON body of a field-api refusal, if the error is one. */
export function apiErrorBody(err: unknown): FieldApiErrorBody | null {
  if (!(err instanceof FieldApiError) || err.reason !== 'status') return null;
  const body = err.body;
  if (body && typeof body === 'object' && typeof (body as { error?: unknown }).error === 'string') {
    return body as FieldApiErrorBody;
  }
  return null;
}

/** The stable error code of a field-api refusal, or null (a network error, a non-JSON answer). */
export function apiErrorCode(err: unknown): FieldApiErrorCode | null {
  return apiErrorBody(err)?.error ?? null;
}

/** The HTTP status of a failed call, or null for a network error. */
export function apiErrorStatus(err: unknown): number | null {
  return err instanceof FieldApiError ? err.status : null;
}

/**
 * A call that never reached field-api, or got no answer it could use: `fetch` rejecting (no
 * signal, DNS, a captive portal reset) or a 2xx that was not JSON (the host's app fallback, a
 * portal's login page). Shown as "no connection" and retried.
 */
export function isOfflineError(err: unknown): boolean {
  if (err instanceof FieldApiError) return err.reason === 'not_json';
  if (err instanceof DOMException) return err.name !== 'AbortError';
  return err instanceof TypeError;
}

/** Seconds a rate-limited caller must wait (`retryAfter`), else null. */
export function retryAfterSeconds(err: unknown): number | null {
  const body = apiErrorBody(err);
  return body?.error === 'rate_limited' && typeof body.retryAfter === 'number'
    ? body.retryAfter
    : null;
}
