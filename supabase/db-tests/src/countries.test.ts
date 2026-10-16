import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import {
  CountryRowSchema,
  deliverableChannels,
  IMPLEMENTED_MESSAGE_CHANNELS,
  messageChannelOrder,
  packCopyGaps,
  pickMessageTransport,
  smsRenderOptions,
  smsReplyAllowed,
  toCountryPack,
  type CountryRow,
} from '@sitelog/shared';
import { DEMO_COUNTRIES } from '@sitelog/shared/demo/countries.ts';
import {
  applyMigration,
  asService,
  asUser,
  bootDatabase,
  migrationFiles,
  probeAs,
  type Caller,
} from './harness.ts';

/**
 * W1-06a (GAP step 12a; D47, D48): 20261014000004_country_packs.sql and
 * 20261014000005_message_channel_columns.sql. The `countries` rows are the source of truth and
 * DEMO_COUNTRIES (packages/shared/src/demo/countries.ts) must equal them; the checks, the orgs
 * foreign key, create_org(p_country) with the deployed panel's 4-argument call, on_org_created's
 * paper, the service-only set_country_endpoints(), who reads the packs, every row's copy and
 * channels (packCopyGaps, the channel layer), a synthetic ZZ pack ("a new country is a new row")
 * and the messages.channel backfill on a live-shaped database.
 */

const PACKS = '20261014000004_country_packs.sql';
const CHANNELS = '20261014000005_message_channel_columns.sql';
const SEED_V1_0 = join(import.meta.dirname, 'fixtures', 'seed-v1.0.sql');

const LENA = 'cccccccc-1111-4111-8111-111111111111';
const NEW_USER = 'cccccccc-2222-4222-8222-222222222222';

let db: PGlite;

const svc = async <T>(sql: string, params: unknown[] = []) =>
  (await asService(db, (q) => q<T>(sql, params))).rows;

/** Runs `fn` in a transaction that is always rolled back (the tests share one database). */
async function rolledBack<T>(fn: () => Promise<T>): Promise<T> {
  await db.exec('begin');
  try {
    return await fn();
  } finally {
    await db.exec('rollback');
  }
}

async function sqlState(run: Promise<unknown>): Promise<string> {
  try {
    await run;
    return 'ok';
  } catch (err) {
    return (err as { code?: string }).code ?? String(err);
  }
}

type OrgPresets = {
  country: string;
  locale: string;
  units: string;
  currency: string;
  timezone: string;
  pdf_paper: string;
};

async function presets(orgId: string): Promise<OrgPresets> {
  const [row] = await svc<OrgPresets>(
    `select o.country, o.locale, o.units, o.currency, o.timezone, s.pdf_paper
     from orgs o join org_settings s on s.org_id = o.id where o.id = $1`,
    [orgId],
  );
  return row!;
}

/** create_org as a signed-in user; `args` is the SQL argument list. */
async function createOrg(args: string, params: unknown[] = []): Promise<string> {
  return asUser(
    db,
    LENA,
    async (q) =>
      (await q<{ r: { id: string } }>(`select create_org(${args}) as r`, params)).rows[0]!.r.id,
    'lena@example.test',
  );
}

const US_PRESETS: OrgPresets = {
  country: 'US',
  locale: 'en-US',
  units: 'imperial',
  currency: 'USD',
  timezone: 'America/Chicago',
  pdf_paper: 'letter',
};

beforeAll(async () => {
  db = await bootDatabase();
  await db.exec(
    `insert into auth.users (id, email) values ('${LENA}', 'lena@example.test'), ('${NEW_USER}', 'new@example.test');`,
  );
});

