import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import {
  DailyReportDataV1Schema,
  emptyReportDataV1,
  officePhotoStoragePath,
  readReportData,
  versionPhotos,
  type DailyReportDataV1,
  type StoredReportData,
} from '@sitelog/shared';
import { DEMO_ORG_ID, DEMO_USERS } from '@sitelog/shared/demo/kestrel.ts';
import { applyMigration, asService, asUser, bootDatabase, MIGRATIONS_DIR } from './harness.ts';

/**
 * 20261014000002_backfill_uploads_compat.sql (W1-05 step 10, GAP §4.1 stage 3) on the frozen v1.0
 * seed (`git show 388fc63:supabase/seed.sql`, fixtures/seed-v1.0.sql) at the schema before the
 * migration, plus the rows only a live database has: office photos the panel filed as messages
 * (the old create_office_report and create_report_version), a photo whose file retention purged,
 * a typed WhatsApp reply that answered no question, a second reporter's photo merged into another
 * reporter's report, and a voice answer and a voice correction (stored audio of a report that is
 * not its source). Each mapping is checked against the rows as they were before the migration.
 */

const MIGRATION = '20261014000002_backfill_uploads_compat.sql';
const SEED_V1_0 = join(import.meta.dirname, 'fixtures', 'seed-v1.0.sql');
const LENA = DEMO_USERS[0]!.id;

let db: PGlite;

type SourceBefore = {
  id: string;
  report_id: string;
  message_id: string;
  kind: string;
  caption: string | null;
  taken_at: Date | null;
  type: string;
  direction: string;
  storage_path: string | null;
  media_mime: string | null;
  duration_s: string | null;
  payload: Record<string, unknown> | null;
  body: string | null;
  created_at: Date;
  conversation_id: string | null;
  report_status: string;
  report_reporter: string | null;
  report_site: string;
  /** The reporter of the message's WhatsApp conversation (who sent it). */
  convo_reporter: string | null;
};

let sourcesBefore: SourceBefore[];
let reportsBefore: Map<string, { updated_at: Date; reporter_id: string | null }>;
let transcriptsBefore: Array<{ id: string; message_id: string }>;
let reportersBefore: Array<{
  id: string;
  status: string;
  verified_at: Date | null;
  invited_at: Date | null;
  created_at: Date;
}>;
let officeReportId: string;
let officeMessageIds: string[];
let editedReportId: string;
let editMessageId: string;
let purgedMessageId: string;
let typedReplyId: string;
let answeredQuestion: { id: string; report_id: string; answered_message_id: string };
let mergedPhoto: { id: string; report_id: string; sender: string; report_reporter: string };
/** Stored voice notes of a report that are not its sources: a voice answer, a voice correction. */
let voiceReplies: Array<{
  id: string;
  report_id: string;
  reporter_id: string;
  site_id: string;
  storage_path: string;
  created_at: Date;
}>;

async function svc<T = Record<string, unknown>>(sql: string, params: unknown[] = []) {
  return (await asService(db, (q) => q<T>(sql, params))).rows;
}

const v1Body = (date: string, extra: Partial<DailyReportDataV1> = {}) =>
  DailyReportDataV1Schema.parse({ ...emptyReportDataV1(date), summary: 'Typed.', ...extra });

/** The data-migration block of the migration file (to run it a second time). */
function backfillBlock(): string {
  const sql = readFileSync(join(MIGRATIONS_DIR, MIGRATION), 'utf8');
  const m = sql.match(/^do \$\$\ndeclare[\s\S]*?^end \$\$;/m);
  if (!m) throw new Error('backfill block not found');
  return m[0];
}

