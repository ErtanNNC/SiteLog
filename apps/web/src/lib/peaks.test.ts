import { describe, expect, it } from 'vitest';
import { MAX_WAVEFORM_BARS, waveformBars } from './peaks';

describe('waveformBars', () => {
  it('keeps 64 WhatsApp peaks as they are', () => {
    const peaks = Array.from({ length: 64 }, (_, i) => i / 63);
    expect(waveformBars(peaks)).toEqual(peaks);
  });

  it('folds about 600 upload peaks to 64 bars, keeping each share loudest', () => {
    const peaks = Array.from({ length: 600 }, (_, i) => (i === 300 ? 1 : 0.1));
    const bars = waveformBars(peaks);
    expect(bars).toHaveLength(MAX_WAVEFORM_BARS);
    expect(bars.filter((b) => b === 1)).toHaveLength(1);
    expect(bars.indexOf(1)).toBe(32);
  });
});
