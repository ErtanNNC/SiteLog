import { afterAll, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { DEMO_COUNTRIES } from '@sitelog/shared/demo/countries.ts';
import { applyMigration, bootDatabase } from './harness.ts';

/**
 * §19 Q374 (decided by the owner 2026-10-23; 20261023000100_whatsapp_only.sql): SMS is passive in
 * every country pack. After the migrations no pack lists SMS (every one orders push, then
 * WhatsApp), DEMO_COUNTRIES says the same, the migration takes SMS out of any other row too and
 * refuses a pack it would leave without WhatsApp, and switching SMS back on is a plain update of
 * the one column (the forward migration that will do it).
 */

const WHATSAPP_ONLY = '20261023000100_whatsapp_only.sql';

const open: PGlite[] = [];
async function boot(opts: { until?: string; seed?: boolean } = {}): Promise<PGlite> {
  const db = await bootDatabase(opts);
  open.push(db);
  return db;
}

afterAll(async () => {
  await Promise.all(open.map((db) => db.close()));
});

const channels = async (db: PGlite) =>
  (
    await db.query<{ code: string; message_channels: string }>(
      `select code, message_channels::text from countries
       where code in ('TR', 'US', 'ZY', 'ZZ') order by code`,
    )
  ).rows;

/** A synthetic pack with the launch packs' shape and the given order. */
const insertPack = (code: string, order: string) =>
  `insert into countries (code, default_locale, field_locales, units, paper, currency,
                          default_timezone, message_channels, sms_sender_type, two_way_sms,
                          sms_links_allowed)
   values ('${code}', 'en-US', '{en-US}', 'metric', 'a4', 'EUR', 'UTC', '${order}', 'long_code',
           true, true)`;

describe('§19 Q374: SMS passive in every country pack', () => {
  it('leaves no pack listing SMS after the migrations (and the seed), push then WhatsApp', async () => {
    const db = await boot({ seed: true });
    expect(await channels(db)).toEqual([
      { code: 'TR', message_channels: '{push,whatsapp}' },
      { code: 'US', message_channels: '{push,whatsapp}' },
    ]);
    const [{ n }] = (
      await db.query<{ n: number }>(
        `select count(*)::int as n from countries where 'sms' = any (message_channels)`,
      )
    ).rows as [{ n: number }];
    expect(n).toBe(0);
    for (const row of DEMO_COUNTRIES) expect(row.message_channels, row.code).not.toContain('sms');
    // The office cannot make SMS a reporter's preference while the pack does not list it.
    const [{ src }] = (
      await db.query<{ src: string }>(
        `select prosrc as src from pg_proc where proname = 'update_reporter_contact'`,
      )
    ).rows as [{ src: string }];
    expect(src).toContain('channel_not_offered');
  });

  it('takes SMS out of every row, not only US and TR, and keeps the rest of each order', async () => {
    const db = await boot({ until: WHATSAPP_ONLY });
    expect(await channels(db)).toEqual([
      { code: 'TR', message_channels: '{push,whatsapp,sms}' },
      { code: 'US', message_channels: '{push,whatsapp,sms}' },
    ]);
    await db.exec(insertPack('ZY', '{sms,whatsapp}'));
    await db.exec(insertPack('ZZ', '{push,whatsapp}'));
    await applyMigration(db, WHATSAPP_ONLY);
    expect(await channels(db)).toEqual([
      { code: 'TR', message_channels: '{push,whatsapp}' },
      { code: 'US', message_channels: '{push,whatsapp}' },
      { code: 'ZY', message_channels: '{whatsapp}' },
      { code: 'ZZ', message_channels: '{push,whatsapp}' },
    ]);
    // Switching SMS back on is a forward migration of this one column, per pack.
    await db.exec(
      `update countries set message_channels = '{push,whatsapp,sms}' where code = 'US'`,
    );
    expect((await channels(db)).find((r) => r.code === 'US')).toEqual({
      code: 'US',
      message_channels: '{push,whatsapp,sms}',
    });
  });

  it('refuses, naming it, a pack that lists SMS but no WhatsApp', async () => {
    const db = await boot({ until: WHATSAPP_ONLY });
    await db.exec(insertPack('ZY', '{push,sms}'));
    await expect(applyMigration(db, WHATSAPP_ONLY)).rejects.toThrow(
      /packs with SMS and no WhatsApp: ZY/,
    );
  });
});
