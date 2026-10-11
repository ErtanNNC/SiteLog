import { describe, expect, it } from 'vitest';
import {
  chunkArgs,
  chunkPlan,
  computePeaks,
  convertToMp3Args,
  decodePcmArgs,
  pcmDurationSeconds,
} from './ffmpeg';

describe('ffmpeg command building', () => {
  it('converts OGG to mono 16 kHz 32 kbps MP3 (§10.2)', () => {
    const args = convertToMp3Args('/tmp/in.ogg', '/tmp/out.mp3');
    expect(args.join(' ')).toContain('-i /tmp/in.ogg');
    expect(args.join(' ')).toContain('-ac 1 -ar 16000 -b:a 32k');
    expect(args[args.length - 1]).toBe('/tmp/out.mp3');
  });

  it('decodes PCM to stdout and cuts chunks without re-encoding', () => {
    expect(decodePcmArgs('/tmp/a.mp3').join(' ')).toContain('-f s16le -acodec pcm_s16le pipe:1');
    const c = chunkArgs('/tmp/a.mp3', '/tmp/c1.mp3', 600, 600);
    expect(c.join(' ')).toContain('-ss 600.00 -t 600.00 -i /tmp/a.mp3');
    expect(c).toContain('copy');
  });
});

describe('chunk planning', () => {
  it('keeps audio up to 15 minutes whole', () => {
    expect(chunkPlan(168)).toEqual([{ index: 0, startS: 0, durationS: 168 }]);
    expect(chunkPlan(900)).toHaveLength(1);
  });

  it('splits longer audio into equal chunks of at most 10 minutes with offsets', () => {
    const plan = chunkPlan(35 * 60);
    expect(plan).toHaveLength(4);
    expect(plan.map((c) => c.startS)).toEqual([0, 525, 1050, 1575]);
    expect(plan.every((c) => c.durationS <= 600)).toBe(true);
    expect(plan.reduce((a, c) => a + c.durationS, 0)).toBeCloseTo(2100, 1);
    const p2 = chunkPlan(901);
    expect(p2).toHaveLength(2);
    expect(p2[1]!.startS + p2[1]!.durationS).toBeCloseTo(901, 1);
  });
});

describe('PCM analysis', () => {
  it('computes duration and 64 normalised peaks', () => {
    const samples = 8000 * 3; // 3 s at 8 kHz
    const pcm = Buffer.alloc(samples * 2);
    for (let i = 0; i < samples; i++) pcm.writeInt16LE(i < samples / 2 ? 16000 : 4000, i * 2);
    expect(pcmDurationSeconds(pcm)).toBe(3);
    const peaks = computePeaks(pcm);
    expect(peaks).toHaveLength(64);
    expect(Math.max(...peaks)).toBe(1);
    expect(peaks[0]).toBe(1);
    expect(peaks[63]).toBeCloseTo(0.25, 2);
    expect(peaks.every((p) => p >= 0 && p <= 1)).toBe(true);
  });

  it('handles empty input', () => {
    expect(computePeaks(Buffer.alloc(0))).toHaveLength(64);
    expect(pcmDurationSeconds(Buffer.alloc(0))).toBe(0);
  });
});
