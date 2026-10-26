import { describe, expect, it, vi } from 'vitest';
import {
  pickRecorderMime,
  RECORDER_MIME_CANDIDATES,
  recorderSupported,
  uploadMimeFor,
} from './mime';

describe('recorder mime detection (§9.3)', () => {
  it('prefers WebM/Opus (Chrome, Android), then audio/mp4 (iOS Safari)', () => {
    expect(RECORDER_MIME_CANDIDATES[0]).toBe('audio/webm;codecs=opus');
    const chrome = (m: string) => m.startsWith('audio/webm');
    expect(pickRecorderMime(chrome)).toBe('audio/webm;codecs=opus');
    const safari = (m: string) => m === 'audio/mp4';
    expect(pickRecorderMime(safari)).toBe('audio/mp4');
    const firefoxOgg = (m: string) => m === 'audio/ogg;codecs=opus';
    expect(pickRecorderMime(firefoxOgg)).toBe('audio/ogg;codecs=opus');
  });

  it('returns null without MediaRecorder or without a type field-api stores', () => {
    expect(pickRecorderMime(null)).toBeNull();
    expect(pickRecorderMime(() => false)).toBeNull();
    // A browser that only offers a container field-api does not keep (nothing in the list).
    expect(pickRecorderMime((m) => m === 'audio/x-weird')).toBeNull();
  });

  it('treats a throwing isTypeSupported as unsupported for that candidate', () => {
    const flaky = vi.fn((m: string) => {
      if (m === 'audio/webm;codecs=opus') throw new TypeError('nope');
      return m === 'audio/mp4';
    });
    expect(pickRecorderMime(flaky)).toBe('audio/mp4');
  });

  it('reads the browser’s own MediaRecorder when none is given', () => {
    vi.stubGlobal('MediaRecorder', { isTypeSupported: (m: string) => m === 'audio/webm' });
    expect(pickRecorderMime()).toBe('audio/webm');
    vi.stubGlobal('MediaRecorder', undefined);
    expect(pickRecorderMime()).toBeNull();
    vi.unstubAllGlobals();
  });

  it('names the upload after the recorder’s real type when it is one field-api keeps', () => {
    expect(uploadMimeFor('audio/mp4', 'audio/webm;codecs=opus')).toBe('audio/mp4');
    expect(uploadMimeFor('audio/webm;codecs=opus', 'audio/webm')).toBe('audio/webm;codecs=opus');
    expect(uploadMimeFor('', 'audio/mp4')).toBe('audio/mp4');
    expect(uploadMimeFor(undefined, 'audio/mp4')).toBe('audio/mp4');
    expect(uploadMimeFor('video/webm', 'audio/webm')).toBe('audio/webm');
  });

  it('knows when the recorder can run at all', () => {
    expect(
      recorderSupported({
        MediaRecorder: class {},
        navigator: { mediaDevices: { getUserMedia: () => Promise.resolve() } },
      }),
    ).toBe(true);
    expect(recorderSupported({ navigator: { mediaDevices: { getUserMedia: () => 0 } } })).toBe(
      false,
    );
    expect(recorderSupported({ MediaRecorder: class {}, navigator: {} })).toBe(false);
    expect(recorderSupported({})).toBe(false);
  });
});
