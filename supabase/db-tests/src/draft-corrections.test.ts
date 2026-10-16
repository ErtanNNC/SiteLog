import { beforeAll, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import {
  applyCrewEdit,
  emptyReportData,
  uploadStoragePath,
  type DailyReportData,
} from '@sitelog/shared';
import { DEMO_USERS } from '@sitelog/shared/demo/kestrel.ts';
import { asService, bootDatabase, probeAs } from './harness.ts';

/**
 * 20261016000100_draft_corrections.sql (W2-10, F8 *Fix by voice* and the steppers, §10.6, §7.2):
 * - uploads.correction_report_id: a correction clip completes onto its draft as no report material
 *   (no source, no status change, no job);
 * - field_request_correction(): a fix of a draft awaiting confirmation (spoken or typed), one at a
 *   time, an older preview discarded, apply_correction (`correction:<id>`) under the report's key;
 * - field_settle_correction(): ready (the preview at the draft's version and revision; a moved
 *   draft refused), unclear, stale; settled once;
 * - field_apply_correction(): Save change at the preview's revision only (`stale` otherwise: a late
 *   photo's re-extraction), the report to processing and decide_next, audited, idempotent;
 * - field_edit_draft(): a stepper's line on the draft the reporter saw, recorded as a fix;
 * - service role only.
 */

const ID = (n: number) => `dcdcdcdc-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const ORG = ID(1);
const SITE = ID(2);
const MARCO = ID(3);
const DANA = ID(4); // on another site of the org only
const SITE2 = ID(5);
const LENA = DEMO_USERS[0]!.id;

let db: PGlite;
let seq = 100;

async function svc<T = Record<string, unknown>>(sql: string, params: unknown[] = []) {
  return (await asService(db, (q) => q<T>(sql, params))).rows;
}

async function failure(sql: string, params: unknown[] = []): Promise<string | null> {
  try {
    await svc(sql, params);
    return null;
  } catch (err) {
    return (err as Error).message;
  }
}

async function insertUpload(
  date: string,
  opts: { fixes?: string; kind?: 'audio' | 'photo'; reporter?: string } = {},
) {
  const id = ID(seq++);
  const kind = opts.kind ?? 'audio';
  const path = uploadStoragePath(ORG, SITE, date, id, kind === 'audio' ? 'webm' : 'jpg');
  await svc(
    `insert into uploads (id, reporter_id, site_id, kind, storage_path, mime, recorded_at, correction_report_id)
     values ($1, $2, $3, $4, $5, $6, now(), $7)`,
    [
      id,
      opts.reporter ?? MARCO,
      SITE,
      kind,
      path,
      kind === 'audio' ? 'audio/webm' : 'image/jpeg',
      opts.fixes ?? null,
    ],
  );
  return id;
}

const complete = (id: string, reporter = MARCO) =>
  svc<{ r: Record<string, unknown> }>(`select field_complete_upload($1, $2, null) as r`, [
    id,
    reporter,
  ]).then((rows) => rows[0]!.r);

const draft = (date: string): DailyReportData => ({
  ...emptyReportData(date, { reportLanguage: 'en', units: 'imperial' }),
  manpower: [
    {
      companyId: null,
      companyNameHeard: 'Apex',
      companyName: 'Apex Concrete',
      workers: 6,
      hoursPerWorker: 8,
      totalHours: 48,
      hoursBasis: 'full_day_default',
      confidence: 0.95,
      source: [],
    },
  ],
});

/** A web draft awaiting confirmation (the worker's state after decide_next). */
async function awaiting(date: string) {
  const voice = await insertUpload(date);
  const { reportId } = (await complete(voice)) as { reportId: string };
  const base = draft(date);
  await svc(
    `insert into report_versions (report_id, version, data, author) values ($1, 1, $2, 'agent')`,
    [reportId, JSON.stringify(base)],
  );
  await svc(`update reports set status = 'awaiting_confirmation' where id = $1`, [reportId]);
  return { reportId, base };
}

const request = (report: string, opts: { upload?: string; text?: string; reporter?: string }) =>
  svc<{ r: { id: string; status: string; jobId: number | null; repeat?: boolean } }>(
    `select field_request_correction($1, $2, $3, $4) as r`,
    [report, opts.reporter ?? MARCO, opts.upload ?? null, opts.text ?? null],
  ).then((rows) => rows[0]!.r);

const settle = (id: string, outcome: string, detail: object = {}) =>
  svc<{ r: { settled: boolean; status: string } }>(
    `select field_settle_correction($1, $2, $3) as r`,
    [id, outcome, JSON.stringify(detail)],
  ).then((rows) => rows[0]!.r);

const apply = (id: string, report: string, reporter = MARCO) =>
  svc<{ r: Record<string, unknown> }>(`select field_apply_correction($1, $2, $3) as r`, [
    id,
    report,
    reporter,
  ]).then((rows) => rows[0]!.r);

const version = (report: string) =>
  svc<{ data: DailyReportData; draft_rev: number }>(
    `select data, draft_rev from report_versions where report_id = $1 and version = 1`,
    [report],
  ).then((rows) => rows[0]!);

const reportStatus = (id: string) =>
  svc<{ status: string }>(`select status::text from reports where id = $1`, [id]).then(
    (rows) => rows[0]!.status,
  );

const correction = (id: string) =>
  svc<{ status: string; reason: string | null; base_rev: number | null }>(
    `select status, reason, base_rev from draft_corrections where id = $1`,
    [id],
  ).then((rows) => rows[0]!);

/** The preview the worker would settle: Apex 6 → 7 (code's numbers), at the draft's revision. */
function preview(base: DailyReportData, rev: number, workers = 7) {
  const data: DailyReportData = {
    ...base,
    manpower: [{ ...base.manpower[0]!, workers, totalHours: workers * 8 }],
  };
  return {
    data,
    changes: [
      {
        kind: 'crew',
        company: 'Apex Concrete',
        change: 'changed',
        workers: [6, workers],
        hoursPerWorker: [8, 8],
        totalHours: [48, workers * 8],
      },
    ],
    operations: [{ op: 'replace', path: '/manpower/0/workers', value: workers }],
    source: { type: 'voice_note', uploadId: 'clip', start: 0, end: 2.3 },
    changeNote: 'Apex Concrete 6 → 7 workers',
    baseVersion: 1,
    baseRev: rev,
  };
}

beforeAll(async () => {
  db = await bootDatabase({ seed: true });
  await db.exec(`
    insert into orgs (id, name) values ('${ORG}', 'Fix Build');
    insert into sites (id, org_id, name, project_code, timezone) values
      ('${SITE}', '${ORG}', 'Riverside', 'FX-1', 'America/Chicago'),
      ('${SITE2}', '${ORG}', 'Pier', 'FX-2', 'America/Chicago');
    insert into reporters (id, org_id, name, phone_e164, status) values
      ('${MARCO}', '${ORG}', 'Marco Ruiz', '+15550149201', 'active'),
      ('${DANA}', '${ORG}', 'Dana Park', '+15550149202', 'active');
    insert into site_reporters (site_id, reporter_id, is_primary) values
      ('${SITE}', '${MARCO}', true), ('${SITE2}', '${DANA}', true);
  `);
});

describe('correction clips (uploads.correction_report_id)', () => {
  it('complete onto the draft as no report material; only an audio clip outside a batch', async () => {
    const { reportId } = await awaiting('2026-10-05');
    const jobs = (await svc(`select id from jobs`)).length;
    const clip = await insertUpload('2026-10-05', { fixes: reportId });
    expect(await complete(clip)).toMatchObject({
      reportId,
      reportStatus: 'awaiting_confirmation',
      jobId: null,
      created: false,
      correctionClip: true,
    });
    expect(await svc(`select 1 from report_sources where upload_id = $1`, [clip])).toEqual([]);
    expect((await svc(`select id from jobs`)).length).toBe(jobs);
    expect(await reportStatus(reportId)).toBe('awaiting_confirmation');
    expect(await complete(clip)).toMatchObject({ alreadyComplete: true, correctionClip: true });
    const wrongDay = await insertUpload('2026-10-06', { fixes: reportId });
    expect(await failure(`select field_complete_upload($1, $2, null)`, [wrongDay, MARCO])).toBe(
      'upload_path_mismatch',
    );
    expect(
      await failure(
        `insert into uploads (reporter_id, site_id, kind, storage_path, correction_report_id)
         values ($1, $2, 'photo', 'x', $3)`,
        [MARCO, SITE, reportId],
      ),
    ).toMatch(/uploads_correction_clip_check/);
  });
});

describe('field_request_correction → field_settle_correction → field_apply_correction', () => {
  it('a spoken fix: listening, the preview, Save change at its revision, decide_next, audited', async () => {
    const { reportId, base } = await awaiting('2026-10-07');
    const clip = await insertUpload('2026-10-07', { fixes: reportId });
    // Not completed yet: not this draft's clip.
    expect(
      await failure(`select field_request_correction($1, $2, $3, null)`, [reportId, MARCO, clip]),
    ).toBe('upload_not_found');
    await complete(clip);
    const req = await request(reportId, { upload: clip });
    expect(req.status).toBe('listening');
    const [job] = await svc<{
      type: string;
      dedupe_key: string;
      payload: object;
      lock_key: string;
    }>(
      `select type, dedupe_key, payload, job_lock_key(type, payload) as lock_key from jobs where id = $1`,
      [req.jobId],
    );
    expect(job).toEqual({
      type: 'apply_correction',
      dedupe_key: `correction:${req.id}`,
      payload: { reportId, correctionId: req.id },
      lock_key: `report:${reportId}`,
    });
    // The same clip again: the first answer, no second job; another fix meanwhile: pending.
    expect(await request(reportId, { upload: clip })).toMatchObject({ id: req.id, repeat: true });
    expect(
      await failure(`select field_request_correction($1, $2, null, 'Apex had 7')`, [
        reportId,
        MARCO,
      ]),
    ).toBe('correction_pending');
    // The preview is not saved yet: nothing to apply.
    expect(
      await failure(`select field_apply_correction($1, $2, $3)`, [req.id, reportId, MARCO]),
    ).toBe('correction_not_ready');

    const rev = (await version(reportId)).draft_rev;
    // A preview made from another revision is refused (the job runs again on the new draft).
    expect(
      await failure(`select field_settle_correction($1, 'ready', $2)`, [
        req.id,
        JSON.stringify(preview(base, rev + 1)),
      ]),
    ).toBe('draft_changed');
    expect(await settle(req.id, 'ready', preview(base, rev))).toEqual({
      settled: true,
      status: 'ready',
    });
    expect(await settle(req.id, 'unclear', { reason: 'silent' })).toEqual({
      settled: false,
      status: 'ready',
    });
    // The draft does not change with the preview.
    expect((await version(reportId)).data.manpower[0]!.workers).toBe(6);

    const res = await apply(req.id, reportId);
    expect(res).toMatchObject({ status: 'applied', reportStatus: 'processing' });
    const after = await version(reportId);
    expect(after.data.manpower[0]).toMatchObject({ workers: 7, totalHours: 56 });
    expect(after.draft_rev).toBe(rev + 1);
    expect(await reportStatus(reportId)).toBe('processing');
    const [decide] = await svc<{ type: string; dedupe_key: string }>(
      `select type, dedupe_key from jobs where id = $1`,
      [res.jobId],
    );
    expect(decide).toEqual({
      type: 'decide_next',
      dedupe_key: `decide:${reportId}:correction:${req.id}`,
    });
    // A retry (a lost response): applied again, nothing written twice.
    expect(await apply(req.id, reportId)).toMatchObject({ status: 'applied', repeat: true });
    expect((await version(reportId)).draft_rev).toBe(rev + 1);
    const actions = (
      await svc<{ action: string }>(
        `select action from audit_log where entity_id = $1 and action like 'report.%' order by id`,
        [reportId],
      )
    ).map((r) => r.action);
    expect(actions).toEqual(
      expect.arrayContaining([
        'report.correction_requested',
        'report.correction_previewed',
        'report.draft_corrected',
      ]),
    );
    const [corrected] = await svc<{
      actor_type: string;
      actor_id: string;
      diff: Record<string, unknown>;
    }>(
      `select actor_type, actor_id, diff from audit_log where entity_id = $1 and action = 'report.draft_corrected'`,
      [reportId],
    );
    expect(corrected).toMatchObject({
      actor_type: 'reporter',
      actor_id: MARCO,
      diff: { correction_id: req.id, via: 'voice', upload_id: clip, from_rev: rev },
    });
  });

  it('a late photo re-extracts the draft first: the preview is stale (draft_changed)', async () => {
    const { reportId, base } = await awaiting('2026-10-08');
    const req = await request(reportId, { text: 'Apex had 7, not 6' });
    const rev = (await version(reportId)).draft_rev;
    await settle(req.id, 'ready', preview(base, rev));
    // The photo completes on the draft: processing, extract_report queued.
    const photo = await insertUpload('2026-10-08', { kind: 'photo' });
    await complete(photo);
    expect(await reportStatus(reportId)).toBe('processing');
    const res = await apply(req.id, reportId);
    expect(res).toMatchObject({ status: 'stale', reportStatus: 'processing' });
    expect(await correction(req.id)).toMatchObject({ status: 'stale', reason: 'draft_changed' });
    expect((await version(reportId)).data.manpower[0]!.workers).toBe(6);
    // The re-extraction wrote a new revision and the draft is shown again: still stale.
    await svc(
      `update report_versions set data = data || '{"summary": "re-extracted"}' where report_id = $1`,
      [reportId],
    );
    await svc(`update reports set status = 'awaiting_confirmation' where id = $1`, [reportId]);
    expect(
      await failure(`select field_apply_correction($1, $2, $3)`, [req.id, reportId, MARCO]),
    ).toBe('correction_not_ready');
  });

  it('unclear, stale and a newer fix: the older preview is discarded', async () => {
    const { reportId, base } = await awaiting('2026-10-09');
    const first = await request(reportId, { text: 'change it to three' });
    expect(
      await settle(first.id, 'unclear', { reason: 'clarification', clarification: 'Which crew?' }),
    ).toEqual({ settled: true, status: 'unclear' });
    const second = await request(reportId, { text: 'Apex had 7' });
    expect((await correction(first.id)).status).toBe('discarded');
    await settle(second.id, 'ready', preview(base, (await version(reportId)).draft_rev));
    const third = await request(reportId, { text: 'Apex had 8' });
    expect((await correction(second.id)).status).toBe('discarded');
    // The report moved on (filed by its timeout) before the worker settled: stale.
    await svc(`update reports set status = 'processing' where id = $1`, [reportId]);
    expect(await settle(third.id, 'ready', preview(base, 1, 8))).toEqual({
      settled: true,
      status: 'stale',
    });
    expect(
      await failure(`select field_request_correction($1, $2, null, 'x y')`, [reportId, MARCO]),
    ).toBe('wrong_state');
  });

  it('scoped to the reporter’s sites and the correction’s reporter', async () => {
    const { reportId } = await awaiting('2026-10-12');
    expect(
      await failure(`select field_request_correction($1, $2, null, 'Apex had 7')`, [
        reportId,
        DANA,
      ]),
    ).toBe('report_not_found');
    const req = await request(reportId, { text: 'Apex had 7' });
    expect(
      await failure(`select field_apply_correction($1, $2, $3)`, [req.id, reportId, DANA]),
    ).toBe('report_not_found');
    expect(
      await failure(`select field_request_correction($1, $2, null, null)`, [reportId, MARCO]),
    ).toBe('invalid_request');
  });
});

describe('field_edit_draft (the steppers)', () => {
  it('writes the line on the draft the reporter saw, records the fix, decide_next; else stale', async () => {
    const { reportId, base } = await awaiting('2026-10-13');
    const rev = (await version(reportId)).draft_rev;
    const source = {
      type: 'reporter_edit',
      reporterId: MARCO,
      at: '2026-10-13T21:00:00Z',
      via: 'web',
    };
    const edit = applyCrewEdit(
      base,
      { index: 0, workers: 7, hoursPerWorker: 9 },
      { source: source as never, defaultShiftHours: 8 },
    );
    expect(edit.ok).toBe(true);
    if (!edit.ok) return;
    const call = (r: number, b: object) =>
      svc<{ r: Record<string, unknown> }>(
        `select field_edit_draft($1, $2, 1, $3, $4, $5, $6, $7) as r`,
        [
          reportId,
          MARCO,
          r,
          JSON.stringify(b),
          JSON.stringify(edit.data),
          JSON.stringify(edit.changes),
          JSON.stringify(source),
        ],
      ).then((rows) => rows[0]!.r);
    // Another revision, or another draft than the one sent: stale, nothing written.
    expect(await call(rev + 1, base)).toMatchObject({ status: 'stale' });
    expect(await call(rev, { ...base, summary: 'other' })).toMatchObject({ status: 'stale' });
    const res = await call(rev, base);
    expect(res).toMatchObject({ status: 'processing', reportStatus: 'processing' });
    const after = await version(reportId);
    expect(after.data.manpower[0]).toMatchObject({ workers: 7, hoursPerWorker: 9, totalHours: 63 });
    expect(after.data.manpower[0]!.source).toEqual([source]);
    const [fix] = await svc<{ via: string; status: string; source: object; base_rev: number }>(
      `select via, status, source, base_rev from draft_corrections where report_id = $1`,
      [reportId],
    );
    expect(fix).toEqual({ via: 'stepper', status: 'applied', source, base_rev: rev });
    const [decide] = await svc<{ dedupe_key: string }>(
      `select dedupe_key from jobs where id = $1`,
      [res.jobId],
    );
    expect(decide!.dedupe_key).toBe(`decide:${reportId}:edit:v1:r${rev}`);
    // Not awaiting confirmation any more: stale.
    expect(await call(after.draft_rev, after.data)).toMatchObject({ status: 'stale' });
  });
});

describe('service role only', () => {
  it('office users and anon cannot call the correction functions or read the table', async () => {
    for (const sql of [
      `select field_request_correction('${ID(999)}', '${ID(998)}', null, 'x y')`,
      `select field_settle_correction('${ID(999)}', 'unclear')`,
      `select field_apply_correction('${ID(999)}', '${ID(998)}', '${ID(997)}')`,
      `select * from draft_corrections`,
    ]) {
      const res = await probeAs(db, { role: 'authenticated', userId: LENA }, sql);
      expect(res, sql).toMatchObject({ ok: false, code: '42501' });
    }
  });
});
