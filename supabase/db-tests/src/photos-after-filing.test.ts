import { beforeAll, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { emptyReportData, uploadStoragePath } from '@sitelog/shared';
import { asService, bootDatabase } from './harness.ts';

/**
 * 20261016000030_photos_after_filing.sql (W2-04; spec F9, §7.2): photos added to a filed report.
 *
 * - field_complete_upload() stages an upload of a batch on the day's filed (or signed-off) report
 *   (F9's window, at most 4 photos after filing, one caption per batch) and says when the batch is
 *   whole; a whole batch with a caption enqueues its transcription (purpose 'caption').
 * - field_attach_photos() makes the batch one new version ("2 photos added", author 'reporter',
 *   via 'web'), with its sources, weather_events.photo_count, the report back to filed (the signer
 *   told), the audit and render_pdf with the "Updated" email; version 1 is never changed.
 */

const ID = (n: number) => `f9f9f9f9-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const ORG = ID(1);
const SITE = ID(2);
const MARCO = ID(3);
const SIGNER = ID(4);
const SITE2 = ID(5);
const TZ = 'America/Chicago';

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

/** A date `daysAgo` days before today at the site (Chicago), YYYY-MM-DD. */
function siteDate(daysAgo: number): string {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());
  const d = new Date(`${today}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - daysAgo);
  return d.toISOString().slice(0, 10);
}

/** A filed web report of `date` with version 1 (a rain stoppage, no photos). */
async function filedReport(date: string, status: 'filed' | 'signed_off' = 'filed', site = SITE) {
  const day = ID(seq++);
  const report = ID(seq++);
  await svc(
    `insert into site_days (id, site_id, date, status, deadline_at)
     values ($1, $2, $3, 'filed', ($3::date + time '17:30') at time zone '${TZ}')`,
    [day, site, date],
  );
  await svc(
    `insert into reports (id, org_id, site_id, site_day_id, report_no, status, kind, current_version,
                          reporter_id, received_at, filed_at, channel, language, signed_off_by, signed_off_at)
     values ($1, $2, $3, $4, 'F9-1-' || $5, $6, 'daily', 1, $7, now(), now(), 'web', 'en',
             $8, case when $8::uuid is null then null else now() end)`,
    [report, ORG, site, day, String(seq), status, MARCO, status === 'signed_off' ? SIGNER : null],
  );
  const data = {
    ...emptyReportData(date, { reportLanguage: 'en', units: 'imperial' }),
    summary: 'Slab pour',
    weather: {
      conditionsText: 'Rain AM',
      periods: [
        {
          start: '07:00',
          end: '10:30',
          condition: 'Rain',
          impact: 'stopped',
          lostHours: 3.5,
          source: [{ type: 'voice_note', uploadId: ID(9999), start: 10 }],
        },
      ],
    },
  };
  await svc(
    `insert into report_versions (report_id, version, data, summary, author) values ($1, 1, $2, 'Slab pour', 'agent')`,
    [report, JSON.stringify(data)],
  );
  await svc(`select denormalize_report_version($1, 1)`, [report]);
  await svc(`update site_days set report_id = $1 where id = $2`, [report, day]);
  return report;
}

/** An upload of a batch, as field-api's `uploads` route writes it with `addTo`. */
async function batchUpload(
  date: string,
  batch: string,
  size: number,
  kind: 'photo' | 'audio' = 'photo',
  site = SITE,
): Promise<string> {
  const id = ID(seq++);
  const path = uploadStoragePath(ORG, site, date, id, kind === 'audio' ? 'webm' : 'jpg');
  await svc(
    `insert into uploads (id, reporter_id, site_id, kind, storage_path, mime, recorded_at, batch_id, batch_size)
     values ($1, $2, $3, $4, $5, $6, now() - interval '1 minute', $7, $8)`,
    [id, MARCO, site, kind, path, kind === 'audio' ? 'audio/webm' : 'image/jpeg', batch, size],
  );
  return id;
}

interface Completed {
  reportId: string;
  reportStatus: string;
  alreadyComplete: boolean;
  jobId: number | null;
  batch?: { id: string; ready: boolean; captionUploadId: string | null };
}

const complete = async (upload: string) =>
  (
    await svc<{ r: Completed }>(`select field_complete_upload($1, $2, 1000) as r`, [upload, MARCO])
  )[0]!.r;

const attach = async (report: string, batch: string, note: string, caption: string | null = null) =>
  (
    await svc<{ r: { version: number; alreadyAttached: boolean } }>(
      `select field_attach_photos($1, $2, $3, $4) as r`,
      [report, batch, note, caption],
    )
  )[0]!.r;

beforeAll(async () => {
  db = await bootDatabase();
  await db.exec(`
    insert into auth.users (id, email) values ('${SIGNER}', 'sam@f9.test');
    insert into orgs (id, name) values ('${ORG}', 'F9 Build');
    insert into sites (id, org_id, name, project_code, timezone, deadline) values
      ('${SITE}', '${ORG}', 'Riverside', 'F9-1', '${TZ}', '17:30'),
      ('${SITE2}', '${ORG}', 'Pier 9', 'F9-2', '${TZ}', '17:30');
    insert into reporters (id, org_id, name, phone_e164, status)
      values ('${MARCO}', '${ORG}', 'Marco Ruiz', '+15550149999', 'active');
    insert into site_reporters (site_id, reporter_id, is_primary) values
      ('${SITE}', '${MARCO}', true), ('${SITE2}', '${MARCO}', true);
  `);
});

