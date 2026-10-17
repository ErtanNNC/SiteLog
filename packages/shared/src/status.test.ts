import { describe, expect, it } from 'vitest';
import { versionPdfStatus, versionSignedOff } from './status.ts';

describe('versionSignedOff / versionPdfStatus', () => {
  const signedOff = { status: 'signed_off' as const, currentVersion: 2 };

  it('prints the sign-off on the current version of a signed-off report only', () => {
    expect(versionSignedOff(signedOff, 2)).toBe(true);
    expect(versionSignedOff(signedOff, 1)).toBe(false);
    expect(versionSignedOff({ status: 'filed', currentVersion: 2 }, 2)).toBe(false);
  });

  it('reads an older version of a signed-off report as filed, any other status as it is', () => {
    expect(versionPdfStatus(signedOff, 2)).toBe('signed_off');
    expect(versionPdfStatus(signedOff, 1)).toBe('filed');
    expect(versionPdfStatus({ status: 'filed', currentVersion: 3 }, 1)).toBe('filed');
  });
});
