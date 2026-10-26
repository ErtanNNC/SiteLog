import { beforeAll, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import type { CountriesSetConnection, Query } from '../../../scripts/src/countries-set.ts';
import { runWhatsappTemplates, type Fetch } from '../../../scripts/src/whatsapp-templates.ts';
import { bootDatabase } from './harness.ts';

/**
 * `pnpm whatsapp:templates -- --sync` (scripts/src/whatsapp-templates.ts) against the migrated
 * schema: the approved content sids reach `countries.whatsapp_templates` through
 * set_country_endpoints() with one `country.endpoints_set` audit row, entries already there are
 * kept, a Marketing one is not written, and a repeat writes nothing. Twilio is a fake fetch.
 */

let db: PGlite;

beforeAll(async () => {
  db = await bootDatabase();
});

const query: Query = async (text, params) => (await db.query(text, params)).rows;
const LOCAL = 'postgresql://postgres:s3cret-pw@127.0.0.1:54322/postgres';
const hx = (n: number) => `HX${n.toString(16).padStart(32, '0')}`;

async function rolledBack<T>(fn: () => Promise<T>): Promise<T> {
  await db.exec('begin; set local role service_role;');
  try {
    return await fn();
  } finally {
    await db.exec('rollback');
  }
}

const connect = async (): Promise<CountriesSetConnection> => ({
  async transaction(fn) {
    await db.exec('savepoint wa_templates');
    try {
      const out = await fn(query);
      await db.exec('release savepoint wa_templates');
      return out;
    } catch (err) {
      await db.exec('rollback to savepoint wa_templates');
      throw err;
    }
  },
  end: async () => undefined,
});

/** ContentAndApprovals with these templates, every one approved in its category. */
function listing(items: Array<[number, string, string]>): Fetch {
  return async () =>
    new Response(
      JSON.stringify({
        contents: items.map(([n, name, category]) => ({
          sid: hx(n),
          friendly_name: name,
          language: name.slice(-2),
          types: {},
          approval_requests: { name, category, status: 'approved', rejection_reason: '' },
        })),
        meta: { next_page_url: null },
      }),
    );
}

const env = {
  SUPABASE_DB_URL: LOCAL,
  TWILIO_ACCOUNT_SID: `AC${'1'.repeat(32)}`,
  TWILIO_AUTH_TOKEN: 'token',
};

describe('whatsapp:templates --sync on the migrated schema', () => {
  it('merges approved sids into the pack, audited once; a repeat writes nothing', async () => {
    await rolledBack(async () => {
      await query(`select set_country_endpoints('TR', null, null, null, $1::text::jsonb, null)`, [
        JSON.stringify({ filed: { tr: hx(90) } }),
      ]);
      // §19 Q378: the TR pack speaks English, so it takes the English templates.
      const fetch = listing([
        [1, 'talkolog_welcome_v2_en', 'UTILITY'],
        [2, 'talkolog_verify_code_en', 'AUTHENTICATION'],
        [3, 'talkolog_daily_link_v2_en', 'MARKETING'],
      ]);
      const deps = { env, connect, fetch, log: () => undefined };
      const out = await runWhatsappTemplates(['--sync', '--code', 'TR'], deps);
      expect(out).toMatchObject({ mode: 'sync', changed: ['TR'] });
      const [row] = (await query(
        `select whatsapp_templates from countries where code = 'TR'`,
        [],
      )) as Array<{
        whatsapp_templates: unknown;
      }>;
      expect(row!.whatsapp_templates).toEqual({
        filed: { tr: hx(90) },
        welcome: { en: hx(1) },
        verify_code: { en: hx(2) },
      });
      const audits = await query(
        `select diff from audit_log where action = 'country.endpoints_set' order by id`,
        [],
      );
      expect(audits).toHaveLength(2);
      expect(await runWhatsappTemplates(['--sync', '--code', 'TR'], deps)).toMatchObject({
        changed: [],
      });
      expect(
        await query(`select 1 from audit_log where action = 'country.endpoints_set'`, []),
      ).toHaveLength(2);
    });
  });
});
