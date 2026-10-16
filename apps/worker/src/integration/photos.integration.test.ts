import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { emptyReportData, JOB_MAX_ATTEMPTS, uploadStoragePath, type JobRow } from '@sitelog/shared';
import { registry } from '../jobs/registry';
import { createFakeTranscriber } from '../ai/fake-transcriber';
import { memoryLogger } from '../log';
import { runJob } from '../runner';
import { startPgliteDatabase, type PgliteDatabase } from '../test/pglite';
import {
  createSim,
  fakeAudio,
  FAKE_PHOTO,
  loadFixtureLibrary,
  manualClock,
  NO_LATENCY,
} from './fakes';
import { createWorld, type World } from './world';

/**
 * F9 photos after filing (W2-04) on a real database: two photos and a voice caption added to a
 * filed web report (the batch as field-api's `uploads` route writes it, completed through
 * `field_complete_upload()`), then the worker: the caption's `transcribe_upload` (purpose
 * 'caption') → `field_attach_photos()` → version 2 "2 photos added" with the caption →
 * `render_pdf` stores the `_v2` PDF → `send_email` sends the "Updated" email. PGlite with every
 * migration and the §18 seed; the database's clock is the wall clock, so the report is today's.
 */

const TZ = 'America/Chicago';
let database: PgliteDatabase;
let world: World;
let ORG = '';
let RIVERSIDE = '';
let MARCO = '';

