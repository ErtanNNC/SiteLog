import { draftLockName, type LockManagerLike } from './locks';
import type { Draft, QueueStore } from './types';

/**
 * The recording being made, saved as it is recorded (F5 step 2): each `dataavailable` chunk goes
 * to the store, so a page the phone kills (a low-memory Android behind the camera, iOS evicting a
 * Safari tab during a call) still sends what was said at the next start (`UploadQueue` recovers
 * drafts). Writes run one after another in order; a failed write is logged and the recording goes
 * on (the clip in memory is what Stop & send queues). While it records, the page holds the draft's
 * Web Lock, so another tab never recovers a draft that is still being made.
 */
export class DraftRecorder {
  readonly id: string;
  private chain: Promise<unknown>;
  private seq = 0;
  private sealed = false;
  private released = false;
  private releaseLock: (() => void) | null = null;
  private draft: Draft;

  constructor(
    private readonly store: Promise<QueueStore>,
    draft: Draft,
    locks: LockManagerLike | null,
  ) {
    this.id = draft.id;
    this.draft = draft;
    if (locks) {
      void locks
        .request(
          draftLockName(draft.id),
          {},
          () =>
            new Promise<void>((resolve) => {
              this.releaseLock = resolve;
              if (this.released) resolve();
            }),
        )
        .catch(() => undefined);
    }
    this.chain = Promise.resolve();
    this.write((s) => s.putDraft(this.draft));
  }

  /** The recorder's media type and start time, once it runs. */
  describe(patch: Pick<Draft, 'mime' | 'startedAt'>): void {
    if (this.sealed) return;
    if (patch.mime === this.draft.mime && patch.startedAt === this.draft.startedAt) return;
    this.draft = { ...this.draft, ...patch };
    const snapshot = this.draft;
    this.write((s) => s.putDraft(snapshot));
  }

  append(blob: Blob, elapsedMs: number): void {
    if (this.sealed || blob.size === 0) return;
    const seq = this.seq++;
    this.write((s) => s.addChunk({ draftId: this.id, seq, blob, elapsedMs }));
  }

  /** No more chunks; resolves once every write so far is done (the clip may be queued now). */
  async seal(): Promise<void> {
    this.sealed = true;
    await this.chain;
  }

  /**
   * Done with the draft: its clip was queued (the queue deleted the draft in the same write), or
   * there is nothing worth sending (`discard`: deleted here). Lets the lock go. Safe to call twice.
   */
  async close({ discard }: { discard: boolean }): Promise<void> {
    if (this.released) return;
    this.released = true;
    this.sealed = true;
    await this.chain;
    if (discard) {
      try {
        await (await this.store).deleteDraft(this.id);
      } catch (err) {
        console.warn('[field] could not drop a recording draft', err);
      }
    }
    this.releaseLock?.();
  }

  get closed(): boolean {
    return this.released;
  }

  private write(op: (store: QueueStore) => Promise<void>) {
    this.chain = this.chain
      .then(() => this.store)
      .then(op)
      .catch((err) => console.warn('[field] could not save the recording as it goes', err));
  }
}
