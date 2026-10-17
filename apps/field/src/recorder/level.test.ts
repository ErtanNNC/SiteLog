import { describe, expect, it } from 'vitest';
import { levelFromTimeDomain, METER_BARS, meterBars, pushLevel } from './level';

describe('level meter (Field-04)', () => {
  it('is 0 for silence and 1 for full swing', () => {
    expect(levelFromTimeDomain(new Uint8Array(256).fill(128))).toBe(0);
    expect(levelFromTimeDomain([])).toBe(0);
    const loud = new Uint8Array(256);
    for (let i = 0; i < loud.length; i++) loud[i] = i % 2 ? 255 : 0;
    expect(levelFromTimeDomain(loud)).toBe(1);
  });

  it('stretches speech-level RMS towards the top of the meter', () => {
    // ±0.3 of full scale square wave: RMS 0.3 → 0.9 after the ×3 stretch.
    const speech = new Uint8Array(100);
    for (let i = 0; i < speech.length; i++) speech[i] = i % 2 ? 128 + 38 : 128 - 38;
    expect(levelFromTimeDomain(speech)).toBeCloseTo(0.89, 2);
  });

  it('fills the bars from the right and keeps the history short', () => {
    expect(METER_BARS).toBe(18);
    expect(meterBars([0.5, 1], 4)).toEqual([0, 0, 0.5, 1]);
    expect(meterBars([1, 2, 3, 4, 5], 3)).toEqual([3, 4, 5]);
    let h: number[] = [];
    for (let i = 1; i <= 20; i++) h = pushLevel(h, i, 4);
    expect(h).toEqual([17, 18, 19, 20]);
  });
});