describe('country pack rows (§4.6)', () => {
  it('equals DEMO_COUNTRIES, both ways, and parses with CountryRowSchema', async () => {
    const rows = await svc<{ row: CountryRow }>(
      `select to_jsonb(c) as row from countries c order by code`,
    );
    for (const { row } of rows) expect(CountryRowSchema.safeParse(row).error).toBeUndefined();
    // created_at is the moment the migration ran; the fixture holds the migration's date.
    const strip = ({ created_at: _created, ...rest }: CountryRow) => rest;
    expect(rows.map((r) => strip(r.row))).toEqual(DEMO_COUNTRIES.map(strip));
  });

  it('every row has its copy and a built channel, and sends through console in week 1', async () => {
    const rows = await svc<{ row: CountryRow }>(
      `select to_jsonb(c) as row from countries c order by code`,
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const { row } of rows) {
      const pack = toCountryPack(row);
      // Every field locale has every SMS key the pack can send, in its two-way variant (§4.6).
      expect(packCopyGaps(pack), row.code).toEqual([]);
      expect(
        pack.messageChannels.some((c) =>
          (IMPLEMENTED_MESSAGE_CHANNELS as readonly string[]).includes(c),
        ),
        row.code,
      ).toBe(true);
      // No sender id in a fresh database: console, demo org or not (D47).
      expect(pickMessageTransport({ isDemo: false }, pack, 'sms'), row.code).toBe('console');
    }
    // The copy variant follows the pack: two-way US, one-way TR, links in both; no voice number yet.
    const byCode = new Map(rows.map(({ row }) => [row.code, toCountryPack(row)]));
    expect(smsRenderOptions(byCode.get('US')!)).toEqual({
      hasVoiceNumber: false,
      twoWay: true,
      linksAllowed: true,
    });
    expect(smsRenderOptions(byCode.get('TR')!)).toEqual({
      hasVoiceNumber: false,
      twoWay: false,
      linksAllowed: true,
    });
    // HELP, STOP and unknown senders get an answer on the two-way pack only.
    expect(smsReplyAllowed(byCode.get('US')!, 'help')).toBe(true);
    expect(smsReplyAllowed(byCode.get('TR')!, 'help')).toBe(false);
  });

  it('holds the US and TR launch values (spec §4.6), nothing per environment', async () => {
    const rows = await svc<Record<string, unknown>>(
      `select code, default_locale, field_locales, units, paper, currency, default_timezone,
              message_channels::text[] as message_channels, sms_provider, whatsapp_provider,
              sms_sender_type, sms_sender_id, two_way_sms, sms_links_allowed, voice_number,
              legal_keys
       from countries order by code`,
    );
    expect(rows).toEqual([
      {
        code: 'TR',
        default_locale: 'tr-TR',
        field_locales: ['tr-TR', 'en-US'],
        units: 'metric',
        paper: 'a4',
        currency: 'TRY',
        default_timezone: 'Europe/Istanbul',
        message_channels: ['push', 'sms'],
        sms_provider: 'iletimerkezi',
        whatsapp_provider: 'twilio',
        sms_sender_type: 'alphanumeric',
        sms_sender_id: null,
        two_way_sms: false,
        sms_links_allowed: true,
        voice_number: null,
        legal_keys: {},
      },
      {
        code: 'US',
        default_locale: 'en-US',
        field_locales: ['en-US', 'es-US'],
        units: 'imperial',
        paper: 'letter',
        currency: 'USD',
        default_timezone: 'America/Chicago',
        message_channels: ['push', 'sms'],
        sms_provider: 'twilio',
        whatsapp_provider: 'twilio',
        sms_sender_type: 'toll_free',
        sms_sender_id: null,
        two_way_sms: true,
        sms_links_allowed: true,
        voice_number: null,
        legal_keys: {},
      },
    ]);
  });

  it('defaults both providers to Twilio (D48)', async () => {
    const [row] = await svc<{ sms: string; wa: string }>(
      `select
         (select column_default from information_schema.columns
          where table_name = 'countries' and column_name = 'sms_provider') as sms,
         (select column_default from information_schema.columns
          where table_name = 'countries' and column_name = 'whatsapp_provider') as wa`,
    );
    expect(row).toEqual({ sms: "'twilio'::text", wa: "'twilio'::text" });
  });

  it.each([
    [
      'a duplicate code',
      `insert into countries select * from countries where code = 'US'`,
      '23505',
    ],
    [
      'two-way SMS from an alphanumeric sender',
      `update countries set two_way_sms = true where code = 'TR'`,
      '23514',
    ],
    [
      'no links in SMS without whatsapp or push',
      `update countries set sms_links_allowed = false where code = 'US'`,
      '23514',
    ],
    [
      'no links in SMS even with whatsapp (spec §19 Q24, 20261015000004)',
      `update countries set sms_links_allowed = false, message_channels = '{whatsapp,sms}' where code = 'US'`,
      '23514',
    ],
    [
      'a voice number that is not E.164',
      `update countries set voice_number = '555-0142' where code = 'US'`,
      '23514',
    ],
    ['a lowercase code', `update countries set code = 'us' where code = 'US'`, '23514'],
    [
      'no message channel',
      `update countries set message_channels = '{}' where code = 'US'`,
      '23514',
    ],
    [
      'an unsupported field locale',
      `update countries set field_locales = '{en-US,de-DE}' where code = 'US'`,
      '23514',
    ],
    [
      'an SMS provider without a driver',
      `update countries set sms_provider = 'vonage' where code = 'US'`,
      '23514',
    ],
    [
      'legal keys that are not an object',
      `update countries set legal_keys = '[]' where code = 'US'`,
      '23514',
    ],
    // The sender id's shape for its type: the table holds what set_country_endpoints() checks,
    // so a direct service write cannot leave a row CountryRowSchema rejects.
    ['a blank sender id', `update countries set sms_sender_id = '' where code = 'US'`, '23514'],
    [
      'a padded sender title',
      `update countries set sms_sender_id = ' SITELOG' where code = 'TR'`,
      '23514',
    ],
    [
      'an E.164 sender on an alphanumeric pack',
      `update countries set sms_sender_id = '+905320000512' where code = 'TR'`,
      '23514',
    ],
    [
      'a title on a toll-free pack',
      `update countries set sms_sender_id = 'SITELOG' where code = 'US'`,
      '23514',
    ],
  ])('refuses %s', async (_label, sql, code) => {
    expect(await rolledBack(() => sqlState(svc(sql)))).toBe(code);
  });

  it('refuses a sender type change that keeps a sender of the old shape (a later migration)', async () => {
    // A policy migration that moved TR to a long code on a database where SITELOG is set fails
    // at push time, instead of leaving a row toCountryPack() throws on.
    await rolledBack(async () => {
      await svc(`select set_country_endpoints('TR', 'SITELOG', null, null, null)`);
      expect(
        await sqlState(svc(`update countries set sms_sender_type = 'long_code' where code = 'TR'`)),
      ).toBe('23514');
    });
    // The same migration passes when it also clears the sender (set again for the new type).
    await rolledBack(async () => {
      await svc(`select set_country_endpoints('TR', 'SITELOG', null, null, null)`);
      await svc(
        `update countries set sms_sender_type = 'long_code', sms_sender_id = null where code = 'TR'`,
      );
      const [{ row }] = (await svc<{ row: CountryRow }>(
        `select to_jsonb(c) as row from countries c where code = 'TR'`,
      )) as [{ row: CountryRow }];
      expect(toCountryPack(row)).toMatchObject({ smsSenderType: 'long_code', smsSenderId: null });
    });
  });
});

