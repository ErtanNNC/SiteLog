import { existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  DEMO_CALL_AUDIO_SITES,
  demoCallAudioPath,
  demoCallPeaks,
  type DemoCallSegment,
} from '@sitelog/shared/demo/calls.ts';
import { DEMO_AUDIO_RATE, synthCallPcm } from './demo-call-audio.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const SEGMENTS: DemoCallSegment[] = [
  { start: 0, end: 1, speaker: 'agent', text: 'Hi.' },
  { start: 1.5, end: 3, speaker: 'reporter', text: 'Five guys.' },
];

/** Mean absolute level of one channel between two seconds. */
function level(pcm: Int16Array, channel: 0 | 1, from: number, to: number): number {
  let sum = 0;
  let n = 0;
  for (let i = Math.floor(from * DEMO_AUDIO_RATE); i < Math.floor(to * DEMO_AUDIO_RATE); i++) {
    sum += Math.abs(pcm[i * 2 + channel]!);
    n++;
  }
  return sum / n;
}

describe('demo call recordings (W3-05)', () => {
  it('puts the site manager on the left channel and the assistant on the right, silence between', () => {
    const pcm = synthCallPcm(SEGMENTS, 4);
    expect(pcm).toHaveLength(4 * DEMO_AUDIO_RATE * 2);
    expect(level(pcm, 1, 0.1, 0.9)).toBeGreaterThan(1000);
    expect(level(pcm, 0, 0.1, 0.9)).toBe(0);
    expect(level(pcm, 0, 1.6, 2.9)).toBeGreaterThan(1000);
    expect(level(pcm, 1, 1.6, 2.9)).toBe(0);
    expect(level(pcm, 0, 3.1, 3.9) + level(pcm, 1, 3.1, 3.9)).toBe(0);
  });

  it('draws the same layout as the lanes’ peaks', () => {
    const peaks = demoCallPeaks(SEGMENTS, 4, 'test', 8);
    // Bars of half a second: the assistant speaks in the first two, the reporter in bars 3–5.
    expect(peaks.agent.slice(0, 2).every((p) => p >= 0.35)).toBe(true);
    expect(peaks.reporter.slice(0, 2).every((p) => p < 0.1)).toBe(true);
    expect(peaks.reporter.slice(3, 6).every((p) => p >= 0.35)).toBe(true);
    expect(peaks.agent.slice(6).every((p) => p < 0.1)).toBe(true);
  });

  it('has a checked-in recording for every demo call that plays one', () => {
    for (const site of DEMO_CALL_AUDIO_SITES) {
      const file = join(root, 'apps', 'web', 'public', demoCallAudioPath(site));
      expect(existsSync(file), file).toBe(true);
      expect(statSync(file).size).toBeLessThan(600_000);
    }
  });
});
