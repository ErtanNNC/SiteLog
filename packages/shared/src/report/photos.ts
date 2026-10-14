import type { Photo } from '../schemas/report.ts';
import { sourceMediaId } from './media.ts';

/**
 * Photos of a report version (§10.3 `photos`, §12 "08 Site photos", site Photos tab).
 *
 * Every photo of a report is a `report_sources` row (kind 'photo') with its file in `uploads`
 * (office photos since 20261014000002, and every stored photo the migration backfilled with its
 * message's id) or, for a WhatsApp photo without an upload, in `messages` (report/media.ts). A
 * version shows the photos its `data.photos` lists, in that order: an office edit can remove a
 * photo or change its caption without touching the older versions.
 */

/** Office uploads: at most this many new photos per create_office_report / create_report_version call. */
export const OFFICE_PHOTO_MAX = 20;
export const OFFICE_PHOTO_MIMES = ['image/jpeg', 'image/png', 'image/webp'] as const;
export type OfficePhotoMime = (typeof OFFICE_PHOTO_MIMES)[number];
/** Longest caption the RPCs accept. */
export const PHOTO_CAPTION_MAX = 500;

const EXT: Record<OfficePhotoMime, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

export function isOfficePhotoMime(mime: string): mime is OfficePhotoMime {
  return (OFFICE_PHOTO_MIMES as readonly string[]).includes(mime);
}

/** Bucket `photos` path of an office upload: {org}/{site}/office/{uuid}.{jpg|png|webp}. */
export function officePhotoStoragePath(
  orgId: string,
  siteId: string,
  id: string,
  mime: OfficePhotoMime,
): string {
  return `${orgId}/${siteId}/office/${id.toLowerCase()}.${EXT[mime]}`;
}

/** One element of the RPCs' `p_photos` argument: a photo uploaded to `path` before the call. */
export interface OfficePhotoUpload {
  path: string;
  mime: OfficePhotoMime;
  caption?: string | null;
  /** ISO timestamp; when the photo was taken (defaults to the call time, never later). */
  takenAt?: string | null;
  /**
   * Index of the photo in the version's final list (0–1000), as the panel shows it; none: after
   * the photos the version keeps. See placeOfficePhotos().
   */
  position?: number | null;
}

/**
 * A version's data.photos from the entries it keeps (in order) and the new uploads' entries
 * (`added[i]` belongs to `uploads[i]`): an upload with a position is inserted at that index of
 * the final list, lowest first, so each lands where the panel showed it; one without follows at
 * the end, in upload order. Mirror of place_office_photos() (20261013000005_office_photos.sql).
 */
export function placeOfficePhotos<T>(
  kept: readonly T[],
  added: readonly T[],
  uploads: ReadonlyArray<Pick<OfficePhotoUpload, 'position'>>,
): T[] {
  const out = [...kept];
  const order = added
    .map((entry, i) => ({ entry, i, pos: uploads[i]?.position ?? null }))
    .sort(
      (x, y) =>
        Number(x.pos === null) - Number(y.pos === null) || (x.pos ?? 0) - (y.pos ?? 0) || x.i - y.i,
    );
  for (const { entry, pos } of order) {
    if (pos === null || pos >= out.length) out.push(entry);
    else out.splice(pos, 0, entry);
  }
  return out;
}

/** The report_sources fields the selection reads (plus whatever the caller joined to it). */
export interface PhotoSourceLike {
  message_id: string | null;
  upload_id?: string | null;
  kind: string;
  caption: string | null;
  taken_at: string | null;
}

export interface VersionPhoto<S extends PhotoSourceLike> {
  source: S;
  caption: string | null;
  takenAt: string | null;
}

/**
 * The photos one version shows, in order. With `data.photos` (every version written since the
 * schema has it): its entries mapped to the report's photo sources, first occurrence of each,
 * caption and time from the entry (an entry without a caption has none). Without it (legacy data):
 * every photo source of the report, as given, with its recorded caption and time. Entries whose
 * message is not a photo of the report are skipped.
 *
 * `photos` is the v2 list (report/upgrade.ts): an entry's `uploadId` (a v1 `messageId`, kept as
 * is by the upgrade) is matched against the source's media id, its `upload_id` or else its
 * `message_id` (one UUID for media the migration backfilled).
 */
export function versionPhotos<S extends PhotoSourceLike>(
  photos: ReadonlyArray<Pick<Photo, 'uploadId' | 'caption' | 'takenAt'>> | null | undefined,
  sources: readonly S[],
): Array<VersionPhoto<S>> {
  const photoSources = sources.filter((s) => s.kind === 'photo');
  if (!Array.isArray(photos)) {
    return photoSources.map((source) => ({
      source,
      caption: source.caption,
      takenAt: source.taken_at,
    }));
  }
  const byMedia = new Map(
    photoSources.flatMap((s) => {
      const id = sourceMediaId(s);
      return id ? [[id.toLowerCase(), s] as const] : [];
    }),
  );
  const seen = new Set<string>();
  const out: Array<VersionPhoto<S>> = [];
  for (const p of photos) {
    const key = typeof p?.uploadId === 'string' ? p.uploadId.toLowerCase() : '';
    const source = byMedia.get(key);
    if (!source || seen.has(key)) continue;
    seen.add(key);
    out.push({
      source,
      caption: typeof p.caption === 'string' && p.caption.trim() ? p.caption.trim() : null,
      takenAt: (typeof p.takenAt === 'string' && p.takenAt) || source.taken_at,
    });
  }
  return out;
}