describe('orgs.country → countries', () => {
  it('is a foreign key, not the old US/TR check', async () => {
    const defs = await svc<{ def: string }>(
      `select pg_get_constraintdef(oid) as def from pg_constraint
       where conrelid = 'orgs'::regclass and contype in ('c', 'f')
         and pg_get_constraintdef(oid) like '%country%'`,
    );
    expect(defs.map((d) => d.def)).toEqual(['FOREIGN KEY (country) REFERENCES countries(code)']);
  });

  it('refuses an org outside the packs and deleting a pack in use', async () => {
    const orgId = await createOrg(`'FK GC'`);
    expect(
      await rolledBack(() =>
        sqlState(svc(`update orgs set country = 'DE' where id = $1`, [orgId])),
      ),
    ).toBe('23503');
    expect(await rolledBack(() => sqlState(svc(`delete from countries where code = 'US'`)))).toBe(
      '23503',
    );
  });

  it('stops before the swap when an org has no pack (the W1-19 push)', async () => {
    const old = await bootDatabase({ until: PACKS });
    // Not possible under the old check: drop it to stand for a database that drifted.
    await old.exec(`alter table orgs drop constraint orgs_country_check;
      insert into orgs (name, country) values ('Drift GmbH', 'DE');`);
    await expect(applyMigration(old, PACKS)).rejects.toThrow(/orgs outside the country packs: DE/);
    await old.close();
  });
});

