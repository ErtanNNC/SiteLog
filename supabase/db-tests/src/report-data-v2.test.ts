import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import {
  DailyReportDataSchema,
  DailyReportDataV1Schema,
  emptyReportData,
  emptyReportDataV1,
  officePhotoStoragePath,
  type DailyReportData,
  type DailyReportDataV1,
  type Source,
  type SourceV1,
} from '@sitelog/shared';
import { DEMO_ORG_ID, DEMO_USERS } from '@sitelog/shared/demo/kestrel.ts';
import { asService, asUser, bootDatabase } from './harness.ts';

/**
 * 20261014000002_backfill_uploads_compat.sql, the SQL readers of report_versions.data on v1 and
 * v2 data (GAP D20): denormalize_report_version (the delay record's voice note, report_sources
 * with the v1.2 keys) and create_report_version (photos keyed by messageId or uploadId), and the
 * office photo flow on uploads end to end (upload → attach → new version → orphan listing).
 */

const LENA = DEMO_USERS[0]!.id;
const OUTSIDER = 'eeeeeeee-4444-4444-8444-444444444444';

let db: PGlite;
let riverside: string;
let oakmont: string;
let marco: string;
let marcoConvo: string;
let dayCounter = 0;

async function svc<T = Record<string, unknown>>(sql: string, params: unknown[] = []) {
  return (await asService(db, (q) => q<T>(sql, params))).rows;
}

/** A filed report on a date of its own (August 2025, before any seeded report). */
async function newReport(siteId: string, opts: { reporter?: string | null } = {}) {
  dayCounter++;
  const date = `2025-08-${String(dayCounter).padStart(2, '0')}`;
  const [day] = await svc<{ id: string }>(
    `insert into site_days (site_id, date, deadline_at, status) values ($1, $2, now(), 'filed') returning id`,
    [siteId, date],
  );
  const [r] = await svc<{ id: string }>(
    `insert into reports (org_id, site_id, site_day_id, report_no, status, reporter_id, filed_at, language)
     values ($1, $2, $3, $4, 'filed', $5, now(), 'en') returning id`,
    [
      DEMO_ORG_ID,
      siteId,
      day!.id,
      `T2-${String(dayCounter).padStart(4, '0')}`,
      opts.reporter ?? null,
    ],
  );
  return { id: r!.id, date };
}

async function writeVersion(reportId: string, version: number, data: unknown, author = 'agent') {
  await svc(
    `insert into report_versions (report_id, version, data, author) values ($1, $2, $3, $4)`,
    [reportId, version, JSON.stringify(data), author],
  );
  await svc(`update reports set current_version = $2 where id = $1`, [reportId, version]);
  await svc(`select denormalize_report_version($1, $2)`, [reportId, version]);
}

async function sources(reportId: string) {
  return svc<{
    kind: string;
    message_id: string | null;
    upload_id: string | null;
    question_id: string | null;
    call_id: string | null;
  }>(
    `select kind, message_id, upload_id, question_id, call_id from report_sources
     where report_id = $1 order by kind, coalesce(upload_id, message_id, question_id, call_id)`,
    [reportId],
  );
}

async function audioUpload(reportId: string | null, siteId: string, id: string = randomUUID()) {
  await svc(
    `insert into uploads (id, report_id, reporter_id, site_id, kind, storage_path, mime, duration_s)
     values ($1, $2, $3, $4, 'audio', $5, 'audio/webm', 42)`,
    [id, reportId, marco, siteId, `${DEMO_ORG_ID}/${siteId}/2025-08-01/${id}.webm`],
  );
  return id;
}

async function errorOf(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (err) {
    return (err as Error).message;
  }
  throw new Error('expected an error');
}

beforeAll(async () => {
  db = await bootDatabase({ seed: true, storage: true });
  const sites = await svc<{ project_code: string; id: string }>(
    `select project_code, id from sites where org_id = $1`,
    [DEMO_ORG_ID],
  );
  riverside = sites.find((s) => s.project_code === 'RL-2041')!.id;
  oakmont = sites.find((s) => s.project_code === 'OM-1187')!.id;
  const [r] = await svc<{ id: string; convo: string }>(
    `select r.id, c.id as convo from reporters r join conversations c on c.reporter_id = r.id
     where r.org_id = $1 and r.name like 'Marco%'`,
    [DEMO_ORG_ID],
  );
  marco = r!.id;
  marcoConvo = r!.convo;
  await db.exec(`insert into auth.users (id, email) values ('${OUTSIDER}', 'z@other.test');`);
});