describe('photos after filing (F9)', () => {
  it('stages a batch, then makes version 2 "2 photos added" without touching version 1', async () => {
    const date = siteDate(0);
    const report = await filedReport(date);
    const batch = ID(seq++);
    const a = await batchUpload(date, batch, 2);
    const b = await batchUpload(date, batch, 2);

    const first = await complete(a);
    expect(first).toMatchObject({
      reportId: report,
      reportStatus: 'filed',
      alreadyComplete: false,
    });
    expect(first.batch).toEqual({ id: batch, ready: false, captionUploadId: null });
    // Staged: on the report, but no source and no version yet.
    expect(await svc(`select 1 from report_sources where upload_id = $1`, [a])).toEqual([]);
    expect(await attachFailure(report, batch)).toBe('batch_incomplete');

    const second = await complete(b);
    expect(second.batch).toEqual({ id: batch, ready: true, captionUploadId: null });
    // A retried complete says the same.
    expect((await complete(b)).batch).toEqual({ id: batch, ready: true, captionUploadId: null });

    expect(await attach(report, batch, '2 photos added')).toEqual({
      version: 2,
      alreadyAttached: false,
      photosAdded: 2,
    });
    const [r] = await svc<{ status: string; current_version: number }>(
      `select status, current_version from reports where id = $1`,
      [report],
    );
    expect(r).toEqual({ status: 'filed', current_version: 2 });
    const versions = await svc<{
      version: number;
      author: string;
      via: string | null;
      change_note: string | null;
      photos: { uploadId: string; takenAt: string }[];
    }>(
      `select version, author::text, via::text, change_note, data->'photos' as photos
       from report_versions where report_id = $1 order by version`,
      [report],
    );
    expect(versions[0]).toMatchObject({ version: 1, author: 'agent', photos: [] });
    expect(versions[1]).toMatchObject({
      version: 2,
      author: 'reporter',
      via: 'web',
      change_note: '2 photos added',
    });
    expect(versions[1]!.photos.map((p) => p.uploadId).sort()).toEqual([a, b].sort());
    expect(
      await svc(
        `select count(*)::int as n from report_sources where report_id = $1 and kind = 'photo'`,
        [report],
      ),
    ).toEqual([{ n: 2 }]);
    // The weather day becomes claim-ready on version 2 (photo_count from data.photos).
    expect(
      await svc(
        `select version, photo_count from weather_events where report_id = $1 order by version`,
        [report],
      ),
    ).toEqual([
      { version: 1, photo_count: 0 },
      { version: 2, photo_count: 2 },
    ]);
    const [audit] = await svc<{
      actor_type: string;
      actor_id: string;
      diff: Record<string, unknown>;
    }>(
      `select actor_type, actor_id, diff from audit_log
       where entity_id = $1 and action = 'report.version_created'`,
      [report],
    );
    expect(audit).toMatchObject({ actor_type: 'reporter', actor_id: MARCO });
    expect(audit!.diff).toMatchObject({
      version: 2,
      change_note: '2 photos added',
      photos_added: 2,
      batch_id: batch,
      via: 'web',
    });
    const jobs = await svc<{ payload: Record<string, unknown>; dedupe_key: string }>(
      `select payload, dedupe_key from jobs where type = 'render_pdf' and payload->>'reportId' = $1`,
      [report],
    );
    expect(jobs).toEqual([
      {
        payload: {
          reportId: report,
          version: 2,
          emailRecipients: true,
          changeNote: '2 photos added',
        },
        dedupe_key: `render_pdf:${report}:2`,
      },
    ]);

    // Attached once: a second call answers the version the batch made.
    expect(await attach(report, batch, '2 photos added')).toEqual({
      version: 2,
      alreadyAttached: true,
    });
    expect(
      await svc(`select count(*)::int as n from report_versions where report_id = $1`, [report]),
    ).toEqual([{ n: 2 }]);

    // At most 4 photos after filing: two more go, a fifth is refused.
    const more = ID(seq++);
    const c = await batchUpload(date, more, 3);
    const d = await batchUpload(date, more, 3);
    const e = await batchUpload(date, more, 3);
    await complete(c);
    await complete(d);
    expect(await completeFailure(e)).toBe('photo_limit');
  });

  it('closes the window at 23:59 the day after; refuses a report not filed; keeps report_filed', async () => {
    const old = siteDate(3);
    const report = await filedReport(old);
    const batch = ID(seq++);
    expect(report).toBeDefined();
    expect(await completeFailure(await batchUpload(old, batch, 1))).toBe('photos_window_closed');

    // A report still being written takes no batch (and a batch never starts a report).
    const date = siteDate(1);
    const day = ID(seq++);
    await svc(
      `insert into site_days (id, site_id, date, status, deadline_at) values ($1, $2, $3, 'pending', now())`,
      [day, SITE, date],
    );
    expect(await completeFailure(await batchUpload(date, ID(seq++), 1))).toBe('wrong_state');

    // An upload without a batch on a filed report is refused as before.
    const today = siteDate(0);
    const [filed] = await svc<{ id: string }>(
      `select r.id from reports r join site_days sd on sd.id = r.site_day_id
       where sd.site_id = $1 and sd.date = $2`,
      [SITE, today],
    );
    expect(filed).toBeDefined();
    const plain = ID(seq++);
    await svc(
      `insert into uploads (id, reporter_id, site_id, kind, storage_path, mime)
       values ($1, $2, $3, 'photo', $4, 'image/jpeg')`,
      [plain, MARCO, SITE, uploadStoragePath(ORG, SITE, today, plain, 'jpg')],
    );
    expect(await completeFailure(plain)).toBe('report_filed');
  });

  it('a caption batch: transcription first; signed off goes back to filed and tells the signer', async () => {
    const date = siteDate(0);
    const report = await filedReport(date, 'signed_off', SITE2);
    const batch = ID(seq++);
    const photo = await batchUpload(date, batch, 2, 'photo', SITE2);
    const clip = await batchUpload(date, batch, 2, 'audio', SITE2);
    expect((await complete(photo)).batch?.ready).toBe(false);
    const done = await complete(clip);
    expect(done.batch).toEqual({ id: batch, ready: true, captionUploadId: clip });
    expect(done.jobId).toEqual(expect.any(Number));
    const [job] = await svc<{ type: string; payload: unknown; dedupe_key: string }>(
      `select type, payload, dedupe_key from jobs where id = $1`,
      [done.jobId],
    );
    expect(job).toEqual({
      type: 'transcribe_upload',
      payload: { uploadId: clip, purpose: 'caption' },
      dedupe_key: `transcribe_upload:${clip}`,
    });
    // One caption per batch.
    const second = await batchUpload(date, batch, 2, 'audio', SITE2);
    expect(await completeFailure(second)).toBe('invalid_batch');
    await svc(`delete from uploads where id = $1`, [second]);
    // The caption clip is no voice note of the report: no source, no extraction.
    expect(await svc(`select 1 from report_sources where upload_id = $1`, [clip])).toEqual([]);

    // The worker, after the transcription: the caption on the photo of the new version.
    expect(await attach(report, batch, '1 photo added', '  Level 4 after the pour ')).toMatchObject(
      {
        version: 2,
        alreadyAttached: false,
      },
    );
    const [v2] = await svc<{ photos: { uploadId: string; caption: string }[] }>(
      `select data->'photos' as photos from report_versions where report_id = $1 and version = 2`,
      [report],
    );
    expect(v2!.photos).toEqual([
      expect.objectContaining({ uploadId: photo, caption: 'Level 4 after the pour' }),
    ]);
    expect(await svc(`select caption from report_sources where upload_id = $1`, [photo])).toEqual([
      { caption: 'Level 4 after the pour' },
    ]);
    const [r] = await svc<{ status: string; signed_off_by: string | null }>(
      `select status, signed_off_by from reports where id = $1`,
      [report],
    );
    expect(r).toEqual({ status: 'filed', signed_off_by: null });
    // The "Updated" email goes to the signer of the version it reopened too (§13, 20261016000130).
    const [render] = await svc<{ payload: Record<string, unknown> }>(
      `select payload from jobs where dedupe_key = $1`,
      [`render_pdf:${report}:2`],
    );
    expect(render!.payload).toMatchObject({ emailRecipients: true, signerId: SIGNER });
    const notices = await svc<{ kind: string; user_id: string; body: string; data: unknown }>(
      `select kind, user_id, body, data from notifications where org_id = $1 and target_path = $2`,
      [ORG, `/reports/${report}`],
    );
    expect(notices).toEqual([
      {
        kind: 'report_edited',
        user_id: SIGNER,
        body: '1 photo added',
        data: { key: 'report_edited', params: { reportNo: expect.any(String) } },
      },
    ]);
    expect(
      await svc(
        `select actor_type from audit_log where entity_id = $1 and action = 'report.signoff_reverted'`,
        [report],
      ),
    ).toEqual([{ actor_type: 'reporter' }]);
  });

  it("is the service role's only", async () => {
    const grants = await svc<{ anon: boolean; auth: boolean; svc: boolean }>(
      `select has_function_privilege('anon', 'field_attach_photos(uuid,uuid,text,text)', 'execute') as anon,
              has_function_privilege('authenticated', 'field_attach_photos(uuid,uuid,text,text)', 'execute') as auth,
              has_function_privilege('service_role', 'field_attach_photos(uuid,uuid,text,text)', 'execute') as svc`,
    );
    expect(grants).toEqual([{ anon: false, auth: false, svc: true }]);
  });
});

async function attachFailure(report: string, batch: string) {
  return failure(`select field_attach_photos($1, $2, 'x', null)`, [report, batch]);
}

async function completeFailure(upload: string) {
  return failure(`select field_complete_upload($1, $2, 1000)`, [upload, MARCO]);
}
