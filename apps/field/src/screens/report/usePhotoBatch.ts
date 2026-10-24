import { useEffect, useState, type ChangeEvent } from 'react';
import type { ReportView } from '@sitelog/shared/field-contract.ts';
import { useQueue, useQueueSnapshot } from '@/queue/useQueue';
import { photoMime } from '@/recorder/photos';
import type { Clip } from '@/recorder/recorder';

/** A batch the reporter sent: its id and the version the report was at. */
interface SentBatch {
  id: string;
  fromVersion: number;
}

/**
 * F9's photo batch on a filed report (W2-04; shared with the photos link's photo-only screen,
 * W3-13): the photos picked (up to what the report still takes), then the batch through the upload
 * queue with an optional voice caption; once every upload of the batch is through, `onRefresh`
 * reads the report again, and `added` turns true when it has the next version.
 */
export function usePhotoBatch({
  code,
  view,
  onRefresh,
}: {
  code: string;
  view: ReportView | null;
  onRefresh: () => void;
}) {
  const queue = useQueue();
  const snapshot = useQueueSnapshot();
  const [picked, setPicked] = useState<{ files: File[]; dropped: number } | null>(null);
  const [sent, setSent] = useState<SentBatch | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);

  const batchItems = sent ? snapshot.items.filter((i) => i.addTo?.batchId === sent.id) : [];
  const batchDone = batchItems.length > 0 && batchItems.every((i) => i.status === 'done');
  const batchFailed = batchItems.find((i) => i.status === 'failed') ?? null;
  useEffect(() => {
    if (batchDone) onRefresh();
  }, [batchDone, onRefresh]);

  const added = sent !== null && view !== null && view.currentVersion > sent.fromVersion;
  const adding = sent !== null && !added && !batchFailed;

  function onPicked(e: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    e.target.value = '';
    const photos = view?.addPhotos;
    if (!photos || files.length === 0) return;
    const usable = files.filter((f) => photoMime(f) !== null);
    if (usable.length === 0) {
      setSendError('media_type_not_allowed');
      return;
    }
    setSendError(null);
    const kept = usable.slice(0, photos.remaining);
    setPicked({ files: kept, dropped: usable.length - kept.length });
  }

  async function send(caption: Clip | null) {
    if (!picked || !view) return;
    const batchId = crypto.randomUUID();
    const addTo = {
      reportId: view.id,
      batchId,
      photos: picked.files.length,
      caption: caption !== null,
    };
    const common = { code, siteId: view.siteId, date: view.date, addTo };
    setPicked(null);
    setSendError(null);
    try {
      for (const file of picked.files) {
        await queue.enqueue({
          ...common,
          kind: 'photo',
          mime: photoMime(file)!,
          blob: file,
          recordedAt: file.lastModified ? new Date(file.lastModified).toISOString() : null,
        });
      }
      if (caption) {
        await queue.enqueue({
          ...common,
          kind: 'audio',
          mime: caption.mime,
          blob: caption.blob,
          recordedAt: caption.startedAt,
        });
      }
      setSent({ id: batchId, fromVersion: view.currentVersion });
    } catch (err) {
      console.error('[field] could not queue the photos', err);
      setSendError('generic');
    }
  }

  return {
    picked,
    closeSheet: () => setPicked(null),
    onPicked,
    send,
    added,
    adding,
    /** A refused upload of the batch, else a refusal before it went (the type, the queue). */
    errorKey: batchFailed ? batchFailed.error : sendError,
  };
}
