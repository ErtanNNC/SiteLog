import { describe, expect, it } from 'vitest';
import { LOGO_MAX_BYTES, logoFileError } from './logo';

describe('logoFileError (§F2: PNG or SVG ≤ 2 MB)', () => {
  it('accepts PNG and SVG up to 2 MB', () => {
    expect(logoFileError({ type: 'image/png', size: LOGO_MAX_BYTES })).toBeNull();
    expect(logoFileError({ type: 'image/svg+xml', size: 12_000 })).toBeNull();
  });

  it('rejects other types and larger files with the setup copy', () => {
    expect(logoFileError({ type: 'image/jpeg', size: 10 })).toBe('Use a PNG or SVG file.');
    expect(logoFileError({ type: '', size: 10 })).toBe('Use a PNG or SVG file.');
    expect(logoFileError({ type: 'image/png', size: LOGO_MAX_BYTES + 1 })).toBe(
      'The logo must be 2 MB or smaller.',
    );
  });
});
