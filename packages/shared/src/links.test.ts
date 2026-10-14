import { describe, expect, it } from 'vitest';
import {
  LINK_CODE_ALPHABET,
  LINK_CODE_LENGTH,
  MASKED_CODE,
  deriveLinkCode,
  ensurePersonalLink,
  fieldLinkUrl,
  linkCodeHash,
  maskFieldLinkUrl,
  photosLinkExpiresAt,
  sha256Hex,
  type PersonalLinkStore,
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

describe('personal link codes (W1-08)', () => {
  const SECRET = 'test-link-signing-secret';
  const ID = '6f1c2a9e-3b7d-4c51-9a0e-2d8f4b6c1e73';

  it('derives the same six characters of the alphabet from the secret and the link id', async () => {
    const code = await deriveLinkCode(SECRET, ID);
    expect(code).toHaveLength(LINK_CODE_LENGTH);
    expect([...code].every((c) => LINK_CODE_ALPHABET.includes(c))).toBe(true);
    expect(await deriveLinkCode(SECRET, ID)).toBe(code);
    expect(await deriveLinkCode(`${SECRET}x`, ID)).not.toBe(code);
    expect(await deriveLinkCode(SECRET, ID.replace(/3$/, '4'))).not.toBe(code);
    expect(await deriveLinkCode(SECRET, ID, 12)).toHaveLength(12);
    await expect(deriveLinkCode('', ID)).rejects.toThrow(/LINK_SIGNING_SECRET/);
  });

  it('spreads codes over the whole alphabet', async () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++)
      for (const c of await deriveLinkCode(SECRET, `id-${i}`)) seen.add(c);
    expect(seen.size).toBe(LINK_CODE_ALPHABET.length);
  });

  it('masks the code of a field link, and nothing else', () => {
    expect(maskFieldLinkUrl('https://go.sitelog.app/r/K7Q2MX')).toBe(
      `https://go.sitelog.app/r/${MASKED_CODE}`,
    );
    expect(maskFieldLinkUrl('Your link: http://localhost:5174/r/AB12CD/report/42 · Call')).toBe(
      `Your link: http://localhost:5174/r/${MASKED_CODE}/report/42 · Call`,
    );
    expect(maskFieldLinkUrl('Riverside Lofts — Block B')).toBe('Riverside Lofts — Block B');
  });

  it('reuses the newest link whose code it can derive again, else issues one', async () => {
    const rows: Array<{ id: string; code_hash: string; reporter_id: string }> = [];
    let n = 0;
    const store: PersonalLinkStore = {
      listPersonalLinks: async () => [...rows].reverse(),
      insertPersonalLink: async (row) => {
        if (rows.some((r) => r.code_hash === row.code_hash)) return false;
        rows.push(row);
        return true;
      },
    };
    const newId = () => `link-${++n}`;
    // A seeded link (its code is not derived) is never re-sent.
    rows.push({ id: 'seeded', code_hash: linkCodeHash('K7Q2MX'), reporter_id: 'r1' });
    const first = await ensurePersonalLink(store, SECRET, 'r1', newId);
    expect(first).toMatchObject({ id: 'link-1', created: true });
    expect(linkCodeHash(first.code)).toBe(rows[1]!.code_hash);
    const again = await ensurePersonalLink(store, SECRET, 'r1', newId);
    expect(again).toEqual({ ...first, created: false });
    expect(rows).toHaveLength(2);
    // A rotated secret cannot re-derive the old code: a new link, the old one stays valid.
    const rotated = await ensurePersonalLink(store, `${SECRET}2`, 'r1', newId);
    expect(rotated.created).toBe(true);
    expect(rows).toHaveLength(3);
  });

  it('retries with a new id when a code hash is taken', async () => {
    const taken = linkCodeHash(await deriveLinkCode(SECRET, 'dup'));
    const ids = ['dup', 'fresh'];
    const inserted: string[] = [];
    const store: PersonalLinkStore = {
      listPersonalLinks: async () => [],
      insertPersonalLink: async (row) => {
        if (row.code_hash === taken) return false;
        inserted.push(row.id);
        return true;
      },
    };
    const link = await ensurePersonalLink(store, SECRET, 'r1', () => ids.shift()!);
    expect(link.id).toBe('fresh');
    expect(inserted).toEqual(['fresh']);
    const never: PersonalLinkStore = { ...store, insertPersonalLink: async () => false };
    await expect(ensurePersonalLink(never, SECRET, 'r1', () => 'x')).rejects.toThrow(
      /personal link/,
    );
  });
});
