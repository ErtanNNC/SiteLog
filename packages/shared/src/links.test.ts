import { describe, expect, it } from 'vitest';
import {
  LINK_CODE_ALPHABET,
  LINK_CODE_LENGTH,
  MASKED_CODE,
  dailyLinkExpiresAt,
  deriveLinkCode,
  ensureDailyLink,
  isDailyLinkTtlHours,
  ensurePersonalLink,
  fieldLinkUrl,
  fieldHistoryLinkUrl,
  fieldReportLinkUrl,
  linkCodeHash,
  maskFieldLinkUrl,
  photosLinkExpiresAt,
  sha256Hex,
  type DailyLinkRow,
  type DailyLinkStore,
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
    expect(fieldLinkUrl('https://go.talkolog.com/', 'k7q2mx')).toBe(
      'https://go.talkolog.com/r/K7Q2MX',
    );
    expect(fieldLinkUrl('http://localhost:5174', 'K7Q2MX')).toBe('http://localhost:5174/r/K7Q2MX');
  });

  it('builds the Filed-screen link of the `filed` text, masked like any field link (W1-15)', () => {
    const url = fieldReportLinkUrl('https://go.talkolog.com/', 'k7q2mx', 'r-1');
    expect(url).toBe('https://go.talkolog.com/r/K7Q2MX/report/r-1');
    expect(maskFieldLinkUrl(`PDF: ${url}`)).toBe(
      'PDF: https://go.talkolog.com/r/••••••/report/r-1',
    );
  });

  it('builds the Past reports links of an SMS EDIT, masked like any field link (W2-12)', () => {
    const url = fieldHistoryLinkUrl('https://go.talkolog.com/', 'k7q2mx', 'r-1');
    expect(url).toBe('https://go.talkolog.com/r/K7Q2MX/history/r-1');
    expect(fieldHistoryLinkUrl('https://go.talkolog.com', 'K7Q2MX')).toBe(
      'https://go.talkolog.com/r/K7Q2MX/history',
    );
    expect(maskFieldLinkUrl(`Confirm here: ${url}`)).toBe(
      'Confirm here: https://go.talkolog.com/r/••••••/history/r-1',
    );
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

  it('derives the same twelve characters of the alphabet from the secret and the link id (§19 Q42)', async () => {
    const code = await deriveLinkCode(SECRET, ID);
    expect(LINK_CODE_LENGTH).toBe(12);
    expect(code).toHaveLength(LINK_CODE_LENGTH);
    expect([...code].every((c) => LINK_CODE_ALPHABET.includes(c))).toBe(true);
    expect(await deriveLinkCode(SECRET, ID)).toBe(code);
    expect(await deriveLinkCode(`${SECRET}x`, ID)).not.toBe(code);
    expect(await deriveLinkCode(SECRET, ID.replace(/3$/, '4'))).not.toBe(code);
    expect(await deriveLinkCode(SECRET, ID, 6)).toBe(code.slice(0, 6));
    await expect(deriveLinkCode('', ID)).rejects.toThrow(/LINK_SIGNING_SECRET/);
  });

  it('spreads codes over the whole alphabet', async () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++)
      for (const c of await deriveLinkCode(SECRET, `id-${i}`)) seen.add(c);
    expect(seen.size).toBe(LINK_CODE_ALPHABET.length);
  });

  it('masks the code of a field link, and nothing else', () => {
    expect(maskFieldLinkUrl('https://go.talkolog.com/r/K7Q2MX')).toBe(
      `https://go.talkolog.com/r/${MASKED_CODE}`,
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

describe('daily links (W1-16, "Text today\'s link")', () => {
  const SECRET = 'test-link-signing-secret';
  const NOW = new Date('2026-10-10T00:05:00Z');

  it('expires DAILY_LINK_TTL_HOURS after it is made (72 by default)', () => {
    expect(dailyLinkExpiresAt(NOW)).toBe('2026-10-13T00:05:00.000Z');
    expect(dailyLinkExpiresAt(NOW, 24)).toBe('2026-10-11T00:05:00.000Z');
    expect(dailyLinkExpiresAt(NOW, Number.NaN)).toBe('2026-10-13T00:05:00.000Z');
    expect(dailyLinkExpiresAt(NOW, 0)).toBe('2026-10-13T00:05:00.000Z');
  });

  function memoryStore() {
    const rows: Array<
      DailyLinkRow & { reporter_id: string; site_id: string; report_date: string }
    > = [];
    const store: DailyLinkStore = {
      listDailyLinks: async (reporterId, siteId, date) =>
        rows
          .filter(
            (r) => r.reporter_id === reporterId && r.site_id === siteId && r.report_date === date,
          )
          .reverse(),
      insertDailyLink: async (row) => {
        if (rows.some((r) => r.code_hash === row.code_hash)) return false;
        rows.push(row);
        return true;
      },
    };
    return { rows, store };
  }

  it('reuses the live link of the reporter, site and date, else issues one', async () => {
    const { rows, store } = memoryStore();
    let n = 0;
    const newId = () => `daily-${++n}`;
    const input = {
      reporterId: 'r1',
      siteId: 's1',
      reportDate: '2026-10-09',
      expiresAt: dailyLinkExpiresAt(NOW),
      now: NOW,
    };
    const first = await ensureDailyLink(store, SECRET, input, newId);
    expect(first).toMatchObject({ id: 'daily-1', created: true, expiresAt: input.expiresAt });
    expect(first.code).toBe(await deriveLinkCode(SECRET, 'daily-1'));
    expect(rows[0]).toMatchObject({
      reporter_id: 'r1',
      site_id: 's1',
      report_date: '2026-10-09',
      code_hash: linkCodeHash(first.code),
    });
    expect(await ensureDailyLink(store, SECRET, input, newId)).toEqual({
      ...first,
      created: false,
    });
    // Another site or another day is another link.
    expect((await ensureDailyLink(store, SECRET, { ...input, siteId: 's2' }, newId)).id).toBe(
      'daily-2',
    );
    expect(
      (await ensureDailyLink(store, SECRET, { ...input, reportDate: '2026-10-10' }, newId)).id,
    ).toBe('daily-3');
    expect(rows).toHaveLength(3);
  });

  it('never re-sends an expired or a seeded link', async () => {
    const { rows, store } = memoryStore();
    rows.push({
      id: 'seeded',
      code_hash: linkCodeHash('K7Q2MX'),
      expires_at: '2026-10-12T22:00:00Z',
      reporter_id: 'r1',
      site_id: 's1',
      report_date: '2026-10-09',
    });
    const expiredId = 'expired';
    rows.push({
      id: expiredId,
      code_hash: linkCodeHash(await deriveLinkCode(SECRET, expiredId)),
      expires_at: '2026-10-09T23:00:00Z',
      reporter_id: 'r1',
      site_id: 's1',
      report_date: '2026-10-09',
    });
    const link = await ensureDailyLink(
      store,
      SECRET,
      {
        reporterId: 'r1',
        siteId: 's1',
        reportDate: '2026-10-09',
        expiresAt: dailyLinkExpiresAt(NOW),
        now: NOW,
      },
      () => 'fresh',
    );
    expect(link).toMatchObject({ id: 'fresh', created: true });
    const never: DailyLinkStore = {
      listDailyLinks: async () => [],
      insertDailyLink: async () => false,
    };
    await expect(
      ensureDailyLink(
        never,
        SECRET,
        { reporterId: 'r1', siteId: 's1', reportDate: '2026-10-09', expiresAt: '', now: NOW },
        () => 'x',
      ),
    ).rejects.toThrow(/daily link/);
  });

  it('W4-05 (§19 Q231): a new link lives the org’s daily_link_ttl_hours before the env value', async () => {
    const asked: string[] = [];
    const withTtl = (ttl: number | null) => {
      const { rows, store } = memoryStore();
      store.orgDailyLinkTtlHours = async (siteId) => {
        asked.push(siteId);
        return ttl;
      };
      return { rows, store };
    };
    const input = {
      reporterId: 'r1',
      siteId: 's1',
      reportDate: '2026-10-09',
      expiresAt: dailyLinkExpiresAt(NOW, 72),
      now: NOW,
    };
    const day = withTtl(24);
    const link = await ensureDailyLink(day.store, SECRET, input, () => 'org-ttl');
    expect(link.expiresAt).toBe('2026-10-11T00:05:00.000Z');
    expect(day.rows[0]!.expires_at).toBe('2026-10-11T00:05:00.000Z');
    expect(asked).toEqual(['s1']);
    // null (and a value the column would refuse) keeps the environment's expiry.
    for (const ttl of [null, 0, 500]) {
      const env = withTtl(ttl);
      expect((await ensureDailyLink(env.store, SECRET, input, () => `env-${ttl}`)).expiresAt).toBe(
        '2026-10-13T00:05:00.000Z',
      );
    }
    expect([0, 1, 168, 169, 1.5, null].map(isDailyLinkTtlHours)).toEqual([
      false,
      true,
      true,
      false,
      false,
      false,
    ]);
  });
});
