import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import {
  analyzeAudio,
  analyzeCall,
  chunkArgs,
  chunkPlan,
  computePeaks,
  convertToMp3Args,
  createFfmpegRunner,
  decodePcmArgs,
  decodeStereoPcmArgs,
  extractLaneArgs,
  pcmDurationSeconds,
  reporterLane,
  splitStereoPcm,
  resolveFfmpegPath,
  UPLOAD_PEAK_BUCKETS,
  withTempDir,
} from './ffmpeg';

/** A real ffmpeg (FFMPEG_PATH, ffmpeg-static or PATH), for the decode test; skipped without one. */
const FFMPEG = (() => {
  const bin = resolveFfmpegPath();
  try {
    execFileSync(bin, ['-version'], { stdio: 'ignore' });
    return bin;
  } catch {
    return null;
  }
})();

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

describe('upload peaks (W1-11)', () => {
  it('computes about 600 peaks for a web recorder voice note, short or long', () => {
    expect(UPLOAD_PEAK_BUCKETS).toBe(600);
    for (const seconds of [0.05, 2, 180, 900]) {
      const samples = Math.round(8000 * seconds);
      const pcm = Buffer.alloc(samples * 2);
      for (let i = 0; i < samples; i++) pcm.writeInt16LE(Math.round(Math.sin(i / 7) * 9000), i * 2);
      const peaks = computePeaks(pcm, UPLOAD_PEAK_BUCKETS);
      expect(peaks).toHaveLength(600);
      expect(peaks.every((p) => p >= 0 && p <= 1)).toBe(true);
      expect(Math.max(...peaks)).toBe(1);
    }
  });

  it.skipIf(!FFMPEG)(
    'decodes a browser webm/opus file with the real ffmpeg: duration and 600 peaks',
    async () => {
      await withTempDir(async (dir) => {
        const path = `${dir}/clip.webm`;
        // 3 s: 1 s of tone, 1 s of silence, 1 s of tone (what a MediaRecorder webm looks like).
        execFileSync(FFMPEG!, [
          '-hide_banner',
          '-loglevel',
          'error',
          '-y',
          '-f',
          'lavfi',
          '-i',
          'sine=frequency=440:duration=3',
          '-af',
          "volume='if(between(t,1,2),0,1)':eval=frame",
          '-c:a',
          'libopus',
          '-b:a',
          '24k',
          path,
        ]);
        const a = await analyzeAudio(createFfmpegRunner(FFMPEG!), path, UPLOAD_PEAK_BUCKETS);
        expect(a.durationS).toBeGreaterThan(2.9);
        expect(a.durationS).toBeLessThan(3.1);
        expect(a.peaks).toHaveLength(600);
        // The silent second reads as (near) silence in the middle third.
        expect(Math.max(...a.peaks.slice(230, 370))).toBeLessThan(0.05);
        expect(Math.max(...a.peaks.slice(0, 180))).toBeGreaterThan(0.5);
      });
    },
    30_000,
  );
});

describe('call recordings (W3-11): two lanes, reporter left, agent right', () => {
  it('builds the stereo decode and the lane extraction', () => {
    expect(decodeStereoPcmArgs('in.ogg')).toEqual(
      expect.arrayContaining(['-i', 'in.ogg', '-ac', '2', '-f', 's16le', 'pipe:1']),
    );
    expect(extractLaneArgs('in.ogg', 'out.wav', 0)).toEqual(
      expect.arrayContaining(['-af', 'pan=mono|c0=c0', '-ar', '16000', '-f', 'wav', 'out.wav']),
    );
    expect(extractLaneArgs('in.ogg', 'out.wav', 1)).toContain('pan=mono|c0=c1');
  });

  it('splits interleaved stereo PCM into its channels', () => {
    const pcm = Buffer.alloc(8);
    pcm.writeInt16LE(100, 0); // L
    pcm.writeInt16LE(-7, 2); // R
    pcm.writeInt16LE(200, 4); // L
    pcm.writeInt16LE(0, 6); // R
    const { left, right } = splitStereoPcm(pcm);
    expect([left.readInt16LE(0), left.readInt16LE(2)]).toEqual([100, 200]);
    expect([right.readInt16LE(0), right.readInt16LE(2)]).toEqual([-7, 0]);
  });

  it.skipIf(!FFMPEG)(
    'splits a generated stereo OGG with the real ffmpeg: two lanes of peaks, the reporter lane alone',
    async () => {
      await withTempDir(async (dir) => {
        const path = `${dir}/call.ogg`;
        // 4 s: the reporter (left) talks for the first 2 s, the agent (right) for the last 2 s.
        execFileSync(FFMPEG!, [
          '-hide_banner',
          '-loglevel',
          'error',
          '-y',
          '-f',
          'lavfi',
          '-i',
          "aevalsrc='if(lt(t,2),sin(440*2*PI*t),0)|if(gte(t,2),0.5*sin(660*2*PI*t),0)':s=48000:d=4",
          '-c:a',
          'libopus',
          '-b:a',
          '48k',
          path,
        ]);
        const run = createFfmpegRunner(FFMPEG!);
        const a = await analyzeCall(run, path);
        expect(a.durationS).toBeGreaterThan(3.9);
        expect(a.durationS).toBeLessThan(4.1);
        expect(a.peaks.reporter).toHaveLength(600);
        expect(a.peaks.agent).toHaveLength(600);
        // Each lane is loud in its own half and (near) silent in the other.
        expect(Math.max(...a.peaks.reporter.slice(20, 280))).toBeGreaterThan(0.5);
        expect(Math.max(...a.peaks.reporter.slice(320, 580))).toBeLessThan(0.05);
        expect(Math.max(...a.peaks.agent.slice(20, 280))).toBeLessThan(0.05);
        expect(Math.max(...a.peaks.agent.slice(320, 580))).toBeGreaterThan(0.5);

        const wav = await reporterLane(run, dir, path);
        expect(wav.subarray(0, 4).toString('ascii')).toBe('RIFF');
        const lane = await analyzeAudio(run, `${dir}/reporter.wav`, UPLOAD_PEAK_BUCKETS);
        expect(lane.durationS).toBeGreaterThan(3.9);
        expect(Math.max(...lane.peaks.slice(320, 580))).toBeLessThan(0.05);
        expect(Math.max(...lane.peaks.slice(20, 280))).toBeGreaterThan(0.5);
      });
    },
    30_000,
  );
});
