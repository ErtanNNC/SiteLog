import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import {
  DailyReportDataV1Schema,
  emptyReportDataV1,
  officePhotoStoragePath,
  type DailyReportDataV1,
  type OfficePhotoUpload,
} from '@sitelog/shared';
import { DEMO_ORG_ID, DEMO_USERS } from '@sitelog/shared/demo/kestrel.ts';
import { MIGRATIONS_DIR, asService, asUser, bootDatabase } from './harness.ts';

/**
 * 20261013000005_office_photos.sql: photos the office uploads in the panel are stored as
 * org-level messages (no conversation) + photo sources of the report, and each version's
 * data.photos lists the photos that version shows.
 */

const LENA = DEMO_USERS[0]!.id; // admin
const SAM = DEMO_USERS[1]!.id; // pm
const ACCOUNTS = DEMO_USERS[2]!.id; // accounts
const OUTSIDER = 'eeeeeeee-3333-4333-8333-333333333333'; // admin of another org

let db: PGlite;
let otherOrgId: string;
let riverside: string;
let oakmont: string;

type Filed = { reportId: string; reportNo: string; created: boolean };
type MessageOut = {
  id: string;
  org_id: string | null;
  conversation_id: string | null;
  direction: string;
  type: string;
  body: string | null;
  payload: unknown;
  media_mime: string | null;
  storage_path: string | null;
  status: string;
};

async function svc<T = Record<string, unknown>>(sql: string, params: unknown[] = []) {
  return (await asService(db, (q) => q<T>(sql, params))).rows;
}

function officeReport(
  user: string,
  siteId: string,
  date: string,
  data: unknown,
  photos?: unknown,
): Promise<Filed> {
  return asUser(db, user, async (q) => {
    const res =
      photos === undefined
        ? await q<{ r: Filed }>(`select create_office_report($1, $2, $3) as r`, [
            siteId,
            date,
            JSON.stringify(data),
          ])
        : await q<{ r: Filed }>(`select create_office_report($1, $2, $3, $4) as r`, [
            siteId,
            date,
            JSON.stringify(data),
            JSON.stringify(photos),
          ]);
    return res.rows[0]!.r;
  });
}

function editReport(
  user: string,
  reportId: string,
  data: unknown,
  photos: unknown = [],
  note = 'Photos updated',
) {
  return asUser(db, user, async (q) => {
    const res = await q<{ r: { version: number } }>(
      `select create_report_version($1, $2, $3, $4) as r`,
      [reportId, JSON.stringify(data), note, JSON.stringify(photos)],
    );
    return res.rows[0]!.r.version;
  });
}

function upload(
  siteId: string,
  over: Partial<OfficePhotoUpload> = {},
  orgId = DEMO_ORG_ID,
): OfficePhotoUpload {
  return {
    path: officePhotoStoragePath(orgId, siteId, randomUUID(), over.mime ?? 'image/jpeg'),
    mime: 'image/jpeg',
    ...over,
  };
}

function body(date: string, extra: Partial<DailyReportDataV1> = {}): DailyReportDataV1 {
  return DailyReportDataV1Schema.parse({
    ...emptyReportDataV1(date),
    summary: 'Typed with photos.',
    ...extra,
  });
}

async function versionData(reportId: string, version: number) {
  return (
    await svc<{ data: DailyReportDataV1 }>(
      `select data from report_versions where report_id = $1 and version = $2`,
      [reportId, version],
    )
  )[0]!.data;
}

async function messagesAt(paths: string[]) {
  return svc<MessageOut>(
    `select id, org_id, conversation_id, direction::text, type::text, body, payload, media_mime,
            storage_path, status::text
     from messages where storage_path = any($1::text[])
     order by array_position($1::text[], storage_path)`,
    [paths],
  );
}

async function photoSources(reportId: string) {
  return svc<{ message_id: string; caption: string | null; taken_at: Date }>(
    `select rs.message_id, rs.caption, rs.taken_at from report_sources rs
     join messages m on m.id = rs.message_id
     where rs.report_id = $1 and rs.kind = 'photo' order by m.created_at, rs.message_id`,
    [reportId],
  );
}

