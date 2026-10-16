import type { Transcriber, TranscriptionRequest } from './transcriber';
import { loadVoiceFixtures, type VoiceFixture } from './voice-fixtures';

/**
 * The fake transcriber (W1-11): no network, no key. It answers with the expected transcript of a
 * fixtures/voice note: the one a fake audio file names (`fakeAudio(id, s)`, the integration
 * harness's bytes), else the first fixture of the request's purpose (a report's voice note, a
 * spoken answer, the Welcome test; W2-09, W2-13) in the requested language (`tr`, `multi`, `en`),
 * so any real recording (the CI field flow's Chromium microphone) gets a transcript of its kind in
 * its reporter's language. Used by the tests, keyless development and the CI worker (TRANSCRIBE_PROVIDER=fake).
 */

const FAKE_AUDIO_KEY = 'sitelog-fake-audio';

/** The bytes a fake voice note carries: which fixture it is and how long it lasts. */
export function fakeAudio(fixtureId: string, durationS: number): Buffer {
  return Buffer.from(JSON.stringify({ [FAKE_AUDIO_KEY]: fixtureId, durationS }));
}

export function readFakeAudio(buf: Buffer): { fixtureId: string; durationS: number } | null {
  if (buf.length > 4096 || buf[0] !== 0x7b) return null;
  try {
    const v = JSON.parse(buf.toString('utf8')) as Record<string, unknown>;
    if (typeof v[FAKE_AUDIO_KEY] !== 'string') return null;
    return { fixtureId: v[FAKE_AUDIO_KEY] as string, durationS: Number(v.durationS) || 1 };
  } catch {
    return null;
  }
}

export interface FakeTranscriberCall {
  fixtureId: string;
  language: TranscriptionRequest['language'];
  keyterms: string[];
  mime: string;
}

export function createFakeTranscriber(
  fixtures: () => VoiceFixture[] = () => loadVoiceFixtures(),
): Transcriber & { calls: FakeTranscriberCall[] } {
  const calls: FakeTranscriberCall[] = [];
  return {
    provider: 'fake',
    model: 'fake',
    calls,
    async transcribe(req) {
      req.signal?.throwIfAborted();
      const all = fixtures();
      const marker = readFakeAudio(req.audio);
      const kind = all.filter((f) => f.kind === (req.purpose ?? 'report'));
      const fixture =
        (marker && all.find((f) => f.id === marker.fixtureId)) ||
        kind.find((f) => f.transcriptionLanguage === req.language) ||
        kind[0] ||
        all[0];
      if (!fixture) throw new Error('fake transcriber: fixtures/voice is empty');
      calls.push({
        fixtureId: fixture.id,
        language: req.language,
        keyterms: req.keyterms,
        mime: req.mime,
      });
      return {
        text: fixture.text,
        language: fixture.expectedLanguage,
        segments: fixture.segments.map((s) => ({ ...s })),
        durationS: req.durationS || marker?.durationS || fixture.durationS,
        model: 'fake',
        provider: 'fake',
        estCostUsd: 0,
      };
    },
  };
}
