import { beforeAll, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { DEMO_ORG_ID, DEMO_USERS } from '@sitelog/shared/demo/kestrel.ts';
import { asService, asUser, bootDatabase } from './harness.ts';

/**
 * 20261015000010_signoff_pdf_rerender.sql: signing off (and undoing it) re-renders the current
 * version's PDF, so the stored file shows "Signed off in SiteLog by {name}" (§12), each event
 * under its own dedupe key (D16).
 */

const SAM = DEMO_USERS[1]!.id; // pm

let db: PGlite;

async function svc<T = Record<string, unknown>>(sql: string, params: unknown[] = []) {
  return (await asService(db, (q) => q<T>(sql, params))).rows;
}

interface JobRow {
  payload: { reportId: string; version: number; emailRecipients: boolean };
  dedupe_key: string;
}

const renderJobs = (reportId: string) =>
  svc<JobRow>(
    `select payload, dedupe_key from jobs
     where type = 'render_pdf' and payload->>'reportId' = $1 order by id`,
    [reportId],
  );

beforeAll(async () => {
  db = await bootDatabase({ seed: true });
});

describe('sign-off re-renders the stored PDF', () => {
  it('enqueues render_pdf for the current version on sign-off and on undo, without email', async () => {
    const [report] = await svc<{ id: string; current_version: number }>(
      `select id, current_version from reports where org_id = $1 and status = 'filed'
       order by report_no limit 1`,
      [DEMO_ORG_ID],
    );
    expect(report).toBeDefined();
    const id = report!.id;
    const before = (await renderJobs(id)).length;

    await asUser(db, SAM, (q) => q(`select sign_off_report($1)`, [id]));
    let jobs = (await renderJobs(id)).slice(before);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.payload).toEqual({
      reportId: id,
      version: report!.current_version,
      emailRecipients: false,
    });
    expect(jobs[0]!.dedupe_key).toMatch(
      new RegExp(`^render_pdf:${id}:${report!.current_version}:signoff:\\d+$`),
    );

    await asUser(db, SAM, (q) => q(`select undo_sign_off($1)`, [id]));
    jobs = (await renderJobs(id)).slice(before);
    expect(jobs).toHaveLength(2);
    expect(jobs[1]!.dedupe_key).toMatch(/:signoff_undone:\d+$/);

    // Signed off again: a new key, so a third render (a key is never used twice, D16).
    await asUser(db, SAM, (q) => q(`select sign_off_report($1)`, [id]));
    jobs = (await renderJobs(id)).slice(before);
    expect(jobs).toHaveLength(3);
    expect(new Set(jobs.map((j) => j.dedupe_key)).size).toBe(3);
  });

  it('runs a sign-off render and its undo render one at a time, in order (20261015000060)', async () => {
    const [report] = await svc<{ id: string }>(
      `select id from reports where org_id = $1 and status = 'filed' order by report_no desc limit 1`,
      [DEMO_ORG_ID],
    );
    const id = report!.id;
    await svc(`delete from jobs`);
    await asUser(db, SAM, (q) => q(`select sign_off_report($1)`, [id]));
    await asUser(db, SAM, (q) => q(`select undo_sign_off($1)`, [id]));
    const keys = await svc<{ lock_key: string | null }>(`select lock_key from jobs order by id`);
    expect(keys).toHaveLength(2);
    expect(keys[0]!.lock_key).not.toBeNull();
    expect(keys[1]!.lock_key).toBe(keys[0]!.lock_key);

    const claim = () => svc<{ dedupe_key: string }>(`select dedupe_key from claim_jobs('w1', 10)`);
    const first = await claim();
    expect(first).toHaveLength(1);
    expect(first[0]!.dedupe_key).toMatch(/:signoff:\d+$/);
    expect(await claim()).toEqual([]); // the undo waits for the sign-off render
    await svc(`update jobs set status = 'done', finished_at = now() where dedupe_key = $1`, [
      first[0]!.dedupe_key,
    ]);
    const second = await claim();
    expect(second).toHaveLength(1);
    expect(second[0]!.dedupe_key).toMatch(/:signoff_undone:\d+$/);
  });
});