describe('create_org(p_country)', () => {
  it('presets a TR org from its pack: tr-TR, metric, TRY, Europe/Istanbul, A4', async () => {
    const orgId = await createOrg(`p_name => 'Demir Yapı', p_country => 'TR'`);
    expect(await presets(orgId)).toEqual({
      country: 'TR',
      locale: 'tr-TR',
      units: 'metric',
      currency: 'TRY',
      timezone: 'Europe/Istanbul',
      pdf_paper: 'a4',
    });
    const audit = await svc<{ actor_id: string; diff: unknown }>(
      `select actor_id, diff from audit_log where entity_id = $1 and action = 'org.created'`,
      [orgId],
    );
    expect(audit).toEqual([{ actor_id: LENA, diff: { country: 'TR' } }]);
  });

  it("still takes the deployed panel's call: the 4 named arguments make a US org", async () => {
    // apps/web/src/app/setup/Page.tsx before W1-06a (PostgREST passes named arguments).
    const orgId = await createOrg(
      `p_name => $1, p_timezone => $2, p_address => $3, p_license_no => $4`,
      ['Fresh Build Co', 'America/Chicago', null, null],
    );
    expect(await presets(orgId)).toEqual(US_PRESETS);
    expect(await presets(await createOrg(`'Other GC'`))).toEqual(US_PRESETS);
  });

  it('keeps an explicit time zone, normalises the code and refuses an unknown one', async () => {
    const denver = await createOrg(`p_name => 'Mile High', p_timezone => 'America/Denver'`);
    expect((await presets(denver)).timezone).toBe('America/Denver');
    const blankTz = await createOrg(`p_name => 'Blank TZ', p_timezone => ' ', p_country => ' tr '`);
    expect(await presets(blankTz)).toMatchObject({ country: 'TR', timezone: 'Europe/Istanbul' });
    expect(await sqlState(createOrg(`p_name => 'Nowhere', p_country => 'xx'`))).toBe('22023');
  });

  it('has one signature: the 4-argument function is gone (no PGRST203 ambiguity)', async () => {
    const fns = await svc<{ fn: string }>(
      `select oid::regprocedure::text as fn from pg_proc where proname = 'create_org'`,
    );
    expect(fns.map((f) => f.fn)).toEqual(['create_org(text,text,text,text,text)']);
  });

  it('presets the paper of a service insert too (on_org_created)', async () => {
    const [{ id }] = (await svc<{ id: string }>(
      `insert into orgs (name, country) values ('Service TR', 'TR') returning id`,
    )) as [{ id: string }];
    expect((await presets(id)).pdf_paper).toBe('a4');
  });
});

