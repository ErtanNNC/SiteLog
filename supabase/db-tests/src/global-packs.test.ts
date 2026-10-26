import { afterAll, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { phoneRegions } from '@sitelog/shared/phone-regions.ts';
import { GLOBAL_PACK_CODES } from '@sitelog/shared/countries-global.ts';
import { applyMigration, bootDatabase } from './harness.ts';

/**
 * §19 Q379 (decided by the owner 2026-10-26; 20261026000100_global_packs.sql): every country has a
 * pack. Every region the phone picker knows has a row; the shared pack is English, push then
 * WhatsApp, USD billed through Stripe, metric and A4 except where a country uses imperial or US
 * Letter; and each new pack takes the database's US WhatsApp sender and templates, audited.
 */

const GLOBAL = '20261026000100_global_packs.sql';
const WA_SENDER = '+15550142299';
const SID = `HX${'a'.repeat(32)}`;

const open: PGlite[] = [];
async function boot(opts: { until?: string } = {}): Promise<PGlite> {
  const db = await bootDatabase(opts);
  open.push(db);
  return db;
}

afterAll(async () => {
  await Promise.all(open.map((db) => db.close()));
});

describe('§19 Q379: a country pack for every country', () => {
  it('has a row for every phone region, the shared pack for all but US and TR', async () => {
    const db = await boot();
    const codes = (
      await db.query<{ code: string }>(`select code from countries order by code`)
    ).rows.map((r) => r.code);
    expect(codes).toEqual(
      phoneRegions('en')
        .map((r) => r.code)
        .sort(),
    );
    expect([...GLOBAL_PACK_CODES, 'TR', 'US'].sort()).toEqual(codes);
    const pack = async (code: string) =>
      (
        await db.query<Record<string, unknown>>(
          `select default_locale, field_locales::text, units, paper, currency, default_timezone,
                  message_channels::text, voice_number, billing_provider_for_country(code) as billing
           from countries where code = $1`,
          [code],
        )
      ).rows[0];
    expect(await pack('DE')).toEqual({
      default_locale: 'en-US',
      field_locales: '{en-US}',
      units: 'metric',
      paper: 'a4',
      currency: 'USD',
      default_timezone: 'Europe/Berlin',
      message_channels: '{push,whatsapp}',
      voice_number: null,
      billing: 'stripe',
    });
    expect(await pack('CA')).toMatchObject({ units: 'metric', paper: 'letter' });
    expect(await pack('LR')).toMatchObject({ units: 'imperial', paper: 'a4' });
    // A USD price exists for every new pack's currency, as create_org() reads it.
    const [{ n }] = (
      await db.query<{ n: number }>(
        `select count(*)::int as n from countries c
         where not exists (select 1 from billing_default_prices p where p.currency = c.currency)
           and c.code <> 'TR'`,
      )
    ).rows as [{ n: number }];
    expect(n).toBe(0);
  });

  it('copies the US WhatsApp sender and templates into each new pack, audited', async () => {
    const db = await boot({ until: GLOBAL });
    await db.query(`select set_country_endpoints('US', null, null, $1, $2::jsonb, null)`, [
      WA_SENDER,
      JSON.stringify({ daily_link: { en: SID } }),
    ]);
    await applyMigration(db, GLOBAL);
    const de = (
      await db.query<{ whatsapp_sender_id: string; whatsapp_templates: unknown }>(
        `select whatsapp_sender_id, whatsapp_templates from countries where code = 'DE'`,
      )
    ).rows[0];
    expect(de).toEqual({
      whatsapp_sender_id: WA_SENDER,
      whatsapp_templates: { daily_link: { en: SID } },
    });
    const [{ n }] = (
      await db.query<{ n: number }>(
        `select count(*)::int as n from audit_log
         where action = 'country.endpoints_set' and diff ->> 'code' not in ('US', 'TR')`,
      )
    ).rows as [{ n: number }];
    expect(n).toBe(GLOBAL_PACK_CODES.length);
    const tr = (
      await db.query<{ whatsapp_sender_id: string | null }>(
        `select whatsapp_sender_id from countries where code = 'TR'`,
      )
    ).rows[0];
    expect(tr?.whatsapp_sender_id ?? null).toBeNull();
  });
});