beforeAll(async () => {
  db = await bootDatabase({ until: MIGRATION });
  await db.exec(readFileSync(SEED_V1_0, 'utf8'));

  const sites = await svc<{ project_code: string; id: string }>(
    `select project_code, id from sites where org_id = $1`,
    [DEMO_ORG_ID],
  );
  const riverside = sites.find((s) => s.project_code === 'RL-2041')!.id;

  // A report typed in the panel with two photos: stored as org-level messages before step 10.
  const date = '2026-08-01';
  const photos = [
    {
      path: officePhotoStoragePath(DEMO_ORG_ID, riverside, randomUUID(), 'image/jpeg'),
      mime: 'image/jpeg',
      caption: 'North elevation',
      takenAt: '2026-08-01T15:20:00Z',
    },
    {
      path: officePhotoStoragePath(DEMO_ORG_ID, riverside, randomUUID(), 'image/png'),
      mime: 'image/png',
    },
  ];
  officeReportId = await asUser(db, LENA, async (q) => {
    const res = await q<{ r: { reportId: string } }>(
      `select create_office_report($1, $2, $3, $4) as r`,
      [riverside, date, JSON.stringify(v1Body(date)), JSON.stringify(photos)],
    );
    return res.rows[0]!.r.reportId;
  });
  officeMessageIds = (
    await svc<{ id: string }>(
      `select id from messages where storage_path = any($1::text[])
       order by array_position($1::text[], storage_path)`,
      [photos.map((p) => p.path)],
    )
  ).map((m) => m.id);
  expect(officeMessageIds).toHaveLength(2);

  // An office photo added to a WhatsApp report by an edit.
  const wa = (
    await svc<{ id: string; site_id: string; current_version: number }>(
      `select r.id, r.site_id, r.current_version from reports r
       where r.reporter_id is not null and r.status = 'filed'
         and (select count(*) from report_sources rs where rs.report_id = r.id and rs.kind = 'photo') = 2
       order by r.report_no limit 1`,
    )
  )[0]!;
  editedReportId = wa.id;
  const waData = (
    await svc<{ data: DailyReportDataV1 }>(
      `select data from report_versions where report_id = $1 and version = $2`,
      [wa.id, wa.current_version],
    )
  )[0]!.data;
  const extra = officePhotoStoragePath(DEMO_ORG_ID, wa.site_id, randomUUID(), 'image/jpeg');
  await asUser(db, LENA, (q) =>
    q(`select create_report_version($1, $2, 'Office photo', $3)`, [
      wa.id,
      JSON.stringify(waData),
      JSON.stringify([{ path: extra, mime: 'image/jpeg', caption: 'From the office' }]),
    ]),
  );
  editMessageId = (
    await svc<{ id: string }>(`select id from messages where storage_path = $1`, [extra])
  )[0]!.id;

  // A WhatsApp photo whose file retention already purged (purgeMessageMedia).
  purgedMessageId = (
    await svc<{ id: string }>(
      `select m.id from report_sources rs join messages m on m.id = rs.message_id
       where rs.kind = 'photo' and m.conversation_id is not null and rs.report_id <> $1
       order by m.created_at limit 1`,
      [editedReportId],
    )
  )[0]!.id;
  await svc(
    `update messages set storage_path = null,
       payload = coalesce(payload, '{}'::jsonb) || '{"purged_at":"2026-10-01T00:00:00Z"}'::jsonb
     where id = $1`,
    [purgedMessageId],
  );

  // A typed weather-day reply (the dayoff handler's 'reply' source) that answered no question.
  const convo = (
    await svc<{ id: string; report_id: string }>(
      `select m.conversation_id as id, rs.report_id from report_sources rs
       join messages m on m.id = rs.message_id
       where rs.kind = 'audio' and m.conversation_id is not null and rs.report_id <> $1
       order by rs.report_id limit 1`,
      [editedReportId],
    )
  )[0]!;
  typedReplyId = (
    await svc<{ id: string }>(
      `insert into messages (conversation_id, direction, type, body, status)
       values ($1, 'in', 'text', 'rained out after lunch', 'received') returning id`,
      [convo.id],
    )
  )[0]!.id;
  await svc(`insert into report_sources (report_id, message_id, kind) values ($1, $2, 'reply')`, [
    convo.report_id,
    typedReplyId,
  ]);

  answeredQuestion = (
    await svc<typeof answeredQuestion>(
      `select id, report_id, answered_message_id from questions where answered_message_id is not null`,
    )
  )[0]!;

  // A second reporter's photo in another reporter's report: intake merges any reporter's media
  // into the site-day's live report (findOpenReportForSiteDay).
  const merged = (
    await svc<{
      id: string;
      site_id: string;
      reporter_id: string;
      conversation_id: string;
      sender: string;
    }>(
      `select r.id, r.site_id, r.reporter_id, c.id as conversation_id, rp.id as sender
       from reports r
       join reporters rp on rp.org_id = r.org_id and rp.id <> r.reporter_id
       join conversations c on c.reporter_id = rp.id
       where r.reporter_id is not null and r.status = 'filed' and r.id <> $1
       order by r.report_no, rp.created_at, rp.id limit 1`,
      [editedReportId],
    )
  )[0]!;
  const [mergedMsg] = await svc<{ id: string }>(
    `insert into messages (conversation_id, direction, type, media_mime, storage_path, body, status)
     values ($1, 'in', 'image', 'image/jpeg', $2, 'From the crane', 'received') returning id`,
    [merged.conversation_id, `${DEMO_ORG_ID}/${merged.site_id}/2026-10-09/${randomUUID()}.jpg`],
  );
  await svc(`insert into report_sources (report_id, message_id, kind) values ($1, $2, 'photo')`, [
    merged.id,
    mergedMsg!.id,
  ]);
  mergedPhoto = {
    id: mergedMsg!.id,
    report_id: merged.id,
    sender: merged.sender,
    report_reporter: merged.reporter_id,
  };

  // A voice answer to a question (storeForReply + parse_reply) and a voice correction
  // (report_versions.author_message_id): stored and transcribed, not report sources.
  const asked = (
    await svc<{ id: string; site_id: string; reporter_id: string; conversation_id: string }>(
      `select r.id, r.site_id, r.reporter_id, c.id as conversation_id
       from reports r join conversations c on c.reporter_id = r.reporter_id
       where r.status = 'filed' and r.id not in ($1, $2)
       order by r.report_no limit 1`,
      [editedReportId, merged.id],
    )
  )[0]!;
  voiceReplies = [];
  for (const [i, text] of ['five, full day', 'make that six'].entries()) {
    const path = `${DEMO_ORG_ID}/${asked.site_id}/2026-10-09/${randomUUID()}.ogg`;
    const [m] = await svc<{ id: string; created_at: Date }>(
      `insert into messages (conversation_id, direction, type, media_mime, storage_path, duration_s, payload, status, created_at)
       values ($1, 'in', 'audio', 'audio/ogg', $2, 6, '{"peaks":[0.2,0.4]}', 'received', $3)
       returning id, created_at`,
      [asked.conversation_id, path, `2026-10-09T23:0${i}:00Z`],
    );
    await svc(`insert into transcripts (message_id, text, segments) values ($1, $2, '[]')`, [
      m!.id,
      text,
    ]);
    voiceReplies.push({
      id: m!.id,
      report_id: asked.id,
      reporter_id: asked.reporter_id,
      site_id: asked.site_id,
      storage_path: path,
      created_at: m!.created_at,
    });
  }
  await svc(
    `insert into questions (report_id, field, prompt, answered_message_id, answered_at)
     values ($1, 'manpower.workers', 'How many?', $2, now())`,
    [asked.id, voiceReplies[0]!.id],
  );
  await svc(
    `update report_versions set author_message_id = $2 where report_id = $1 and version = 1`,
    [asked.id, voiceReplies[1]!.id],
  );

  sourcesBefore = await svc<SourceBefore>(
    `select rs.id, rs.report_id, rs.message_id, rs.kind, rs.caption, rs.taken_at,
            m.type::text, m.direction::text, m.storage_path, m.media_mime, m.duration_s::text,
            m.payload, m.body, m.created_at, m.conversation_id,
            r.status::text as report_status, r.reporter_id as report_reporter, r.site_id as report_site,
            c.reporter_id as convo_reporter
     from report_sources rs join messages m on m.id = rs.message_id join reports r on r.id = rs.report_id
     left join conversations c on c.id = m.conversation_id`,
  );
  reportsBefore = new Map(
    (
      await svc<{ id: string; updated_at: Date; reporter_id: string | null }>(
        `select id, updated_at, reporter_id from reports`,
      )
    ).map((r) => [r.id, r]),
  );
  transcriptsBefore = await svc(`select id, message_id from transcripts`);
  reportersBefore = await svc(
    `select id, status::text, verified_at, invited_at, created_at from reporters`,
  );

  await applyMigration(db, MIGRATION);
}, 120_000);

