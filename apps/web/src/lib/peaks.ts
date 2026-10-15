/**
 * The MediaPlayer draws at most this many bars: a 1 px bar and a 1 px gap each, so they fit the
 * waveform at 390 px. WhatsApp voice notes carry 64 peaks; a web recorder upload about 600
 * (W1-11, `uploads.peaks`).
 */
export const MAX_WAVEFORM_BARS = 64;

/** Peaks folded to at most `max` bars, each the loudest peak of its share. */
export function waveformBars(peaks: readonly number[], max = MAX_WAVEFORM_BARS): number[] {
  if (peaks.length <= max) return [...peaks];
  const out: number[] = [];
  for (let b = 0; b < max; b++) {
    const from = Math.floor((b * peaks.length) / max);
    const to = Math.max(from + 1, Math.floor(((b + 1) * peaks.length) / max));
    out.push(Math.max(...peaks.slice(from, to)));
  }
  return out;
}
