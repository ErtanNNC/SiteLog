import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  applyAnswer,
  correctionNote,
  formatDate,
  optionAnswer,
  readReportData,
  type DailyReportData,
  type JobRow,
  type QuestionOption,
  type StoredReportData,
} from '@sitelog/shared';
import { createFakeTranscriber, fakeAudio } from '../ai/fake-transcriber';
import { runJob } from '../runner';
import { startPgliteDatabase, type PgliteDatabase } from '../test/pglite';
import { createSim, loadFixtureLibrary, manualClock, NO_LATENCY } from './fakes';
import { createWorld, type World } from './world';
import { DEMO_USERS } from '@sitelog/shared/demo/kestrel.ts';

/**
 * W2-10 (F8 *Fix by voice*, §10.6, §7.2) on a real database (PGlite, every migration and the §18
 * seed): the hero report's draft fixed by voice. The correction clip goes in as field-api puts it
 * (`uploads.correction_report_id`, field_complete_upload(), field_request_correction()), then the
 * real apply_correction job: the fake transcriber (fixtures/voice, kind `correction`) and the fake
 * Claude (the recorded fixtures/corrections output). "Apex had seven, not six." makes the preview
 * "Apex Concrete 6 → 7 workers, 48 → 56 h" without touching the draft; Save change
 * (field_apply_correction()) writes it at that revision, decide_next shows the draft again (7 × 8 =
 * 56 h, the clip as the source) and Confirm & send files that revision. A late photo makes the
 * preview stale; a re-extraction keeps the fix (spec §19 Q96); a model total is never taken; a fix
 * with no crew named asks which; nothing goes to a provider once a processing consent is off.
 */

let database: PgliteDatabase;
let world: World;
const clock = manualClock(new Date('2026-10-12T22:35:00Z'));
const transcriber = createFakeTranscriber();
let MARCO = '';
let RIVERSIDE = '';
let ORG = '';

beforeAll(async () => {
  database = await startPgliteDatabase({ seed: true });
  world = createWorld({
    db: database.db,
    sql: database.sql,
    clock,
    sim: createSim({ advance: clock, profile: NO_LATENCY }),
    lib: loadFixtureLibrary(['riverside-2026-10-09']),
    fieldTranscriber: transcriber,
    config: { CLAUDE_MODEL: 'claude-test' },
  });
  const marco = (
    await database.q<{ id: string; org_id: string }>(
      `select id, org_id from reporters where name = 'Marco Ruiz'`,
    )
  )[0]!;
  MARCO = marco.id;
  ORG = marco.org_id;
  RIVERSIDE = (
    await database.q<{ id: string }>(`select id from sites where project_code = 'RL-2041'`)
  )[0]!.id;
  // Marco is on the recorder: no draft_ready text in these tests.
  await database.q(
    `insert into field_devices (reporter_id, device_token_hash, verified_at, last_seen_at)
     values ($1, 'w2-10-device', now(), now() + interval '1 day')`,
    [MARCO],
  );
}, 120_000);

afterAll(async () => {
  await database?.close();
});

async function run(jobId: number) {
  const [row] = await database.q<JobRow>(
    `update jobs set status = 'running', locked_at = now(), locked_by = 'integration',
       attempts = attempts + 1 where id = $1 returning *`,
    [jobId],
  );
  return runJob(world.ctx, row!, 60_000, { workerId: 'integration' });
}

async function runQueued(type: string, reportId: string) {
  const jobs = await database.q<{ id: number; dedupe_key: string }>(
    `select id, dedupe_key from jobs where type = $1 and status = 'queued'
       and payload ->> 'reportId' = $2 and not payload ? 'timeout' order by id`,
    [type, reportId],
  );
  expect(jobs, `${type} queued`).toHaveLength(1);
  expect(await run(jobs[0]!.id)).toEqual({ ok: true });
  return jobs[0]!;
}

