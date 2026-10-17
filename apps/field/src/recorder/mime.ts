import { uploadMediaType } from '@sitelog/shared/field-contract.ts';

/**
 * Which container the phone's `MediaRecorder` writes (spec §9.3): `audio/webm;codecs=opus` on
 * Chrome and Android, `audio/mp4` (AAC) on iOS Safari; Firefox takes WebM too and Ogg as a last
 * resort. The first the browser says it supports wins. Every candidate's base type is one
 * field-api stores (`UPLOAD_MEDIA_TYPES`).
 */
export const RECORDER_MIME_CANDIDATES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/mp4',
  'audio/ogg;codecs=opus',
] as const;

export type RecorderMime = (typeof RECORDER_MIME_CANDIDATES)[number];

type IsTypeSupported = (mime: string) => boolean;

/** The browser's `MediaRecorder.isTypeSupported`, if there is one. */
function nativeIsTypeSupported(): IsTypeSupported | null {
  const Recorder = (globalThis as { MediaRecorder?: { isTypeSupported?: IsTypeSupported } })
    .MediaRecorder;
  return typeof Recorder?.isTypeSupported === 'function'
    ? (mime) => Recorder.isTypeSupported!(mime)
    : null;
}

/**
 * The first candidate the browser supports, or null when none is (no `MediaRecorder` at all, or
 * one that only writes something field-api does not store). A browser whose `isTypeSupported`
 * throws for a candidate (older Safari builds did) counts that candidate as unsupported.
 */
export function pickRecorderMime(
  isTypeSupported: IsTypeSupported | null = nativeIsTypeSupported(),
): RecorderMime | null {
  if (!isTypeSupported) return null;
  for (const mime of RECORDER_MIME_CANDIDATES) {
    let ok: boolean;
    try {
      ok = isTypeSupported(mime);
    } catch {
      ok = false;
    }
    if (ok && uploadMediaType(mime)) return mime;
  }
  return null;
}

/**
 * The media type to name an upload with: the recorder's own type when it reports one (Safari
 * says `audio/mp4`; Chrome `audio/webm;codecs=opus`), else the one it was asked for. Parameters
 * are kept; field-api drops them when it stores the base type.
 */
export function uploadMimeFor(recorderMime: string | undefined, requested: string): string {
  const candidate = recorderMime?.trim();
  return candidate && uploadMediaType(candidate) ? candidate : requested;
}

/** `getUserMedia` and `MediaRecorder` exist: the recorder can run (else the file-input fallback). */
export function recorderSupported(
  win: {
    MediaRecorder?: unknown;
    navigator?: { mediaDevices?: { getUserMedia?: unknown } };
  } = globalThis as never,
): boolean {
  return (
    typeof win.MediaRecorder === 'function' &&
    typeof win.navigator?.mediaDevices?.getUserMedia === 'function'
  );
}