describe('denormalize_report_version on v1 data', () => {
  it('reads the audio source and re-keys the report’s WhatsApp sources', async () => {
    const report = await newReport(riverside, { reporter: marco });
    const msg = async (type: string, body: string | null = null) =>
      (
        await svc<{ id: string }>(
          `insert into messages (conversation_id, direction, type, body, storage_path, status)
           values ($1, 'in', $2, $3, $4, 'received') returning id`,
          [marcoConvo, type, body, type === 'audio' ? `x/${randomUUID()}.ogg` : null],
        )
      )[0]!.id;
    const audio = await msg('audio');
    const answer = await msg('interactive', '5 · full day');
    const typed = await msg('text', 'rained out');
    // As the WhatsApp worker writes them until step 22.
    await svc(
      `insert into report_sources (report_id, message_id, kind) values
         ($1, $2, 'audio'), ($1, $3, 'reply')`,
      [report.id, audio, typed],
    );
    const [q] = await svc<{ id: string }>(
      `insert into questions (report_id, field, prompt, answered_message_id, answered_at)
       values ($1, 'manpower.workers', 'How many?', $2, now()) returning id`,
      [report.id, answer],
    );
    const audioSrc: SourceV1 = { type: 'audio', messageId: audio, start: 12, end: 15 };
    const data: DailyReportDataV1 = DailyReportDataV1Schema.parse({
      ...emptyReportDataV1(report.date),
      weather: {
        conditionsText: 'Rain PM',
        periods: [{ condition: 'Rain', lostHours: 2, source: [audioSrc] }],
      },
      manpower: [
        {
          companyId: null,
          companyNameHeard: 'Delta',
          companyName: 'Delta Mechanical',
          workers: 5,
          hoursPerWorker: 8,
          totalHours: 40,
          hoursBasis: 'reply',
          confidence: 0.9,
          source: [{ type: 'reply', messageId: answer }, audioSrc],
        },
      ],
      issues: [{ description: 'Rain', source: [{ type: 'reply', messageId: typed }] }],
    });
    await writeVersion(report.id, 1, data);

    expect(
      await svc(`select audio_source, lost_hours::text from weather_events where report_id = $1`, [
        report.id,
      ]),
    ).toEqual([{ audio_source: audioSrc, lost_hours: '2.00' }]);
    expect(
      await svc(
        `select hours::text, hours_basis, source from manpower_entries where report_id = $1`,
        [report.id],
      ),
    ).toEqual([
      { hours: '40.00', hours_basis: 'reply', source: { type: 'reply', messageId: answer } },
    ]);
    expect(await sources(report.id)).toEqual([
      { kind: 'answer', message_id: answer, upload_id: null, question_id: q!.id, call_id: null },
      { kind: 'text', message_id: typed, upload_id: null, question_id: null, call_id: null },
      // No upload exists for a voice note the WhatsApp worker stored after the migration.
      { kind: 'voice_note', message_id: audio, upload_id: null, question_id: null, call_id: null },
    ]);

    // A backfilled voice note (same id) gets its upload_id on the next denormalization.
    await audioUpload(report.id, riverside, audio);
    await svc(`select denormalize_report_version($1, 1)`, [report.id]);
    expect((await sources(report.id)).find((s) => s.kind === 'voice_note')).toMatchObject({
      message_id: audio,
      upload_id: audio,
    });
    // Idempotent: nothing is added on a re-run.
    await svc(`select denormalize_report_version($1, 1)`, [report.id]);
    expect(await sources(report.id)).toHaveLength(3);
  });
});

