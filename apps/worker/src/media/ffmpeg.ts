import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * ffmpeg helpers (§10.2). The binary is resolved as FFMPEG_PATH → ffmpeg-static (when its
 * download succeeded) → `ffmpeg` on PATH. Commands are built by pure functions so tests can
 * assert on them with a mocked runner.
 */

export interface FfmpegResult {
  stdout: Buffer;
  stderr: string;
}

export type FfmpegRunner = (args: string[], opts?: { timeoutMs?: number; maxBuffer?: number }) => Promise<FfmpegResult>;

export const PCM_SAMPLE_RATE = 8000;
export const MP3_SAMPLE_RATE = 16000;
export const MP3_BITRATE = '32k';
export const PEAK_BUCKETS = 64;
/** Audio longer than this is split before transcription (§F5 edge case). */
export const SPLIT_THRESHOLD_S = 15 * 60;
export const MAX_CHUNK_S = 10 * 60;

let cachedPath: string | null = null;

export function resolveFfmpegPath(env: NodeJS.ProcessEnv = process.env): string {
  if (cachedPath) return cachedPath;
  if (env.FFMPEG_PATH && existsSync(env.FFMPEG_PATH)) return (cachedPath = env.FFMPEG_PATH);
  try {
    const require = createRequire(import.meta.url);
    const staticPath = require('ffmpeg-static') as string | null;
    if (staticPath && existsSync(staticPath)) return (cachedPath = staticPath);
  } catch {
    /* ffmpeg-static not installed or its binary missing */
  }
  return (cachedPath = 'ffmpeg');
}

/** `ffmpeg -i in.ogg -vn -ac 1 -ar 16000 -b:a 32k out.mp3` */
export function convertToMp3Args(input: string, output: string): string[] {
  return ['-hide_banner', '-loglevel', 'error', '-y', '-i', input, '-vn', '-ac', '1', '-ar', String(MP3_SAMPLE_RATE), '-b:a', MP3_BITRATE, '-f', 'mp3', output];
}

/** Decode to signed 16-bit mono PCM on stdout (for duration + waveform peaks). */
export function decodePcmArgs(input: string, sampleRate = PCM_SAMPLE_RATE): string[] {
  return ['-hide_banner', '-loglevel', 'error', '-i', input, '-vn', '-ac', '1', '-ar', String(sampleRate), '-f', 's16le', '-acodec', 'pcm_s16le', 'pipe:1'];
}

/** Cut `[start, start+duration)` seconds out of an mp3 without re-encoding. */
export function chunkArgs(input: string, output: string, startS: number, durationS: number): string[] {
  return ['-hide_banner', '-loglevel', 'error', '-y', '-ss', startS.toFixed(2), '-t', durationS.toFixed(2), '-i', input, '-vn', '-c', 'copy', '-f', 'mp3', output];
}

export interface Chunk {
  index: number;
  startS: number;
  durationS: number;
}

/** Split audio over the threshold into equal chunks of at most `maxChunkS` (10 min). */
export function chunkPlan(durationS: number, maxChunkS = MAX_CHUNK_S, thresholdS = SPLIT_THRESHOLD_S): Chunk[] {
  const d = Math.max(0, durationS);
  if (d <= thresholdS) return [{ index: 0, startS: 0, durationS: d }];
  const n = Math.ceil(d / maxChunkS);
  const len = d / n;
  return Array.from({ length: n }, (_, i) => ({
    index: i,
    startS: Math.round(i * len * 100) / 100,
    durationS: Math.round((i === n - 1 ? d - i * len : len) * 100) / 100,
  }));
}

export function pcmDurationSeconds(pcm: Buffer, sampleRate = PCM_SAMPLE_RATE): number {
  return Math.round((pcm.length / 2 / sampleRate) * 100) / 100;
}

/** 64 normalised peaks (0–1) for the web VoicePlayer waveform (§11.3). */
export function computePeaks(pcm: Buffer, buckets = PEAK_BUCKETS): number[] {
  const samples = Math.floor(pcm.length / 2);
  if (samples === 0) return Array.from({ length: buckets }, () => 0);
  const per = Math.max(1, Math.ceil(samples / buckets));
  const peaks: number[] = [];
  for (let b = 0; b < buckets; b++) {
    const from = b * per;
    const to = Math.min(samples, from + per);
    let max = 0;
    for (let i = from; i < to; i++) {
      const v = Math.abs(pcm.readInt16LE(i * 2));
      if (v > max) max = v;
    }
    peaks.push(from >= samples ? 0 : max / 32768);
  }
  const top = Math.max(...peaks);
  if (top <= 0) return peaks;
  return peaks.map((p) => Math.round((p / top) * 1000) / 1000);
}

export function createFfmpegRunner(binary: string = resolveFfmpegPath()): FfmpegRunner {
  return (args, opts = {}) =>
    new Promise<FfmpegResult>((resolve, reject) => {
      execFile(
        binary,
        args,
        { encoding: 'buffer', maxBuffer: opts.maxBuffer ?? 256 * 1024 * 1024, timeout: opts.timeoutMs ?? 120_000 },
        (err, stdout, stderr) => {
          const errText = Buffer.isBuffer(stderr) ? stderr.toString('utf8') : String(stderr ?? '');
          if (err) {
            reject(new Error(`ffmpeg failed (${binary} ${args.slice(0, 6).join(' ')}…): ${errText.slice(-500) || err.message}`));
            return;
          }
          resolve({ stdout: Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout), stderr: errText });
        },
      );
    });
}

export interface AudioAnalysis {
  durationS: number;
  peaks: number[];
}

/** Decode once: duration + peaks. */
export async function analyzeAudio(run: FfmpegRunner, inputPath: string): Promise<AudioAnalysis> {
  const { stdout } = await run(decodePcmArgs(inputPath));
  return { durationS: pcmDurationSeconds(stdout), peaks: computePeaks(stdout) };
}

export async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'sitelog-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export async function writeTemp(dir: string, name: string, data: Buffer): Promise<string> {
  const p = join(dir, name);
  await writeFile(p, data);
  return p;
}

export const readTemp = (p: string): Promise<Buffer> => readFile(p);