beforeAll(async () => {
  database = await startPgliteDatabase({ seed: true });
  const clock = manualClock(new Date());
  world = createWorld({
    db: database.db,
    sql: database.sql,
    clock,
    sim: createSim({ advance: clock, profile: NO_LATENCY }),
    lib: loadFixtureLibrary(['riverside-2026-10-09']),
    log: memoryLogger('info'),
    fieldTranscriber: createFakeTranscriber(),
  });
  const q = database.q.bind(database);
  const [site] = await q<{ id: string; org_id: string }>(
    `select id, org_id from sites where project_code = 'RL-2041'`,
  );
  RIVERSIDE = site!.id;
  ORG = site!.org_id;
  MARCO = (await q<{ id: string }>(`select id from reporters where name = 'Marco Ruiz'`))[0]!.id;
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

const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());

describe('photos after filing (F9, W2-04): caption → version 2 → _v2 PDF → Updated email', () => {
  it('adds two captioned photos as version 2 and sends the update', async () => {
    const q = database.q.bind(database);
    const date = today();
    // Today's filed web report at Riverside (version 1, no photos).
    await q(`delete from site_days where site_id = $1 and date = $2`, [RIVERSIDE, date]);
    const [day] = await q<{ id: string }>(
      `insert into site_days (site_id, date, status, deadline_at)
       values ($1, $2, 'filed', ($2::date + time '17:30') at time zone '${TZ}') returning id`,
      [RIVERSIDE, date],
    );
    const [report] = await q<{ id: string; report_no: string }>(
      `insert into reports (org_id, site_id, site_day_id, report_no, status, kind, current_version,
                            reporter_id, received_at, filed_at, confirmed_at, confirmed_via, channel, language)
       values ($1, $2, $3, next_report_no($2), 'filed', 'daily', 1, $4, now(), now(), now(), 'web', 'web', 'en')
       returning id, report_no`,
      [ORG, RIVERSIDE, day!.id, MARCO],
    );
    const reportId = report!.id;
    const data = {
      ...emptyReportData(date, { reportLanguage: 'en', units: 'imperial' }),
      summary: 'Slab pour on Level 4.',
    };
    await q(
      `insert into report_versions (report_id, version, data, summary, author) values ($1, 1, $2, $3, 'agent')`,
      [reportId, JSON.stringify(data), data.summary],
    );
    await q(`select denormalize_report_version($1, 1)`, [reportId]);
    await q(`update site_days set report_id = $1 where id = $2`, [reportId, day!.id]);

    // The batch: two photos and a caption, stored and completed as field-api does.
    const batch = '9f9f9f9f-0000-4000-8000-000000000001';
    const uploads: { id: string; kind: 'photo' | 'audio' }[] = [
      { id: '9f9f9f9f-0000-4000-8000-0000000000a1', kind: 'photo' },
      { id: '9f9f9f9f-0000-4000-8000-0000000000a2', kind: 'photo' },
      { id: '9f9f9f9f-0000-4000-8000-0000000000a3', kind: 'audio' },
    ];
    let captionJob: number | null = null;
    for (const u of uploads) {
      const path = uploadStoragePath(
        ORG,
        RIVERSIDE,
        date,
        u.id,
        u.kind === 'audio' ? 'webm' : 'png',
      );
      if (u.kind === 'audio') {
        await world.storage.upload('audio', path, fakeAudio('en-elm-2026-10-02', 6), 'audio/webm');
      } else {
        await world.storage.upload('photos', path, FAKE_PHOTO, 'image/png');
      }
      await q(
        `insert into uploads (id, reporter_id, site_id, kind, storage_path, mime, recorded_at, batch_id, batch_size)
         values ($1, $2, $3, $4, $5, $6, now(), $7, 3)`,
        [
          u.id,
          MARCO,
          RIVERSIDE,
          u.kind,
          path,
          u.kind === 'audio' ? 'audio/webm' : 'image/png',
          batch,
        ],
      );
      const [res] = await q<{ r: { jobId: number | null; batch: { ready: boolean } } }>(
        `select field_complete_upload($1, $2, 100) as r`,
        [u.id, MARCO],
      );
      captionJob = res!.r.jobId ?? captionJob;
    }
    expect(captionJob).not.toBeNull();

    // The caption's transcription attaches the batch (no extraction).
    expect(await run(captionJob!)).toEqual({ ok: true });
    const extracts = await q(
      `select 1 from jobs where type = 'extract_report' and payload ->> 'reportId' = $1`,
      [reportId],
    );
    expect(extracts).toEqual([]);
    const [v2] = await q<{
      author: string;
      via: string;
      change_note: string;
      photos: { uploadId: string; caption: string }[];
    }>(
      `select author::text, via::text, change_note, data->'photos' as photos
       from report_versions where report_id = $1 and version = 2`,
      [reportId],
    );
    expect(v2).toMatchObject({ author: 'reporter', via: 'web', change_note: '2 photos added' });
    expect(v2!.photos.map((p) => p.uploadId)).toEqual([uploads[0]!.id, uploads[1]!.id]);
    expect(v2!.photos[0]!.caption).toMatch(/Elm Street, Friday/);
    expect(v2!.photos[0]!.caption.length).toBeLessThanOrEqual(500);

    // render_pdf: the _v2 file, and the "Updated" email.
    const [render] = await q<{ id: number }>(`select id from jobs where dedupe_key = $1`, [
      `render_pdf:${reportId}:2`,
    ]);
    expect(await run(render!.id)).toEqual({ ok: true });
    const [stored] = await q<{ pdf_path: string }>(
      `select pdf_path from report_versions where report_id = $1 and version = 2`,
      [reportId],
    );
    expect(stored!.pdf_path).toMatch(new RegExp(`${report!.report_no}_v2\\.pdf$`));
    expect(world.storage.files.has(`pdfs/${stored!.pdf_path}`)).toBe(true);

    const [email] = await q<{ id: number }>(`select id from jobs where dedupe_key = $1`, [
      `email:report_updated:${reportId}:2`,
    ]);
    const before = world.emails.length;
    expect(await run(email!.id)).toEqual({ ok: true });
    const sent = world.emails.slice(before);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.subject).toMatch(new RegExp(`^Updated: ${report!.report_no} · `));
    expect(sent[0]!.text).toContain('2 photos added');
  }, 60_000);

  it('adds the photos without a caption when the transcription fails for good', async () => {
    const q = database.q.bind(database);
    const [r] = await q<{ id: string; current_version: number }>(
      `select r.id, r.current_version from reports r join site_days d on d.id = r.site_day_id
       where d.site_id = $1 and d.date = $2`,
      [RIVERSIDE, today()],
    );
    const batch = '9f9f9f9f-0000-4000-8000-000000000002';
    const photo = '9f9f9f9f-0000-4000-8000-0000000000b1';
    const clip = '9f9f9f9f-0000-4000-8000-0000000000b2';
    for (const [id, kind] of [
      [photo, 'photo'],
      [clip, 'audio'],
    ] as const) {
      const path = uploadStoragePath(
        ORG,
        RIVERSIDE,
        today(),
        id,
        kind === 'audio' ? 'webm' : 'png',
      );
      await world.storage.upload(
        kind === 'audio' ? 'audio' : 'photos',
        path,
        kind === 'audio' ? fakeAudio('en-elm-2026-10-02', 3) : FAKE_PHOTO,
        kind === 'audio' ? 'audio/webm' : 'image/png',
      );
      await q(
        `insert into uploads (id, reporter_id, site_id, kind, storage_path, mime, recorded_at, batch_id, batch_size)
         values ($1, $2, $3, $4, $5, $6, now(), $7, 2)`,
        [id, MARCO, RIVERSIDE, kind, path, kind === 'audio' ? 'audio/webm' : 'image/png', batch],
      );
      await q(`select field_complete_upload($1, $2, 100)`, [id, MARCO]);
    }
    const down = {
      ...world.ctx,
      ai: {
        ...world.ctx.ai,
        transcriber: {
          ...world.ctx.ai.transcriber,
          transcribe: () => Promise.reject(new Error('provider down')),
        },
      },
    };
    const payload = { uploadId: clip, purpose: 'caption' as const };
    // An attempt with retries left fails (the job retries) and adds nothing.
    await expect(
      registry.transcribe_upload(down, payload, { attempts: 1 } as JobRow),
    ).rejects.toThrow('provider down');
    expect(
      (
        await q<{ v: number }>(`select current_version as v from reports where id = $1`, [r!.id])
      )[0]!.v,
    ).toBe(r!.current_version);
    // The last attempt adds the photo without its caption.
    await registry.transcribe_upload(down, payload, { attempts: JOB_MAX_ATTEMPTS } as JobRow);
    const [v] = await q<{ change_note: string; photos: { uploadId: string; caption?: string }[] }>(
      `select change_note, data->'photos' as photos from report_versions
       where report_id = $1 and version = $2`,
      [r!.id, r!.current_version + 1],
    );
    expect(v!.change_note).toBe('1 photo added');
    expect(v!.photos.at(-1)).toEqual({ uploadId: photo, takenAt: expect.any(String) });
  }, 60_000);
});