describe('denormalize_report_version on v2 data', () => {
  it('reads voice notes, answers and calls and writes report_sources with the v1.2 keys', async () => {
    const report = await newReport(riverside, { reporter: marco });
    const voice = await audioUpload(report.id, riverside);
    const [q] = await svc<{ id: string }>(
      `insert into questions (report_id, field, prompt, channel, answered_at, answer)
       values ($1, 'manpower.workers', 'How many?', 'web', now(), '{"workers":5}') returning id`,
      [report.id],
    );
    const [call] = await svc<{ id: string }>(
      `insert into calls (org_id, reporter_id, site_id, report_id, direction, status)
       values ($1, $2, $3, $4, 'outbound', 'completed') returning id`,
      [DEMO_ORG_ID, marco, riverside, report.id],
    );
    // Media and questions of another report, and another org's upload: never linked.
    const other = await newReport(riverside);
    const otherVoice = await audioUpload(other.id, riverside);
    const [otherQ] = await svc<{ id: string }>(
      `insert into questions (report_id, field, prompt) values ($1, 'x', 'y') returning id`,
      [other.id],
    );
    const voiceSrc: Source = { type: 'voice_note', uploadId: voice, start: 3, end: 9 };
    const data: DailyReportData = DailyReportDataSchema.parse({
      ...emptyReportData(report.date, { reportLanguage: 'en', units: 'imperial' }),
      weather: {
        conditionsText: 'Rain',
        observed: { precip: 0.4, tempMin: 51, tempMax: 63, wind: 12, provider: 'open-meteo' },
        periods: [{ condition: 'Rain', lostHours: 3, source: [voiceSrc] }],
      },
      manpower: [
        {
          companyId: null,
          companyNameHeard: 'Delta',
          companyName: 'Delta Mechanical',
          workers: 5,
          hoursPerWorker: 8,
          totalHours: 40,
          hoursBasis: 'answer',
          confidence: 0.9,
          source: [{ type: 'answer', questionId: q!.id }],
        },
      ],
      workPerformed: [
        {
          area: 'Level 2',
          activity: 'Framing',
          status: 'in_progress',
          source: [
            { type: 'call', callId: call!.id, start: 1 },
            { type: 'voice_note', uploadId: otherVoice, start: 1 },
            { type: 'answer', questionId: otherQ!.id },
            { type: 'voice_note', uploadId: 'not-a-uuid', start: 0 },
          ],
        },
      ],
      safety: { incidents: [], noIncidentsStated: true, visitors: [], source: [voiceSrc] },
    });
    await writeVersion(report.id, 1, data);

    expect(
      await svc(
        `select audio_source, photo_count, observed, claim_ready from weather_events where report_id = $1`,
        [report.id],
      ),
    ).toEqual([
      {
        audio_source: voiceSrc,
        photo_count: 0,
        observed: data.weather.observed,
        claim_ready: false,
      },
    ]);
    expect(
      await svc(`select hours::text, hours_basis from manpower_entries where report_id = $1`, [
        report.id,
      ]),
    ).toEqual([{ hours: '40.00', hours_basis: 'answer' }]);
    expect(
      await svc(`select activity, source from work_items where report_id = $1`, [report.id]),
    ).toEqual([{ activity: 'Framing', source: { type: 'call', callId: call!.id, start: 1 } }]);
    expect(await sources(report.id)).toEqual([
      { kind: 'answer', message_id: null, upload_id: null, question_id: q!.id, call_id: null },
      { kind: 'call', message_id: null, upload_id: null, question_id: null, call_id: call!.id },
      { kind: 'voice_note', message_id: null, upload_id: voice, question_id: null, call_id: null },
    ]);
    expect(await sources(other.id)).toEqual([]);

    // Re-running (a refiling, an office edit of the same data) adds nothing.
    await svc(`select denormalize_report_version($1, 1)`, [report.id]);
    expect(await sources(report.id)).toHaveLength(3);
  });

  it('finds the question of a v1 reply carried into v2 by the upgrade (its reply message id)', async () => {
    const report = await newReport(riverside, { reporter: marco });
    const [reply] = await svc<{ id: string }>(
      `insert into messages (conversation_id, direction, type, body, status)
       values ($1, 'in', 'interactive', '4 · full day', 'received') returning id`,
      [marcoConvo],
    );
    const [q] = await svc<{ id: string }>(
      `insert into questions (report_id, field, prompt, answered_message_id, answered_at)
       values ($1, 'manpower.workers', 'How many?', $2, now()) returning id`,
      [report.id, reply!.id],
    );
    const data = {
      ...emptyReportData(report.date, { reportLanguage: 'en', units: 'imperial' }),
      issues: [{ description: 'x', source: [{ type: 'answer', questionId: reply!.id }] }],
    };
    await writeVersion(report.id, 1, data);
    expect(await sources(report.id)).toEqual([
      { kind: 'answer', message_id: reply!.id, upload_id: null, question_id: q!.id, call_id: null },
    ]);
  });
});