async function draftOf(reportId: string): Promise<{ data: DailyReportData; rev: number }> {
  const [v] = await database.q<{ data: StoredReportData; draft_rev: number }>(
    `select v.data, v.draft_rev from report_versions v join reports r on r.id = v.report_id
       and v.version = r.current_version where r.id = $1`,
    [reportId],
  );
  return { data: readReportData(v!.data), rev: v!.draft_rev };
}

const status = async (reportId: string) =>
  (
    await database.q<{ s: string }>(`select status::text as s from reports where id = $1`, [
      reportId,
    ])
  )[0]!.s;

const apex = (d: DailyReportData) => d.manpower.find((m) => m.companyName === 'Apex Concrete')!;

/** A photo of the report as field-api completes it. */
async function photo(date: string) {
  const [u] = await database.q<{ id: string }>(
    `insert into uploads (reporter_id, site_id, kind, storage_path, mime, recorded_at)
     values ($1, $2, 'photo', 'pending', 'image/jpeg', now()) returning id`,
    [MARCO, RIVERSIDE],
  );
  const path = `${ORG}/${RIVERSIDE}/${date}/${u!.id}.jpg`;
  await database.q(`update uploads set storage_path = $2 where id = $1`, [u!.id, path]);
  const [r] = await database.q<{ r: { jobId: number | null; reportStatus: string } }>(
    `select field_complete_upload($1, $2, 1) as r`,
    [u!.id, MARCO],
  );
  return r!.r;
}

/** The hero note with two photos → the Delta question → answered (a tap) → the draft. */
async function heroDraft(date: string): Promise<string> {
  const up = await world.uploadVoiceNote({
    reporterId: MARCO,
    siteId: RIVERSIDE,
    fixtureId: 'es-en-riverside-2026-10-09',
    date,
  });
  await photo(date);
  await photo(date);
  expect(await run(up.jobId!)).toEqual({ ok: true });
  await runQueued('extract_report', up.reportId);
  await runQueued('decide_next', up.reportId);
  const [q] = await database.q<{
    id: string;
    field: 'manpower.workers';
    target: object;
    options: QuestionOption[];
  }>(`select id, field, target, options from questions where report_id = $1`, [up.reportId]);
  const [v] = await database.q<{ data: StoredReportData }>(
    `select data from report_versions where report_id = $1 and version = 1`,
    [up.reportId],
  );
  const option = q!.options.find((o) => o.id === 'o2')!;
  const value = optionAnswer(q!.field, option)!;
  const applied = applyAnswer(
    readReportData(v!.data),
    { field: q!.field, target: q!.target },
    value,
    {
      defaultShiftHours: 8,
      source: { type: 'answer', questionId: q!.id },
    },
  );
  await database.q(`select field_answer_question($1, $2, $3, $4, $5, $6, $7, null)`, [
    up.reportId,
    q!.id,
    MARCO,
    JSON.stringify(v!.data),
    JSON.stringify(applied.data),
    JSON.stringify({ optionId: 'o2', text: option.label, parsed: value, via: 'web' }),
    JSON.stringify({ type: 'answer', questionId: q!.id }),
  ]);
  await runQueued('decide_next', up.reportId);
  expect(await status(up.reportId)).toBe('awaiting_confirmation');
  return up.reportId;
}

/** A correction clip as field-api makes it: upload (correction_report_id), complete, request. */
async function fix(reportId: string, fixtureId: string, date: string) {
  const [u] = await database.q<{ id: string }>(
    `insert into uploads (reporter_id, site_id, kind, storage_path, mime, recorded_at, correction_report_id)
     values ($1, $2, 'audio', 'pending', 'audio/webm', now(), $3) returning id`,
    [MARCO, RIVERSIDE, reportId],
  );
  const path = `${ORG}/${RIVERSIDE}/${date}/${u!.id}.webm`;
  await database.q(`update uploads set storage_path = $2 where id = $1`, [u!.id, path]);
  const body = fakeAudio(fixtureId, 3);
  await world.storage.upload('audio', path, body, 'audio/webm');
  const [done] = await database.q<{ r: { jobId: number | null; correctionClip: boolean } }>(
    `select field_complete_upload($1, $2, $3) as r`,
    [u!.id, MARCO, body.length],
  );
  expect(done!.r).toMatchObject({ jobId: null, correctionClip: true });
  const [res] = await database.q<{ r: { id: string; status: string; jobId: number } }>(
    `select field_request_correction($1, $2, $3, null) as r`,
    [reportId, MARCO, u!.id],
  );
  expect(res!.r.status).toBe('listening');
  return { uploadId: u!.id, correctionId: res!.r.id, jobId: res!.r.jobId };
}

