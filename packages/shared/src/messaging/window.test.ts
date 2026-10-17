import { describe, expect, it } from 'vitest';
import { isServiceWindowOpen, sendMode } from './window.ts';

describe('24h customer service window', () => {
  const now = new Date('2026-10-09T23:00:00Z');
  it('is open within 24h minus the safety margin', () => {
    expect(isServiceWindowOpen(new Date('2026-10-09T00:00:00Z'), now)).toBe(true);
    expect(sendMode(new Date('2026-10-09T22:59:00Z'), now)).toBe('free_form');
  });
  it('is closed after 24h, with no inbound, or in the future', () => {
    expect(isServiceWindowOpen(new Date('2026-10-08T22:59:00Z'), now)).toBe(false);
    expect(isServiceWindowOpen(new Date('2026-10-08T23:03:00Z'), now)).toBe(false); // inside margin
    expect(isServiceWindowOpen(null, now)).toBe(false);
    expect(isServiceWindowOpen(new Date('2026-10-10T00:00:00Z'), now)).toBe(false);
    expect(sendMode(undefined, now)).toBe('template');
  });
});
