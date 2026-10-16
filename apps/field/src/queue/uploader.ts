import { uploadMediaType } from '@sitelog/shared/field-contract.ts';
import type { CompleteResponse, FieldApiErrorCode } from '@sitelog/shared/field-contract.ts';
import { apiErrorCode, apiErrorStatus, isOfflineError, retryAfterSeconds } from '@/api/field';
import type { FieldRoutes } from '@/api/field';
import type { QueuedUpload } from './types';

/**
 * One try at sending a queued item (F5 step 3): `POST uploads` for a signed URL (kept for the
 * next try), PUT the file to Storage, then `POST uploads/:id/complete`, which creates the day's
 * report on the first voice note and enqueues the transcription. Each step's result is persisted
 * through `persist`, so a try cut off halfway resumes where it was.
 *
 * Every request has a deadline: a stalled connection on site (signal bars, no data) must not hold
 * the queue for the minutes the phone takes to give up on it. A request past its deadline, or the
 * whole try aborted by the queue (`signal`: the signal came back), is a `timeout`, retried like a
 * lost connection.
 */

export type UploadOutcome =
  | { ok: true; result: CompleteResponse }
  | {
      ok: false;
      /** Field-api refused for good (or until the reporter opens the link again): no retry. */
      permanent: boolean;
      error: string;
      /** A rate limit's wait, when it named one. */
      retryAfterMs?: number;
    };

export type Persist = (patch: Partial<QueuedUpload>) => Promise<void>;

/** An item with its file in hand (the queue reads a stored file before the try). */
export type SendableUpload = QueuedUpload & { blob: Blob };

export interface UploaderDeps {
  /**
   * `answer` hands a spoken answer's clip to field-api after it completes (W2-09), `correction`
   * a correction clip (W2-10), so neither is lost when the page goes before the upload finishes.
   */
  routes: Pick<FieldRoutes, 'createUpload' | 'completeUpload'> &
    Partial<Pick<FieldRoutes, 'answer' | 'correction'>>;
  /** PUTs the file to the signed URL; the default is `fetch`. */
  put?: (url: string, blob: Blob, mime: string, signal: AbortSignal) => Promise<{ status: number }>;
}

/** field-api's JSON routes answer in well under this; past it the connection is stalled. */
export const API_DEADLINE_MS = 30_000;

/** A PUT's deadline: a minute, plus the file at 25 kB/s (a weak 3G link). */
export function putDeadlineMs(bytes: number): number {
  return 60_000 + Math.ceil(bytes / 25);
}

/** Refusals that no retry can change (the queue keeps the item and shows why). */
const PERMANENT: ReadonlySet<FieldApiErrorCode> = new Set<FieldApiErrorCode>([
  'invalid_request',
  'link_not_found',
  'link_expired',
  'link_revoked',
  'reporter_disabled',
  'device_unverified',
  'consent_required',
  'site_inactive',
  'date_not_allowed',
  'kind_not_allowed',
  'media_type_not_allowed',
  'upload_too_large',
  'report_filed',
  'day_closed',
  'wrong_state',
  'photos_window_closed',
  'photo_limit',
]);

/** Field-api's upload row is gone or never got the file: the next try starts over. */
const START_OVER: ReadonlySet<FieldApiErrorCode> = new Set<FieldApiErrorCode>([
  'not_found',
  'upload_missing',
]);

function defaultPut(
  url: string,
  blob: Blob,
  mime: string,
  signal: AbortSignal,
): Promise<{ status: number }> {
  return fetch(url, {
    method: 'PUT',
    headers: { 'Content-Type': mime, 'x-upsert': 'false' },
    body: blob,
    signal,
  }).then((res) => ({ status: res.status }));
}

function isAbort(err: unknown): boolean {
  return (err as { name?: string } | null)?.name === 'AbortError';
}

function timedOut(): DOMException {
  return new DOMException('The request took too long', 'AbortError');
}

/**
 * Runs `call` with a signal that aborts after `ms` or when `parent` aborts, and gives up at that
 * moment even if `call` ignores its signal.
 */
async function withDeadline<T>(
  ms: number,
  parent: AbortSignal | undefined,
  call: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let rejectAbort: (err: unknown) => void = () => undefined;
  const aborted = new Promise<never>((_, reject) => (rejectAbort = reject));
  aborted.catch(() => undefined);
  const abort = () => {
    controller.abort();
    rejectAbort(timedOut());
  };
  const timer = setTimeout(abort, ms);
  if (parent?.aborted) abort();
  else parent?.addEventListener('abort', abort, { once: true });
  try {
    return await Promise.race([call(controller.signal), aborted]);
  } finally {
    clearTimeout(timer);
    parent?.removeEventListener('abort', abort);
  }
}

function failure(err: unknown): UploadOutcome & { ok: false } {
  if (isAbort(err)) return { ok: false, permanent: false, error: 'timeout' };
  const code = apiErrorCode(err);
  if (code) {
    const retryAfter = retryAfterSeconds(err);
    return {
      ok: false,
      permanent: PERMANENT.has(code),
      error: code,
      ...(retryAfter !== null ? { retryAfterMs: retryAfter * 1000 } : {}),
    };
  }
  if (isOfflineError(err)) return { ok: false, permanent: false, error: 'network' };
  const status = apiErrorStatus(err);
  return { ok: false, permanent: false, error: status ? `http_${status}` : 'internal' };
}

