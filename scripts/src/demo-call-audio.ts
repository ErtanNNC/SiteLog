/**
 * The demo calls' synthetic recordings (W3-05): `apps/web/public/demo/call-{site}.ogg` for the
 * Oct 9 calls of Northgate and Hillcrest, so the panel's demo mode plays a two-lane call without
 * a stack. Tones only, no speech: the reporter's lane on the left channel and the assistant's on
 * the right (§9.4 "Recording"), laid out on the demo call transcript's segments
 * (`packages/shared/src/demo/calls.ts`), so the player's lanes, the excerpts and the sound agree.
 *
 *   pnpm demo:call-audio        → writes both files (needs ffmpeg with libopus on PATH, or FFMPEG_PATH)
 *
 * Rerun it when the demo calls' transcripts or lengths change.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEMO_CALL_AUDIO_SITES,
  demoCallAudioPath,
  type DemoCallSegment,
} from '@sitelog/shared/demo/calls.ts';
import { DEMO_TODAY, buildKestrelDemo } from '@sitelog/shared/demo/kestrel.ts';
import { demoId } from '@sitelog/shared/demo/ids.ts';

export const DEMO_AUDIO_RATE = 16_000;

/** Each lane's tone: a low voice for the site manager, a higher one for the assistant. */
const LANES = {
  reporter: { channel: 0, hz: 165, syllables: 3.1 },
  agent: { channel: 1, hz: 245, syllables: 3.9 },
} as const;

/**
 * Interleaved 16-bit stereo PCM of a call: a tone with a syllable-like envelope on the speaker's
 * channel during each segment (20 ms fades), silence elsewhere.
 */
export function synthCallPcm(
  segments: readonly DemoCallSegment[],
  durationS: number,
  rate = DEMO_AUDIO_RATE,
): Int16Array {
  const frames = Math.round(durationS * rate);
  const out = new Int16Array(frames * 2);
  const fade = 0.02;
  for (const s of segments) {
    const lane = LANES[s.speaker];
    const from = Math.max(0, Math.floor(s.start * rate));
    const to = Math.min(frames, Math.floor(s.end * rate));
    for (let i = from; i < to; i++) {
      const t = i / rate;
      const edge = Math.min(1, (t - s.start) / fade, (s.end - t) / fade);
      const envelope = 0.55 + 0.45 * Math.sin(2 * Math.PI * lane.syllables * t);
      const wave =
        0.7 * Math.sin(2 * Math.PI * lane.hz * t) + 0.3 * Math.sin(2 * Math.PI * 2 * lane.hz * t);
      out[i * 2 + lane.channel] = Math.round(0.3 * 32767 * Math.max(0, edge) * envelope * wave);
    }
  }
  return out;
}

function main(): void {
  const demo = buildKestrelDemo();
  const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const ffmpeg = process.env.FFMPEG_PATH ?? 'ffmpeg';
  for (const site of DEMO_CALL_AUDIO_SITES) {
    const callId = demoId(`call:${site}:${DEMO_TODAY}`);
    const call = demo.calls.find((c) => c.id === callId);
    const transcript = demo.transcripts.find((t) => t.call_id === callId);
    if (!call || !transcript) throw new Error(`no demo call with a transcript for ${site}`);
    const pcm = synthCallPcm(
      transcript.segments as unknown as DemoCallSegment[],
      Number(call.duration_s ?? 0),
    );
    const file = join(root, 'apps', 'web', 'public', demoCallAudioPath(site));
    mkdirSync(dirname(file), { recursive: true });
    const res = spawnSync(
      ffmpeg,
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
        '-f',
        's16le',
        '-ar',
        String(DEMO_AUDIO_RATE),
        '-ac',
        '2',
        '-i',
        'pipe:0',
        '-map_metadata',
        '-1',
        '-c:a',
        'libopus',
        '-b:a',
        '16k',
        '-application',
        'voip',
        file,
      ],
      { input: Buffer.from(pcm.buffer), stdio: ['pipe', 'inherit', 'inherit'] },
    );
    if (res.status !== 0)
      throw new Error(`ffmpeg failed for ${site} (${String(res.error ?? res.status)})`);
    console.log(`wrote ${file} (${call.duration_s} s)`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
