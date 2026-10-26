import { afterAll, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { DEMO_COUNTRIES } from '@sitelog/shared/demo/countries.ts';
import { applyMigration, bootDatabase } from './harness.ts';

/**
 * §19 Q378 (decided by the owner 2026-10-25; 20261025000100_turkish_off.sql): Turkish is off. The
 * TR pack speaks English (DEMO_COUNTRIES says the same), and the orgs, office users and reporters
 * that spoke Turkish move to English, the reporters with one audit row per org. The rest of the
 * pack stays.
 */

const TURKISH_OFF = '20261025000100_turkish_off.sql';
const ORG = '00000000-0000-4000-8000-0000000000a1';
const US_ORG = '00000000-0000-4000-8000-0000000000a2';
const USER = '00000000-0000-4000-8000-0000000000b1';

const open: PGlite[] = [];
async function boot(opts: { until?: string; seed?: boolean } = {}): Promise<PGlite> {
  const db = await bootDatabase(opts);
  open.push(db);
  return db;
}

afterAll(async () => {
  await Promise.all(open.map((db) => db.close()));
});

const packs = async (db: PGlite) =>
  (
    await db.query<{ code: string; default_locale: string; field_locales: string }>(
      `select code, default_locale, field_locales::text from countries
       where code in ('TR', 'US') order by code`,
    )
  ).rows;

describe('§19 Q378: Turkish off', () => {
  it('leaves the TR pack in English after the migrations, the rest of the pack unchanged', async () => {
    const db = await boot();
    expect(await packs(db)).toEqual([
      { code: 'TR', default_locale: 'en-US', field_locales: '{en-US}' },
      { code: 'US', default_locale: 'en-US', field_locales: '{en-US,es-US}' },
    ]);
    const tr = DEMO_COUNTRIES.find((c) => c.code === 'TR')!;
    expect([tr.default_locale, tr.field_locales]).toEqual(['en-US', ['en-US']]);
    const [row] = (
      await db.query<{ currency: string; default_timezone: string; message_channels: string }>(
        `select currency, default_timezone, message_channels::text from countries where code = 'TR'`,
      )
    ).rows;
    expect(row).toEqual({
      currency: 'TRY',
      default_timezone: 'Europe/Istanbul',
      message_channels: '{push,whatsapp}',
    });
  });

  it('moves Turkish orgs, office users and reporters to English, and audits the reporters', async () => {
    const db = await boot({ until: TURKISH_OFF });
    await db.exec(`
      insert into auth.users (id, email) values ('${USER}', 'office@example.test');
      insert into orgs (id, name, country, currency, locale) values
        ('${ORG}', 'Demo TR', 'TR', 'TRY', 'tr-TR'),
        ('${US_ORG}', 'Demo US', 'US', 'USD', 'en-US');
      insert into org_members (org_id, user_id, role, ui_locale) values
        ('${ORG}', '${USER}', 'admin', 'tr-TR');
      insert into reporters (org_id, name, phone_e164, status, locale) values
        ('${ORG}', 'Ali', '+905550000001', 'active', 'tr-TR'),
        ('${ORG}', 'Ayşe', '+905550000002', 'active', 'tr-TR'),
        ('${ORG}', 'Ana', '+905550000003', 'active', 'es-US'),
        ('${US_ORG}', 'Dana', '+15550000004', 'active', 'en-US');
    `);
    await applyMigration(db, TURKISH_OFF);

    const orgs = (await db.query<{ locale: string }>(`select locale from orgs order by name`)).rows;
    expect(orgs).toEqual([{ locale: 'en-US' }, { locale: 'en-US' }]);
    const members = (
      await db.query<{ ui_locale: string | null }>(`select ui_locale from org_members`)
    ).rows;
    expect(members).toEqual([{ ui_locale: null }]);
    const reporters = (
      await db.query<{ name: string; locale: string }>(
        `select name, locale from reporters order by name`,
      )
    ).rows;
    expect(reporters).toEqual([
      { name: 'Ali', locale: 'en-US' },
      { name: 'Ana', locale: 'es-US' },
      { name: 'Ayşe', locale: 'en-US' },
      { name: 'Dana', locale: 'en-US' },
    ]);
    const audit = (
      await db.query<{ org_id: string; actor_type: string; diff: Record<string, unknown> }>(
        `select org_id, actor_type, diff from audit_log where action = 'reporter.locale_set'`,
      )
    ).rows;
    expect(audit).toEqual([
      {
        org_id: ORG,
        actor_type: 'system',
        diff: { from: 'tr-TR', to: 'en-US', reporters: 2, reason: 'turkish_off' },
      },
    ]);
  });
});
