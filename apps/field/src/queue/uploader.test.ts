import { afterEach, describe, expect, it, vi } from 'vitest';
import { FieldApiError } from '@/api/client';
import {
  API_DEADLINE_MS,
  putDeadlineMs,
  uploadItem,
  type Persist,
  type SendableUpload,
} from './uploader';
import type { QueuedUpload } from './types';

function item(patch: Partial<SendableUpload> = {}): SendableUpload {
  return {
    id: 'q1',
    code: 'K7Q2MX',
    kind: 'audio',
    mime: 'audio/webm;codecs=opus',
    blob: new Blob(['abc'], { type: 'audio/webm' }),
    bytes: 3,
    siteId: 'site-1',
    date: '2026-10-09',
    recordedAt: '2026-10-09T20:00:00.000Z',
    createdAt: 1,
    status: 'uploading',
    attempts: 0,
    nextAt: 0,
    uploadId: null,
    signedUrl: null,
    putDone: false,
    error: null,
    result: null,
    holdId: null,
    doneAt: null,
    persisted: true,
    ...patch,
  };
}

const created = {
  uploadId: 'u1',
  bucket: 'audio' as const,
  path: 'o/s/2026-10-09/u1.webm',
  signedUrl: 'https://p/storage/v1/object/upload/sign/audio/o/s/2026-10-09/u1.webm?token=t',
  token: 't',
};
const completed = {
  reportId: 'r1',
  reportNo: 'RL-2041-0188',
  reportStatus: 'processing' as const,
  created: true,
  alreadyComplete: false,
};

function apiError(status: number, error: string, extra: Record<string, unknown> = {}) {
  return new FieldApiError(status, 'uploads', { error, ...extra });
}

function harness() {
  const routes = {
    createUpload: vi.fn(async (_code: string, _body: unknown, _signal?: AbortSignal) => created),
    completeUpload: vi.fn(
      async (_code: string, _uploadId: string, _signal?: AbortSignal) => completed,
    ),
  };
  const put = vi.fn(async (_url: string, _blob: Blob, _mime: string, _signal: AbortSignal) => ({
    status: 200,
  }));
  const patches: Partial<QueuedUpload>[] = [];
  const persist: Persist = async (patch) => {
    patches.push(patch);
  };
  return { routes, put, patches, persist };
}

