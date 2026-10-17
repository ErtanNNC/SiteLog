import { beforeAll, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import {
  applyCountriesSet,
  parseCountriesSetArgs,
  runCountriesSet,
  type CountriesSetConnection,
  type PackEndpoints,
  type Query,
} from '../../../scripts/src/countries-set.ts';
import { bootDatabase } from './harness.ts';

/**
 * `pnpm countries:set` (scripts/src/countries-set.ts) against the migrated schema: its SQL (the
 * column list, `for update`, the call through set_country_endpoints() and its `$n` bindings) and
 * its claims (a flag left out keeps the value, an unchanged run writes and audits nothing, one
 * `country.endpoints_set` row per write, a bad sender stops before any write). The unit tests in
 * scripts/ run the same code over a fake; this file is what fails when a migration renames or
 * retypes a `countries` column or changes the function.
 *
 * The queries run as `service_role` (no RLS, Supabase's grants only): the script's connection is
 * the database owner, which may do at least as much.
 */

let db: PGlite;

beforeAll(async () => {
  db = await bootDatabase();
});

/** The script's query function over PGlite (postgres.js `sql.unsafe` in the script). */
const query: Query = async (text, params) => (await db.query(text, params)).rows;

/** Runs `fn` as the service role in a transaction that is always rolled back (one shared db). */
async function rolledBack<T>(fn: () => Promise<T>): Promise<T> {
  await db.exec('begin; set local role service_role;');
  try {
    return await fn();
  } finally {
    await db.exec('rollback');
  }
}

const run = (...argv: string[]) => applyCountriesSet(query, parseCountriesSetArgs(argv));

async function pack(code: string): Promise<PackEndpoints> {
  const [row] = (await query(
    `select code, sms_provider, sms_sender_type, sms_sender_id, voice_number, field_locales,
            whatsapp_provider, whatsapp_sender_id, whatsapp_templates, outbound_trunk_id
       from countries where code = $1`,
    [code],
  )) as PackEndpoints[];
  return row!;
}

async function audits(): Promise<unknown[]> {
  const rows = (await query(
    `select org_id, actor_type, entity, diff from audit_log
      where action = 'country.endpoints_set' order by id`,
    [],
  )) as Array<{ diff: unknown }>;
  return rows;
}

describe('countries:set on the migrated schema', () => {
  it('sets the US voice number, then the sender keeping it; a repeat writes nothing', async () => {
    await rolledBack(async () => {
      const voice = await run('--code', 'US', '--voice', '+15550142290');
      expect(voice).toMatchObject({
        changed: true,
        before: {
          code: 'US',
          sms_sender_type: 'toll_free',
          sms_sender_id: null,
          voice_number: null,
        },
        after: { sms_sender_id: null, voice_number: '+15550142290' },
      });

      const sender = await run('--code', 'US', '--sms-sender', '+18885550142');
      expect(sender).toMatchObject({
        changed: true,
        after: {
          sms_provider: 'twilio',
          sms_sender_id: '+18885550142',
          voice_number: '+15550142290',
        },
      });
      expect(await pack('US')).toEqual(sender.after);

      // The same voice number again: nothing written, nothing audited.
      const again = await run('--code', 'US', '--voice', '+15550142290');
      expect(again.changed).toBe(false);
      expect(again.after).toEqual(sender.after);

      expect(await audits()).toEqual([
        {
          org_id: null,
          actor_type: 'system',
          entity: 'country',
          diff: {
            code: 'US',
            from: {
              sms_sender_id: null,
              voice_number: null,
              whatsapp_sender_id: null,
              whatsapp_templates: null,
              outbound_trunk_id: null,
            },
            to: {
              sms_sender_id: null,
              voice_number: '+15550142290',
              whatsapp_sender_id: null,
              whatsapp_templates: null,
              outbound_trunk_id: null,
            },
          },
        },
        {
          org_id: null,
          actor_type: 'system',
          entity: 'country',
          diff: {
            code: 'US',
            from: {
              sms_sender_id: null,
              voice_number: '+15550142290',
              whatsapp_sender_id: null,
              whatsapp_templates: null,
              outbound_trunk_id: null,
            },
            to: {
              sms_sender_id: '+18885550142',
              voice_number: '+15550142290',
              whatsapp_sender_id: null,
              whatsapp_templates: null,
              outbound_trunk_id: null,
            },
          },
        },
      ]);

      // --clear-sms-sender: back to the console transport; the voice number stays.
      const cleared = await run('--code', 'US', '--clear-sms-sender');
      expect(cleared.after).toMatchObject({ sms_sender_id: null, voice_number: '+15550142290' });
      expect(await pack('US')).toEqual(cleared.after);
      expect(await audits()).toHaveLength(3);
    });
  });

  it('sets the TR title once (one audit row), and clears it', async () => {
    await rolledBack(async () => {
      const set = await run('--code', 'tr', '--sms-sender', 'SITELOG');
      expect(set).toMatchObject({
        changed: true,
        after: { code: 'TR', sms_provider: 'iletimerkezi', sms_sender_id: 'SITELOG' },
      });
      expect(await run('--code', 'TR', '--sms-sender', 'SITELOG')).toMatchObject({
        changed: false,
      });
      expect(await audits()).toHaveLength(1);
      const cleared = await run('--code', 'TR', '--clear-sms-sender');
      expect(cleared.after.sms_sender_id).toBeNull();
      expect(await audits()).toHaveLength(2);
    });
  });

  it('stops before writing on a sender of the wrong shape or an unknown pack', async () => {
    await rolledBack(async () => {
      const before = await pack('TR');
      // The script's own check, from the sender type it read (not the database's 22023).
      await expect(run('--code', 'TR', '--sms-sender', '+905320000000')).rejects.toThrow(
        'not a valid alphanumeric sender',
      );
      expect(await pack('TR')).toEqual(before);
      await expect(run('--code', 'DE', '--clear-voice')).rejects.toThrow('no country pack DE');
      expect(await audits()).toEqual([]);
    });
  });
});

describe('runCountriesSet on PGlite', () => {
  /** A connection whose transaction is a savepoint inside rolledBack(). */
  function savepointConnection() {
    const calls = { connect: 0, end: 0 };
    const connect = async (): Promise<CountriesSetConnection> => {
      calls.connect += 1;
      return {
        async transaction(fn) {
          await db.exec('savepoint countries_set');
          try {
            const out = await fn(query);
            await db.exec('release savepoint countries_set');
            return out;
          } catch (err) {
            await db.exec('rollback to savepoint countries_set');
            throw err;
          }
        },
        async end() {
          calls.end += 1;
        },
      };
    };
    return { connect, calls };
  }
  const LOCAL = 'postgresql://postgres:s3cret-pw@127.0.0.1:54322/postgres';

  it('writes, logs the target without the password, and closes the connection', async () => {
    await rolledBack(async () => {
      const { connect, calls } = savepointConnection();
      const lines: string[] = [];
      const result = await runCountriesSet(['--code', 'TR', '--sms-sender', 'SITELOG'], {
        env: { SUPABASE_DB_URL: LOCAL },
        connect,
        log: (l) => lines.push(l),
      });
      expect(result.after.sms_sender_id).toBe('SITELOG');
      expect(await pack('TR')).toEqual(result.after);
      expect(calls).toEqual({ connect: 1, end: 1 });
      expect(lines).toHaveLength(3);
      expect(lines[2]).toContain('SITELOG (sends through iletimerkezi)');
      expect(lines.join('\n')).not.toContain('s3cret-pw');
      expect(await audits()).toHaveLength(1);
    });
  });

  it('refuses a hosted target without --yes before connecting', async () => {
    const { connect, calls } = savepointConnection();
    await expect(
      runCountriesSet(['--code', 'TR', '--sms-sender', 'SITELOG'], {
        env: {
          SUPABASE_DB_URL:
            'postgresql://postgres:s3cret-pw@db.abcdefghijklmnopqrst.supabase.co:5432/postgres',
        },
        connect,
        log: () => undefined,
      }),
    ).rejects.toThrow('--yes');
    expect(calls.connect).toBe(0);
  });
});