describe('denormalize_report_version keeps media sources that answered a question', () => {
  /** A WhatsApp photo or voice note of the report, as the worker stores it (old kinds). */
  async function waMedia(reportId: string, type: 'image' | 'audio') {
    const path = `${DEMO_ORG_ID}/${riverside}/2025-08-01/${randomUUID()}.${type === 'image' ? 'jpg' : 'ogg'}`;
    const [m] = await svc<{ id: string }>(
      `insert into messages (conversation_id, direction, type, body, storage_path, media_mime, status)
       values ($1, 'in', $2, $3, $4, $5, 'received') returning id`,
      [
        marcoConvo,
        type,
        type === 'image' ? 'Rebar' : null,
        path,
        type === 'image' ? 'image/jpeg' : 'audio/ogg',
      ],
    );
    await svc(
      `insert into report_sources (report_id, message_id, kind, caption, taken_at)
       values ($1, $2, $3, $4, now())`,
      [reportId, m!.id, type === 'image' ? 'photo' : 'audio', type === 'image' ? 'Rebar' : null],
    );
    return { id: m!.id, path };
  }

  /** A question of the report answered by the message (intake.ts mergeIntoActive, storeForReply). */
  async function answeredBy(reportId: string, messageId: string, field: string) {
    const [q] = await svc<{ id: string }>(
      `insert into questions (report_id, field, prompt, answered_message_id, answered_at, answer)
       values ($1, $2, 'Send a photo', $3, now(), '{"photo":true}') returning id`,
      [reportId, field, messageId],
    );
    return q!.id;
  }

  const photoSources = async (reportId: string) =>
    (
      await svc<{ media_id: string }>(`select media_id from report_photo_sources($1)`, [reportId])
    ).map((p) => p.media_id);

  it('v1: a photo and a voice note cited as replies stay photo and voice_note sources', async () => {
    const report = await newReport(riverside, { reporter: marco });
    const photo = await waMedia(report.id, 'image');
    const voice = await waMedia(report.id, 'audio');
    const photoQ = await answeredBy(report.id, photo.id, 'photo');
    const voiceQ = await answeredBy(report.id, voice.id, 'manpower.workers');
    const data: DailyReportDataV1 = DailyReportDataV1Schema.parse({
      ...emptyReportDataV1(report.date),
      // As the model cites previousAnswers: "Values provided by answers carry source type reply".
      issues: [
        { description: 'Rebar exposed', source: [{ type: 'reply', messageId: photo.id }] },
        {
          description: 'Crew',
          source: [
            { type: 'reply', messageId: voice.id },
            { type: 'audio', messageId: voice.id, start: 0, end: 4 },
          ],
        },
      ],
    });
    await writeVersion(report.id, 1, data);

    const expected = [
      { kind: 'answer', message_id: null, upload_id: null, question_id: photoQ, call_id: null },
      { kind: 'answer', message_id: null, upload_id: null, question_id: voiceQ, call_id: null },
      { kind: 'photo', message_id: photo.id, upload_id: null, question_id: null, call_id: null },
      {
        kind: 'voice_note',
        message_id: voice.id,
        upload_id: null,
        question_id: null,
        call_id: null,
      },
    ];
    const sorted = (rows: Awaited<ReturnType<typeof sources>>) =>
      [...rows].sort(
        (a, b) =>
          a.kind.localeCompare(b.kind) || (a.question_id ?? '').localeCompare(b.question_id ?? ''),
      );
    expect(sorted(await sources(report.id))).toEqual(sorted(expected));
    expect(await photoSources(report.id)).toEqual([photo.id]);

    // Every later filing or edit denormalizes again: nothing moves, nothing is added.
    await svc(`select denormalize_report_version($1, 1)`, [report.id]);
    expect(sorted(await sources(report.id))).toEqual(sorted(expected));
  });

  it('v2: a photo cited as an answer (by question id or the upgrade’s reply UUID) stays a photo through an office edit', async () => {
    const report = await newReport(riverside, { reporter: marco });
    const photo = await waMedia(report.id, 'image');
    // Backfilled: the photo has an upload with its message id.
    await svc(
      `insert into uploads (id, report_id, reporter_id, site_id, kind, storage_path, mime)
       values ($1, $2, $3, $4, 'photo', $5, 'image/jpeg')`,
      [photo.id, report.id, marco, riverside, photo.path],
    );
    await svc(`update report_sources set upload_id = $1 where message_id = $1`, [photo.id]);
    const photoQ = await answeredBy(report.id, photo.id, 'photo');
    const data: DailyReportData = DailyReportDataSchema.parse({
      ...emptyReportData(report.date, { reportLanguage: 'en', units: 'imperial' }),
      issues: [
        { description: 'Rebar exposed', source: [{ type: 'answer', questionId: photoQ }] },
        { description: 'Again', source: [{ type: 'answer', questionId: photo.id }] },
      ],
      photos: [{ uploadId: photo.id, caption: 'Rebar', takenAt: '2025-08-01T15:00:00.000Z' }],
    });
    await writeVersion(report.id, 1, data);

    const expected = [
      { kind: 'answer', message_id: null, upload_id: null, question_id: photoQ, call_id: null },
      {
        kind: 'photo',
        message_id: photo.id,
        upload_id: photo.id,
        question_id: null,
        call_id: null,
      },
    ];
    expect(await sources(report.id)).toEqual(expected);
    expect(await photoSources(report.id)).toEqual([photo.id]);

    // An office edit that only rewords the summary keeps the photo and counts nothing removed.
    await asUser(db, LENA, (q) =>
      q(`select create_report_version($1, $2, 'Reworded', '[]')`, [
        report.id,
        JSON.stringify({ ...data, summary: 'Reworded' }),
      ]),
    );
    const [v2] = await svc<{ data: { photos: unknown[] } }>(
      `select data from report_versions where report_id = $1 and version = 2`,
      [report.id],
    );
    expect(v2!.data.photos).toEqual(data.photos);
    expect(
      (
        await svc<{ diff: Record<string, unknown> }>(
          `select diff from audit_log where entity_id = $1 and action = 'report.version_created'`,
          [report.id],
        )
      )[0]!.diff,
    ).toMatchObject({ version: 2, photos: 1, photos_added: 0, photos_removed: 0 });
    expect(await sources(report.id)).toEqual(expected);
    expect(await photoSources(report.id)).toEqual([photo.id]);
  });
});