const isMedia = (s: SourceBefore) =>
  (s.kind === 'audio' || s.kind === 'photo') &&
  s.direction === 'in' &&
  s.storage_path !== null &&
  (s.type === 'audio' ||
    s.type === 'image' ||
    (s.type === 'document' && (s.media_mime ?? '').startsWith('image/')));

describe('the frozen v1.0 seed plus office photos, before the migration', () => {
  it('has every kind of row the backfill maps', () => {
    const kinds = new Set(sourcesBefore.map((s) => s.kind));
    expect([...kinds].sort()).toEqual(['audio', 'photo', 'reply']);
    expect(sourcesBefore.filter((s) => s.kind === 'audio').length).toBeGreaterThan(50);
    expect(sourcesBefore.filter((s) => s.kind === 'photo').length).toBeGreaterThan(50);
    expect(sourcesBefore.filter((s) => s.kind === 'reply')).toHaveLength(2);
    expect(transcriptsBefore.length).toBeGreaterThan(0);
    expect(reportersBefore.filter((r) => r.status === 'verified')).toHaveLength(6);
  });
});

describe('uploads from message media', () => {
  it('gives every stored voice note and photo an upload with the message id', async () => {
    const media = new Map(sourcesBefore.filter(isMedia).map((s) => [s.message_id, s]));
    const uploads = await svc<{
      id: string;
      report_id: string;
      reporter_id: string | null;
      site_id: string;
      kind: string;
      storage_path: string;
      mime: string | null;
      bytes: number | null;
      duration_s: string | null;
      peaks: unknown;
      recorded_at: Date | null;
      received_at: Date;
      caption: string | null;
      uploaded_by: string | null;
      purged_at: Date | null;
    }>(`select *, kind::text, duration_s::text from uploads`);
    expect(uploads).toHaveLength(media.size + voiceReplies.length);
    expect(media.size).toBe(
      new Set(sourcesBefore.filter((s) => s.kind !== 'reply').map((s) => s.message_id)).size - 1,
    ); // every media message but the purged one
    expect(media.has(purgedMessageId)).toBe(false);
    for (const u of uploads) {
      const reply = voiceReplies.find((v) => v.id === u.id);
      if (reply) {
        // Not a source, still the report's recording: an audio upload of that report.
        expect(u).toEqual({
          id: reply.id,
          report_id: reply.report_id,
          reporter_id: reply.reporter_id,
          site_id: reply.site_id,
          kind: 'audio',
          storage_path: reply.storage_path,
          mime: 'audio/ogg',
          bytes: null,
          duration_s: '6',
          peaks: [0.2, 0.4],
          recorded_at: reply.created_at,
          received_at: reply.created_at,
          caption: null,
          uploaded_by: null,
          purged_at: null,
        });
        continue;
      }
      const m = media.get(u.id)!;
      expect(m, u.id).toBeDefined();
      const office = m.conversation_id === null;
      expect(u).toEqual({
        id: m.message_id,
        report_id: m.report_id,
        // Who sent it: the reporter of its conversation, not necessarily the report's.
        reporter_id: office ? null : (m.convo_reporter ?? m.report_reporter),
        site_id: m.report_site,
        kind: m.kind === 'audio' ? 'audio' : 'photo',
        storage_path: m.storage_path,
        mime: m.media_mime,
        bytes: null,
        duration_s: m.duration_s,
        peaks: Array.isArray(m.payload?.peaks) ? m.payload.peaks : null,
        recorded_at: m.kind === 'photo' ? (m.taken_at ?? m.created_at) : m.created_at,
        received_at: m.created_at,
        caption: m.kind === 'photo' ? (m.caption ?? m.body) : null,
        uploaded_by: office ? LENA : null,
        purged_at: null,
      });
    }
    // The merged photo is the second reporter's, in the first reporter's report.
    expect(mergedPhoto.sender).not.toBe(mergedPhoto.report_reporter);
    expect(uploads.find((u) => u.id === mergedPhoto.id)).toMatchObject({
      report_id: mergedPhoto.report_id,
      reporter_id: mergedPhoto.sender,
      caption: 'From the crane',
    });
    const office = uploads.filter((u) => [...officeMessageIds, editMessageId].includes(u.id));
    expect(office).toHaveLength(3);
    expect(office.find((u) => u.id === officeMessageIds[0])).toMatchObject({
      report_id: officeReportId,
      caption: 'North elevation',
      mime: 'image/jpeg',
    });
    expect(office.find((u) => u.id === editMessageId)).toMatchObject({
      report_id: editedReportId,
      caption: 'From the office',
    });
    // Voice notes keep their waveform for the panel player.
    expect(uploads.filter((u) => u.kind === 'audio').every((u) => Array.isArray(u.peaks))).toBe(
      true,
    );
  });

  it('keys every source by its upload and maps the kinds to the v1.2 labels', async () => {
    const after = new Map(
      (
        await svc<{
          id: string;
          message_id: string;
          kind: string;
          upload_id: string | null;
          question_id: string | null;
        }>(`select id, message_id, kind, upload_id, question_id from report_sources`)
      ).map((s) => [s.id, s]),
    );
    expect(after.size).toBe(sourcesBefore.length);
    for (const s of sourcesBefore) {
      const a = after.get(s.id)!;
      expect(a.message_id).toBe(s.message_id);
      expect(a.upload_id).toBe(isMedia(s) ? s.message_id : null);
      if (s.kind === 'audio') expect(a.kind).toBe('voice_note');
      if (s.kind === 'photo') expect(a.kind).toBe('photo');
      if (s.kind === 'reply') {
        const answered =
          s.message_id === answeredQuestion.answered_message_id &&
          s.report_id === answeredQuestion.report_id;
        expect(a).toMatchObject(
          answered
            ? { kind: 'answer', question_id: answeredQuestion.id }
            : { kind: 'text', question_id: null },
        );
      } else expect(a.question_id).toBeNull();
    }
    expect(after.get(sourcesBefore.find((s) => s.message_id === typedReplyId)!.id)!.kind).toBe(
      'text',
    );
    // No WhatsApp-era label is left.
    const old = await svc(`select 1 from report_sources where kind in ('audio', 'reply')`);
    expect(old).toEqual([]);
  });

  it('links the transcripts of backfilled voice notes', async () => {
    const after = new Map(
      (
        await svc<{ id: string; message_id: string; upload_id: string | null }>(
          `select id, message_id, upload_id from transcripts`,
        )
      ).map((t) => [t.id, t]),
    );
    const voice = new Set([
      ...sourcesBefore.filter((s) => isMedia(s) && s.kind === 'audio').map((s) => s.message_id),
      ...voiceReplies.map((v) => v.id),
    ]);
    expect(after.size).toBe(transcriptsBefore.length);
    let linked = 0;
    for (const t of transcriptsBefore) {
      const expected = voice.has(t.message_id) ? t.message_id : null;
      expect(after.get(t.id)!.upload_id).toBe(expected);
      if (expected) linked++;
    }
    expect(linked).toBeGreaterThan(0);
    // The voice answer and the voice correction keep their transcripts, now on their uploads.
    for (const v of voiceReplies)
      expect([...after.values()].filter((t) => t.upload_id === v.id)).toHaveLength(1);
  });

  it('resolves every photo the stored versions list through report_sources and uploads', async () => {
    const versions = await svc<{ report_id: string; version: number; data: StoredReportData }>(
      `select report_id, version, data from report_versions`,
    );
    const sources = await svc<{
      report_id: string;
      message_id: string | null;
      upload_id: string | null;
      kind: string;
      caption: string | null;
      taken_at: string | null;
      storage_path: string | null;
    }>(
      `select rs.report_id, rs.message_id, rs.upload_id, rs.kind, rs.caption, rs.taken_at::text,
              coalesce(u.storage_path, m.storage_path) as storage_path
       from report_sources rs
       left join uploads u on u.id = rs.upload_id
       left join messages m on m.id = rs.message_id`,
    );
    let listed = 0;
    for (const v of versions) {
      const data = readReportData(v.data);
      if (!Array.isArray(data.photos)) continue;
      const shown = versionPhotos(
        data.photos,
        sources.filter((s) => s.report_id === v.report_id),
      );
      // Every listed photo is still found (versions are never rewritten), with its file unless
      // retention purged it.
      expect(shown.map((p) => p.source.upload_id ?? p.source.message_id)).toEqual(
        data.photos.map((p) => p.uploadId),
      );
      for (const p of shown) {
        listed++;
        if (p.source.message_id === purgedMessageId) expect(p.source.storage_path).toBeNull();
        else expect(p.source.upload_id).toBe(p.source.message_id);
      }
    }
    expect(listed).toBeGreaterThan(50);
  });
});

