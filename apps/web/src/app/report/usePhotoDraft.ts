/**
 * The photos of a report being typed (New report) or edited (Edit): the report's own photos,
 * which can be re-captioned, moved or removed, and files picked here. A pick is prepared
 * (lib/photos: upright, ≤ 2000 px, JPEG) as soon as it is chosen, one at a time so a phone never
 * holds more than one full-size decode, and uploaded when the report is saved, with its position
 * in the list (the PDF prints the first few).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  OFFICE_PHOTO_MAX,
  PHOTO_CAPTION_MAX,
  type OfficePhotoUpload,
} from '@sitelog/shared/report/photos.ts';
import type { PhotoV1 } from '@sitelog/shared/schemas/report.ts';
import { translate } from '@/i18n/useCopy';
import type { DataSource, UploadedPhoto } from '@/data/source';
import type { PhotoSourceInfo } from '@/data/types';
import {
  PhotoError,
  photoFileError,
  photoTakenAt,
  preparePhoto,
  unreadableMessage,
  type PreparedPhoto,
} from '@/lib/photos';
import { localId } from '@/lib/utils';

export interface DraftPhoto {
  key: string;
  /** A photo the report already has (its message id); null for one picked here. */
  messageId: string | null;
  /** Signed URL of a report photo, object URL of a prepared pick; null while preparing. */
  previewUrl: string | null;
  caption: string;
  takenAt: string | null;
  status: 'saved' | 'preparing' | 'ready';
}

/** A picked photo, prepared and ready to upload. */
export interface NewPhoto {
  key: string;
  caption: string;
  photo: PreparedPhoto;
  /** Its index in the list when settled: where the version shows it (p_photos position). */
  position: number;
}

export interface PhotoDraft {
  items: DraftPhoto[];
  /** Why picked files were not added (not an image, too large, unreadable, over the limit). */
  errors: string[];
  /** Photos were added, removed, re-captioned or reordered. */
  changed: boolean;
  /** At least one photo was picked (preparing or ready). */
  hasNew: boolean;
  add(files: FileList | readonly File[]): void;
  remove(key: string): void;
  /** Moves a photo one place earlier (-1) or later (+1). */
  move(key: string, delta: -1 | 1): void;
  setCaption(key: string, caption: string): void;
  dismissErrors(): void;
  /** Back to the report's photos, dropping every pick. */
  reset(photos?: readonly PhotoSourceInfo[] | null): void;
  /**
   * data.photos entries of the report's photos still listed, in order, with their captions; keyed
   * by the photo's message id (the v1 entry shape). The editor stores them in the edited version's
   * own shape with withPhotoEntries() (reportForm.ts).
   */
  kept(): PhotoV1[];
  /**
   * Waits for every pick to be prepared; null when one failed meanwhile (the picker says why).
   * Each pick comes with its position in the list.
   */
  settle(): Promise<NewPhoto[] | null>;
  /**
   * Uploads prepared picks for `siteId` in order and returns them as the RPC's p_photos (with
   * their positions). A pick already uploaded for that site (a save that failed after the
   * upload) is not sent again.
   */
  upload(
    source: Pick<DataSource, 'uploadReportPhoto'>,
    siteId: string,
    photos: readonly NewPhoto[],
    onProgress?: (i: number, n: number) => void,
  ): Promise<OfficePhotoUpload[]>;
}

/** One data.photos entry; the caption key is left out when there is none. */
export function photoEntry(
  messageId: string,
  caption: string | null | undefined,
  takenAt: string | null | undefined,
): PhotoV1 {
  const text = caption?.trim();
  return { messageId, ...(text ? { caption: text } : {}), takenAt: takenAt ?? '' };
}

/** data.photos as the viewed version shows it (the baseline an edit is compared with). */
export function reportPhotoEntries(
  photos: readonly PhotoSourceInfo[] | null | undefined,
): PhotoV1[] {
  return (photos ?? []).map((p) => photoEntry(p.messageId, p.caption, p.takenAt));
}

