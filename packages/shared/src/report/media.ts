import type { ReportSourceKind } from '../db/types.ts';
import type { Source, SourceV1 } from '../schemas/report.ts';

/**
 * The media of a report during the move to `uploads` (W1-05 step 10, GAP D14, D20).
 *
 * - 20261014000002 gave every stored voice note and photo of a report an `uploads` row with the
 *   same UUID as its WhatsApp (or office) message, and re-keyed `report_sources`: `upload_id`, and
 *   the §6.2 `source_kind` labels (audio → voice_note, reply → answer or text).
 * - From then on, office photos are uploads only (a source with `upload_id`, no message); the
 *   WhatsApp worker keeps writing messages and the old kinds until step 22.
 *
 * So a reader takes a source's media from its upload when there is one and from its message
 * otherwise, matches both kind labels, and keys a photo or voice note by its media id (the
 * upload id, else the message id: one UUID). Stored report data uses the same id: `messageId` in
 * v1 data, `uploadId` in v2 (`readReportData` maps one to the other).
 */

/** A voice note: `voice_note` (§6.2), or `audio` as the WhatsApp worker still writes it. */
export function isVoiceSourceKind(kind: string): kind is 'voice_note' | 'audio' {
  return kind === 'voice_note' || kind === 'audio';
}

/** An answer: `answer` (§6.2), or the WhatsApp `reply` the migration did not re-key. */
export function isAnswerSourceKind(kind: string): kind is 'answer' | 'reply' {
  return kind === 'answer' || kind === 'reply';
}

/** The §6.2 label of a source kind as stored (audio → voice_note; a reply stays one). */
export function sourceKindV12(kind: ReportSourceKind): ReportSourceKind {
  return kind === 'audio' ? 'voice_note' : kind;
}

/** The media id of a report source: its upload, else its message (the same UUID when both). */
export function sourceMediaId(source: {
  upload_id?: string | null;
  message_id: string | null;
}): string | null {
  return source.upload_id ?? source.message_id ?? null;
}

/** The media id a transcript belongs to: its upload, else its WhatsApp voice note. */
export function transcriptMediaId(t: {
  upload_id?: string | null;
  message_id: string | null;
}): string | null {
  return t.upload_id ?? t.message_id ?? null;
}

/** The voice note a data source cites (v1 `audio.messageId`, v2 `voice_note.uploadId`), or null. */
export function voiceMediaIdOf(source: Source | SourceV1 | null | undefined): string | null {
  if (!source || typeof source !== 'object') return null;
  if (source.type === 'voice_note') return source.uploadId;
  if (source.type === 'audio') return source.messageId;
  return null;
}

/** The fields of a stored file the readers need, from an upload or a message. */
export interface MediaRef {
  /** Upload id, else message id. */
  id: string;
  storagePath: string | null;
  mime: string | null;
  durationS: number | null;
  /** Waveform peaks: uploads.peaks, or the WhatsApp message's payload.peaks. */
  peaks: number[] | null;
  /** When SiteLog received it. */
  receivedAt: string;
  /** The upload's caption, or the message body (a photo's WhatsApp caption). */
  text: string | null;
  /** The WhatsApp conversation of a message; null for an upload without one. */
  conversationId: string | null;
}

interface UploadLike {
  id: string;
  storage_path: string;
  /** Retention deleted the file (the row stays, so the source keeps its key). */
  purged_at?: string | null;
  mime: string | null;
  duration_s: number | null;
  peaks: unknown;
  received_at: string | null;
  recorded_at: string | null;
  caption: string | null;
}

interface MessageLike {
  id: string;
  storage_path: string | null;
  media_mime: string | null;
  duration_s: number | null;
  payload: unknown;
  created_at: string;
  body: string | null;
  conversation_id: string | null;
}

/** Waveform peaks: the numbers of a JSON array, else none. */
function peaksOf(value: unknown): number[] | null {
  return Array.isArray(value) ? value.filter((x): x is number => typeof x === 'number') : null;
}

/**
 * A source's file, with the upload first and the message as the fallback: the upload of
 * `upload_id` (or of `message_id`, the same UUID for backfilled media), else the message.
 * The message still supplies the conversation of a backfilled WhatsApp file. A file retention
 * deleted has `storagePath` null (`uploads.purged_at`, or a message's null `storage_path`).
 */
export function mediaOf(
  source: { upload_id?: string | null; message_id: string | null },
  uploads: ReadonlyMap<string, UploadLike>,
  messages: ReadonlyMap<string, MessageLike>,
): MediaRef | undefined {
  const id = sourceMediaId(source);
  const upload = id ? uploads.get(id) : undefined;
  const message = source.message_id ? messages.get(source.message_id) : undefined;
  if (upload) {
    return {
      id: upload.id,
      // A purged upload keeps the deleted object's name: no file, as a purged message.
      storagePath: upload.purged_at ? null : upload.storage_path,
      mime: upload.mime,
      durationS: upload.duration_s === null ? null : Number(upload.duration_s),
      peaks: peaksOf(upload.peaks),
      receivedAt: upload.received_at ?? upload.recorded_at ?? message?.created_at ?? '',
      text: upload.caption ?? message?.body ?? null,
      conversationId: message?.conversation_id ?? null,
    };
  }
  if (!message) return undefined;
  const payload =
    message.payload && typeof message.payload === 'object'
      ? (message.payload as Record<string, unknown>)
      : {};
  return {
    id: message.id,
    storagePath: message.storage_path,
    mime: message.media_mime,
    durationS: message.duration_s === null ? null : Number(message.duration_s),
    peaks: peaksOf(payload.peaks),
    receivedAt: message.created_at,
    text: message.body,
    conversationId: message.conversation_id,
  };
}
