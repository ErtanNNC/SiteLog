import { beforeAll, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { INVOICE_GAP_POLICY, noticeDataSchema } from '@sitelog/shared';
import { asUser, bootDatabase, probeAs } from './harness.ts';
import { ORG, seedTwoOrgs, V1_DATA } from './fixtures/two-orgs.ts';

/**
 * W3-06 (20261016000270_invoice_gap_notice.sql; spec F19, §13 "Invoice gap: ops, accounts", §19
 * Q133's recommended default, `INVOICE_GAP_POLICY`): one `invoice_gap` notice per invoice and gap,
 * from the invoice save and from a report version that changes the hours behind it.
 *
 * The fixture's org A has one filed report on Fri Oct 9 (2026-W41) with Apex A: 6 workers, 48 h.
 */

const A = ORG.A;
const PERIOD = { start: '2026-10-05', end: '2026-10-09' };
let db: PGlite;
let n = 0;

beforeAll(async () => {
  db = await bootDatabase({ storage: true });
  await seedTwoOrgs(db);
});

async function addInvoice(totalHours: number | null, opts: { lines?: unknown } = {}) {
  n += 1;
  const id = `aaaaaaaa-0000-4000-8000-${(0x900 + n).toString(16).padStart(12, '0')}`;
  await asUser(db, A.users.accounts, (q) =>
    q(
      `insert into sub_invoices (id, org_id, company_id, invoice_no, period_start, period_end, lines, total_hours)
       values ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        id,
        A.org,
        A.company,
        `GAP-${n}`,
        PERIOD.start,
        PERIOD.end,
        opts.lines === undefined ? null : JSON.stringify(opts.lines),
        totalHours,
      ],
    ),
  );
  return id;
}

async function notices(invoiceNo?: string) {
  const res = await db.query<{
    title: string;
    body: string;
    target_path: string;
    user_id: string | null;
    data: unknown;
  }>(
    `select title, body, target_path, user_id, data from notifications
     where org_id = $1 and kind = 'invoice_gap' and ($2::text is null or data -> 'params' ->> 'invoiceNo' = $2)
     order by created_at, id`,
    [A.org, invoiceNo ?? null],
  );
  return res.rows;
}

async function update(id: string, set: string) {
  await asUser(db, A.users.ops, (q) => q(`update sub_invoices set ${set} where id = $1`, [id]));
}

async function gapNotified(id: string) {
  const res = await db.query<{ gap_notified: string | null }>(
    `select gap_notified::text from sub_invoices where id = $1`,
    [id],
  );
  return res.rows[0]?.gap_notified ?? null;
}

describe('invoice_gap notice (W3-06, §19 Q133)', () => {
  it('posts one notice when an invoice is saved with a gap, for admin, ops and accounts', async () => {
    const id = await addInvoice(56);
    const rows = await notices('GAP-1');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      title: 'Invoice gap: Apex A +8 h',
      body: 'GAP-1 invoices 56 h · reports show 48 h',
      target_path: '/hours?week=2026-W41',
      user_id: null,
    });
    expect(noticeDataSchema.parse(rows[0]!.data)).toEqual({
      key: 'invoice_gap',
      params: { company: 'Apex A', invoiceNo: 'GAP-1', invoiced: 56, reported: 48, gap: 8 },
    });
    expect(await gapNotified(id)).toBe('8.00');

    const audit = await db.query<{ actor_type: string; actor_id: string; diff: unknown }>(
      `select actor_type, actor_id, diff from audit_log where action = 'invoice.gap_notified' and entity_id = $1`,
      [id],
    );
    expect(audit.rows).toEqual([
      {
        actor_type: 'user',
        actor_id: A.users.accounts,
        diff: {
          gap: 8,
          previous: null,
          invoiced: 56,
          reported: 48,
          cause: 'invoice_added',
        },
      },
    ]);

    // §13 audience: ops and accounts (admin holds every capability); not pm.
    const seen = async (role: 'admin' | 'pm' | 'ops' | 'accounts') => {
      const res = await probeAs(
        db,
        { role: 'authenticated', userId: A.users[role] },
        `select count(*)::int as n from notifications where kind = 'invoice_gap' and data -> 'params' ->> 'invoiceNo' = 'GAP-1'`,
      );
      return res.ok ? res.rows[0]!.n : res.message;
    };
    expect(await seen('accounts')).toBe(1);
    expect(await seen('ops')).toBe(1);
    expect(await seen('admin')).toBe(1);
    expect(await seen('pm')).toBe(0);
  });

  it('notifies again only when the gap moves by 1 h or more, and a negative gap too', async () => {
    const id = await addInvoice(56); // GAP-2: +8
    await update(id, 'total_hours = 56.5'); // +8.5: moved < 1 h
    await update(id, `invoice_no = 'GAP-2'`); // not an hours change
    expect(await notices('GAP-2')).toHaveLength(1);
    await update(id, 'total_hours = 60'); // +12
    await update(id, 'total_hours = 40'); // −8
    await update(id, 'total_hours = 48.5'); // +0.5: below 1 h, nothing to say
    const rows = await notices('GAP-2');
    expect(rows.map((r) => r.title)).toEqual([
      'Invoice gap: Apex A +8 h',
      'Invoice gap: Apex A +12 h',
      'Invoice gap: Apex A −8 h',
    ]);
    expect(await gapNotified(id)).toBe('-8.00');
  });

  it('never notifies a queried or resolved invoice, nor one under 1 h or without hours', async () => {
    const queried = await addInvoice(48); // match
    await update(queried, `status = 'queried'`);
    await update(queried, 'total_hours = 80');
    const resolved = await addInvoice(48);
    await update(resolved, `status = 'resolved', total_hours = 90`);
    await addInvoice(48.75); // GAP-5: +0.75
    await addInvoice(null); // GAP-6: no hours to compare
    for (const no of ['GAP-3', 'GAP-4', 'GAP-5', 'GAP-6']) expect(await notices(no)).toEqual([]);
    // Re-opened with its gap: notified.
    await update(queried, `status = 'open'`);
    expect((await notices('GAP-3')).map((r) => r.title)).toEqual(['Invoice gap: Apex A +32 h']);
  });

  it('reads the hours from the lines when there is no total', async () => {
    await addInvoice(null, {
      lines: [
        { date: '2026-10-08', hours: 8 },
        { date: '2026-10-09', hours: 50 },
      ],
    }); // GAP-7: 58 − 48 = +10
    expect((await notices('GAP-7')).map((r) => r.body)).toEqual([
      'GAP-7 invoices 58 h · reports show 48 h',
    ]);
  });

  it('notifies when a new report version changes the hours behind an invoice, at commit', async () => {
    // Only this invoice is open from here on.
    await db.query(`update sub_invoices set status = 'resolved' where org_id = $1`, [A.org]);
    const id = await addInvoice(64); // GAP-8: +16
    expect(await notices('GAP-8')).toHaveLength(1);

    const version = async (v: number, workers: number) => {
      // The writer moves the current version first and writes its manpower rows after, in one
      // transaction: the deferred trigger sees the rows.
      await db.exec('begin');
      try {
        await db.query(
          `insert into report_versions (report_id, version, data, summary, author) values ($1, $2, $3, 'v', 'office_user')`,
          [A.report, v, V1_DATA],
        );
        await db.query(`update reports set current_version = $2 where id = $1`, [A.report, v]);
        await db.query(
          `insert into manpower_entries (report_id, version, company_id, company_name, workers, hours)
         values ($1, $2, $3, 'Apex A', $4, $5)`,
          [A.report, v, A.company, workers, workers * 8],
        );
        await db.exec('commit');
      } catch (err) {
        await db.exec('rollback');
        throw err;
      }
    };

    await version(2, 6); // same 48 h: no change
    expect(await notices('GAP-8')).toHaveLength(1);
    await version(3, 7); // 56 h: gap +8, moved 8 h
    await version(4, 8); // 64 h: gap 0, nothing to say
    await version(5, 4); // 32 h: gap +32
    const rows = await notices('GAP-8');
    expect(rows.map((r) => r.title)).toEqual([
      'Invoice gap: Apex A +16 h',
      'Invoice gap: Apex A +8 h',
      'Invoice gap: Apex A +32 h',
    ]);
    const causes = await db.query<{ cause: string }>(
      `select diff ->> 'cause' as cause from audit_log
       where action = 'invoice.gap_notified' and entity_id = $1 order by id`,
      [id],
    );
    expect(causes.rows.map((r) => r.cause)).toEqual([
      'invoice_added',
      'report_version',
      'report_version',
    ]);
  });

  it('compares each invoice with its own period in invoice_gaps()', async () => {
    const res = await probeAs(
      db,
      { role: 'authenticated', userId: A.users.accounts },
      `select invoice_id, reported::float8 as reported from invoice_gaps($1, '2026-10-09', '2026-10-09')`,
      [A.org],
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // Every invoice covers Oct 5–9; the report of Oct 9 is the only one: each gets its hours once.
    for (const row of res.rows) expect(row.reported).toBe(32);
  });

  it('keeps the SQL thresholds equal to INVOICE_GAP_POLICY', async () => {
    const def = await db.query<{ def: string }>(
      `select pg_get_functiondef('invoice_gap_check(uuid, text)'::regprocedure) as def`,
    );
    const src = def.rows[0]!.def;
    expect(src).toContain(`c_min_gap constant numeric := ${INVOICE_GAP_POLICY.minGapHours};`);
    expect(src).toContain(`c_min_change constant numeric := ${INVOICE_GAP_POLICY.minChangeHours};`);
    expect(src).toContain(
      `i.status in (${INVOICE_GAP_POLICY.silentStatuses.map((s) => `'${s}'`).join(', ')})`,
    );
  });

  it('is not callable by office users or anon', async () => {
    for (const fn of [
      `select invoice_gap_check('${A.invoice}', 'x')`,
      `select invoice_reported_hours('${A.org}', '${A.company}', '2026-10-01', '2026-10-31')`,
    ]) {
      const office = await probeAs(db, { role: 'authenticated', userId: A.users.admin }, fn);
      expect(office.ok).toBe(false);
      const anon = await probeAs(db, { role: 'anon' }, fn);
      expect(anon.ok).toBe(false);
    }
  });
});

describe('the seed posts no second notice (W3-06)', () => {
  it('loads with the seeded gaps already notified', async () => {
    const seeded = await bootDatabase({ seed: true });
    const res = await seeded.query<{ title: string }>(
      `select title from notifications where kind = 'invoice_gap' order by title`,
    );
    expect(res.rows.map((r) => r.title)).toEqual(['Invoice gap: BrightLine Electric +16 h']);
    const gaps = await seeded.query<{ invoice_no: string; gap_notified: string | null }>(
      `select invoice_no, gap_notified::text from sub_invoices order by invoice_no`,
    );
    expect(gaps.rows).toEqual([
      { invoice_no: 'AP-1097', gap_notified: null },
      { invoice_no: 'BL-3381', gap_notified: '16.00' },
      { invoice_no: 'CV-2210', gap_notified: '8.00' },
      { invoice_no: 'IC-0554', gap_notified: null },
    ]);
    await seeded.close();
  });
});