describe('uploadItem (F5 step 3)', () => {
  afterEach(() => vi.useRealTimers());

  it('creates the upload, PUTs the file with its base type, completes, persisting each step', async () => {
    const h = harness();
    const out = await uploadItem(item(), { routes: h.routes, put: h.put }, h.persist);
    expect(out).toEqual({ ok: true, result: completed });
    expect(h.routes.createUpload).toHaveBeenCalledWith(
      'K7Q2MX',
      {
        kind: 'audio',
        mime: 'audio/webm;codecs=opus',
        bytes: 3,
        siteId: 'site-1',
        date: '2026-10-09',
        recordedAt: '2026-10-09T20:00:00.000Z',
      },
      expect.any(AbortSignal),
    );
    expect(h.put).toHaveBeenCalledWith(
      created.signedUrl,
      expect.any(Blob),
      'audio/webm',
      expect.any(AbortSignal),
    );
    expect(h.routes.completeUpload).toHaveBeenCalledWith('K7Q2MX', 'u1', expect.any(AbortSignal));
    expect(h.patches).toEqual([
      { uploadId: 'u1', signedUrl: created.signedUrl, putDone: false },
      { putDone: true },
      { putDone: true },
    ]);
  });

  it('sends a photo for a filed report with its batch instead of a site and day (F9)', async () => {
    const h = harness();
    const addTo = { reportId: 'r1', batchId: 'b1', photos: 2, caption: false };
    await uploadItem(
      item({ kind: 'photo', mime: 'image/jpeg', recordedAt: null, addTo }),
      { routes: h.routes, put: h.put },
      h.persist,
    );
    expect(h.routes.createUpload).toHaveBeenCalledWith(
      'K7Q2MX',
      { kind: 'photo', mime: 'image/jpeg', bytes: 3, addTo },
      expect.any(AbortSignal),
    );
  });

  it('treats a closed photo window and the photo limit as final (F9)', async () => {
    for (const error of ['photos_window_closed', 'photo_limit']) {
      const h = harness();
      h.routes.completeUpload.mockRejectedValueOnce(apiError(409, error));
      const out = await uploadItem(item(), { routes: h.routes, put: h.put }, h.persist);
      expect(out).toEqual({ ok: false, permanent: true, error });
    }
  });

  it('resumes a try cut off after the PUT: no new upload row, no second PUT', async () => {
    const h = harness();
    const out = await uploadItem(
      item({ uploadId: 'u1', signedUrl: created.signedUrl, putDone: true }),
      { routes: h.routes, put: h.put },
      h.persist,
    );
    expect(out.ok).toBe(true);
    expect(h.routes.createUpload).not.toHaveBeenCalled();
    expect(h.put).not.toHaveBeenCalled();
    expect(h.routes.completeUpload).toHaveBeenCalledOnce();
  });

  it('is a retry (not permanent) with no signal, and keeps the signed URL for the next try', async () => {
    const h = harness();
    h.put.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const out = await uploadItem(item(), { routes: h.routes, put: h.put }, h.persist);
    expect(out).toEqual({ ok: false, permanent: false, error: 'network' });
    expect(h.patches[0]).toMatchObject({ uploadId: 'u1', putDone: false });
    // A field-api call that never got through (fetch rejected) is the same.
    const h2 = harness();
    h2.routes.createUpload.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    expect(await uploadItem(item(), { routes: h2.routes, put: h2.put }, h2.persist)).toEqual({
      ok: false,
      permanent: false,
      error: 'network',
    });
  });

  it('retries Storage 5xx and 429, and starts over when the row or object is gone', async () => {
    const h = harness();
    h.put.mockResolvedValueOnce({ status: 503 });
    expect(await uploadItem(item(), { routes: h.routes, put: h.put }, h.persist)).toEqual({
      ok: false,
      permanent: false,
      error: 'storage_put_503',
    });
    const h2 = harness();
    h2.routes.completeUpload.mockRejectedValueOnce(apiError(409, 'upload_missing'));
    const out = await uploadItem(
      item({ uploadId: 'u1', signedUrl: created.signedUrl, putDone: true }),
      { routes: h2.routes, put: h2.put },
      h2.persist,
    );
    expect(out).toEqual({ ok: false, permanent: false, error: 'upload_missing' });
    expect(h2.patches.at(-1)).toEqual({ uploadId: null, signedUrl: null, putDone: false });
  });

  it('marks field-api refusals that no retry can change as permanent', async () => {
    for (const code of ['report_filed', 'day_closed', 'upload_too_large', 'consent_required']) {
      const h = harness();
      h.routes.completeUpload.mockRejectedValueOnce(apiError(409, code));
      expect(await uploadItem(item(), { routes: h.routes, put: h.put }, h.persist)).toEqual({
        ok: false,
        permanent: true,
        error: code,
      });
    }
    const h = harness();
    h.routes.createUpload.mockRejectedValueOnce(apiError(400, 'date_not_allowed'));
    expect((await uploadItem(item(), { routes: h.routes, put: h.put }, h.persist)).ok).toBe(false);
  });

  it('passes a rate limit wait on, and treats other statuses as retries', async () => {
    const h = harness();
    h.routes.createUpload.mockRejectedValueOnce(apiError(429, 'rate_limited', { retryAfter: 42 }));
    expect(await uploadItem(item(), { routes: h.routes, put: h.put }, h.persist)).toEqual({
      ok: false,
      permanent: false,
      error: 'rate_limited',
      retryAfterMs: 42_000,
    });
    const h2 = harness();
    h2.routes.createUpload.mockRejectedValueOnce(new FieldApiError(502, 'uploads', 'Bad gateway'));
    expect(await uploadItem(item(), { routes: h2.routes, put: h2.put }, h2.persist)).toEqual({
      ok: false,
      permanent: false,
      error: 'http_502',
    });
  });

  it('lets complete decide after a refused PUT (a spent signed URL whose object is there)', async () => {
    const h = harness();
    h.put.mockResolvedValueOnce({ status: 400 });
    expect(
      await uploadItem(
        item({ uploadId: 'u1', signedUrl: created.signedUrl }),
        { routes: h.routes, put: h.put },
        h.persist,
      ),
    ).toEqual({ ok: true, result: completed });
  });

  it('gives up on a PUT that hangs on a stalled connection, as a retry', async () => {
    vi.useFakeTimers();
    const h = harness();
    // fetch on a dead link: never answers, and ignores the abort.
    h.put.mockImplementation(() => new Promise<never>(() => undefined));
    const blob = new Blob([new Uint8Array(250_000)]);
    const out = uploadItem(
      item({ blob, bytes: blob.size }),
      { routes: h.routes, put: h.put },
      h.persist,
    );
    await vi.advanceTimersByTimeAsync(putDeadlineMs(blob.size) - 1);
    let settled = false;
    void out.then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await out).toEqual({ ok: false, permanent: false, error: 'timeout' });
    expect(putDeadlineMs(blob.size)).toBe(70_000);
    // The signal handed to fetch was aborted too.
    expect(h.put.mock.calls[0]![3].aborted).toBe(true);
  });

  it('gives up on a field-api call that hangs, keeping what the try had done', async () => {
    vi.useFakeTimers();
    const h = harness();
    h.routes.completeUpload.mockImplementation(() => new Promise<never>(() => undefined));
    const out = uploadItem(item(), { routes: h.routes, put: h.put }, h.persist);
    await vi.advanceTimersByTimeAsync(API_DEADLINE_MS);
    expect(await out).toEqual({ ok: false, permanent: false, error: 'timeout' });
    // The file reached Storage: the next try only completes.
    expect(h.patches).toContainEqual({ putDone: true });
    expect(h.patches.at(-1)).toEqual({ putDone: true });
  });

  it('stops at once when the queue aborts the try', async () => {
    const h = harness();
    h.routes.createUpload.mockImplementation(() => new Promise<never>(() => undefined));
    const controller = new AbortController();
    const out = uploadItem(item(), { routes: h.routes, put: h.put }, h.persist, controller.signal);
    controller.abort();
    expect(await out).toEqual({ ok: false, permanent: false, error: 'timeout' });
  });
});
