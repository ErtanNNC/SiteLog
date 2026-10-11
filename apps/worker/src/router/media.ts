import { audioStoragePath, photoStoragePath, type MessageRow } from '@sitelog/shared';
import type { Ctx } from '../context';
import { analyzeAudio, withTempDir, writeTemp } from '../media/ffmpeg';
import { mimeExtension, type Bucket } from '../storage';

/**
 * Download inbound media immediately (URLs are short-lived), store the original in the private
 * bucket, measure duration + waveform peaks for audio (§11.3 VoicePlayer) and remember everything
 * on the `messages` row. Idempotent: a message with storage_path is not downloaded again.
 */

export interface MediaLocation {
  orgId: string;
  siteId: string;
  /** Local date of arrival (storage path only; not the report date). */
  date: string;
}

export interface StoredMedia {
  storagePath: string;
  bucket: Bucket;
  durationS: number | null;
  peaks: number[] | null;
  mime: string | null;
}

export function storagePathFor(message: Pick<MessageRow, 'id' | 'type' | 'media_mime'>, loc: MediaLocation | { custom: string }): { bucket: Bucket; path: string } {
  const isAudio = message.type === 'audio';
  const ext = mimeExtension(message.media_mime, isAudio ? 'ogg' : 'jpg');
  if ('custom' in loc) return { bucket: isAudio ? 'audio' : 'photos', path: `${loc.custom}/${message.id}.${ext}` };
  return isAudio
    ? { bucket: 'audio', path: audioStoragePath(loc.orgId, loc.siteId, loc.date, message.id, ext) }
    : { bucket: 'photos', path: photoStoragePath(loc.orgId, loc.siteId, loc.date, message.id, ext) };
}

export async function ensureMediaStored(ctx: Ctx, message: MessageRow, loc: MediaLocation | { custom: string }): Promise<StoredMedia | null> {
  if (message.type !== 'audio' && message.type !== 'image' && message.type !== 'document') return null;
  const payload = (message.payload && typeof message.payload === 'object' && !Array.isArray(message.payload) ? message.payload : {}) as Record<string, unknown>;
  const { bucket, path } = storagePathFor(message, loc);
  if (message.storage_path) {
    return {
      storagePath: message.storage_path,
      bucket,
      durationS: message.duration_s,
      peaks: Array.isArray(payload.peaks) ? (payload.peaks as number[]) : null,
      mime: message.media_mime,
    };
  }
  if (!message.media_id) return null;
  const media = await ctx.wa.downloadMedia(message.media_id);
  const mime = media.mime ?? message.media_mime ?? (message.type === 'audio' ? 'audio/ogg' : 'image/jpeg');
  await ctx.storage.upload(bucket, path, media.buffer, mime);
  let durationS: number | null = null;
  let peaks: number[] | null = null;
  if (message.type === 'audio') {
    try {
      const analysis = await withTempDir(async (dir) => analyzeAudio(ctx.ffmpeg, await writeTemp(dir, `in.${mimeExtension(mime, 'ogg')}`, media.buffer)));
      durationS = analysis.durationS;
      peaks = analysis.peaks;
      ctx.metrics.add({ audioSeconds: durationS });
    } catch (err) {
      ctx.log.warn('audio analysis failed', { err, message_id: message.id });
    }
  }
  await ctx.db.updateMessage(message.id, {
    storage_path: path,
    duration_s: durationS,
    media_mime: mime,
    payload: { ...payload, ...(peaks ? { peaks } : {}), ...(durationS !== null ? { duration_s: durationS } : {}), sha256: media.sha256 ?? payload.sha256 ?? null },
  });
  message.storage_path = path;
  message.duration_s = durationS;
  message.media_mime = mime;
  return { storagePath: path, bucket, durationS, peaks, mime };
}

/** Load a stored original (audio) for transcription. */
export async function loadStoredAudio(ctx: Ctx, message: MessageRow): Promise<{ buffer: Buffer; ext: string } | null> {
  if (!message.storage_path) return null;
  const buffer = await ctx.storage.download('audio', message.storage_path);
  return { buffer, ext: message.storage_path.split('.').pop() ?? 'ogg' };
}