/**
 * W2-09: a completed answer clip goes to `reports/:id/answer {uploadId}` (field-api queues
 * parse_answer). A question answered meanwhile, a report that moved on, or a clip already being
 * listened to leave nothing to do: the item is done. Anything else (no signal) fails the try, and
 * the next one completes again (`alreadyComplete`) and answers again (field-api answers a repeat
 * the same way).
 */
const ANSWER_SETTLED: ReadonlySet<FieldApiErrorCode> = new Set<FieldApiErrorCode>([
  'question_closed',
  'wrong_state',
  'answer_pending',
  'not_found',
]);

async function answerWith(
  item: QueuedUpload,
  deps: UploaderDeps,
  signal: AbortSignal | undefined,
): Promise<void> {
  if (!deps.routes.answer || !item.answerTo || !item.uploadId) return;
  const { reportId, questionId } = item.answerTo;
  try {
    await withDeadline(API_DEADLINE_MS, signal, () =>
      deps.routes.answer!(item.code, reportId, { questionId, uploadId: item.uploadId! }),
    );
  } catch (err) {
    const code = apiErrorCode(err);
    if (code && ANSWER_SETTLED.has(code)) return;
    throw err;
  }
}

/**
 * W2-10 review: a completed correction clip goes to `reports/:id/correction {uploadId}` (field-api
 * queues apply_correction) from the queue itself, so a fix said just before a reload is still
 * listened to; the screen's own call after `waitFor` gets the same fix back (field-api answers a
 * repeat of the clip with it). A fix already pending, a report that moved on (filed, locked) or
 * gone leave nothing to do: the item is done. Anything else fails the try for a retry.
 */
const CORRECTION_SETTLED: ReadonlySet<FieldApiErrorCode> = new Set<FieldApiErrorCode>([
  'correction_pending',
  'wrong_state',
  'report_locked',
  'site_inactive',
  'not_found',
]);

async function correctWith(
  item: QueuedUpload,
  deps: UploaderDeps,
  signal: AbortSignal | undefined,
): Promise<void> {
  if (!deps.routes.correction || !item.fixTo || !item.uploadId) return;
  const { reportId } = item.fixTo;
  try {
    await withDeadline(API_DEADLINE_MS, signal, () =>
      deps.routes.correction!(item.code, reportId, { uploadId: item.uploadId! }),
    );
  } catch (err) {
    const code = apiErrorCode(err);
    if (code && CORRECTION_SETTLED.has(code)) return;
    throw err;
  }
}

export async function uploadItem(
  item: SendableUpload,
  deps: UploaderDeps,
  persist: Persist,
  signal?: AbortSignal,
): Promise<UploadOutcome> {
  const put = deps.put ?? defaultPut;
  let current: SendableUpload = item;
  const save = async (patch: Partial<Omit<QueuedUpload, 'blob'>>) => {
    current = { ...current, ...patch };
    await persist(patch);
  };

  try {
    if (!current.uploadId || !current.signedUrl) {
      const created = await withDeadline(API_DEADLINE_MS, signal, (s) =>
        deps.routes.createUpload(
          current.code,
          {
            kind: current.kind,
            mime: current.mime,
            bytes: current.bytes,
            // F9: a photo for a filed report goes in that report's site and day; W2-09: so does
            // a spoken answer, in its question's report; W2-10: a correction clip, in its draft's.
            ...(current.addTo
              ? { addTo: current.addTo }
              : current.answerTo
                ? { answerTo: current.answerTo }
                : current.fixTo
                  ? { fixTo: current.fixTo }
                  : { siteId: current.siteId, date: current.date }),
            ...(current.recordedAt ? { recordedAt: current.recordedAt } : {}),
          },
          s,
        ),
      );
      await save({ uploadId: created.uploadId, signedUrl: created.signedUrl, putDone: false });
    }

    let putRefused = false;
    if (!current.putDone) {
      // The stored object's type is what `complete` checks: the base type, as field-api keeps it.
      const base = uploadMediaType(current.mime)?.mime ?? current.mime;
      let res: { status: number };
      try {
        res = await withDeadline(putDeadlineMs(current.blob.size), signal, (s) =>
          put(current.signedUrl!, current.blob, base, s),
        );
      } catch (err) {
        if (isAbort(err)) return { ok: false, permanent: false, error: 'timeout' };
        if (isOfflineError(err) || err instanceof TypeError) {
          return { ok: false, permanent: false, error: 'network' };
        }
        throw err;
      }
      if (res.status >= 200 && res.status < 300) {
        await save({ putDone: true });
      } else if (res.status === 429 || res.status >= 500) {
        return { ok: false, permanent: false, error: `storage_put_${res.status}` };
      } else {
        // A spent or expired signed URL, or the object is already there from a try whose answer
        // was lost: let `complete` decide, and start over if the file is not there.
        putRefused = true;
      }
    }

    try {
      const result = await withDeadline(API_DEADLINE_MS, signal, (s) =>
        deps.routes.completeUpload(current.code, current.uploadId!, s),
      );
      await save({ putDone: true });
      if (current.answerTo) await answerWith(current, deps, signal);
      if (current.fixTo) await correctWith(current, deps, signal);
      return { ok: true, result };
    } catch (err) {
      const code = apiErrorCode(err);
      if (code && START_OVER.has(code)) {
        await save({ uploadId: null, signedUrl: null, putDone: false });
        return { ok: false, permanent: false, error: code };
      }
      if (putRefused && !code && !isAbort(err)) {
        await save({ uploadId: null, signedUrl: null, putDone: false });
      }
      return failure(err);
    }
  } catch (err) {
    return failure(err);
  }
}