const correction = async (id: string) =>
  (
    await database.q<{
      status: string;
      reason: string | null;
      clarification: string | null;
      changes: unknown;
      data: StoredReportData | null;
      base_rev: number | null;
    }>(
      `select status, reason, clarification, changes, data, base_rev from draft_corrections where id = $1`,
      [id],
    )
  )[0]!;

const save = async (correctionId: string, reportId: string) =>
  (
    await database.q<{ r: { status: string; jobId: number | null } }>(
      `select field_apply_correction($1, $2, $3) as r`,
      [correctionId, reportId, MARCO],
    )
  )[0]!.r;

describe('W2-10: Fix by voice on the draft, apply_correction, Save change, Confirm & send', () => {
  it('"Apex had seven, not six" → preview → saved → 7 × 8 = 56 h citing the clip → filed at that revision', async () => {
    const date = '2026-10-12';
    const reportId = await heroDraft(date);
    const before = await draftOf(reportId);
    expect(apex(before.data)).toMatchObject({ workers: 6, hoursPerWorker: 8, totalHours: 48 });

    const clip = await fix(reportId, 'correction-en-apex-seven', date);
    // The clip is not report material: no report source, no transcription job.
    expect(
      await database.q(`select 1 from report_sources where upload_id = $1`, [clip.uploadId]),
    ).toEqual([]);
    const [job] = await database.q<{ dedupe_key: string }>(
      `select dedupe_key from jobs where id = $1`,
      [clip.jobId],
    );
    expect(job!.dedupe_key).toBe(`correction:${clip.correctionId}`);
    expect(await run(clip.jobId)).toEqual({ ok: true });

    // The preview: code's numbers; the draft itself unchanged until Save change.
    const preview = await correction(clip.correctionId);
    expect(preview).toMatchObject({ status: 'ready', base_rev: before.rev });
    expect(preview.changes).toEqual([
      {
        kind: 'crew',
        company: 'Apex Concrete',
        change: 'changed',
        workers: [6, 7],
        hoursPerWorker: [8, 8],
        totalHours: [48, 56],
      },
    ]);
    expect(await draftOf(reportId)).toEqual(before);
    expect(await status(reportId)).toBe('awaiting_confirmation');
    expect(world.claude.phoneLeaks).toEqual([]);

    // Save change → processing → decide_next shows the draft again with a new revision.
    expect(await save(clip.correctionId, reportId)).toMatchObject({
      status: 'applied',
      reportStatus: 'processing',
    });
    const decide = await runQueued('decide_next', reportId);
    expect(decide.dedupe_key).toBe(`decide:${reportId}:correction:${clip.correctionId}`);
    expect(await status(reportId)).toBe('awaiting_confirmation');
    const after = await draftOf(reportId);
    expect(after.rev).toBeGreaterThan(before.rev);
    expect(apex(after.data)).toMatchObject({ workers: 7, hoursPerWorker: 8, totalHours: 56 });
    expect(apex(after.data).source).toEqual([
      ...apex(before.data).source,
      { type: 'voice_note', uploadId: clip.uploadId, start: 0, end: 2.3 },
    ]);
    // Every other crew untouched.
    expect(after.data.manpower.filter((m) => m.companyName !== 'Apex Concrete')).toEqual(
      before.data.manpower.filter((m) => m.companyName !== 'Apex Concrete'),
    );
    // The new revision has its own §7.2 clock.
    const clockKeys = (
      await database.q<{ dedupe_key: string }>(
        `select dedupe_key from jobs where type = 'decide_next' and payload ->> 'reportId' = $1
           and payload ? 'timeout'`,
        [reportId],
      )
    ).map((j) => j.dedupe_key);
    expect(clockKeys).toContain(`decide:${reportId}:file-timeout:v1:r${after.rev}`);

    // An old revision cannot be confirmed; the one shown can, and that is what is filed.
    const confirm = (rev: number) =>
      database.q<{ r: { status: string } }>(`select field_confirm_report($1, $2, 1, $3) as r`, [
        reportId,
        MARCO,
        rev,
      ]);
    await expect(confirm(before.rev)).rejects.toThrow(/draft_changed/);
    expect((await confirm(after.rev))[0]!.r.status).toBe('queued');
    await runQueued('file_report', reportId);
    expect(await status(reportId)).toBe('filed');
    const [filed] = await database.q<{ data: StoredReportData }>(
      `select data from report_versions where report_id = $1 and version = 1`,
      [reportId],
    );
    expect(apex(readReportData(filed!.data))).toMatchObject({ workers: 7, totalHours: 56 });
    const [m] = await database.q<{ workers: number; hours: string }>(
      `select workers, hours::text from manpower_entries where report_id = $1 and company_name = 'Apex Concrete'`,
      [reportId],
    );
    expect(m).toMatchObject({ workers: 7 });
    expect(Number(m!.hours)).toBe(56);
  });

  it('a late photo before Save change makes the preview stale; a re-extraction keeps a saved fix (Q96)', async () => {
    const date = '2026-10-13';
    const reportId = await heroDraft(date);
    const first = await fix(reportId, 'correction-en-apex-seven', date);
    // The photo reaches the draft while the fix is listened to: processing, re-extraction queued.
    expect((await photo(date)).reportStatus).toBe('processing');
    expect(await run(first.jobId)).toEqual({ ok: true });
    expect(await correction(first.correctionId)).toMatchObject({
      status: 'stale',
      reason: 'report_moved_on',
    });
    await runQueued('extract_report', reportId);
    await runQueued('decide_next', reportId);
    expect(await status(reportId)).toBe('awaiting_confirmation');

    // A fix on the new draft, saved.
    const second = await fix(reportId, 'correction-es-apex-siete', date);
    expect(await run(second.jobId)).toEqual({ ok: true });
    expect((await correction(second.correctionId)).status).toBe('ready');
    await save(second.correctionId, reportId);
    await runQueued('decide_next', reportId);
    expect(apex((await draftOf(reportId)).data)).toMatchObject({ workers: 7, totalHours: 56 });

    // Another photo: the model's draft has Apex at 6 again; code puts the reporter's 7 back.
    await photo(date);
    await runQueued('extract_report', reportId);
    await runQueued('decide_next', reportId);
    const kept = apex((await draftOf(reportId)).data);
    expect(kept).toMatchObject({ workers: 7, hoursPerWorker: 8, totalHours: 56 });
    expect(kept.source).toContainEqual({
      type: 'voice_note',
      uploadId: second.uploadId,
      start: 0,
      end: 2.5,
    });
    const [audit] = await database.q<{ diff: { fixes_reapplied: number } }>(
      `select diff from audit_log where entity_id = $1 and action = 'report.extracted'
        order by id desc limit 1`,
      [reportId],
    );
    expect(audit!.diff.fixes_reapplied).toBe(1);
  });

  it('a model total is never taken; a fix naming no crew asks which and changes nothing', async () => {
    const date = '2026-10-14';
    const reportId = await heroDraft(date);
    const total = await fix(reportId, 'correction-en-apex-total', date);
    expect(await run(total.jobId)).toEqual({ ok: true });
    const preview = await correction(total.correctionId);
    expect(preview.status).toBe('ready');
    expect(apex(readReportData(preview.data!))).toMatchObject({ workers: 7, totalHours: 56 });

    const which = await fix(reportId, 'correction-en-which-crew', date);
    // The newer fix replaced the preview not saved.
    expect((await correction(total.correctionId)).status).toBe('discarded');
    expect(await run(which.jobId)).toEqual({ ok: true });
    expect(await correction(which.correctionId)).toMatchObject({
      status: 'unclear',
      reason: 'clarification',
      clarification: 'Which crew had three — Ironclad Steel, or another one?',
    });
    expect(apex((await draftOf(reportId)).data).workers).toBe(6);
  });

  it('a processing consent turned off: nothing goes to a provider, the fix is unclear (Q95)', async () => {
    const date = '2026-10-15';
    const reportId = await heroDraft(date);
    const clip = await fix(reportId, 'correction-en-apex-seven', date);
    await database.q(
      `update consents set revoked_at = now() where reporter_id = $1 and type = 'data_processing'`,
      [MARCO],
    );
    const heard = transcriber.calls.length;
    const asked = world.claude.calls.length;
    expect(await run(clip.jobId)).toEqual({ ok: true });
    expect(await correction(clip.correctionId)).toMatchObject({
      status: 'unclear',
      reason: 'consent_revoked',
    });
    expect(transcriber.calls.length).toBe(heard);
    expect(world.claude.calls.length).toBe(asked);
    const [r] = await database.q<{ review_reasons: string[] }>(
      `select review_reasons from reports where id = $1`,
      [reportId],
    );
    expect(r!.review_reasons).toContain('consent_revoked');
  });
});