async function auditOf(reportId: string, action: string) {
  return svc<{ actor_id: string; diff: Record<string, unknown> }>(
    `select actor_id, diff from audit_log where entity_id = $1 and action = $2 order by created_at`,
    [reportId, action],
  );
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
  db = await bootDatabase({ seed: true });
  await db.exec(`insert into auth.users (id, email) values ('${OUTSIDER}', 'y@other.test');`);
  otherOrgId = await asUser(
    db,
    OUTSIDER,
    async (q) =>
      (await q<{ r: { id: string } }>(`select create_org('Other GC') as r`)).rows[0]!.r.id,
    'y@other.test',
  );
  const sites = await svc<{ project_code: string; id: string }>(
    `select project_code, id from sites where org_id = $1`,
    [DEMO_ORG_ID],
  );
  const byCode = Object.fromEntries(sites.map((s) => [s.project_code, s.id]));
  riverside = byCode['RL-2041']!;
  oakmont = byCode['OM-1187']!;
});

describe('create_office_report with photos', () => {
  it('stores each upload as an org-level photo message and lists it in data.photos', async () => {
    const date = '2026-08-03';
    const a = upload(riverside, {
      caption: '  North elevation  ',
      takenAt: '2026-08-03T15:20:00Z',
    });
    const b = upload(riverside, { mime: 'image/png' });
    const c = upload(riverside, { mime: 'image/webp', takenAt: '2999-01-01T00:00:00Z' });
    const before = Date.now();
    const data = body(date, {
      // The client's photo list is replaced by the uploads.
      photos: [{ messageId: randomUUID(), takenAt: '2026-08-03T12:00:00Z' }],
      weather: {
        conditionsText: 'Rain',
        periods: [{ condition: 'Rain', lostHours: 2, source: [] }],
      },
    });
    const res = await officeReport(LENA, riverside, date, data, [a, b, c]);
    expect(res.created).toBe(true);

    const msgs = await messagesAt([a.path, b.path, c.path]);
    expect(msgs).toEqual([
      {
        id: expect.any(String),
        org_id: DEMO_ORG_ID,
        conversation_id: null,
        direction: 'in',
        type: 'image',
        body: 'North elevation',
        payload: { source: 'office_upload', uploaded_by: LENA },
        media_mime: 'image/jpeg',
        storage_path: a.path,
        status: 'received',
      },
      expect.objectContaining({ body: null, media_mime: 'image/png', storage_path: b.path }),
      expect.objectContaining({ body: null, media_mime: 'image/webp', storage_path: c.path }),
    ]);

    const sources = await svc<{ message_id: string; caption: string | null; taken_at: Date }>(
      `select message_id, caption, taken_at from report_sources
       where report_id = $1 and kind = 'photo'`,
      [res.reportId],
    );
    expect(sources).toHaveLength(3);
    const byMsg = new Map(sources.map((s) => [s.message_id, s]));
    expect(byMsg.get(msgs[0]!.id)!.caption).toBe('North elevation');
    expect(byMsg.get(msgs[0]!.id)!.taken_at.toISOString()).toBe('2026-08-03T15:20:00.000Z');
    // No time sent: the filing time. A time in the future is never stored.
    for (const m of [msgs[1]!, msgs[2]!]) {
      const t = byMsg.get(m.id)!.taken_at.getTime();
      expect(t).toBeGreaterThanOrEqual(before - 1000);
      expect(t).toBeLessThanOrEqual(Date.now() + 1000);
    }

    const v1 = await versionData(res.reportId, 1);
    expect(v1.photos).toEqual([
      { messageId: msgs[0]!.id, caption: 'North elevation', takenAt: '2026-08-03T15:20:00.000Z' },
      { messageId: msgs[1]!.id, takenAt: byMsg.get(msgs[1]!.id)!.taken_at.toISOString() },
      { messageId: msgs[2]!.id, takenAt: byMsg.get(msgs[2]!.id)!.taken_at.toISOString() },
    ]);
    expect(DailyReportDataV1Schema.safeParse(v1).success).toBe(true);
    // The delay record counts them (claim-ready needs audio + photo + observed data).
    const wx = await svc<{ photo_count: number }>(
      `select photo_count from weather_events where report_id = $1 and version = 1`,
      [res.reportId],
    );
    expect(wx).toEqual([{ photo_count: 3 }]);

    expect(await auditOf(res.reportId, 'report.filed')).toEqual([
      {
        actor_id: LENA,
        diff: { trigger: 'office_entry', version: 1, is_late: true, date, photos: 3 },
      },
    ]);
  });

  it('files without photos: data.photos is empty whatever the client sent', async () => {
    const date = '2026-08-04';
    const res = await officeReport(
      SAM,
      riverside,
      date,
      body(date, { photos: [{ messageId: randomUUID(), takenAt: '2026-08-04T12:00:00Z' }] }),
    );
    expect(res.created).toBe(true);
    expect((await versionData(res.reportId, 1)).photos).toEqual([]);
    expect(await photoSources(res.reportId)).toEqual([]);
  });

  it('orders the uploads by their position, then as sent', async () => {
    const date = '2026-08-08';
    const a = upload(riverside, { position: 2 });
    const b = upload(riverside, { position: 0 });
    const c = upload(riverside);
    const d = upload(riverside, { position: 1 });
    const res = await officeReport(LENA, riverside, date, body(date), [a, b, c, d]);
    const msgs = await messagesAt([a.path, b.path, c.path, d.path]);
    const id = (path: string) => msgs.find((m) => m.storage_path === path)!.id;
    expect((await versionData(res.reportId, 1)).photos.map((p) => p.messageId)).toEqual([
      id(b.path),
      id(d.path),
      id(a.path),
      id(c.path),
    ]);
  });

  it('returns the existing report on a double submit without attaching the photos again', async () => {
    const date = '2026-08-05';
    const a = upload(riverside);
    const first = await officeReport(LENA, riverside, date, body(date), [a]);
    const again = await officeReport(LENA, riverside, date, body(date), [a]);
    expect(again).toEqual({ ...first, created: false });
    expect(await messagesAt([a.path])).toHaveLength(1);
    expect(await photoSources(first.reportId)).toHaveLength(1);
  });

  it('refuses uploads that are not office photos of the report’s org and site', async () => {
    const date = '2026-08-06';
    const seq = async () =>
      (await svc<{ n: number }>(`select report_seq as n from sites where id = $1`, [riverside]))[0]!
        .n;
    const seqBefore = await seq();
    const messagesBefore = (await svc<{ n: number }>(`select count(*)::int as n from messages`))[0]!
      .n;
    const file = (photos: unknown) => () => officeReport(LENA, riverside, date, body(date), photos);
    const id = randomUUID();

    expect(await errorOf(file([upload(riverside, {}, otherOrgId)]))).toBe('unexpected photo path');
    expect(await errorOf(file([upload(oakmont)])) /* another site of the org */).toBe(
      'unexpected photo path',
    );
    expect(
      await errorOf(
        file([{ path: `${DEMO_ORG_ID}/${riverside}/${date}/${id}.jpg`, mime: 'image/jpeg' }]),
      ),
    ).toBe('unexpected photo path');
    expect(
      await errorOf(
        file([{ path: `${DEMO_ORG_ID}/${riverside}/office/../${id}.jpg`, mime: 'image/jpeg' }]),
      ),
    ).toBe('unexpected photo path');
    expect(
      await errorOf(
        file([{ path: `${DEMO_ORG_ID}/${riverside}/office/${id}.gif`, mime: 'image/gif' }]),
      ),
    ).toBe('unexpected photo path');
    expect(await errorOf(file([{ ...upload(riverside), mime: 'image/gif' }]))).toBe(
      'unsupported photo type',
    );
    expect(
      await errorOf(
        file([{ path: `${DEMO_ORG_ID}/${riverside}/office/${id}.png`, mime: 'image/jpeg' }]),
      ),
    ).toBe('photo type does not match its file name');
    expect(await errorOf(file(Array.from({ length: 21 }, () => upload(riverside))))).toBe(
      'at most 20 photos at a time',
    );
    expect(await errorOf(file({ path: upload(riverside).path }))).toBe(
      'photos must be a JSON array',
    );
    expect(await errorOf(file([upload(riverside, { takenAt: 'yesterday at five' })]))).toBe(
      'invalid photo time',
    );
    expect(await errorOf(file([{ ...upload(riverside), caption: 42 }]))).toBe(
      'photo caption must be text',
    );
    expect(await errorOf(file([upload(riverside, { caption: 'x'.repeat(501) })]))).toBe(
      'photo caption is too long',
    );
    for (const position of [-1, 1.5, '2', 1001, true])
      expect(await errorOf(file([{ ...upload(riverside), position }]))).toBe(
        'invalid photo position',
      );
    const twice = upload(riverside);
    expect(await errorOf(file([twice, twice]))).toBe('photo already attached');

    // Nothing was filed or stored by the refused calls.
    expect(
      await svc(
        `select 1 from reports r join site_days sd on sd.id = r.site_day_id
         where sd.site_id = $1 and sd.date = $2`,
        [riverside, date],
      ),
    ).toEqual([]);
    expect(await seq()).toBe(seqBefore);
    expect((await svc<{ n: number }>(`select count(*)::int as n from messages`))[0]!.n).toBe(
      messagesBefore,
    );

    // Exactly 20 is fine.
    const res = await officeReport(
      LENA,
      riverside,
      date,
      body(date),
      Array.from({ length: 20 }, () => upload(riverside)),
    );
    expect((await versionData(res.reportId, 1)).photos).toHaveLength(20);
  });

  it('is not open to other orgs or the accounts role', async () => {
    const date = '2026-08-07';
    for (const user of [OUTSIDER, ACCOUNTS])
      expect(
        await errorOf(() => officeReport(user, riverside, date, body(date), [upload(riverside)])),
      ).toBe('not allowed');
    // The internal helper cannot be called directly by an office user either.
    const reportId = (await svc<{ id: string }>(`select id from reports limit 1`))[0]!.id;
    expect(
      await errorOf(() =>
        asUser(db, OUTSIDER, (q) => q(`select attach_office_photos($1, '[]'::jsonb)`, [reportId])),
      ),
    ).toMatch(/not allowed|permission denied/);
  });
});

