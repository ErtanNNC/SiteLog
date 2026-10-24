import { describe, expect, it } from 'vitest';
import { turnedOffConsents } from './consent';

describe('turnedOffConsents (F15, spec §19 Q95)', () => {
  const at = '2026-10-16T10:00:00Z';
  it('names a processing consent revoked with no live row of its type', () => {
    expect(
      turnedOffConsents([
        { type: 'recording', revoked_at: at },
        { type: 'data_processing', revoked_at: null },
        { type: 'sms', revoked_at: at },
      ]),
    ).toEqual(['recording']);
  });

  it('a consent given again, or never given, is not turned off', () => {
    expect(
      turnedOffConsents([
        { type: 'recording', revoked_at: at },
        { type: 'recording', revoked_at: null },
      ]),
    ).toEqual([]);
    expect(turnedOffConsents([])).toEqual([]);
  });
});