describe('create_report_version on v1 and v2 data', () => {
  /** A typed report (v1) with two photos, edited into v2 by a seeded-style version. */
  let reportId: string;
  let date: string;
  let photoA: string;
  let photoB: string;

  const putObject = (path: string) =>
    asUser(db, LENA, (q) =>
      q(`insert into storage.objects (bucket_id, name) values ('photos', $1)`, [path]),
    );

  beforeAll(async () => {
    date = '2025-07-01';
    const a = officePhotoStoragePath(DEMO_ORG_ID, oakmont, randomUUID(), 'image/jpeg');
    const b = officePhotoStoragePath(DEMO_ORG_ID, oakmont, randomUUID(), 'image/png');
    await putObject(a);
    await putObject(b);
    reportId = await asUser(db, LENA, async (q) => {
      const res = await q<{ r: { reportId: string } }>(
        `select create_office_report($1, $2, $3, $4) as r`,
        [
          oakmont,
          date,
          JSON.stringify(emptyReportDataV1(date)),
          JSON.stringify([
            { path: a, mime: 'image/jpeg', caption: 'A', takenAt: '2025-07-01T14:00:00Z' },
            { path: b, mime: 'image/png', takenAt: '2025-07-01T15:00:00Z' },
          ]),
        ],
      );
      return res.rows[0]!.r.reportId;
    });
    const ids = await svc<{ id: string }>(
      `select id from uploads where storage_path = any($1::text[])
       order by array_position($1::text[], storage_path)`,
      [[a, b]],
    );
    [photoA, photoB] = [ids[0]!.id, ids[1]!.id];
  });

  const edit = (data: unknown, photos: unknown[] = [], note = 'Edited') =>
    asUser(db, LENA, async (q) => {
      const res = await q<{ r: { version: number } }>(
        `select create_report_version($1, $2, $3, $4) as r`,
        [reportId, JSON.stringify(data), note, JSON.stringify(photos)],
      );
      return res.rows[0]!.r.version;
    });

  const versionOf = async (v: number) =>
    (
      await svc<{ data: Record<string, unknown> & { photos: unknown[] } }>(
        `select data from report_versions where report_id = $1 and version = $2`,
        [reportId, v],
      )
    )[0]!.data;

  it('keys the photos of a v1 version by messageId (the upload ids)', async () => {
    const v1 = await versionOf(1);
    expect(v1.photos).toEqual([
      { messageId: photoA, caption: 'A', takenAt: '2025-07-01T14:00:00.000Z' },
      { messageId: photoB, takenAt: '2025-07-01T15:00:00.000Z' },
    ]);
    expect(DailyReportDataV1Schema.safeParse(v1).success).toBe(true);
  });

  it('edits a v2 version: reads uploadId entries, writes them with uploadId, adds uploads', async () => {
    // A v2 version of the report, as W1-06 seeds and W1-12 writes them.
    const v2: DailyReportData = DailyReportDataSchema.parse({
      ...emptyReportData(date, { reportLanguage: 'en', units: 'imperial' }),
      summary: 'v2 data',
      photos: [
        { uploadId: photoB, takenAt: '2025-07-01T15:00:00.000Z' },
        { uploadId: photoA, caption: 'A', takenAt: '2025-07-01T14:00:00.000Z' },
      ],
    });
    await svc(
      `insert into report_versions (report_id, version, data, author) values ($1, 2, $2, 'agent')`,
      [reportId, JSON.stringify(v2)],
    );
    await svc(`update reports set current_version = 2 where id = $1`, [reportId]);

    const c = officePhotoStoragePath(DEMO_ORG_ID, oakmont, randomUUID(), 'image/webp');
    await putObject(c);
    const version = await edit(
      {
        ...v2,
        summary: 'Edited in the panel',
        photos: [
          { uploadId: photoA.toUpperCase(), caption: ' A2 ', takenAt: '2000-01-01T00:00:00Z' },
          { uploadId: randomUUID(), takenAt: '2025-07-01T12:00:00Z' }, // not a photo of the report
        ],
      },
      [{ path: c, mime: 'image/webp', caption: 'C', position: 0 }],
    );
    expect(version).toBe(3);
    const [cUpload] = await svc<{ id: string }>(`select id from uploads where storage_path = $1`, [
      c,
    ]);
    const v3 = await versionOf(3);
    expect(v3.schemaVersion).toBe(2);
    expect(v3.photos).toEqual([
      { uploadId: cUpload!.id, caption: 'C', takenAt: expect.any(String) },
      { uploadId: photoA, caption: 'A2', takenAt: '2025-07-01T14:00:00.000Z' },
    ]);
    expect(DailyReportDataSchema.safeParse(v3).success).toBe(true);
    expect(
      (
        await svc<{ diff: Record<string, unknown> }>(
          `select diff from audit_log where entity_id = $1 and action = 'report.version_created'
           order by created_at desc limit 1`,
          [reportId],
        )
      )[0]!.diff,
    ).toMatchObject({ version: 3, photos: 2, photos_added: 1, photos_removed: 1 });
  });

  it('keeps a v2 version’s photos when the data has no photos array', async () => {
    const v3 = await versionOf(3);
    const { photos, ...rest } = v3;
    const version = await edit({ ...rest, summary: 'Reworded' });
    expect((await versionOf(version)).photos).toEqual(photos);
  });

  it('turns a v1 edit after a v2 version into v1 entries (messageId)', async () => {
    const current = await versionOf(4);
    const version = await edit(
      {
        ...emptyReportDataV1(date),
        photos: [{ messageId: photoB, takenAt: '2025-07-01T15:00:00Z' }],
      },
      [],
    );
    expect((await versionOf(version)).photos).toEqual([
      { messageId: photoB, takenAt: '2025-07-01T15:00:00.000Z' },
    ]);
    expect(current.photos).toHaveLength(2);
  });
});