/** A day before today in the site's time zone (F10's 14 days run on the database's clock). */
function recentDate(days: number): string {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
  const d = new Date(`${today}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

describe('W2-11: Change something on a filed report (F10), version 2, _v2, Updated, edit_applied', () => {
  it('Marco changes the Apex count 6 → 7 after sign-off: once each under retries', async () => {
    // A day of the last 14 that no other test used, and Marco's consents as given (Q95's test
    // turned one off).
    let date = recentDate(0);
    for (let n = 0; n < 14; n++) {
      date = recentDate(n);
      const used = await database.q(
        `select 1 from site_days where site_id = $1 and date = $2::date`,
        [RIVERSIDE, date],
      );
      if (used.length === 0) break;
    }
    await database.q(`update consents set revoked_at = null where reporter_id = $1`, [MARCO]);
    const reportId = await heroDraft(date);
    const { rev } = await draftOf(reportId);
    await database.q(`select field_confirm_report($1, $2, 1, $3)`, [reportId, MARCO, rev]);
    await runQueued('file_report', reportId);
    expect(await status(reportId)).toBe('filed');
    const LENA = DEMO_USERS[0]!;
    await database.q(
      `update reports set status = 'signed_off', signed_off_by = $2, signed_off_at = now() where id = $1`,
      [reportId, LENA.id],
    );

    // The clip of the change, as field-api makes it (fixTo on a filed report).
    const [u] = await database.q<{ id: string }>(
      `insert into uploads (reporter_id, site_id, kind, storage_path, mime, recorded_at, correction_report_id)
       values ($1, $2, 'audio', 'pending', 'audio/webm', now(), $3) returning id`,
      [MARCO, RIVERSIDE, reportId],
    );
    const path = `${ORG}/${RIVERSIDE}/${date}/${u!.id}.webm`;
    await database.q(`update uploads set storage_path = $2 where id = $1`, [u!.id, path]);
    const body = fakeAudio('correction-en-apex-seven', 3);
    await world.storage.upload('audio', path, body, 'audio/webm');
    await database.q(`select field_complete_upload($1, $2, $3)`, [u!.id, MARCO, body.length]);
    const [req] = await database.q<{ r: { id: string; jobId: number } }>(
      `select field_request_filed_correction($1, $2, $3, null) as r`,
      [reportId, MARCO, u!.id],
    );
    expect(await run(req!.r.jobId)).toEqual({ ok: true });
    const preview = await correction(req!.r.id);
    expect(preview.status).toBe('ready');
    const changes = preview.changes as Parameters<typeof correctionNote>[0];
    // Version 1 is untouched by the preview.
    expect(apex((await draftOf(reportId)).data)).toMatchObject({ workers: 6, totalHours: 48 });

    // Save change, as field-api calls it (the note and the text from code's lines).
    const note = correctionNote(changes, 'en')!;
    const change = correctionNote(changes, 'en', { sms: true })!;
    const weekday = formatDate(date, 'weekday', 'en');
    const [saved] = await database.q<{ r: { status: string; version: number } }>(
      `select field_save_filed_correction($1, $2, $3, $4, $5) as r`,
      [req!.r.id, reportId, MARCO, note, JSON.stringify({ weekday, change })],
    );
    expect(saved!.r).toMatchObject({ status: 'applied', version: 2 });
    expect(note).toBe('Apex Concrete 6 → 7 workers, 48 → 56 h');
    const v2 = await draftOf(reportId);
    expect(apex(v2.data)).toMatchObject({ workers: 7, hoursPerWorker: 8, totalHours: 56 });
    expect(apex(v2.data).source).toContainEqual({
      type: 'voice_note',
      uploadId: u!.id,
      start: 0,
      end: 2.3,
    });
    const [notice] = await database.q<{ user_id: string; data: unknown }>(
      `select user_id, data from notifications where kind = 'report_edited' and target_path = $1`,
      [`/reports/${reportId}`],
    );
    expect(notice).toEqual({
      user_id: LENA.id,
      data: { key: 'report_edited', params: { reportNo: expect.any(String) } },
    });

    // render_pdf (_v2), the "Updated" email to the recipients and the signer, edit_applied: twice
    // each (a retry), once each.
    const byKey = async (key: string) =>
      (await database.q<JobRow>(`select * from jobs where dedupe_key = $1`, [key]))[0]!;
    const rerun = async (job: JobRow) => {
      await database.q(`update jobs set status = 'queued' where id = $1`, [job.id]);
      expect(await run(job.id)).toEqual({ ok: true });
    };
    const render = await byKey(`render_pdf:${reportId}:2`);
    await rerun(render);
    await rerun(render);
    const [stored] = await database.q<{ pdf_path: string; report_no: string }>(
      `select v.pdf_path, r.report_no from report_versions v join reports r on r.id = v.report_id
       where v.report_id = $1 and v.version = 2`,
      [reportId],
    );
    expect(stored!.pdf_path).toMatch(new RegExp(`${stored!.report_no}_v2\\.pdf$`));
    const later = await database.q<{ type: string; dedupe_key: string }>(
      `select type, dedupe_key from jobs where (type = 'send_email' or type = 'notify')
         and dedupe_key like any (array['email:report_updated:' || $1 || '%', 'notify:edit_applied:' || $1 || '%'])
       order by id`,
      [reportId],
    );
    expect(later).toEqual([
      { type: 'send_email', dedupe_key: `email:report_updated:${reportId}:2` },
      { type: 'notify', dedupe_key: `notify:edit_applied:${reportId}:v2` },
    ]);

    const before = world.emails.length;
    const email = await byKey(`email:report_updated:${reportId}:2`);
    await rerun(email);
    await rerun(email);
    const sent = world.emails.slice(before);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.subject).toMatch(new RegExp(`^Updated: ${stored!.report_no} · `));
    // The site's recipients and the signer of the version it reopened (§13 Recipients + signer).
    const recipients = (
      await database.q<{ email: string }>(`select email from site_recipients where site_id = $1`, [
        RIVERSIDE,
      ])
    ).map((r) => r.email);
    expect(recipients.length).toBeGreaterThan(0);
    expect([...sent[0]!.to].sort()).toEqual([...new Set([...recipients, LENA.email])].sort());
    expect(sent[0]!.text).toContain(note);
    expect(sent[0]!.attachments?.map((a) => a.filename)).toEqual([
      `${stored!.report_no}_${date}_v2.pdf`,
    ]);

    const text = await byKey(`notify:edit_applied:${reportId}:v2`);
    await rerun(text);
    await rerun(text);
    const msgs = await database.q<{ body: string }>(
      `select body from messages where reporter_id = $1 and copy_key = 'edit_applied'
         and payload ->> 'dedupe_key' = $2`,
      [MARCO, `notify:edit_applied:${reportId}:v2`],
    );
    expect(msgs).toEqual([
      {
        body: `Updated ${weekday}: Apex Concrete 6 -> 7 workers, 48 -> 56 h. Version 2 sent to the office.`,
      },
    ]);
  }, 60_000);
});

describe('W3-14: F10 on a call (load_report, apply_correction, the yes, version 2 via voice)', () => {
  it('"Apex had seven, not six" said on a call → preview citing the call → saved after the yes', async () => {
    let date = recentDate(0);
    for (let n = 0; n < 14; n++) {
      date = recentDate(n);
      const used = await database.q(
        `select 1 from site_days where site_id = $1 and date = $2::date`,
        [RIVERSIDE, date],
      );
      if (used.length === 0) break;
    }
    await database.q(`update consents set revoked_at = null where reporter_id = $1`, [MARCO]);
    const reportId = await heroDraft(date);
    const { rev } = await draftOf(reportId);
    await database.q(`select field_confirm_report($1, $2, 1, $3)`, [reportId, MARCO, rev]);
    await runQueued('file_report', reportId);
    expect(await status(reportId)).toBe('filed');

    // A later call of Marco's (field-api's apply_correction with the reportId load_report found).
    const [call] = await database.q<{ id: string }>(
      `insert into calls (org_id, reporter_id, site_id, direction, transport, status, started_at,
                          answered_at, call_token_issued_at, language)
       values ($1, $2, $3, 'inbound', 'web', 'in_progress', now(), now(), now(), 'en-US')
       returning id`,
      [ORG, MARCO, RIVERSIDE],
    );
    const [req] = await database.q<{ r: { id: string; jobId: number } }>(
      `select voice_request_filed_correction($1, $2, 'Apex had seven, not six.', 41.5, 43.8) as r`,
      [call!.id, reportId],
    );
    expect(await run(req!.r.jobId)).toEqual({ ok: true });
    const preview = await correction(req!.r.id);
    expect(preview.status).toBe('ready');
    const changes = preview.changes as Parameters<typeof correctionNote>[0];
    expect(correctionNote(changes, 'en')).toBe('Apex Concrete 6 → 7 workers, 48 → 56 h');
    // Nothing changed before the yes.
    expect(apex((await draftOf(reportId)).data)).toMatchObject({ workers: 6, totalHours: 48 });

    const [refused] = await database.q<{ r: { status: string } }>(
      `select voice_save_filed_correction($1, $2, 'sounds good I guess', false, 'x') as r`,
      [call!.id, req!.r.id],
    );
    expect(refused!.r.status).toBe('not_confirmed');
    const [saved] = await database.q<{ r: { status: string; version: number } }>(
      `select voice_save_filed_correction($1, $2, 'Yes.', true, $3, $4) as r`,
      [
        call!.id,
        req!.r.id,
        correctionNote(changes, 'en'),
        JSON.stringify({
          weekday: formatDate(date, 'weekday', 'en'),
          change: correctionNote(changes, 'en', { sms: true }),
        }),
      ],
    );
    expect(saved!.r).toMatchObject({ status: 'applied', version: 2 });
    const v2 = await draftOf(reportId);
    expect(apex(v2.data)).toMatchObject({ workers: 7, hoursPerWorker: 8, totalHours: 56 });
    expect(apex(v2.data).source).toContainEqual({
      type: 'call',
      callId: call!.id,
      start: 41.5,
      end: 43.8,
    });
    const [ver] = await database.q<{ via: string; author_reporter_id: string }>(
      `select via::text, author_reporter_id from report_versions where report_id = $1 and version = 2`,
      [reportId],
    );
    expect(ver).toEqual({ via: 'voice', author_reporter_id: MARCO });
    expect(
      await database.q(`select 1 from jobs where dedupe_key = $1`, [`render_pdf:${reportId}:2`]),
    ).toHaveLength(1);
  }, 60_000);
});
