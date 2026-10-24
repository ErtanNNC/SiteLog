import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import {
  createRecorder,
  type Recorder,
  type RecorderDeps,
  type RecorderState,
} from '@/recorder/recorder';
import { createWakeLock, type WakeLock } from '@/recorder/wakeLock';

/**
 * One recorder for the screen's life, with its state as React sees it. `onChunk` gets each chunk
 * as it comes (the latest callback is used). The screen decides what happens to a recording when
 * it goes away (the Recording screen keeps the clip), so this hook never disposes it by itself.
 */
export function useRecorder(
  deps?: RecorderDeps,
  onChunk?: (chunk: Blob, elapsedMs: number) => void,
): { recorder: Recorder; state: RecorderState } {
  const [recorder] = useState(() => createRecorder(deps));
  // Before the screen's own effects (they start recording), and the latest one every render.
  useEffect(() => {
    recorder.setOnChunk(onChunk ?? null);
  });
  const subscribe = useCallback((l: () => void) => recorder.subscribe(l), [recorder]);
  const state = useSyncExternalStore(subscribe, recorder.getState, recorder.getState);
  return { recorder, state };
}

/** The screen lock while `wanted` (spec §9.3); `held` says whether the screen really stays on. */
export function useWakeLock(wanted: boolean, lock?: WakeLock): boolean {
  const [wake] = useState(() => lock ?? createWakeLock());
  const [held, setHeld] = useState(wake.held);
  useEffect(() => wake.onChange(setHeld), [wake]);
  useEffect(() => {
    if (wanted) void wake.acquire().then((ok) => setHeld(ok || wake.held));
    else void wake.release().then(() => setHeld(false));
  }, [wanted, wake]);
  useEffect(() => () => void wake.release(), [wake]);
  return held;
}