function fromReport(photos: readonly PhotoSourceInfo[] | null | undefined): DraftPhoto[] {
  return (photos ?? []).map((p) => ({
    key: `saved:${p.messageId}`,
    messageId: p.messageId,
    previewUrl: p.url,
    caption: p.caption ?? '',
    takenAt: p.takenAt,
    status: 'saved',
  }));
}

function keptOf(items: readonly DraftPhoto[]): PhotoV1[] {
  return items.flatMap((x) => (x.messageId ? [photoEntry(x.messageId, x.caption, x.takenAt)] : []));
}

export function usePhotoDraft(
  initial?: readonly PhotoSourceInfo[] | null,
  opts: { prepare?: (file: File) => Promise<PreparedPhoto> } = {},
): PhotoDraft {
  const [items, setItemsState] = useState<DraftPhoto[]>(() => fromReport(initial));
  const [base, setBase] = useState<PhotoV1[]>(() => reportPhotoEntries(initial));
  const [errors, setErrors] = useState<string[]>([]);
  // The list as the latest update left it (callbacks read it between renders).
  const itemsRef = useRef(items);
  const prepareRef = useRef(opts.prepare ?? preparePhoto);
  prepareRef.current = opts.prepare ?? preparePhoto;
  const files = useRef(new Map<string, File>());
  const prepared = useRef(new Map<string, PreparedPhoto>());
  const pending = useRef(new Map<string, Promise<void>>());
  const uploaded = useRef(new Map<string, UploadedPhoto & { siteId: string }>());
  const objectUrls = useRef(new Map<string, string>());
  const queue = useRef<Promise<void>>(Promise.resolve());
  const failures = useRef(0);
  const alive = useRef(true);

  const setItems = useCallback((fn: (xs: DraftPhoto[]) => DraftPhoto[]) => {
    itemsRef.current = fn(itemsRef.current);
    setItemsState(itemsRef.current);
  }, []);

  useEffect(() => {
    alive.current = true;
    const urls = objectUrls.current;
    return () => {
      alive.current = false;
      for (const url of urls.values()) URL.revokeObjectURL(url);
      urls.clear();
    };
  }, []);

  const enqueue = useCallback(
    (key: string) => {
      const run = queue.current.then(async () => {
        const file = files.current.get(key);
        if (!alive.current || !file) {
          pending.current.delete(key); // removed before its turn
          return;
        }
        try {
          const photo = await prepareRef.current(file);
          if (!alive.current || !files.current.has(key)) return;
          const url = URL.createObjectURL(photo.blob);
          objectUrls.current.set(key, url);
          prepared.current.set(key, photo);
          setItems((xs) =>
            xs.map((x) =>
              x.key === key
                ? { ...x, previewUrl: url, takenAt: photo.takenAt, status: 'ready' }
                : x,
            ),
          );
        } catch (err) {
          if (!alive.current || !files.current.has(key)) return;
          files.current.delete(key);
          failures.current += 1;
          setItems((xs) => xs.filter((x) => x.key !== key));
          setErrors((e) => [
            ...e,
            err instanceof PhotoError ? err.message : unreadableMessage(file),
          ]);
        } finally {
          pending.current.delete(key);
        }
      });
      pending.current.set(key, run);
      queue.current = run;
    },
    [setItems],
  );

  const add = useCallback(
    (list: FileList | readonly File[]) => {
      const picked = Array.from(list);
      const errs: string[] = [];
      let room = OFFICE_PHOTO_MAX - itemsRef.current.length;
      let skipped = 0;
      const fresh: DraftPhoto[] = [];
      for (const file of picked) {
        const error = photoFileError(file);
        if (error) {
          errs.push(error);
          continue;
        }
        if (room <= 0) {
          skipped += 1;
          continue;
        }
        room -= 1;
        const key = localId('photo');
        files.current.set(key, file);
        fresh.push({
          key,
          messageId: null,
          previewUrl: null,
          caption: '',
          takenAt: photoTakenAt(file),
          status: 'preparing',
        });
      }
      if (skipped)
        errs.push(
          translate('report.editMode.photos.limit', { count: skipped, max: OFFICE_PHOTO_MAX }),
        );
      setErrors(errs);
      if (!fresh.length) return;
      setItems((xs) => [...xs, ...fresh]);
      for (const x of fresh) enqueue(x.key);
    },
    [enqueue, setItems],
  );

  const remove = useCallback(
    (key: string) => {
      files.current.delete(key);
      prepared.current.delete(key);
      uploaded.current.delete(key);
      const url = objectUrls.current.get(key);
      if (url) {
        URL.revokeObjectURL(url);
        objectUrls.current.delete(key);
      }
      setItems((xs) => xs.filter((x) => x.key !== key));
    },
    [setItems],
  );

  const move = useCallback(
    (key: string, delta: -1 | 1) =>
      setItems((xs) => {
        const i = xs.findIndex((x) => x.key === key);
        const j = i + delta;
        if (i < 0 || j < 0 || j >= xs.length) return xs;
        const next = [...xs];
        [next[i], next[j]] = [next[j]!, next[i]!];
        return next;
      }),
    [setItems],
  );

  const setCaption = useCallback(
    (key: string, caption: string) =>
      setItems((xs) =>
        xs.map((x) => (x.key === key ? { ...x, caption: caption.slice(0, PHOTO_CAPTION_MAX) } : x)),
      ),
    [setItems],
  );

  const reset = useCallback(
    (photos?: readonly PhotoSourceInfo[] | null) => {
      for (const url of objectUrls.current.values()) URL.revokeObjectURL(url);
      objectUrls.current.clear();
      files.current.clear();
      prepared.current.clear();
      uploaded.current.clear();
      setItems(() => fromReport(photos));
      setBase(reportPhotoEntries(photos));
      setErrors([]);
    },
    [setItems],
  );

  const settle = useCallback(async (): Promise<NewPhoto[] | null> => {
    const before = failures.current;
    // Picks added while waiting are waited for too; a finished run never stays in the map.
    while (pending.current.size) {
      const batch = [...pending.current];
      await Promise.all(batch.map(([, run]) => run));
      for (const [key, run] of batch)
        if (pending.current.get(key) === run) pending.current.delete(key);
    }
    if (failures.current !== before) return null;
    return itemsRef.current.flatMap((x, position) => {
      const photo = x.messageId ? undefined : prepared.current.get(x.key);
      return photo ? [{ key: x.key, caption: x.caption, photo, position }] : [];
    });
  }, []);

  const upload = useCallback<PhotoDraft['upload']>(async (source, siteId, photos, onProgress) => {
    const out: OfficePhotoUpload[] = [];
    for (const [i, p] of photos.entries()) {
      // The page is gone (the user left mid-save): upload no more.
      if (!alive.current) throw new Error('photo upload stopped');
      onProgress?.(i + 1, photos.length);
      let done = uploaded.current.get(p.key);
      if (!done || done.siteId !== siteId) {
        done = { ...(await source.uploadReportPhoto(siteId, p.photo.blob, p.photo.mime)), siteId };
        uploaded.current.set(p.key, done);
      }
      out.push({
        path: done.path,
        mime: done.mime,
        caption: p.caption.trim() || null,
        takenAt: p.photo.takenAt,
        position: p.position,
      });
    }
    return out;
  }, []);

  const hasNew = items.some((x) => x.messageId === null);
  const changed = useMemo(
    () => hasNew || JSON.stringify(keptOf(items)) !== JSON.stringify(base),
    [hasNew, items, base],
  );

  return {
    items,
    errors,
    changed,
    hasNew,
    add,
    remove,
    move,
    setCaption,
    dismissErrors: useCallback(() => setErrors([]), []),
    reset,
    kept: useCallback(() => keptOf(itemsRef.current), []),
    settle,
    upload,
  };
}