describe('create_report_version with photos', () => {
  let reportId: string;
  let v1: DailyReportDataV1;
  let ids: { a: string; b: string; c: string };

  beforeAll(async () => {
    const date = '2026-08-10';
    const a = upload(riverside, { caption: 'A', takenAt: '2026-08-10T14:00:00Z' });
    const b = upload(riverside, { caption: 'B', takenAt: '2026-08-10T14:05:00Z' });
    const c = upload(riverside, { takenAt: '2026-08-10T14:10:00Z' });
    reportId = (await officeReport(LENA, riverside, date, body(date), [a, b, c])).reportId;
    const msgs = await messagesAt([a.path, b.path, c.path]);
    ids = { a: msgs[0]!.id, b: msgs[1]!.id, c: msgs[2]!.id };
    v1 = await versionData(reportId, 1);
  });

  it('keeps, re-captions, removes and adds photos; older versions keep theirs', async () => {
    const d = upload(riverside, { caption: 'Delivered rebar', takenAt: '2026-08-10T16:00:00Z' });
    const jobsBefore = (await svc<{ n: number }>(`select count(*)::int as n from jobs`))[0]!.n;
    const version = await editReport(
      SAM,
      reportId,
      {
        ...v1,
        photos: [
          // Re-captioned and moved first; a time sent for a kept photo is ignored.
          { messageId: ids.c, caption: ' East stair ', takenAt: '2000-01-01T00:00:00Z' },
          // Caption cleared.
          { messageId: ids.a, caption: '', takenAt: v1.photos[0]!.takenAt },
          // Not a photo of this report, and a repeat: both skipped. B is left out: removed.
          { messageId: randomUUID(), takenAt: '2026-08-10T14:00:00Z' },
          { messageId: ids.a.toUpperCase(), caption: 'again', takenAt: v1.photos[0]!.takenAt },
        ],
      },
      [d],
    );
    expect(version).toBe(2);
    const [dMsg] = await messagesAt([d.path]);

    const v2 = await versionData(reportId, 2);
    expect(v2.photos).toEqual([
      { messageId: ids.c, caption: 'East stair', takenAt: '2026-08-10T14:10:00.000Z' },
      { messageId: ids.a, takenAt: '2026-08-10T14:00:00.000Z' },
      { messageId: dMsg!.id, caption: 'Delivered rebar', takenAt: '2026-08-10T16:00:00.000Z' },
    ]);
    expect(DailyReportDataV1Schema.safeParse(v2).success).toBe(true);
    // Version 1 is immutable and still shows A, B, C.
    expect(await versionData(reportId, 1)).toEqual(v1);
    expect(v1.photos.map((p) => p.messageId)).toEqual([ids.a, ids.b, ids.c]);
    // B stays a source of the report (its message and object are not deleted).
    expect((await photoSources(reportId)).map((s) => s.message_id).sort()).toEqual(
      [ids.a, ids.b, ids.c, dMsg!.id].sort(),
    );

    expect(await auditOf(reportId, 'report.version_created')).toEqual([
      {
        actor_id: SAM,
        diff: {
          version: 2,
          change_note: 'Photos updated',
          photos: 3,
          photos_added: 1,
          photos_removed: 1,
        },
      },
    ]);
    // The worker still renders and emails the new version.
    const jobs = await svc<{ type: string; payload: Record<string, unknown> }>(
      `select type, payload from jobs order by id desc limit 1`,
    );
    expect((await svc<{ n: number }>(`select count(*)::int as n from jobs`))[0]!.n).toBe(
      jobsBefore + 1,
    );
    expect(jobs[0]).toMatchObject({ type: 'render_pdf', payload: { reportId, version: 2 } });
  });

  it('accepts a photo change alone and can bring back a removed photo', async () => {
    const v2 = await versionData(reportId, 2);
    const version = await editReport(LENA, reportId, {
      ...v2,
      photos: [{ messageId: ids.b, caption: 'B', takenAt: '2026-08-10T23:59:00Z' }],
    });
    expect(version).toBe(3);
    expect((await versionData(reportId, 3)).photos).toEqual([
      { messageId: ids.b, caption: 'B', takenAt: '2026-08-10T14:05:00.000Z' },
    ]);
    expect((await auditOf(reportId, 'report.version_created'))[1]!.diff).toMatchObject({
      version: 3,
      photos: 1,
      photos_added: 1,
      photos_removed: 3,
    });
  });

  it('keeps the replaced version’s photos when the data has no photos array', async () => {
    const v3 = await versionData(reportId, 3);
    const { photos: _drop, ...withoutPhotos } = v3;
    void _drop;
    const version = await editReport(LENA, reportId, { ...withoutPhotos, summary: 'Reworded.' });
    const v4 = await versionData(reportId, version);
    expect(v4.summary).toBe('Reworded.');
    expect(v4.photos).toEqual(v3.photos);
    expect((await auditOf(reportId, 'report.version_created'))[2]!.diff).toMatchObject({
      photos: 1,
      photos_added: 0,
      photos_removed: 0,
    });
  });

  it('removes every photo when the version lists none', async () => {
    const current = (
      await svc<{ v: number }>(`select current_version as v from reports where id = $1`, [reportId])
    )[0]!.v;
    const data = await versionData(reportId, current);
    const version = await editReport(LENA, reportId, { ...data, photos: [] });
    expect((await versionData(reportId, version)).photos).toEqual([]);
    expect((await auditOf(reportId, 'report.version_created')).at(-1)!.diff).toMatchObject({
      photos: 0,
      photos_added: 0,
      photos_removed: 1,
    });
  });

  it('places new uploads among the kept photos at their position', async () => {
    const current = (
      await svc<{ v: number }>(`select current_version as v from reports where id = $1`, [reportId])
    )[0]!.v;
    const data = await versionData(reportId, current);
    const kept = [
      { messageId: ids.c, takenAt: '2026-08-10T14:10:00.000Z' },
      { messageId: ids.a, caption: 'A', takenAt: '2026-08-10T14:00:00.000Z' },
    ];
    // The panel's order: new, C, new, A, then one with no position (appended).
    const first = upload(riverside, { position: 0, caption: 'First' });
    const middle = upload(riverside, { position: 2 });
    const last = upload(riverside);
    const beyond = upload(riverside, { position: 99 });
    const version = await editReport(LENA, reportId, { ...data, photos: kept }, [
      last,
      middle,
      beyond,
      first,
    ]);
    const msgs = await messagesAt([first.path, middle.path, last.path, beyond.path]);
    expect((await versionData(reportId, version)).photos.map((p) => p.messageId)).toEqual([
      msgs[0]!.id,
      ids.c,
      msgs[1]!.id,
      ids.a,
      msgs[3]!.id,
      msgs[2]!.id,
    ]);
    expect((await auditOf(reportId, 'report.version_created')).at(-1)!.diff).toMatchObject({
      photos: 6,
      // The previous version showed none: C and A come back too.
      photos_added: 6,
      photos_removed: 0,
    });
  });

  it('refuses another site’s path, a re-used upload and too many photos; nothing changes', async () => {
    const current = async () =>
      (
        await svc<{ v: number }>(`select current_version as v from reports where id = $1`, [
          reportId,
        ])
      )[0]!.v;
    const before = await current();
    const data = await versionData(reportId, before);
    const used = (
      await svc<{ storage_path: string }>(`select storage_path from messages where id = $1`, [
        ids.a,
      ])
    )[0]!.storage_path;
    expect(await errorOf(() => editReport(LENA, reportId, data, [upload(oakmont)]))).toBe(
      'unexpected photo path',
    );
    expect(
      await errorOf(() => editReport(LENA, reportId, data, [{ path: used, mime: 'image/jpeg' }])),
    ).toBe('photo already attached');
    expect(
      await errorOf(() =>
        editReport(
          LENA,
          reportId,
          data,
          Array.from({ length: 21 }, () => upload(riverside)),
        ),
      ),
    ).toBe('at most 20 photos at a time');
    expect(await errorOf(() => editReport(OUTSIDER, reportId, data, [upload(riverside)]))).toBe(
      'not allowed',
    );
    expect(await current()).toBe(before);
  });

  it('adds office photos to a WhatsApp report and keeps the photos the site manager sent', async () => {
    const wa = (
      await svc<{ id: string; site_id: string; current_version: number }>(
        `select r.id, r.site_id, r.current_version from reports r
         where r.reporter_id is not null and r.status = 'filed'
           and (select count(*) from report_sources rs where rs.report_id = r.id and rs.kind = 'photo') = 2
         order by r.report_no limit 1`,
      )
    )[0]!;
    const data = await versionData(wa.id, wa.current_version);
    expect(data.photos).toHaveLength(2);
    const extra = upload(wa.site_id, { caption: 'From the office' });
    const version = await editReport(LENA, wa.id, data, [extra]);
    const next = await versionData(wa.id, version);
    const [extraMsg] = await messagesAt([extra.path]);
    expect(next.photos).toEqual([
      ...data.photos.map((p) => ({
        messageId: p.messageId,
        ...(p.caption ? { caption: p.caption } : {}),
        takenAt: p.takenAt,
      })),
      { messageId: extraMsg!.id, caption: 'From the office', takenAt: expect.any(String) },
    ]);
    // The WhatsApp photos are still messages of the site manager's conversation.
    const waMsgs = await svc<{ conversation_id: string | null; org_id: string | null }>(
      `select conversation_id, org_id from messages where id = any($1::uuid[])`,
      [data.photos.map((p) => p.messageId)],
    );
    expect(waMsgs.every((m) => m.conversation_id !== null && m.org_id === null)).toBe(true);
  });
});

