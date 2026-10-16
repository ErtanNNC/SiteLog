import { JOB_MAX_ATTEMPTS, type TestClipRow } from '@sitelog/shared';
import { transcriptionLanguage } from '../ai/transcriber';
import type { Ctx } from '../context';
import { PermanentJobError, type JobHandler } from './types';

/**
 * F4's optional test recording (W2-13, spec §19 Q52): "Say anything — nothing gets filed." The
 * clip is outside any report and never a source (`test_clips`, not `uploads`; no transcript row).
 *
 * `transcribe_test_clip` (field_test_clip_complete(), `test_clip:<id>`): the file goes to the
 * configured transcriber in the reporter's language (§10.2; the fake answers with a fixtures/voice
 * test clip), the words are kept as the snippet (at most 160 characters) for the Welcome screen,
 * and the file is deleted at once. A clip that cannot be transcribed (no file, or the last attempt
 * failing) is marked failed and its file deleted: the screen says it could not hear it.
 *
 * `delete_test_clip` (field_test_clip_create(), `test_clip:<id>:delete`, 10 minutes on): the file
 * and the words go, read or not (the file is removed even when the row is already deleted). The
 * nightly retention job is the backstop (`expireTestClips`).
 */

export const TEST_SNIPPET_MAX = 160;

/** The words as the Welcome screen shows them: one line, at most 160 characters. */
export function testSnippet(text: string): string {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length <= TEST_SNIPPET_MAX ? one : `${one.slice(0, TEST_SNIPPET_MAX - 1).trimEnd()}…`;
}

export const transcribeTestClipJob: JobHandler<'transcribe_test_clip'> = async (
  ctx,
  payload,
  job,
) => {
  const clip = await ctx.db.getTestClip(payload.testClipId);
  if (!clip) throw new PermanentJobError(`test clip ${payload.testClipId} not found`);
  const log = ctx.log.child({ test_clip_id: clip.id });
  if (clip.deleted_at || clip.transcribed_at || clip.failed_at) {
    log.info('test clip already settled or deleted');
    return;
  }
  try {
    const reporter = await ctx.db.getReporter(clip.reporter_id);
    const audio = await ctx.storage.download('audio', clip.storage_path);
    ctx.signal.throwIfAborted();
    const result = await ctx.ai.transcriber.transcribe({
      audio,
      mime: clip.mime,
      language: transcriptionLanguage({
        locale: reporter?.locale ?? null,
        languages: reporter?.languages ?? [],
      }),
      // A test of the microphone: no site, so no vocabulary.
      keyterms: [],
      prompt: '',
      purpose: 'test',
      signal: ctx.signal,
    });
    const words = testSnippet(result.text);
    ctx.metrics.add({
      audioSeconds: result.durationS,
      estCostUsd: result.estCostUsd,
      transcribeProvider: result.provider,
    });
    await ctx.db.saveTestClipResult(clip.id, {
      heard: words.length > 0,
      snippet: words || null,
      provider: result.provider,
    });
    log.info('test clip transcribed', { heard: words.length > 0, provider: result.provider });
  } catch (err) {
    const last = err instanceof PermanentJobError || (job?.attempts ?? 1) >= JOB_MAX_ATTEMPTS;
    if (!last) throw err;
    log.warn('test clip not transcribed; the screen says so', { err });
    await ctx.db.saveTestClipResult(clip.id, { failed: true });
  }
  await removeFile(ctx, clip);
};

/**
 * The row is marked deleted if it is not yet, and the file is removed either way: a clip read
 * (field_test_clip_read() marks it deleted) after the worker failed to remove its file still has
 * one, and removing a file already gone is harmless.
 */
export const deleteTestClipJob: JobHandler<'delete_test_clip'> = async (ctx, payload) => {
  const deleted = await ctx.db.deleteTestClip(payload.testClipId, 'expired');
  const clip = deleted ?? (await ctx.db.getTestClip(payload.testClipId));
  if (clip) await removeFile(ctx, clip);
  ctx.log.info('test clip deleted', { test_clip_id: payload.testClipId, was_open: !!deleted });
};

/**
 * The retention backstop: test recordings older than 10 minutes still open are deleted, and the
 * file of every recent one is removed again (`listExpiredTestClips`), deleted or not, so a file
 * whose removal failed does not outlive its row. Returns how many rows it deleted.
 */
export async function expireTestClips(ctx: Ctx, before: Date, limit = 500): Promise<number> {
  let n = 0;
  for (const clip of await ctx.db.listExpiredTestClips(before, limit)) {
    const deleted = clip.deleted_at ? null : await ctx.db.deleteTestClip(clip.id, 'expired');
    await removeFile(ctx, clip);
    if (deleted) n++;
  }
  return n;
}

/** The file goes (a file already gone, or never uploaded, is fine). */
async function removeFile(ctx: Ctx, clip: Pick<TestClipRow, 'id' | 'storage_path'>) {
  try {
    await ctx.storage.remove('audio', [clip.storage_path]);
  } catch (err) {
    ctx.log.error('test clip file not removed', {
      err,
      test_clip_id: clip.id,
      path: clip.storage_path,
    });
  }
}