describe('set_country_endpoints() (service role only)', () => {
  it('sets a sender id and a voice number per pack type, audited', async () => {
    await rolledBack(async () => {
      const [tr] = await svc<{ r: CountryRow }>(
        `select to_jsonb(set_country_endpoints('tr', ' SITELOG ', null, null, null)) as r`,
      );
      expect(tr!.r).toMatchObject({ code: 'TR', sms_sender_id: 'SITELOG', voice_number: null });
      const [us] = await svc<{ r: CountryRow }>(
        `select to_jsonb(set_country_endpoints('US', '+18885550142', '+15550142290', null, null)) as r`,
      );
      expect(us!.r).toMatchObject({ sms_sender_id: '+18885550142', voice_number: '+15550142290' });
      expect(toCountryPack(us!.r).voiceNumber).toBe('+15550142290');
      const audit = await svc<Record<string, unknown>>(
        `select org_id, actor_type, actor_id, entity, entity_id, diff from audit_log
         where action = 'country.endpoints_set' order by id`,
      );
      expect(audit).toEqual([
        {
          org_id: null,
          actor_type: 'system',
          actor_id: null,
          entity: 'country',
          entity_id: null,
          diff: {
            code: 'TR',
            from: {
              sms_sender_id: null,
              voice_number: null,
              whatsapp_sender_id: null,
              whatsapp_templates: null,
            },
            to: {
              sms_sender_id: 'SITELOG',
              voice_number: null,
              whatsapp_sender_id: null,
              whatsapp_templates: null,
            },
          },
        },
        {
          org_id: null,
          actor_type: 'system',
          actor_id: null,
          entity: 'country',
          entity_id: null,
          diff: {
            code: 'US',
            from: {
              sms_sender_id: null,
              voice_number: null,
              whatsapp_sender_id: null,
              whatsapp_templates: null,
            },
            to: {
              sms_sender_id: '+18885550142',
              voice_number: '+15550142290',
              whatsapp_sender_id: null,
              whatsapp_templates: null,
            },
          },
        },
      ]);
      // A blank value clears it (back to console, Talk now only).
      const [cleared] = await svc<{ r: CountryRow }>(
        `select to_jsonb(set_country_endpoints('US', '', null, null, null)) as r`,
      );
      expect(cleared!.r).toMatchObject({ sms_sender_id: null, voice_number: null });
    });
  });

  it.each([
    ['an E.164 sender on an alphanumeric pack', `'TR', '+905320000512', null, null, null`],
    ['a 12-character title', `'TR', 'SITELOGAPP12', null, null, null`],
    ['a title on a toll-free pack', `'US', 'SITELOG', null, null, null`],
    ['a malformed voice number', `'US', null, '555-0142', null, null`],
    ['an unknown pack', `'DE', null, null, null, null`],
    ['a WhatsApp sender that is not E.164 (W2-15)', `'TR', null, null, '0532 000 0000', null`],
    ['WhatsApp templates that are not an object', `'TR', null, null, null, '[]'::jsonb`],
    [
      'a template with a bad content sid',
      `'TR', null, null, null, '{"daily_link":{"tr":"HX1"}}'::jsonb`,
    ],
    [
      'a template in another language',
      `'TR', null, null, null, '{"daily_link":{"de":"HX${'a'.repeat(32)}"}}'::jsonb`,
    ],
    [
      'a template key that is not a key',
      `'TR', null, null, null, '{"Daily Link":{"tr":"HX${'a'.repeat(32)}"}}'::jsonb`,
    ],
  ])('refuses %s (22023)', async (_label, args) => {
    expect(await rolledBack(() => sqlState(svc(`select set_country_endpoints(${args})`)))).toBe(
      '22023',
    );
  });

  it('sets and clears the WhatsApp sender and template ids, audited (W2-15)', async () => {
    await rolledBack(async () => {
      const sid = `HX${'b'.repeat(32)}`;
      const [set] = await svc<{ r: Record<string, unknown> }>(
        `select to_jsonb(set_country_endpoints('TR', null, null, ' +905320000000 ', '{"daily_link":{"tr":"${sid}"}}'::jsonb)) as r`,
      );
      expect(set!.r).toMatchObject({
        whatsapp_sender_id: '+905320000000',
        whatsapp_templates: { daily_link: { tr: sid } },
      });
      const [audit] = await svc<{ diff: Record<string, Record<string, unknown>> }>(
        `select diff from audit_log where action = 'country.endpoints_set' order by id desc limit 1`,
      );
      expect(audit!.diff.to).toMatchObject({
        whatsapp_sender_id: '+905320000000',
        whatsapp_templates: { daily_link: { tr: sid } },
      });
      // {} clears the templates; one sender per pack (the inbound lookup, W2-16).
      const [cleared] = await svc<{ r: Record<string, unknown> }>(
        `select to_jsonb(set_country_endpoints('TR', null, null, '+905320000000', '{}'::jsonb)) as r`,
      );
      expect(cleared!.r).toMatchObject({ whatsapp_templates: null });
      expect(
        await sqlState(
          svc(`select set_country_endpoints('US', null, null, '+905320000000', null)`),
        ),
      ).toBe('23505');
    });
  });

  it('runs as the service role, and cannot be run by a signed-in user or anon', async () => {
    const sql = `select set_country_endpoints('TR', 'SITELOG', null, null, null)`;
    for (const caller of [
      { role: 'authenticated', userId: LENA },
      { role: 'anon' },
    ] satisfies Caller[]) {
      const res = await probeAs(db, caller, sql);
      expect(res, caller.role).toMatchObject({ ok: false, code: '42501' });
    }
    // svc() runs as the migration owner, as pnpm countries:set does (SUPABASE_DB_URL's user;
    // countries-set.test.ts runs it as service_role). service_role keeps EXECUTE through
    // Supabase's default privileges (the revoke names public, anon, authenticated).
    const [priv] = await svc<{ ok: boolean }>(
      `select has_function_privilege('service_role', 'set_country_endpoints(text,text,text,text,jsonb)', 'execute') as ok`,
    );
    expect(priv!.ok).toBe(true);
    await rolledBack(async () => {
      await db.exec('set local role service_role');
      const res = await db.query<{ code: string; sms_sender_id: string }>(
        `select code, sms_sender_id from set_country_endpoints('TR', 'SITELOG', null, null, null)`,
      );
      expect(res.rows).toEqual([{ code: 'TR', sms_sender_id: 'SITELOG' }]);
    });
  });
});

