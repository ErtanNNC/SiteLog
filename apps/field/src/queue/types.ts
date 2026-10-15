import type { CompleteResponse } from '@sitelog/shared/field-contract.ts';
import type { UploadKind } from '@sitelog/shared/enums.ts';

/**
 * The upload queue (F5 step 3, W1-09): every clip and photo goes into IndexedDB first, then to
 * Storage by signed URL, then `complete`. Nothing is dropped: a clip stays queued through
 * reloads and lost signal until field-api takes it, or until the reporter removes one field-api
 * refused for good. A recording is saved while it is made (a draft, chunk by chunk), so a page the
 * phone kills mid-recording still sends what was said at the next start.
 */

export type QueuedStatus =
  /** A photo taken during a recording: kept until its clip goes (`release`), or the next start. */
  | 'held'
  /** Waiting for its turn, or for `nextAt` after a failure. */
  | 'queued'
  /** Being sent right now. */
  | 'uploading'
  /** Completed: `result` holds the report. */
  | 'done'
  /** Refused (`error`): see `failedKind` for what can still send it. */
  | 'failed';

export interface QueuedUpload {
  /** The queue's own id (a UUID); `uploadId` is field-api's. */
  id: string;
  /** The link code the upload goes with (`X-Link-Code`). */
  code: string;
  kind: UploadKind;
  /** The media type as the recorder named it (parameters kept; field-api stores the base type). */
  mime: string;
  /**
   * The file while this page holds it. Null for an item loaded from the store (read from there
   * when it is sent: the store keeps each file once, apart from the row) and once it is sent.
   */
  blob: Blob | null;
  bytes: number;
  siteId: string;
  /** The report date (`YYYY-MM-DD`), one of Today's `allowedDates`. */
  date: string;
  /** When recording started (`uploads.recorded_at`), ISO; null for a picked file. */
  recordedAt: string | null;
  /** Epoch ms. */
  createdAt: number;
  status: QueuedStatus;
  /** Failed tries so far. */
  attempts: number;
  /** Epoch ms before which it is not tried again. */
  nextAt: number;
  /** field-api's upload row and its signed URL, once created (reused on retry). */
  uploadId: string | null;
  signedUrl: string | null;
  /** The file reached Storage: the next try skips the PUT. */
  putDone: boolean;
  /**
   * The last failure: a field-api error code, or `network`, `timeout`, `storage_put_<status>`,
   * `http_<status>`, `internal`, `file_missing`.
   */
  error: string | null;
  result: CompleteResponse | null;
  /** The Recording screen holding this photo until its clip goes; null otherwise. */
  holdId: string | null;
  /** When it was sent (epoch ms): the stored row stays a while without its file, for other tabs. */
  doneAt: number | null;
  /** False when the phone's storage refused it: it lives in this page only (and is still sent). */
  persisted: boolean;
}

/** A queued item as the store keeps it: everything but the file and the page's own flags. */
export type StoredUpload = Omit<QueuedUpload, 'blob' | 'persisted'>;

/** The row of an item, for the store. */
export function storedUpload(item: QueuedUpload): StoredUpload {
  const { blob: _blob, persisted: _persisted, ...row } = item;
  return row;
}

/**
 * Refusals a new pass through the link clears (a phone verified again, consent given again, a
 * newer link): once `/r/:code` reaches Today, the items refused with them go again under that
 * link's code (`UploadQueue.relink`).
 */
export const RELINK_ERRORS = [
  'device_unverified',
  'consent_required',
  'link_expired',
  'link_revoked',
  'link_not_found',
] as const;

/**
 * Refusals nothing can change: the reporter can only remove the item, and nothing is removed
 * without that tap. `removed` is `waitFor`'s answer for an item gone from the queue.
 */
export const FINAL_ERRORS = [
  'report_filed',
  'day_closed',
  'date_not_allowed',
  'upload_too_large',
  'media_type_not_allowed',
  'kind_not_allowed',
  'invalid_request',
  'file_missing',
  'removed',
] as const;

/**
 * What can still send a refused item: `relink`, the link flow (automatic); `final`, nothing (Remove
 * only); `retry`, a tap once the office has acted (a paused reporter or site, anything else).
 */
export type FailedKind = 'relink' | 'final' | 'retry';

export function failedKind(error: string | null): FailedKind {
  if ((RELINK_ERRORS as readonly string[]).includes(error ?? '')) return 'relink';
  if ((FINAL_ERRORS as readonly string[]).includes(error ?? '')) return 'final';
  return 'retry';
}

/** What a screen hands the queue. */
export interface NewUpload {
  code: string;
  kind: UploadKind;
  mime: string;
  blob: Blob;
  siteId: string;
  date: string;
  recordedAt: string | null;
}

/** A recording being made (F5 step 2), saved chunk by chunk until its clip is queued. */
export interface Draft {
  id: string;
  code: string;
  siteId: string;
  date: string;
  /** The recorder's media type, once it runs. */
  mime: string | null;
  /** When recording started (ISO), once it runs. */
  startedAt: string | null;
  /** Epoch ms. */
  createdAt: number;
}

/** One `dataavailable` chunk of a draft, in order. */
export interface DraftChunk {
  draftId: string;
  seq: number;
  blob: Blob;
  /** Recording time when the chunk came (pauses excluded): the last one is the clip's length. */
  elapsedMs: number;
}

/** Where queued items and drafts live between tries and reloads. */
export interface QueueStore {
  /** Every item's row (no files). */
  list(): Promise<StoredUpload[]>;
  get(id: string): Promise<StoredUpload | undefined>;
  /** A new item and its file, in one write; with `draftId`, that draft goes in the same write. */
  add(item: StoredUpload, blob: Blob, opts?: { draftId?: string }): Promise<void>;
  /** An item's state, never its file; `dropFile` deletes the file in the same write (sent). */
  put(item: StoredUpload, opts?: { dropFile?: boolean }): Promise<void>;
  /** An item's file. */
  file(id: string): Promise<Blob | undefined>;
  /** An item and its file. */
  delete(id: string): Promise<void>;
  putDraft(draft: Draft): Promise<void>;
  addChunk(chunk: DraftChunk): Promise<void>;
  listDrafts(): Promise<Draft[]>;
  /** A draft's chunks, in order. */
  draftChunks(draftId: string): Promise<DraftChunk[]>;
  /** A draft and its chunks. */
  deleteDraft(draftId: string): Promise<void>;
}
