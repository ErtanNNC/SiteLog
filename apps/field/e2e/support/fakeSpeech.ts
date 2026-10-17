import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * A speech-like WAV for Chromium's fake microphone (`--use-file-for-fake-audio-capture`). Its
 * default device only beeps 20 ms a second, which noise suppression and the Recording screen's
 * level meter can both miss: the screen would then take the clip for silence (F5 "recording < 5 s
 * or silent") and refuse it. This is a voiced sound (a 140 Hz voice with harmonics to 3 kHz) in
 * syllables (4 a second), looped by Chromium, so the meter hears what a phone hears from a voice.
 */
export function writeFakeSpeech(path: string, seconds = 4, rate = 48_000): string {
  const frames = seconds * rate;
  const data = Buffer.alloc(frames * 2);
  for (let i = 0; i < frames; i++) {
    const t = i / rate;
    let voice = 0;
    for (let h = 1; h * 140 <= 3_000; h++) voice += Math.sin(2 * Math.PI * 140 * h * t) / h;
    const syllable = Math.abs(Math.sin(2 * Math.PI * 2 * t)) ** 0.5;
    const sample = Math.max(-1, Math.min(1, 0.25 * voice * syllable));
    data.writeInt16LE(Math.round(sample * 32_767), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, Buffer.concat([header, data]));
  return path;
}