describe('who reads the packs (§6.5)', () => {
  it('every signed-in user, member of an org or not; anon nobody', async () => {
    const res = await probeAs(
      db,
      { role: 'authenticated', userId: NEW_USER },
      `select code from countries order by code`,
    );
    expect(res).toMatchObject({ ok: true, rows: [{ code: 'TR' }, { code: 'US' }] });
    expect(await probeAs(db, { role: 'anon' }, `select code from countries`)).toMatchObject({
      ok: false,
      code: '42501',
    });
  });

  it('no client writes a pack', async () => {
    const user: Caller = { role: 'authenticated', userId: LENA };
    for (const sql of [
      `insert into countries (code, default_locale, field_locales, units, paper, currency, default_timezone, message_channels, sms_sender_type, two_way_sms, sms_links_allowed) values ('ZY', 'en-US', '{en-US}', 'metric', 'a4', 'EUR', 'UTC', '{sms}', 'long_code', true, true)`,
      `update countries set sms_sender_id = '+18885550142' where code = 'US'`,
      `delete from countries where code = 'TR'`,
    ])
      expect(await probeAs(db, user, sql), sql).toMatchObject({ ok: false, code: '42501' });
  });
});

describe('a new country is a new row (ZZ)', () => {
  it('create_org presets from a pack no code knows about', async () => {
    await rolledBack(async () => {
      await svc(
        `insert into countries (code, default_locale, field_locales, units, paper, currency,
           default_timezone, message_channels, sms_provider, whatsapp_provider, sms_sender_type,
           sms_sender_id, two_way_sms, sms_links_allowed, voice_number, legal_keys)
         values ('ZZ', 'en-US', '{es-US}', 'metric', 'a4', 'EUR', 'UTC', '{whatsapp,sms}',
           'twilio', 'twilio', 'alphanumeric', null, false, true, null, '{}')`,
      );
      const orgId = await createOrg(`p_name => 'Zed Bau', p_country => 'ZZ'`);
      expect(await presets(orgId)).toEqual({
        country: 'ZZ',
        locale: 'en-US',
        units: 'metric',
        currency: 'EUR',
        timezone: 'UTC',
        pdf_paper: 'a4',
      });
      const [{ row }] = (await svc<{ row: CountryRow }>(
        `select to_jsonb(c) as row from countries c where code = 'ZZ'`,
      )) as [{ row: CountryRow }];
      const zz = toCountryPack(row);
      expect(zz.messageChannels).toEqual(['whatsapp', 'sms']);
      // Its language (Spanish) has all the one-way copy: no code change for this row.
      expect(packCopyGaps(zz)).toEqual([]);
      // The channel layer follows its flags: WhatsApp first, but not built until week 2, so
      // every message goes by SMS (a pack must allow links in SMS, spec §19 Q24).
      expect(messageChannelOrder(zz, null)).toEqual(['whatsapp', 'sms']);
      const reach = (key: 'daily_link' | 'verify_code' | 'edit_applied') =>
        deliverableChannels({
          pack: zz,
          key,
          preferred: null,
          consents: new Set(['sms', 'recording']),
          revoked: new Set(),
          optedOut: new Set(),
        });
      expect(reach('daily_link')).toEqual(['sms']);
      expect(reach('verify_code')).toEqual(['sms']);
      expect(reach('edit_applied')).toEqual(['sms']);
      expect(smsRenderOptions(zz)).toEqual({
        hasVoiceNumber: false,
        twoWay: false,
        linksAllowed: true,
      });
      expect(smsReplyAllowed(zz, 'stop_confirm')).toBe(false); // one-way
    });
  });
});

