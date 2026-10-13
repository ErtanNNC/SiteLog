import { beforeAll, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { emptyReportDataV1, type DailyReportDataV1 } from '@sitelog/shared';
import { DEMO_ORG_ID, DEMO_USERS } from '@sitelog/shared/demo/kestrel.ts';
import { asService, asUser, bootDatabase } from './harness.ts';

/**
 * 20261013000002_report_archive.sql: the Reports archive view the panel filters, counts and pages
 * server-side — one row per filed / signed-off report, flags from its current version.
 */

const LENA = DEMO_USERS[0]!.id; // admin
const SAM = DEMO_USERS[1]!.id; // pm
const ACCOUNTS = DEMO_USERS[2]!.id; // accounts
const OUTSIDER = 'eeeeeeee-2222-4222-8222-222222222222'; // admin of another org

let db: PGlite;
let riverside: string;

interface ArchiveRow {
  id: string;
  report_no: string;
  date: string;
  site_name: string;
  project_code: string;
  lost_hours: string;
  has_incident: boolean;
  summary: string | null;
}

async function svc<T = Record<string, unknown>>(sql: string, params: unknown[] = []) {
  return (await asService(db, (q) => q<T>(sql, params))).rows;
}

async function archiveAs(user: string, where = 'true', params: unknown[] = []) {
  return (
    await asUser(db, user, (q) =>
      q<ArchiveRow>(
        `select id, report_no, to_char(date, 'YYYY-MM-DD') as date, site_name, project_code,
                lost_hours::text, has_incident, summary
         from report_archive where ${where}`,
        params,
      ),
    )
  ).rows;
}

function withIncident(date: string, incident: boolean, summary: string): DailyReportDataV1 {
  const d = emptyReportDataV1(date);
  return {
    ...d,
    summary,
    safety: {
      ...d.safety,
      incidents: incident
        ? [
            {
              description: 'Laborer cut a hand on rebar; first aid on site.',
              severity: 'first_aid',
              source: [],
            },
          ]
        : [],
    },
  };
}

beforeAll(async () => {
  db = await bootDatabase({ seed: true });
  await db.exec(`insert into auth.users (id, email) values ('${OUTSIDER}', 'y@other.test');`);
  await asUser(db, OUTSIDER, (q) => q(`select create_org('Other GC')`), 'y@other.test');
  riverside = (
    await svc<{ id: string }>(
      `select id from sites where org_id = $1 and project_code = 'RL-2041'`,
      [DEMO_ORG_ID],
    )
  )[0]!.id;
});

describe('report_archive view', () => {
  it('lists every filed / signed-off report once, with its site-day date and site', async () => {
    const expected = await svc<{ id: string; date: string; name: string; code: string }>(
      `select r.id, to_char(sd.date, 'YYYY-MM-DD') as date, s.name, s.project_code as code
       from reports r join site_days sd on sd.id = r.site_day_id join sites s on s.id = r.site_id
       where r.org_id = $1 and r.status in ('filed', 'signed_off')`,
      [DEMO_ORG_ID],
    );
    expect(expected.length).toBeGreaterThan(50);
    const rows = await archiveAs(LENA);
    expect(rows).toHaveLength(expected.length);
    const byId = new Map(rows.map((r) => [r.id, r]));
    for (const e of expected)
      expect(byId.get(e.id)).toMatchObject({
        date: e.date,
        site_name: e.name,
        project_code: e.code,
      });
    // Drafts and void reports stay out.
    const other = await svc<{ id: string }>(
      `select id from reports where org_id = $1 and status not in ('filed', 'signed_off')`,
      [DEMO_ORG_ID],
    );
    for (const o of other) expect(byId.has(o.id)).toBe(false);
  });

  it("sums the current version's lost weather hours", async () => {
    const wx = await svc<{ report_id: string; lost: string }>(
      `select report_id, sum(lost_hours)::text as lost from current_weather
       where org_id = $1 group by report_id having sum(lost_hours) > 0`,
      [DEMO_ORG_ID],
    );
    expect(wx.length).toBeGreaterThan(0);
    const delayed = await archiveAs(SAM, 'lost_hours > 0');
    expect(new Map(delayed.map((r) => [r.id, Number(r.lost_hours)]))).toEqual(
      new Map(wx.map((w) => [w.report_id, Number(w.lost)])),
    );
    const none = await archiveAs(SAM, 'lost_hours = 0');
    expect(none.length).toBeGreaterThan(0);
  });

  it('flags an incident and finds the summary from the current version only', async () => {
    const date = '2026-09-16';
    const filed = await asUser(db, LENA, async (q) => {
      const res = await q<{ r: { reportId: string } }>(
        `select create_office_report($1, $2, $3) as r`,
        [riverside, date, JSON.stringify(withIncident(date, true, 'Cut hand at the rebar cage.'))],
      );
      return res.rows[0]!.r.reportId;
    });
    expect(await archiveAs(LENA, 'id = $1', [filed])).toEqual([
      expect.objectContaining({ has_incident: true, summary: 'Cut hand at the rebar cage.' }),
    ]);
    expect((await archiveAs(LENA, `summary ilike '%rebar cage%'`)).map((r) => r.id)).toEqual([
      filed,
    ]);

    // An office edit removes the incident: v1 still has it, the archive must not.
    await asUser(db, LENA, (q) =>
      q(`select create_report_version($1, $2, $3)`, [
        filed,
        JSON.stringify(withIncident(date, false, 'Formwork on Level 2.')),
        'No incident: it was a different site',
      ]),
    );
    expect(await archiveAs(LENA, 'id = $1', [filed])).toEqual([
      expect.objectContaining({ has_incident: false, summary: 'Formwork on Level 2.' }),
    ]);
    expect(await archiveAs(LENA, `summary ilike '%rebar cage%'`)).toEqual([]);
    expect((await archiveAs(LENA, 'has_incident')).map((r) => r.id)).not.toContain(filed);
  });

  it('shows nothing to accounts members or to other orgs', async () => {
    expect(await archiveAs(ACCOUNTS)).toEqual([]);
    expect(await archiveAs(OUTSIDER)).toEqual([]);
  });
});
