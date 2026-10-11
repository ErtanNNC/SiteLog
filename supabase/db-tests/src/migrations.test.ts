import { beforeAll, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { PG_ENUMS } from '@sitelog/shared';
import { asService, asUser, bootDatabase } from './harness.ts';

const LENA = '11111111-1111-4111-8111-111111111111';
const SAM = '22222222-2222-4222-8222-222222222222';
const OUTSIDER = '33333333-3333-4333-8333-333333333333';

let db: PGlite;
let orgId: string;
let siteId: string;

beforeAll(async () => {
  db = await bootDatabase();
  await db.exec(
    `insert into auth.users (id, email) values ('${LENA}', 'lena@kestrel.test'), ('${SAM}', 'sam@kestrel.test'), ('${OUTSIDER}', 'x@other.test');`,
  );
});

describe('migrations', () => {
  it('creates every enum with the values in packages/shared', async () => {
    for (const [name, values] of Object.entries(PG_ENUMS)) {
      const res = await db.query<{ enumlabel: string }>(
        `select e.enumlabel from pg_enum e join pg_type t on t.oid = e.enumtypid where t.typname = $1 order by e.enumsortorder`,
        [name],
      );
      expect(
        res.rows.map((r) => r.enumlabel),
        name,
      ).toEqual([...values]);
    }
  });

  it('enables RLS on every public table', async () => {
    const res = await db.query<{ relname: string; relrowsecurity: boolean }>(
      `select c.relname, c.relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind = 'r' order by 1`,
    );
    expect(res.rows.length).toBeGreaterThan(25);
    const off = res.rows.filter((r) => !r.relrowsecurity).map((r) => r.relname);
    expect(off).toEqual([]);
  });
});

describe('org creation and membership (RLS)', () => {
  it('lets a signed-in user create an org and become its admin', async () => {
    orgId = await asUser(
      db,
      LENA,
      async (q) => {
        const r = await q<{ r: { id: string } }>(
          `select create_org('Kestrel Build Group', 'America/Chicago') as r`,
        );
        return r.rows[0]!.r.id;
      },
      'lena@kestrel.test',
    );
    const members = await asService(db, (q) =>
      q<{ role: string }>(`select role from org_members where org_id = $1`, [orgId]),
    );
    expect(members.rows).toEqual([{ role: 'admin' }]);
    const settings = await asService(db, (q) =>
      q(`select default_deadline::text as d from org_settings where org_id = $1`, [orgId]),
    );
    expect(settings.rows[0]).toEqual({ d: '17:30:00' });
    const self = await asService(db, (q) =>
      q<{ name: string }>(`select name from companies where org_id = $1 and is_self_perform`, [
        orgId,
      ]),
    );
    expect(self.rows[0]!.name).toBe('Kestrel Build Group self-perform');
  });

  it('hides the org from non-members and lets admins add sites', async () => {
    const hidden = await asUser(db, OUTSIDER, (q) => q(`select id from orgs`));
    expect(hidden.rows).toEqual([]);
    siteId = await asUser(db, LENA, async (q) => {
      const r = await q<{ id: string }>(
        `insert into sites (org_id, name, project_code, timezone, lat, lng) values ($1, 'Riverside Lofts — Block B', 'RL-2041', 'America/Chicago', 41.88, -87.63) returning id`,
        [orgId],
      );
      return r.rows[0]!.id;
    });
    await asService(db, (q) =>
      q(
        `insert into org_members (org_id, user_id, role, display_name) values ($1, $2, 'pm', 'Sam Kowalski')`,
        [orgId, SAM],
      ),
    );
    const asPm = await asUser(db, SAM, (q) => q(`select name from sites`));
    expect(asPm.rows).toEqual([{ name: 'Riverside Lofts — Block B' }]);
    await expect(
      asUser(db, SAM, (q) =>
        q(
          `insert into sites (org_id, name, project_code, timezone) values ($1, 'X', 'X-1', 'UTC')`,
          [orgId],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it('numbers reports per site', async () => {
    const a = await asService(db, (q) =>
      q<{ n: string }>(`select next_report_no($1) as n`, [siteId]),
    );
    const b = await asService(db, (q) =>
      q<{ n: string }>(`select next_report_no($1) as n`, [siteId]),
    );
    expect([a.rows[0]!.n, b.rows[0]!.n]).toEqual(['RL-2041-0001', 'RL-2041-0002']);
  });
});

describe('job queue', () => {
  it('enqueues with dedupe, claims with skip locked, completes and backs off', async () => {
    const id1 = await asService(db, (q) =>
      q<{ id: string }>(
        `select enqueue_job('inbound_message', '{"messageId":"m1"}', null, 'inbound:m1') as id`,
      ),
    );
    const id2 = await asService(db, (q) =>
      q<{ id: string }>(
        `select enqueue_job('inbound_message', '{"messageId":"m1"}', null, 'inbound:m1') as id`,
      ),
    );
    expect(id1.rows[0]!.id).toBe(id2.rows[0]!.id);
    const claimed = await asService(db, (q) =>
      q<{ id: string; status: string; attempts: number; locked_by: string }>(
        `select * from claim_jobs('w1', 4)`,
      ),
    );
    expect(claimed.rows).toHaveLength(1);
    expect(claimed.rows[0]).toMatchObject({ status: 'running', attempts: 1, locked_by: 'w1' });
    const again = await asService(db, (q) => q(`select * from claim_jobs('w2', 4)`));
    expect(again.rows).toHaveLength(0);
    await asService(db, (q) => q(`select fail_job($1, 'boom')`, [claimed.rows[0]!.id]));
    const after = await asService(db, (q) =>
      q<{ status: string; run_after: Date; last_error: string }>(
        `select status, run_after, last_error from jobs where id = $1`,
        [claimed.rows[0]!.id],
      ),
    );
    expect(after.rows[0]).toMatchObject({ status: 'queued', last_error: 'boom' });
    expect(new Date(after.rows[0]!.run_after).getTime()).toBeGreaterThan(Date.now() + 20_000);
    await asService(db, (q) =>
      q(`update jobs set attempts = 5 where id = $1`, [claimed.rows[0]!.id]),
    );
    await asService(db, (q) => q(`select fail_job($1, 'boom again')`, [claimed.rows[0]!.id]));
    const dead = await asService(db, (q) =>
      q<{ status: string }>(`select status from jobs where id = $1`, [claimed.rows[0]!.id]),
    );
    expect(dead.rows[0]!.status).toBe('dead');
    await expect(asUser(db, LENA, (q) => q(`select * from jobs`))).resolves.toMatchObject({
      rows: [],
    });
  });
});

describe('report lifecycle RPCs', () => {
  let reportId: string;
  let siteDayId: string;

  it('files a report, denormalises rows and signs it off', async () => {
    siteDayId = await asService(db, async (q) => {
      const r = await q<{ id: string }>(
        `insert into site_days (site_id, date, status, deadline_at) values ($1, '2026-10-09', 'processing', '2026-10-09T22:30:00Z') returning id`,
        [siteId],
      );
      return r.rows[0]!.id;
    });
    const data = {
      schemaVersion: 1,
      reportDate: '2026-10-09',
      languageDetected: ['es', 'en'],
      summary: 'Level 4 slab pour completed.',
      weather: {
        conditionsText: 'Rain AM',
        observed: { precipIn: 0.4, tempMinF: 58, tempMaxF: 64, windMph: 9, provider: 'Open-Meteo' },
        periods: [
          {
            start: '07:00',
            end: '10:30',
            condition: 'Rain',
            impact: 'Masonry stopped',
            lostHours: 3.5,
            source: [{ type: 'audio', messageId: 'm1', start: 41 }],
          },
        ],
      },
      manpower: [
        {
          companyId: null,
          companyNameHeard: 'Apex',
          companyName: 'Apex Concrete',
          workers: 6,
          hoursPerWorker: 8,
          totalHours: 48,
          hoursBasis: 'stated',
          confidence: 0.9,
          source: [{ type: 'audio', messageId: 'm1', start: 12 }],
        },
        {
          companyId: null,
          companyNameHeard: 'the Ridgeway crew',
          companyName: 'Ridgeway',
          workers: 6,
          hoursPerWorker: 8,
          totalHours: 48,
          hoursBasis: 'stated',
          confidence: 0.8,
          source: [],
        },
      ],
      workPerformed: [
        {
          area: 'Level 4',
          activity: 'Slab pour',
          status: 'complete',
          quantity: { value: 68, unit: 'yd³' },
          source: [],
        },
      ],
      deliveries: [],
      equipment: [],
      safety: { incidents: [], noIncidentsStated: true, visitors: [], source: [] },
      issues: [],
      nextWorkday: [],
      photos: [{ messageId: 'p1', takenAt: '2026-10-09T22:40:00Z' }],
      newTerms: [],
      missingRequired: [],
      lowConfidence: [],
      proposedQuestions: [],
    };
    reportId = await asService(db, async (q) => {
      const r = await q<{ id: string }>(
        `insert into reports (org_id, site_id, site_day_id, report_no, status, filed_at, needs_review, review_reasons) values ($1, $2, $3, 'RL-2041-0187', 'filed', now(), true, '{unknown_company:Ridgeway}') returning id`,
        [orgId, siteId, siteDayId],
      );
      await q(
        `insert into report_versions (report_id, version, data, summary, author) values ($1, 1, $2, 'Level 4 slab pour completed.', 'agent')`,
        [r.rows[0]!.id, JSON.stringify(data)],
      );
      await q(`select denormalize_report_version($1, 1)`, [r.rows[0]!.id]);
      await q(`update site_days set status = 'filed', report_id = $1 where id = $2`, [
        r.rows[0]!.id,
        siteDayId,
      ]);
      return r.rows[0]!.id;
    });
    const mp = await asService(db, (q) =>
      q<{ company_name: string; workers: number; hours: string }>(
        `select company_name, workers, hours from manpower_entries where report_id = $1 order by company_name`,
        [reportId],
      ),
    );
    expect(mp.rows).toEqual([
      { company_name: 'Apex Concrete', workers: 6, hours: '48.00' },
      { company_name: 'Ridgeway', workers: 6, hours: '48.00' },
    ]);
    const wx = await asService(db, (q) =>
      q<{ lost_hours: string; claim_ready: boolean; photo_count: number }>(
        `select lost_hours, claim_ready, photo_count from weather_events where report_id = $1`,
        [reportId],
      ),
    );
    expect(wx.rows[0]).toEqual({ lost_hours: '3.50', claim_ready: true, photo_count: 1 });
    const view = await asUser(db, SAM, (q) =>
      q<{ hours: string }>(`select hours from current_manpower where report_id = $1`, [reportId]),
    );
    expect(view.rows).toHaveLength(2);

    await expect(
      asUser(db, OUTSIDER, (q) => q(`select sign_off_report($1)`, [reportId])),
    ).rejects.toThrow(/not allowed|not found/);
    const signed = await asUser(db, SAM, (q) =>
      q<{ r: { status: string } }>(`select sign_off_report($1) as r`, [reportId]),
    );
    expect(signed.rows[0]!.r.status).toBe('signed_off');
    const audit = await asService(db, (q) =>
      q<{ action: string }>(`select action from audit_log where entity_id = $1 order by id`, [
        reportId,
      ]),
    );
    expect(audit.rows.map((a) => a.action)).toContain('report.signed_off');
  });

  it('creates an office version, reverting sign-off and enqueuing a PDF', async () => {
    const current = await asService(db, (q) =>
      q<{ data: Record<string, unknown> }>(
        `select data from report_versions where report_id = $1 and version = 1`,
        [reportId],
      ),
    );
    const data = current.rows[0]!.data as { manpower: Array<Record<string, unknown>> };
    data.manpower[0]!.workers = 7;
    data.manpower[0]!.totalHours = 56;
    await expect(
      asUser(db, SAM, (q) =>
        q(`select create_report_version($1, $2, '')`, [reportId, JSON.stringify(data)]),
      ),
    ).rejects.toThrow(/change note/);
    const res = await asUser(db, SAM, (q) =>
      q<{ r: { version: number } }>(
        `select create_report_version($1, $2, 'Apex Concrete 6 → 7 workers') as r`,
        [reportId, JSON.stringify(data)],
      ),
    );
    expect(res.rows[0]!.r.version).toBe(2);
    const rep = await asService(db, (q) =>
      q<{ status: string; current_version: number; signed_off_by: string | null }>(
        `select status, current_version, signed_off_by from reports where id = $1`,
        [reportId],
      ),
    );
    expect(rep.rows[0]).toEqual({ status: 'filed', current_version: 2, signed_off_by: null });
    const jobs = await asService(db, (q) =>
      q<{ type: string; payload: { version: number } }>(
        `select type, payload from jobs where type = 'render_pdf'`,
      ),
    );
    expect(jobs.rows.map((j) => j.payload.version)).toContain(2);
    const v2 = await asUser(db, SAM, (q) =>
      q<{ hours: string }>(
        `select hours from current_manpower where report_id = $1 and company_name = 'Apex Concrete'`,
        [reportId],
      ),
    );
    expect(v2.rows[0]!.hours).toBe('56.00');
  });

  it('resolves an unknown company into a confirmed subcontractor and clears the review flag', async () => {
    const res = await asUser(db, SAM, (q) =>
      q<{ r: { version: number; company_id: string } }>(
        `select resolve_unknown_company($1, 'Ridgeway', 'add', null) as r`,
        [reportId],
      ),
    );
    expect(res.rows[0]!.r.version).toBe(3);
    const rep = await asService(db, (q) =>
      q<{ needs_review: boolean; review_reasons: string[] }>(
        `select needs_review, review_reasons from reports where id = $1`,
        [reportId],
      ),
    );
    expect(rep.rows[0]).toEqual({ needs_review: false, review_reasons: [] });
    const company = await asService(db, (q) =>
      q<{ status: string }>(`select status from companies where id = $1`, [
        res.rows[0]!.r.company_id,
      ]),
    );
    expect(company.rows[0]!.status).toBe('confirmed');
    const mp = await asService(db, (q) =>
      q<{ company_id: string | null }>(
        `select company_id from manpower_entries where report_id = $1 and version = 3 and company_name = 'Ridgeway'`,
        [reportId],
      ),
    );
    expect(mp.rows[0]!.company_id).toBe(res.rows[0]!.r.company_id);
  });

  it('marks a pending day as no work and refuses on filed days', async () => {
    const pending = await asService(db, async (q) => {
      const r = await q<{ id: string }>(
        `insert into site_days (site_id, date, status, deadline_at) values ($1, '2026-10-12', 'reminded', '2026-10-12T22:30:00Z') returning id`,
        [siteId],
      );
      return r.rows[0]!.id;
    });
    const r = await asUser(db, SAM, (q) =>
      q<{ r: { status: string } }>(`select mark_no_work($1) as r`, [pending]),
    );
    expect(r.rows[0]!.r.status).toBe('no_work');
    await expect(asUser(db, SAM, (q) => q(`select mark_no_work($1)`, [siteDayId]))).rejects.toThrow(
      /filed/,
    );
  });

  it('keeps accounts users to hours-only data', async () => {
    const ACC = '44444444-4444-4444-8444-444444444444';
    await db.exec(`insert into auth.users (id, email) values ('${ACC}', 'acc@kestrel.test')`);
    await asService(db, (q) =>
      q(`insert into org_members (org_id, user_id, role) values ($1, $2, 'accounts')`, [
        orgId,
        ACC,
      ]),
    );
    const reports = await asUser(db, ACC, (q) => q(`select id from reports`));
    expect(reports.rows).toEqual([]);
    const hours = await asUser(db, ACC, (q) => q(`select hours from current_manpower`));
    expect(hours.rows.length).toBeGreaterThan(0);
    const companies = await asUser(db, ACC, (q) => q(`select name from companies`));
    expect(companies.rows.length).toBeGreaterThan(0);
  });

  it('reviews glossary terms', async () => {
    const termId = await asService(db, async (q) => {
      const r = await q<{ id: string }>(
        `insert into glossary_terms (org_id, heard, official, status) values ($1, 'mud', 'Joint compound', 'needs_review') returning id`,
        [orgId],
      );
      return r.rows[0]!.id;
    });
    await asUser(db, SAM, (q) =>
      q(`select review_glossary_term($1, 'change', 'Joint compound (drywall)', null)`, [termId]),
    );
    const t = await asService(db, (q) =>
      q<{ status: string; official: string }>(
        `select status, official from glossary_terms where id = $1`,
        [termId],
      ),
    );
    expect(t.rows[0]).toEqual({ status: 'confirmed', official: 'Joint compound (drywall)' });
  });
});