describe('messages without a conversation', () => {
  let officeIds: string[];

  beforeAll(async () => {
    officeIds = (
      await svc<{ id: string }>(
        `select id from messages where org_id = $1 and payload->>'source' = 'office_upload'`,
        [DEMO_ORG_ID],
      )
    ).map((m) => m.id);
    expect(officeIds.length).toBeGreaterThan(0);
  });

  const visible = (user: string, sql: string, params: unknown[] = []) =>
    asUser(db, user, async (q) => (await q<{ n: number }>(sql, params)).rows[0]!.n);

  it('lets admin, pm and ops of the org read the office photos, nobody else', async () => {
    const sql = `select count(*)::int as n from messages where id = any($1::uuid[])`;
    expect(await visible(LENA, sql, [officeIds])).toBe(officeIds.length);
    expect(await visible(SAM, sql, [officeIds])).toBe(officeIds.length);
    expect(await visible(ACCOUNTS, sql, [officeIds])).toBe(0);
    expect(await visible(OUTSIDER, sql, [officeIds])).toBe(0);
    // Nor their photo sources.
    const src = `select count(*)::int as n from report_sources where message_id = any($1::uuid[])`;
    expect(await visible(OUTSIDER, src, [officeIds])).toBe(0);
    expect(await visible(LENA, src, [officeIds])).toBe(officeIds.length);
    const orgs = await svc<{ org: string }>(
      `select distinct message_org(id) as org from messages where id = any($1::uuid[])`,
      [officeIds],
    );
    expect(orgs).toEqual([{ org: DEMO_ORG_ID }]);
  });

  it('keeps WhatsApp messages scoped by their conversation as before', async () => {
    const counts = (
      await svc<{ own: number; total: number }>(
        `select count(*) filter (where c.org_id = $1)::int as own, count(*)::int as total
         from messages m join conversations c on c.id = m.conversation_id`,
        [DEMO_ORG_ID],
      )
    )[0]!;
    expect(counts.own).toBeGreaterThan(0);
    const waSql = `select count(*)::int as n from messages where conversation_id is not null`;
    expect(await visible(LENA, waSql)).toBe(counts.own);
    expect(await visible(OUTSIDER, waSql)).toBe(0);
    // Transcripts follow their message's org.
    const tr = `select count(*)::int as n from transcripts`;
    const totalTranscripts = (await svc<{ n: number }>(tr))[0]!.n;
    expect(totalTranscripts).toBeGreaterThan(0);
    expect(await visible(LENA, tr)).toBeGreaterThan(0);
    expect(await visible(OUTSIDER, tr)).toBe(0);

    // A new inbound WhatsApp message needs no org_id; its jobs still lock on the conversation.
    const convo = (
      await svc<{ id: string }>(`select id from conversations where org_id = $1 limit 1`, [
        DEMO_ORG_ID,
      ])
    )[0]!.id;
    const [msg] = await svc<{ id: string; org_id: string | null }>(
      `insert into messages (conversation_id, direction, type, body) values ($1, 'in', 'text', 'hi')
       returning id, org_id`,
      [convo],
    );
    expect(msg!.org_id).toBeNull();
    expect((await svc<{ org: string }>(`select message_org($1) as org`, [msg!.id]))[0]!.org).toBe(
      DEMO_ORG_ID,
    );
    expect(
      await visible(LENA, `select count(*)::int as n from messages where id = $1`, [msg!.id]),
    ).toBe(1);
    const key = (
      await svc<{ k: string }>(`select job_lock_key('inbound_message', $1) as k`, [
        JSON.stringify({ messageId: msg!.id }),
      ])
    )[0]!.k;
    expect(key).toBe(`convo:${convo}`);
  });

  it('requires a conversation or an org on every message, and one message per office upload', async () => {
    const code = async (sql: string, params: unknown[] = []) => {
      try {
        await svc(sql, params);
        return 'ok';
      } catch (err) {
        return (err as { code?: string }).code;
      }
    };
    expect(
      await code(`insert into messages (direction, type, body) values ('in', 'text', 'x')`),
    ).toBe('23514');
    expect(await code(`update messages set org_id = null where id = $1`, [officeIds[0]])).toBe(
      '23514',
    );
    const path = (
      await svc<{ p: string }>(`select storage_path as p from messages where id = $1`, [
        officeIds[0],
      ])
    )[0]!.p;
    expect(
      await code(
        `insert into messages (org_id, direction, type, storage_path) values ($1, 'in', 'image', $2)`,
        [DEMO_ORG_ID, path],
      ),
    ).toBe('23505');
    expect(
      await code(`insert into messages (org_id, direction, type) values ($1, 'in', 'image')`, [
        DEMO_ORG_ID,
      ]),
    ).toBe('ok');
  });
});

