import type { RecorderDeps } from '@/recorder/recorder';
import { fakeRecorderDeps } from '@/test/fakeMediaRecorder';

/** Recorder fakes for the screen tests (the engine's own tests build theirs inline). */
export function fakeMediaRecorderDepsFor(over: Partial<RecorderDeps> = {}) {
  return fakeRecorderDeps(over);
}
