import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { emptyReportDataV1, type DailyReportDataV1 } from '@sitelog/shared';
import { connectStack, STACK_DB_URL } from '../../../supabase/db-tests/stack/db.ts';
import { connectDb, type Db, type VersionInput } from './db';

/**
 * The filing lock (W1-15, 20261015000090) on real Postgres (`pnpm test:stack`, CI's e2e-supabase
 * job; skipped without SUPABASE_DB_URL). PGlite is one session, so db.pglite.test.ts can only run
 * fileVersion and the draft writes one after the other; here they overlap on two connections.
 *
 * To hold fileVersion inside its transaction, a third session locks the report's version row
 * first: fileVersion then has the site-day and report row locks and waits on that row. A draft
 * write started meanwhile queues on the report's row lock (storeDraftVersion and insertVersion
 * both take it first). Releasing the version row lets fileVersion finish and commit; the draft
 * write then sees a filed report and writes nothing.
 *
 * The other order: the draft write holds the report's row lock (waiting on the version row) when
 * fileVersion starts, so fileVersion queues behind it, then finds a newer draft revision than the
 * one its filing was computed from and writes nothing.
 */

const describeStack = STACK_DB_URL ? describe : describe.skip;

describeStack('filing lock on real Postgres (W1-15)', () => {
  let sql: Sql;
  let dbFile: Db;
  let dbDraft: Db;
  let orgId: string | undefined;
  let siteId: string;
  let day = 0;

  beforeAll(async () => {
    sql = connectStack(4);
    // One connection each: their transactions are separate sessions.
    dbFile = connectDb(STACK_DB_URL!, { max: 1 });
    dbDraft = connectDb(STACK_DB_URL!, { max: 1 });
    const [org] = await sql<{ id: string }[]>`
      insert into orgs (name) values (${`test:stack filing ${Date.now()}`}) returning id`;
    orgId = org!.id;
    const [site] = await sql<{ id: string }[]>`
      insert into sites (org_id, name, project_code, timezone)
      values (${orgId}, 'Filing', 'STK-F', 'America/Chicago') returning id`;
    siteId = site!.id;
  });

  afterAll(async () => {
    await dbFile?.close();
    await dbDraft?.close();
    if (orgId) await sql`delete from orgs where id = ${orgId}`;
    await sql?.end({ timeout: 5 });
  });

  function reportData(date: string, summary: string): DailyReportDataV1 {
    return {
      ...emptyReportDataV1(date),
      summary,
      manpower: [
        {
          companyId: null,
          companyNameHeard: 'the Ridgeway crew',
          companyName: 'Ridgeway',
          workers: 4,
          hoursPerWorker: 6.5,
          totalHours: 26,
          hoursBasis: 'stated',
          confidence: 0.8,
          source: [],
        },
      ],
    };
  }

  /** A report awaiting confirmation with draft v1 at revision 1, on a site-day of its own. */
  async function seedReport() {
    const date = `2026-03-${String(++day).padStart(2, '0')}`;
    const siteDay = await dbFile.getOrCreateSiteDay(siteId, date, new Date(`${date}T23:30:00Z`));
    const report = await dbFile.insertReport({
      org_id: orgId!,
      site_id: siteId,
      site_day_id: siteDay.id,
      report_no: await dbFile.nextReportNo(siteId),
      reporter_id: null,
      received_at: `${date}T21:30:00Z`,
      kind: 'daily',
      status: 'awaiting_confirmation',
    });
    const draft = (summary: string): VersionInput => ({
      report_id: report.id,
      version: 1,
      data: reportData(date, summary),
      summary,
      author: 'agent',
    });
    expect((await dbFile.storeDraftVersion(draft('Extracted')))!.draft_rev).toBe(1);
    const file = (draftRev: number) =>
      dbFile.fileVersion({
        reportId: report.id,
        siteDayId: siteDay.id,
        version: 1,
        expect: { status: 'awaiting_confirmation', draftRev },
        data: reportData(date, 'Frozen'),
        summary: 'Frozen',
        report: { status: 'filed', filed_at: new Date(`${date}T21:40:00Z`) },
        siteDay: { status: 'filed', report_id: report.id },
        audit: {
          org_id: orgId!,
          actor_type: 'agent',
          action: 'report.filed',
          entity: 'report',
          entity_id: report.id,
          diff: { version: 1 },
        },
      });
    const state = async () => {
      const [row] = await sql<
        {
          status: string;
          day: string;
          summary: string;
          rev: number;
          manpower: number;
          filed: number;
        }[]
      >`
        select r.status::text, d.status::text as day, v.summary, v.draft_rev as rev,
               (select count(*)::int from manpower_entries m where m.report_id = r.id) as manpower,
               (select count(*)::int from audit_log a
                 where a.entity_id = r.id and a.action = 'report.filed') as filed
        from reports r
        join site_days d on d.id = r.site_day_id
        join report_versions v on v.report_id = r.id and v.version = 1
        where r.id = ${report.id}`;
      return row!;
    };
    return { report, draft, file, state };
  }

  /** Locks the report's version row in a session of its own until `release()`. */
  async function holdVersionRow(reportId: string) {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let locked!: (pid: number) => void;
    const pid = new Promise<number>((r) => (locked = r));
    const done = sql.begin(async (tx) => {
      const [row] = await tx<{ pid: number }[]>`select pg_backend_pid() as pid`;
      await tx`select 1 from report_versions where report_id = ${reportId} and version = 1 for update`;
      locked(row!.pid);
      await gate;
    });
    const holder = await Promise.race([
      pid,
      done.then(() => Promise.reject(new Error('the version row lock ended early'))),
    ]);
    return {
      pid: holder,
      release: async () => {
        release();
        await done;
      },
    };
  }

  /** Waits until a session waits on a lock `pid` holds, and returns that session's pid. */
  async function blockedBy(pid: number): Promise<number> {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const rows = await sql<{ pid: number }[]>`
        select pid from pg_stat_activity where ${pid}::int = any(pg_blocking_pids(pid))`;
      if (rows.length > 0) return rows[0]!.pid;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error(`nothing waited on session ${pid}`);
  }

  /** Records whether `p` has settled, without letting a rejection go unhandled. */
  function track<T>(p: Promise<T>) {
    const t = { settled: false, result: p };
    p.then(
      () => (t.settled = true),
      () => (t.settled = true),
    );
    return t;
  }

  it.each([
    ['storeDraftVersion', (db: Db, v: VersionInput) => db.storeDraftVersion(v)],
    ['insertVersion', (db: Db, v: VersionInput) => db.insertVersion(v)],
  ] as const)(
    '%s waiting on a filing in progress does not overwrite the filed version',
    async (writer, write) => {
      const { report, draft, file, state } = await seedReport();
      const hold = await holdVersionRow(report.id);
      // fileVersion: site-day and report row locks taken, waiting on the version row.
      const filing = track(file(1));
      const filePid = await blockedBy(hold.pid);
      // The draft write queues on the report's row lock that fileVersion holds.
      const drafting = track(write(dbDraft, draft(`Re-extracted by ${writer}`)));
      await blockedBy(filePid);
      expect(filing.settled).toBe(false);
      expect(drafting.settled).toBe(false);

      await hold.release();
      const filed = await filing.result;
      expect(filed.filed && filed.report.status).toBe('filed');
      if (writer === 'storeDraftVersion') expect(await drafting.result).toBeNull();
      else await expect(drafting.result).rejects.toThrow('already exists and is immutable');

      // The frozen data stands, at the revision the filing was computed from.
      const end = await state();
      expect(end).toEqual({
        status: 'filed',
        day: 'filed',
        summary: 'Frozen',
        rev: 1,
        manpower: 1,
        filed: 1,
      });
      expect(
        (await dbFile.getVersion(report.id, 1))!.data as unknown as DailyReportDataV1,
      ).toMatchObject({ summary: 'Frozen' });
    },
  );

  it('a draft write that commits first makes the filing stale: fileVersion writes nothing', async () => {
    const { report, draft, file, state } = await seedReport();
    const before = await state();
    expect(before).toMatchObject({ status: 'awaiting_confirmation', rev: 1, filed: 0 });
    const hold = await holdVersionRow(report.id);
    // storeDraftVersion: report row lock taken, its upsert waiting on the version row.
    const drafting = track(dbDraft.storeDraftVersion(draft('Re-extracted')));
    const draftPid = await blockedBy(hold.pid);
    // fileVersion (computed from revision 1) queues on the report's row lock.
    const filing = track(file(1));
    await blockedBy(draftPid);
    expect(drafting.settled).toBe(false);
    expect(filing.settled).toBe(false);

    await hold.release();
    expect((await drafting.result)!.draft_rev).toBe(2);
    expect(await filing.result).toEqual({ filed: false });
    // No partial filing: status, site-day, frozen data, denormalised rows and audit untouched.
    expect(await state()).toEqual({ ...before, summary: 'Re-extracted', rev: 2 });

    // A filing computed from the new revision goes through.
    const res = await file(2);
    expect(res.filed).toBe(true);
    expect(await state()).toMatchObject({ status: 'filed', summary: 'Frozen', rev: 2, filed: 1 });
  });
});
