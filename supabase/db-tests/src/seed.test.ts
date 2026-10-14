import { beforeAll, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { DEMO_USERS } from '@sitelog/shared/demo/kestrel.ts';
import { asUser, bootDatabase } from './harness.ts';

let db: PGlite;
const LENA = DEMO_USERS[0]!.id;
const ACCOUNTS = DEMO_USERS[2]!.id;

beforeAll(async () => {
  db = await bootDatabase({ seed: true });
});

describe('seed.sql (Kestrel demo)', () => {
  it('loads the §18 org, sites and people', async () => {
    const counts = await db.query<{ t: string; n: number }>(`
      select 'sites' as t, count(*)::int as n from sites union all
      select 'reporters', count(*)::int from reporters union all
      select 'companies', count(*)::int from companies union all
      select 'site_days', count(*)::int from site_days union all
      select 'reports', count(*)::int from reports union all
      select 'messages', count(*)::int from messages order by 1`);
    const map = Object.fromEntries(counts.rows.map((r) => [r.t, r.n]));
    expect(map.sites).toBe(6);
    expect(map.reporters).toBe(7);
    expect(map.companies).toBe(8);
    expect(map.reports).toBeGreaterThan(60);
    expect(map.site_days!).toBeGreaterThan(map.reports!);
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
        `select company_name, gap::text from invoice_gaps((select id from orgs limit 1), '2026-10-05', '2026-10-09') order by 1`,
      ),
    );
    expect(gaps.rows.map((g) => [g.company_name, Number(g.gap)])).toEqual([
      ['Apex Concrete', 0],
      ['BrightLine Electric', 16],
      ['ClearView Glazing', 8],
      ['Ironclad Steel', 0],
    ]);
  });

  it('has the Oct 9 overview states and the weather log totals', async () => {
    const today = await asUser(db, LENA, (q) =>
      q<{ code: string; status: string; needs_review: boolean | null }>(
        `select s.project_code as code, sd.status::text, r.needs_review from site_days sd join sites s on s.id = sd.site_id
         left join reports r on r.id = sd.report_id where sd.date = '2026-10-09' order by s.project_code`,
      ),
    );
    expect(today.rows).toEqual([
      { code: 'ES-0377', status: 'missing', needs_review: null },
      { code: 'HS-0418', status: 'weather_day', needs_review: false },
      { code: 'NG-2210', status: 'filed', needs_review: false },
      { code: 'OM-1187', status: 'filed', needs_review: true },
      { code: 'P9-0932', status: 'filed', needs_review: false },
      { code: 'RL-2041', status: 'filed', needs_review: false },
    ]);
    const wx = await asUser(db, LENA, (q) =>
      q<{ n: number; lost: string; ready: number }>(
        `select count(*)::int as n, sum(lost_hours)::text as lost, count(*) filter (where claim_ready)::int as ready from current_weather where date >= '2026-10-01'`,
      ),
    );
    expect(wx.rows[0]).toEqual({ n: 10, lost: '36.50', ready: 7 });
  });

  it('keeps the hero report history intact', async () => {
    const hero = await asUser(db, LENA, (q) =>
      q<{ version: number; change_note: string | null; author: string }>(
        `select rv.version, rv.change_note, rv.author::text from report_versions rv join reports r on r.id = rv.report_id where r.report_no = 'RL-2041-0187' order by version`,
      ),
    );
    expect(hero.rows).toEqual([
      { version: 1, change_note: null, author: 'agent' },
      { version: 2, change_note: 'Apex Concrete 6 → 7 workers', author: 'reporter' },
    ]);
    const transcript = await asUser(db, LENA, (q) =>
      q<{ n: number }>(
        `select jsonb_array_length(segments)::int as n from transcripts t join messages m on m.id = t.message_id where m.duration_s = 168`,
      ),
    );
    expect(transcript.rows[0]!.n).toBe(13);
  });
});