describe('office photos on uploads, end to end', () => {
  it('upload → attach → new version → orphan listing', async () => {
    const date = '2025-06-02';
    const orphans = async () =>
      (
        await svc<{ name: string }>(
          `select name from list_orphan_office_photos('2999-01-01T00:00:00Z', 500) name`,
        )
      ).map((r) => r.name);
    const put = (path: string) =>
      asUser(db, LENA, (q) =>
        q(`insert into storage.objects (bucket_id, name) values ('photos', $1)`, [path]),
      );
    // 1. The panel uploads three files; the report call attaches two of them.
    const a = officePhotoStoragePath(DEMO_ORG_ID, riverside, randomUUID(), 'image/jpeg');
    const b = officePhotoStoragePath(DEMO_ORG_ID, riverside, randomUUID(), 'image/jpeg');
    const dropped = officePhotoStoragePath(DEMO_ORG_ID, riverside, randomUUID(), 'image/jpeg');
    for (const p of [a, b, dropped]) await put(p);
    expect(await orphans()).toEqual(expect.arrayContaining([a, b, dropped]));

    const { reportId } = await asUser(db, LENA, async (q) => {
      const res = await q<{ r: { reportId: string } }>(
        `select create_office_report($1, $2, $3, $4) as r`,
        [
          riverside,
          date,
          JSON.stringify(emptyReportDataV1(date)),
          JSON.stringify([{ path: a, mime: 'image/jpeg', caption: 'Deck' }]),
        ],
      );
      return res.rows[0]!.r;
    });
    // 2. An edit attaches the second; the third is never attached.
    const v2 = await asUser(db, LENA, async (q) => {
      const data = (
        await q<{ data: DailyReportDataV1 }>(
          `select data from report_versions where report_id = $1 and version = 1`,
          [reportId],
        )
      ).rows[0]!.data;
      return (
        await q<{ r: { version: number } }>(
          `select create_report_version($1, $2, 'Second photo', $3) as r`,
          [reportId, JSON.stringify(data), JSON.stringify([{ path: b, mime: 'image/jpeg' }])],
        )
      ).rows[0]!.r.version;
    });
    expect(v2).toBe(2);

    // The panel reads them through RLS: uploads and their sources, no messages.
    const seen = await asUser(
      db,
      LENA,
      async (q) =>
        (
          await q<{
            storage_path: string;
            kind: string;
            message_id: string | null;
            uploaded_by: string;
          }>(
            `select u.storage_path, rs.kind, rs.message_id, u.uploaded_by
           from report_sources rs join uploads u on u.id = rs.upload_id
           where rs.report_id = $1 order by u.received_at, u.storage_path`,
            [reportId],
          )
        ).rows,
    );
    expect(seen.map((s) => s.storage_path).sort()).toEqual([a, b].sort());
    expect(
      seen.every((s) => s.kind === 'photo' && s.message_id === null && s.uploaded_by === LENA),
    ).toBe(true);
    const outsider = await asUser(
      db,
      OUTSIDER,
      async (q) =>
        (await q(`select 1 from uploads where storage_path = any($1::text[])`, [[a, b]])).rows,
    );
    expect(outsider).toEqual([]);

    // 3. Only the dropped file is an orphan for the retention job.
    const listed = await orphans();
    expect(listed).toContain(dropped);
    expect(listed).not.toContain(a);
    expect(listed).not.toContain(b);

    // An upload cannot be attached twice, to this report or another.
    expect(
      await errorOf(() =>
        asUser(db, LENA, (q) =>
          q(`select create_report_version($1, $2, 'Again', $3)`, [
            reportId,
            JSON.stringify(emptyReportDataV1(date)),
            JSON.stringify([{ path: a, mime: 'image/jpeg' }]),
          ]),
        ),
      ),
    ).toBe('photo already attached');
  });
});
