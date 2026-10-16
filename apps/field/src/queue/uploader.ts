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
  routes: Pick<FieldRoutes, 'createUpload' | 'completeUpload'>;
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
            // F9: a photo for a filed report goes in that report's site and day.
            ...(current.addTo
              ? { addTo: current.addTo }
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