describe('messages.channel backfill (20261014000005) on a live-shaped database', () => {
  it('marks SMS rows only: Meta WhatsApp and office-photo rows stay null', async () => {
    const files = migrationFiles();
    const from = '20261014000002_backfill_uploads_compat.sql';
    const live = await bootDatabase({ until: from });
    await live.exec(readFileSync(SEED_V1_0, 'utf8'));
    for (const f of files.filter((f) => f >= from && f < CHANNELS)) await applyMigration(live, f);
    const q = async <T>(sql: string) => (await live.query<T>(sql)).rows;
    const [org] = await q<{ id: string }>(`select id from orgs limit 1`);
    const [rep] = await q<{ id: string; phone_e164: string }>(
      `select id, phone_e164 from reporters where org_id = '${org!.id}' limit 1`,
    );
    await live.exec(`
      insert into messages (org_id, reporter_id, phone_e164, direction, body, status, provider, copy_key)
      values ('${org!.id}', '${rep!.id}', '${rep!.phone_e164}', 'out', 'Your link', 'sent', 'console', 'daily_link');
      insert into messages (org_id, direction, type, storage_path, status)
      values ('${org!.id}', 'in', 'image', '${org!.id}/office/photo.jpg', 'received');`);
    const before = await q<{ id: string; kind: string }>(
      `select id, case when conversation_id is not null then 'meta'
                       when phone_e164 is null then 'office' else 'sms' end as kind
       from messages order by id`,
    );
    expect(new Set(before.map((m) => m.kind))).toEqual(new Set(['meta', 'office', 'sms']));
    await applyMigration(live, CHANNELS);
    const after = await q<{ id: string; channel: string | null }>(
      `select id, channel::text as channel from messages order by id`,
    );
    expect(after).toEqual(
      before.map((m) => ({ id: m.id, channel: m.kind === 'sms' ? 'sms' : null })),
    );
    const [reporter] = await q<{ n: number }>(
      `select count(*)::int as n from reporters where message_channel is not null`,
    );
    expect(reporter!.n).toBe(0);
    await live.close();
  });
});
