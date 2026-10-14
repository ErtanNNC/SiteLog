import { describe, expect, it } from 'vitest';
import {
  LINK_CODE_ALPHABET,
  fieldLinkUrl,
  linkCodeHash,
  photosLinkExpiresAt,
  sha256Hex,
} from './links.ts';
import { demoLinkCode } from './demo/ids.ts';

describe('field link codes', () => {
  it('hashes like SHA-256 over UTF-8 (the code_hash field-api compares)', () => {
    // Vectors from Node's crypto.createHash('sha256') (the shared package has no Node APIs).
    const vectors: Array<[string, string]> = [
      ['', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
      ['abc', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
      ['K7Q2MX', '52c4dca64e5ef50a3e714d5a28ffff0599ede7be7d84776511296f20e4fe8e34'],
      [
        'Kartal Konutları — B Blok',
        '95d6f19ef2f5c2acfd13ece15f33bbabe5f0212fab39d868c8fb2c224dd090d4',
      ],
      ['x'.repeat(55), 'd5e285683cd4efc02d021a5c62014694958901005d6f71e89e0989fac77e4072'],
      ['y'.repeat(200), '8ca9bfd43d61bf0ab214f1b75fb137479da5ed86dd0ab570d4fa70eb1594c268'],
    ];
    for (const [text, hex] of vectors) expect(sha256Hex(text)).toBe(hex);
  });

  it('hashes the trimmed, upper case code', () => {
    expect(linkCodeHash(' k7q2mx ')).toBe(linkCodeHash('K7Q2MX'));
    expect(linkCodeHash('K7Q2MX')).toBe(sha256Hex('K7Q2MX'));
  });

  it('builds the SMS link on the field host', () => {
    expect(fieldLinkUrl('https://go.sitelog.app/', 'k7q2mx')).toBe(
      'https://go.sitelog.app/r/K7Q2MX',
    );
    expect(fieldLinkUrl('http://localhost:5174', 'K7Q2MX')).toBe('http://localhost:5174/r/K7Q2MX');
  });

  it('makes deterministic six-character demo codes from the alphabet', () => {
    const code = demoLinkCode('personal:marco');
    expect(code).toMatch(new RegExp(`^[${LINK_CODE_ALPHABET}]{6}$`));
    expect(demoLinkCode('personal:marco')).toBe(code);
    expect(demoLinkCode('personal:dana')).not.toBe(code);
    expect(LINK_CODE_ALPHABET).not.toMatch(/[01ILOU]/);
  });

  it('ends a photos link at 23:59 the next day in the site time zone (F9)', () => {
    // Fri Oct 9, 2026 → Sat Oct 10 23:59 CDT (UTC-5).
    expect(photosLinkExpiresAt('2026-10-09', 'America/Chicago')).toBe('2026-10-11T04:59:00.000Z');
    // Across the end of DST (Sun Nov 1): Sat Oct 31 → Sun Nov 1 23:59 CST (UTC-6).
    expect(photosLinkExpiresAt('2026-10-31', 'America/Chicago')).toBe('2026-11-02T05:59:00.000Z');
    // Istanbul has no DST (UTC+3); a month end rolls over.
    expect(photosLinkExpiresAt('2026-10-31', 'Europe/Istanbul')).toBe('2026-11-01T20:59:00.000Z');
  });
});
