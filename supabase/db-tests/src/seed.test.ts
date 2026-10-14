import { beforeAll, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { DEMO_ORG_ID, DEMO_USERS } from '@sitelog/shared/demo/kestrel.ts';
import { buildDemirDemo, DEMIR_ORG_ID } from '@sitelog/shared/demo/demir.ts';
import { asUser, bootDatabase } from './harness.ts';

let db: PGlite;
const LENA = DEMO_USERS[0]!.id;
const ACCOUNTS = DEMO_USERS[2]!.id;

beforeAll(async () => {
  db = await bootDatabase({ seed: true });
});

const count = async (sql: string, params: unknown[] = []) =>
  (await db.query<{ n: number }>(sql, params)).rows[0]!.n;

describe('seed.sql (§18 demo orgs)', () => {
  it('loads the §18.1 org, sites and people', async () => {
    const counts = await db.query<{ t: string; n: number }>(
      `
      select 'sites' as t, count(*)::int as n from sites where org_id = $1 union all
      select 'reporters', count(*)::int from reporters where org_id = $1 union all
      select 'companies', count(*)::int from companies where org_id = $1 union all
      select 'site_days', count(*)::int from site_days sd join sites s on s.id = sd.site_id where s.org_id = $1 union all
      select 'reports', count(*)::int from reports where org_id = $1 union all
      select 'texts', count(*)::int from messages where org_id = $1 union all
      select 'uploads', count(*)::int from uploads u join sites s on s.id = u.site_id where s.org_id = $1 union all
      select 'calls', count(*)::int from calls where org_id = $1 union all
      select 'links', count(*)::int from field_links l join reporters r on r.id = l.reporter_id where r.org_id = $1 union all
      select 'consents', count(*)::int from consents c join reporters r on r.id = c.reporter_id where r.org_id = $1
      order by 1`,
      [DEMO_ORG_ID],
    );
    const map = Object.fromEntries(counts.rows.map((r) => [r.t, r.n]));
    expect(map.sites).toBe(6);
    expect(map.reporters).toBe(7);
    expect(map.companies).toBe(8);
    expect(map.reports).toBeGreaterThan(60);
    expect(map.site_days!).toBeGreaterThan(map.reports!);
    expect(map.texts).toBe(21);
    expect(map.uploads).toBeGreaterThan(map.reports!);
    expect(map.calls).toBe(4);
    expect(map.links).toBe(12);
    expect(map.consents).toBe(20);
    expect(
      (await db.query<{ is_demo: boolean }>(`select is_demo from orgs order by name`)).rows,
    ).toEqual([{ is_demo: true }, { is_demo: true }]);
  });

  it('gives reporters their §18.1 preference and locale', async () => {
    const rows = await db.query<{ name: string; contact_pref: string; locale: string }>(
      `select name, contact_pref::text, locale from reporters where org_id = $1 order by name`,
      [DEMO_ORG_ID],
    );
    expect(rows.rows).toEqual([
      { name: 'Aisha Bello', contact_pref: 'call', locale: 'en-US' },
      { name: 'Dana Whitfield', contact_pref: 'link', locale: 'en-US' },
      { name: 'Jorge Medina', contact_pref: 'link', locale: 'es-US' },
      { name: "Kevin O'Brien", contact_pref: 'call', locale: 'en-US' },
      { name: 'Marco Ruiz', contact_pref: 'link', locale: 'en-US' },
      { name: 'Priya Raman', contact_pref: 'link', locale: 'en-US' },
      { name: 'Tomasz Nowak', contact_pref: 'link', locale: 'en-US' },
    ]);
  });

  it('shows the Oct 5–9 hours per company through the RLS view', async () => {
    const rows = await asUser(db, LENA, (q) =>
      q<{ name: string; hours: string }>(
        `select c.name, sum(cm.hours)::text as hours from current_manpower cm join companies c on c.id = cm.company_id
         where cm.date between '2026-10-05' and '2026-10-09' and not c.is_self_perform group by c.name order by c.name`,
      ),
    );
    expect(Object.fromEntries(rows.rows.map((r) => [r.name, Number(r.hours)]))).toEqual({
      'Apex Concrete': 472,
      'BrightLine Electric': 196,
      'ClearView Glazing': 152,
      'Delta Mechanical': 384,
      'Ironclad Steel': 232,
      'Summit Drywall': 320,
    });
    const ridgeway = await asUser(db, LENA, (q) =>
      q<{ h: string }>(
        `select sum(hours)::text as h from current_manpower where company_name = 'Ridgeway'`,
      ),
    );
    expect(Number(ridgeway.rows[0]!.h)).toBe(48);
  });

  it('exposes invoice gaps (+16 BrightLine, +8 ClearView)', async () => {
    const gaps = await asUser(db, ACCOUNTS, (q) =>
      q<{ company_name: string; gap: string }>(
        `select company_name, gap::text from invoice_gaps($1, '2026-10-05', '2026-10-09') order by 1`,
        [DEMO_ORG_ID],
      ),
    );
    expect(gaps.rows.map((g) => [g.company_name, Number(g.gap)])).toEqual([
      ['Apex Concrete', 0],
      ['BrightLine Electric', 16],
      ['ClearView Glazing', 8],
      ['Ironclad Steel', 0],
    ]);
  });

  it('has the Oct 9 overview states and channels, and the weather log totals', async () => {
    const today = await asUser(db, LENA, (q) =>
      q<{ code: string; status: string; needs_review: boolean | null; channel: string | null }>(
        `select s.project_code as code, sd.status::text, r.needs_review, r.channel::text as channel
         from site_days sd join sites s on s.id = sd.site_id
         left join reports r on r.id = sd.report_id where sd.date = '2026-10-09' order by s.project_code`,
      ),
    );
    expect(today.rows).toEqual([
      { code: 'ES-0377', status: 'missing', needs_review: null, channel: null },
      { code: 'HS-0418', status: 'weather_day', needs_review: false, channel: 'voice' },
      { code: 'NG-2210', status: 'filed', needs_review: false, channel: 'voice' },
      { code: 'OM-1187', status: 'filed', needs_review: true, channel: 'web' },
      { code: 'P9-0932', status: 'filed', needs_review: false, channel: 'web' },
      { code: 'RL-2041', status: 'filed', needs_review: false, channel: 'web' },
    ]);
    const wx = await asUser(db, LENA, (q) =>
      q<{ n: number; lost: string; ready: number }>(
        `select count(*)::int as n, sum(lost_hours)::text as lost, count(*) filter (where claim_ready)::int as ready from current_weather where date >= '2026-10-01'`,
      ),
    );
    expect(wx.rows[0]).toEqual({ n: 10, lost: '36.50', ready: 7 });
  });

  it('keeps the hero report history: v2 by the reporter on the web, schemaVersion 2', async () => {
    const hero = await asUser(db, LENA, (q) =>
      q<{
        version: number;
        change_note: string | null;
        author: string;
        via: string | null;
        sv: string;
      }>(
        `select rv.version, rv.change_note, rv.author::text, rv.via::text as via, rv.data->>'schemaVersion' as sv
         from report_versions rv join reports r on r.id = rv.report_id where r.report_no = 'RL-2041-0187' order by version`,
      ),
    );
    expect(hero.rows).toEqual([
      { version: 1, change_note: null, author: 'agent', via: null, sv: '2' },
      {
        version: 2,
        change_note: 'Apex Concrete 6 → 7 workers',
        author: 'reporter',
        via: 'web',
        sv: '2',
      },
    ]);
    // The voice note is an upload with its transcript; Lena reads both (RLS).
    const transcript = await asUser(db, LENA, (q) =>
      q<{ n: number; d: string }>(
        `select jsonb_array_length(t.segments)::int as n, u.duration_s::text as d
         from transcripts t join uploads u on u.id = t.upload_id where u.duration_s = 168`,
      ),
    );
    expect(transcript.rows[0]).toEqual({ n: 13, d: '168' });
    const q = await asUser(db, LENA, (q) =>
      q<{ channel: string; answered: string }>(
        `select q.channel::text, to_char(q.answered_at at time zone 'America/Chicago', 'HH24:MI') as answered
         from questions q join reports r on r.id = q.report_id where r.report_no = 'RL-2041-0187'`,
      ),
    );
    expect(q.rows).toEqual([{ channel: 'web', answered: '17:41' }]);
    // denormalize_report_version reads the v2 hero like the seed wrote it.
    const before = await db.query(
      `select company_name, workers, hours::text, hours_basis, source from manpower_entries m join reports r on r.id = m.report_id
       where r.report_no = 'RL-2041-0187' and m.version = 2 order by company_name`,
    );
    const id = (
      await db.query<{ id: string }>(`select id from reports where report_no = 'RL-2041-0187'`)
    ).rows[0]!.id;
    await db.query(`select denormalize_report_version($1, 2)`, [id]);
    const after = await db.query(
      `select company_name, workers, hours::text, hours_basis, source from manpower_entries m join reports r on r.id = m.report_id
       where r.report_no = 'RL-2041-0187' and m.version = 2 order by company_name`,
    );
    expect(after.rows).toEqual(before.rows);
  });

  it('has the unknown caller as a voice contact with its call', async () => {
    const rows = await asUser(db, LENA, (q) =>
      q<{ phone_e164: string; channel: string; status: string; duration_s: number }>(
        `select u.phone_e164, u.channel::text, c.status::text, c.duration_s
         from unknown_contacts u join calls c on c.id = u.call_id`,
      ),
    );
    expect(rows.rows).toEqual([
      { phone_e164: '+15550194410', channel: 'voice', status: 'completed', duration_s: 41 },
    ]);
  });

  it('loads Demir Yapı A.Ş. (§18.2) with its Turkish text intact', async () => {
    const demir = buildDemirDemo();
    const org = (
      await db.query<Record<string, unknown>>(
        `select name, timezone, locale, country, units, currency, is_demo from orgs where id = $1`,
        [DEMIR_ORG_ID],
      )
    ).rows[0];
    expect(org).toEqual({
      name: 'Demir Yapı A.Ş.',
      timezone: 'Europe/Istanbul',
      locale: 'tr-TR',
      country: 'TR',
      units: 'metric',
      currency: 'TRY',
      is_demo: true,
    });
    const text = async (sql: string) =>
      (await db.query<{ t: string }>(sql, [DEMIR_ORG_ID])).rows.map((r) => r.t);
    expect(
      await text(
        `select name || ' ' || project_code as t from sites where org_id = $1 order by project_code desc`,
      ),
    ).toEqual(['Kartal Konutları — B Blok KK-1203', 'Ataşehir Ofis Binası AO-0512']);
    expect(await text(`select name as t from reporters where org_id = $1 order by name`)).toEqual([
      'Emre Yıldız',
      'Selin Kaya',
    ]);
    expect(
      await text(
        `select name || ' (' || trade || ')' as t from companies where org_id = $1 order by name`,
      ),
    ).toEqual([
      'Akış Mekanik (Mekanik)',
      'Demir Yapı öz ekip (Genel işçilik)',
      'Usta Beton (Beton)',
      'Volt Elektrik (Elektrik)',
    ]);
    expect(
      await text(
        `select heard || ' → ' || official as t from glossary_terms where org_id = $1 order by heard`,
      ),
    ).toEqual(
      demir.glossary.map((g) => `${g.heard} → ${g.official}`).sort((a, b) => (a < b ? -1 : 1)),
    );
    // §18.2's "TBM / tool box": the two phrases, each mapped to the official term.
    expect(
      await text(
        `select heard as t from glossary_terms where org_id = $1 and official = 'İş güvenliği bilgilendirmesi' order by heard`,
      ),
    ).toEqual(['TBM', 'tool box']);
    expect(
      await text(`select body as t from messages where org_id = $1 order by created_at, body`),
    ).toEqual(demir.messages.map((m) => m.body));
    // Characters and bytes in the database's own terms: UTF-8 (ı, ö, ü are two bytes each).
    expect(
      await text(
        `select length(heard) || '/' || octet_length(heard) as t from glossary_terms where org_id = $1 and heard like 'kal%'`,
      ),
    ).toEqual(['12/15']);
    expect(
      await count(`select count(*)::int as n from reports where org_id = $1`, [DEMIR_ORG_ID]),
    ).toBe(0);
    expect(
      await count(`select count(*)::int as n from org_members where org_id = $1`, [DEMIR_ORG_ID]),
    ).toBe(0);
  });
});
