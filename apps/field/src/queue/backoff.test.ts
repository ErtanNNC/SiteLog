import { describe, expect, it } from 'vitest';
import { BACKOFF_BASE_MS, BACKOFF_MAX_MS, backoffDelay } from './backoff';

describe('upload backoff', () => {
  const mid = () => 0.5;

  it('doubles from 2 s and caps at 5 minutes', () => {
    expect(backoffDelay(1, mid)).toBe(2_000);
    expect(backoffDelay(2, mid)).toBe(4_000);
    expect(backoffDelay(3, mid)).toBe(8_000);
    expect(backoffDelay(8, mid)).toBe(256_000);
    expect(backoffDelay(9, mid)).toBe(BACKOFF_MAX_MS);
    expect(backoffDelay(50, mid)).toBe(BACKOFF_MAX_MS);
    expect(BACKOFF_BASE_MS).toBe(2_000);
  });

  it('jitters within ±50 % of the base', () => {
    expect(backoffDelay(1, () => 0)).toBe(1_000);
    expect(backoffDelay(1, () => 0.999)).toBe(2_998);
    for (let i = 0; i < 50; i++) {
      const d = backoffDelay(3);
      expect(d).toBeGreaterThanOrEqual(4_000);
      expect(d).toBeLessThan(12_000);
    }
  });

  it('treats a bad attempt number as the first', () => {
    expect(backoffDelay(0, mid)).toBe(2_000);
    expect(backoffDelay(-3, mid)).toBe(2_000);
    expect(backoffDelay(1.7, mid)).toBe(2_000);
  });
});