describe('reports, reporters and the audit row', () => {
  it('sets every report language to en and makes it required, without touching updated_at', async () => {
    const rows = await svc<{
      id: string;
      language: string;
      channel: string | null;
      updated_at: Date;
    }>(`select id, language, channel::text, updated_at from reports`);
    expect(rows).toHaveLength(reportsBefore.size);
    for (const r of rows) {
      expect(r.language).toBe('en');
      expect(r.updated_at).toEqual(reportsBefore.get(r.id)!.updated_at);
      // Typed in the panel: channel office; WhatsApp-era reports keep a null channel (D13).
      expect(r.channel).toBe(r.id === officeReportId ? 'office' : null);
    }
    const col = await svc<{ is_nullable: string; column_default: string }>(
      `select is_nullable, column_default from information_schema.columns
       where table_name = 'reports' and column_name = 'language'`,
    );
    expect(col).toEqual([{ is_nullable: 'NO', column_default: null }]);
  });

  it('refuses a report written without a language (no default: every writer sets it)', async () => {
    const r = (
      await svc<{ org_id: string; site_id: string }>(
        `select org_id, site_id from reports where id = $1`,
        [officeReportId],
      )
    )[0]!;
    const day = (
      await svc<{ id: string }>(
        `insert into site_days (site_id, date, deadline_at) values ($1, '2026-07-31', now()) returning id`,
        [r.site_id],
      )
    )[0]!.id;
    await expect(
      svc(
        `insert into reports (org_id, site_id, site_day_id, report_no) values ($1, $2, $3, 'OLD-0001')`,
        [r.org_id, r.site_id, day],
      ),
    ).rejects.toMatchObject({ code: '23502' });
    await expect(
      svc(
        `insert into reports (org_id, site_id, site_day_id, report_no, language)
         values ($1, $2, $3, 'OLD-0002', null)`,
        [r.org_id, r.site_id, day],
      ),
    ).rejects.toMatchObject({ code: '23502' });
  });

  it('records when each verified reporter became active', async () => {
    const after = new Map(
      (
        await svc<{ id: string; activated_at: Date | null }>(
          `select id, activated_at from reporters`,
        )
      ).map((r) => [r.id, r.activated_at]),
    );
    for (const r of reportersBefore)
      expect(after.get(r.id)).toEqual(
        r.status === 'verified' ? (r.verified_at ?? r.invited_at ?? r.created_at) : null,
      );
  });

  it('writes one audit row with the counts, and a second run changes nothing', async () => {
    const audit = await svc<{
      org_id: string | null;
      actor_type: string;
      diff: Record<string, number>;
    }>(
      `select org_id, actor_type, diff from audit_log where action = 'migration.backfill_uploads'`,
    );
    const media = sourcesBefore.filter(isMedia);
    expect(audit).toEqual([
      {
        org_id: null,
        actor_type: 'system',
        diff: {
          migration: '20261014000002',
          reports_language: reportsBefore.size,
          reports_office_channel: 1,
          reporters_activated: 6,
          uploads: media.length,
          uploads_voice_replies: voiceReplies.length,
          sources_upload_id: media.length,
          sources_voice_note: sourcesBefore.filter((s) => s.kind === 'audio').length,
          sources_answer: 1,
          sources_text: 1,
          transcripts_upload_id: expect.any(Number),
        },
      },
    ]);

    const snapshot = async () =>
      svc(
        `select (select count(*) from uploads)::int as uploads,
                (select string_agg(id::text || kind || coalesce(upload_id::text, '') || coalesce(question_id::text, ''), ',' order by id) from report_sources) as sources,
                (select string_agg(id::text || coalesce(upload_id::text, ''), ',' order by id) from transcripts) as transcripts,
                (select string_agg(id::text || coalesce(activated_at::text, ''), ',' order by id) from reporters) as reporters,
                (select count(*) from audit_log)::int as audit`,
      );
    const before = await snapshot();
    await db.exec(backfillBlock());
    expect(await snapshot()).toEqual(before);
  });
});