// Last: creates a stand-in for Supabase's storage schema, which every later upload would need.
describe('with the storage schema', () => {
  beforeAll(async () => {
    await db.exec(`
      create schema storage;
      create table storage.objects (
        id uuid primary key default gen_random_uuid(),
        bucket_id text not null,
        name text not null,
        owner uuid default auth.uid(),
        created_at timestamptz not null default now()
      );
      create function storage.foldername(name text) returns text[] language sql immutable as $$
        select (string_to_array(name, '/'))[1:array_length(string_to_array(name, '/'), 1) - 1]
      $$;
      alter table storage.objects enable row level security;
      grant usage on schema storage to authenticated;
      grant all on storage.objects to authenticated;
    `);
    // The migration's storage block, as Supabase runs it.
    const sql = readFileSync(join(MIGRATIONS_DIR, '20261013000005_office_photos.sql'), 'utf8');
    const block = /-- 2\. Storage[\s\S]*?\nend \$\$;/.exec(sql)?.[0];
    expect(block).toBeTruthy();
    await db.exec(block!);
  });

  const put = (user: string, name: string, bucket = 'photos') =>
    asUser(db, user, (q) =>
      q(`insert into storage.objects (bucket_id, name) values ($1, $2)`, [bucket, name]),
    ).then(
      () => 'ok',
      (err: Error) => err.message,
    );

  it('lets office roles upload under {org}/{site}/office/ of their org only', async () => {
    const ok = upload(riverside).path;
    expect(await put(LENA, ok)).toBe('ok');
    expect(await put(SAM, upload(oakmont).path)).toBe('ok');
    const rls = /row-level security/;
    expect(await put(ACCOUNTS, upload(riverside).path)).toMatch(rls);
    expect(await put(OUTSIDER, upload(riverside).path)).toMatch(rls);
    expect(await put(LENA, `${DEMO_ORG_ID}/${riverside}/2026-08-11/${randomUUID()}.jpg`)).toMatch(
      rls,
    );
    expect(await put(LENA, upload(riverside).path, 'pdfs')).toMatch(rls);
  });

  it('files a photo only once it is in the bucket', async () => {
    const date = '2026-08-11';
    const missing = upload(riverside);
    expect(await errorOf(() => officeReport(LENA, riverside, date, body(date), [missing]))).toBe(
      'photo not uploaded',
    );
    // Same name in another bucket does not count.
    expect(await put(LENA, missing.path, 'audio')).toMatch(/row-level security/);
    await svc(`insert into storage.objects (bucket_id, name) values ('audio', $1)`, [missing.path]);
    expect(await errorOf(() => officeReport(LENA, riverside, date, body(date), [missing]))).toBe(
      'photo not uploaded',
    );

    expect(await put(LENA, missing.path)).toBe('ok');
    const res = await officeReport(LENA, riverside, date, body(date), [missing]);
    expect(res.created).toBe(true);
    expect((await versionData(res.reportId, 1)).photos).toHaveLength(1);
  });

  it('lists office uploads never attached to a report, for the retention job', async () => {
    const date = '2026-08-12';
    const orphans = async (before = '2999-01-01T00:00:00Z') =>
      (
        await svc<{ name: string }>(`select name from list_orphan_office_photos($1, 500) name`, [
          before,
        ])
      ).map((r) => r.name);
    const already = await orphans();
    const attached = upload(riverside);
    const dropped = upload(riverside); // uploaded, then the call failed
    const fresh = upload(oakmont); // uploaded a moment ago: may still be filed
    const whatsapp = `${DEMO_ORG_ID}/${riverside}/${date}/${randomUUID()}.jpg`;
    for (const name of [attached.path, dropped.path])
      await svc(
        `insert into storage.objects (bucket_id, name, created_at) values ('photos', $1, $2)`,
        [name, '2026-08-12T10:00:00Z'],
      );
    await svc(`insert into storage.objects (bucket_id, name) values ('photos', $1)`, [fresh.path]);
    await svc(
      `insert into storage.objects (bucket_id, name, created_at) values ('photos', $1, $2), ('pdfs', $3, $2)`,
      [whatsapp, '2026-08-12T10:00:00Z', upload(riverside).path],
    );
    await officeReport(LENA, riverside, date, body(date), [attached]);

    const listed = await orphans(new Date(Date.now() - 3_600_000).toISOString());
    expect(listed).toContain(dropped.path);
    for (const name of [attached.path, fresh.path, whatsapp]) expect(listed).not.toContain(name);
    expect(listed.filter((n) => !already.includes(n))).toEqual([dropped.path]);
    // Every office object listed has no message (the earlier tests' refused uploads, say).
    const stored = await svc<{ n: number }>(
      `select count(*)::int as n from messages where storage_path = any($1::text[])`,
      [listed],
    );
    expect(stored[0]!.n).toBe(0);
    expect(await orphans('2026-08-12T09:00:00Z')).not.toContain(dropped.path);
    expect(
      await svc(`select * from list_orphan_office_photos('2999-01-01T00:00:00Z', 1)`),
    ).toHaveLength(1);
  });
});
