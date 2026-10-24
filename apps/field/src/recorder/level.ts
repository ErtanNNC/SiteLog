/**
 * The live level meter of the Recording screen (Field-04): an `AnalyserNode` on the microphone
 * stream gives 8-bit time-domain samples; their RMS, scaled to 0–1, drives the bars.
 */

/** Bars in the meter, as on the artboard. */
export const METER_BARS = 18;

/**
 * Below this the whole clip was silence (F5 "recording < 5 s or silent"): a muted or covered
 * microphone reads 0. A level of 0.02 is an RMS of about 0.7 % of full scale (−43 dBFS): any
 * voice near the phone is well above it, and so is a site's background noise.
 */
export const SILENT_LEVEL = 0.02;

/** A clip whose meter ran and never rose above silence; unknown (null) is never silent. */
export function silentClip(peakLevel: number | null): boolean {
  return peakLevel !== null && peakLevel < SILENT_LEVEL;
}

/**
 * 0–1 from 8-bit time-domain samples (128 is silence, 0 and 255 full swing). Speech peaks at an
 * RMS of about 0.3 of full scale, so the value is stretched by 3 and clamped; silence is 0.
 */
export function levelFromTimeDomain(samples: ArrayLike<number>): number {
  const n = samples.length;
  if (n === 0) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const v = (samples[i]! - 128) / 128;
    sum += v * v;
  }
  const rms = Math.sqrt(sum / n);
  return Math.min(1, rms * 3);
}

/**
 * The bar heights (0–1) for a history of levels, newest last: the last `count` levels, padded
 * with silence on the left so the meter fills from the right as on the artboard.
 */
export function meterBars(history: readonly number[], count: number = METER_BARS): number[] {
  const recent = history.slice(-count);
  const pad = Math.max(0, count - recent.length);
  return [...Array<number>(pad).fill(0), ...recent];
}

/** The level history after a new sample, kept to what the meter shows. */
export function pushLevel(
  history: readonly number[],
  level: number,
  count: number = METER_BARS,
): number[] {
  const next = [...history, level];
  return next.length > count ? next.slice(next.length - count) : next;
}
