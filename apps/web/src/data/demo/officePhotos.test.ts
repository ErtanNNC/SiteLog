import { describe, expect, it } from 'vitest';
import { emptyReportDataV1, type DailyReportDataV1 } from '@sitelog/shared/schemas/report.ts';
import { storedV1 } from '@/test/storedData';
import { DemoSource } from './DemoSource';
import { DemoStore, demoUserFor } from './store';

/**
 * Photos the office uploads in the panel, in demo mode: DemoStore mirrors
 * create_office_report / create_report_version with p_photos (20261013000005_office_photos.sql)
 * and DemoSource keeps the uploads as object URLs. Every view shows the photos the viewed
 * version lists.
 */
const lena = demoUserFor('admin');

function setup() {
  const store = new DemoStore();
  const source = new DemoSource(store, {
    id: lena.id,
    email: lena.email,
    name: lena.name,
    role: lena.role,
  });
  const elm = store.data.sites.find((s) => s.project_code === 'ES-0377')!;
  const upload = (siteId = elm.id) =>
    source.uploadReportPhoto(siteId, new Blob(['jpeg'], { type: 'image/jpeg' }), 'image/jpeg');
  return { store, source, elm, upload };
}

const typed = (summary = 'Framing on units 3 and 4.'): DailyReportDataV1 => ({
  ...emptyReportDataV1('2026-10-09'),
  summary,
});

describe('demo: photos on a report typed in the panel', () => {
  it('files the uploads as org-level image messages + photo sources, listed by version 1', async () => {
    const { store, source, elm, upload } = setup();
    const a = await upload();
    const b = await upload();
    expect(a.path).toMatch(
      new RegExp(`^${store.data.org.id}/${elm.id}/office/[0-9a-f-]{36}\\.jpg$`),
    );
    const { reportId, created } = await source.createOfficeReport({
      siteId: elm.id,
      date: '2026-10-09',
      // Anything the client lists itself is replaced by the uploads.
      data: { ...typed(), photos: [{ messageId: 'bogus', takenAt: '2026-10-09T10:00:00Z' }] },
      photos: [
        {
          path: a.path,
          mime: 'image/jpeg',
          caption: '  North wall  ',
          takenAt: '2026-10-09T15:00:00Z',
        },
        // A camera clock ahead of the filing time is capped at "now".
        { path: b.path, mime: 'image/jpeg', caption: '', takenAt: '2030-01-01T00:00:00Z' },
      ],
    });
    expect(created).toBe(true);

    const messages = store.data.messages.filter((m) => m.storage_path?.includes('/office/'));
    expect(messages).toEqual([
      expect.objectContaining({
        conversation_id: null,
        org_id: store.data.org.id,
        direction: 'in',
        type: 'image',
        body: 'North wall',
        media_mime: 'image/jpeg',
        storage_path: a.path,
        status: 'received',
        payload: { source: 'office_upload', uploaded_by: lena.id },
      }),
      expect.objectContaining({ body: null, storage_path: b.path }),
    ]);
    const sources = store.data.sources.filter((s) => s.report_id === reportId);
    expect(sources.map((s) => [s.kind, s.caption, s.taken_at])).toEqual([
      ['photo', 'North wall', '2026-10-09T15:00:00.000Z'],
      ['photo', null, store.nowIso()],
    ]);
    const v1 = store.data.versions.find((v) => v.report_id === reportId)!
      .data as unknown as DailyReportDataV1;
    expect(v1.photos).toEqual([
      { messageId: messages[0]!.id, caption: 'North wall', takenAt: '2026-10-09T15:00:00.000Z' },
      { messageId: messages[1]!.id, takenAt: store.nowIso() },
    ]);
    expect(store.data.audit).toContainEqual(
      expect.objectContaining({
        action: 'report.filed',
        entity_id: reportId,
        diff: expect.objectContaining({ trigger: 'office_entry', photos: 2 }),
      }),
    );

    // The report page and its PDF read them with the session's object URLs.
    const detail = await source.getReportDetail(reportId);
    expect(detail.photos).toEqual([
      {
        messageId: messages[0]!.id,
        storagePath: a.path,
        mime: 'image/jpeg',
        url: expect.stringMatching(/^blob:/),
        caption: 'North wall',
        takenAt: '2026-10-09T15:00:00.000Z',
      },
      expect.objectContaining({ storagePath: b.path, caption: null, takenAt: store.nowIso() }),
    ]);
    const site = await source.getSiteDetail(elm.id, '2026-10');
    expect(site.photos!.filter((p) => p.reportId === reportId).map((p) => p.caption)).toEqual([
      'North wall',
      null,
    ]);
    expect(site.photos!.every((p) => p.reportId !== reportId || p.url)).toBe(true);
  });

  it('refuses uploads that are not this site’s, not uploaded, already attached or too many', async () => {
    const { store, source, elm, upload } = setup();
    const riverside = store.data.sites.find((s) => s.project_code === 'RL-2041')!;
    const before = store.data.reports.length;
    const file = (photos: Parameters<DemoSource['createOfficeReport']>[0]['photos']) =>
      source.createOfficeReport({ siteId: elm.id, date: '2026-10-09', data: typed(), photos });

    const other = await upload(riverside.id);
    await expect(file([{ path: other.path, mime: 'image/jpeg' }])).rejects.toThrow(
      'unexpected photo path',
    );
    const missing = `${store.data.org.id}/${elm.id}/office/0b6a51c8-3d0e-4b8e-9f3a-2f1d7c9e4a10.jpg`;
    await expect(file([{ path: missing, mime: 'image/jpeg' }])).rejects.toThrow(
      'photo not uploaded',
    );
    const ok = await upload();
    await expect(file([{ path: ok.path, mime: 'image/png' }])).rejects.toThrow(
      'photo type does not match its file name',
    );
    await expect(file([{ path: ok.path, mime: 'image/jpeg', takenAt: 'soon' }])).rejects.toThrow(
      'invalid photo time',
    );
    const many = await Promise.all(Array.from({ length: 21 }, () => upload()));
    await expect(file(many.map((u) => ({ path: u.path, mime: u.mime })))).rejects.toThrow(
      'at most 20 photos at a time',
    );
    // Nothing was written by a refused call.
    expect(store.data.reports).toHaveLength(before);
    expect(store.data.messages.some((m) => m.org_id)).toBe(false);

    await file([{ path: ok.path, mime: 'image/jpeg' }]);
    const { reportId } = await source.createOfficeReport({
      siteId: elm.id,
      // Before the demo history starts: a day with no report yet.
      date: '2026-09-14',
      data: typed(),
      photos: [],
    });
    const v1 = storedV1(await source.getReportDetail(reportId));
    await expect(
      source.createReportVersion(reportId, v1, 'Again', [{ path: ok.path, mime: 'image/jpeg' }]),
    ).rejects.toThrow('photo already attached');
  });
});

describe('demo: an office edit keeps, re-captions, removes and adds photos', () => {
  it('lists the kept photos in the order sent, then the new ones; older versions keep theirs', async () => {
    const { store, source, elm, upload } = setup();
    const [a, b, c] = [await upload(), await upload(), await upload()];
    const { reportId } = await source.createOfficeReport({
      siteId: elm.id,
      date: '2026-10-09',
      data: typed(),
      photos: [
        { path: a.path, mime: 'image/jpeg', caption: 'A', takenAt: '2026-10-09T14:00:00Z' },
        { path: b.path, mime: 'image/jpeg', caption: 'B', takenAt: '2026-10-09T15:00:00Z' },
      ],
    });
    const v1 = storedV1(await source.getReportDetail(reportId));
    const [pa, pb] = v1.photos;

    // Drop A, re-caption B (its time stays the recorded one, whatever is sent), add C.
    const { version } = await source.createReportVersion(
      reportId,
      {
        ...v1,
        photos: [
          { ...pb!, caption: 'B, east side', takenAt: '2026-01-01T00:00:00Z' },
          { ...pb!, caption: 'repeat' },
          { messageId: 'not-a-photo-of-this-report', takenAt: '2026-10-09T15:00:00Z' },
        ],
      },
      'Swapped the photo',
      [{ path: c.path, mime: 'image/jpeg', caption: 'C', takenAt: '2026-10-09T16:00:00Z' }],
    );
    expect(version).toBe(2);
    const v2 = await source.getReportDetail(reportId);
    expect(v2.photos.map((p) => [p.caption, p.takenAt])).toEqual([
      ['B, east side', '2026-10-09T15:00:00.000Z'],
      ['C', '2026-10-09T16:00:00.000Z'],
    ]);
    // The v2 view keeps each photo's message UUID as its uploadId.
    expect(v2.data.photos.map((p) => p.uploadId)).toEqual([pb!.messageId, v2.photos[1]!.messageId]);
    expect(store.data.audit).toContainEqual(
      expect.objectContaining({
        action: 'report.version_created',
        entity_id: reportId,
        diff: expect.objectContaining({
          version: 2,
          photos: 2,
          photos_added: 1,
          photos_removed: 1,
        }),
      }),
    );

    // Version 1 still shows A and B with their captions.
    const old = await source.getReportDetail(reportId, 1);
    expect(old.photos.map((p) => p.caption)).toEqual(['A', 'B']);
    // The Photos tab shows the current version only.
    const site = await source.getSiteDetail(elm.id, '2026-10');
    expect(site.photos!.filter((p) => p.reportId === reportId).map((p) => p.caption)).toEqual([
      'B, east side',
      'C',
    ]);

    // A cleared caption stays cleared (no fallback to the message text), and removing every
    // photo is an edit of its own.
    await source.createReportVersion(
      reportId,
      {
        ...storedV1(v2),
        photos: [{ messageId: pa!.messageId, caption: '', takenAt: pa!.takenAt }],
      },
      'Back to A, no caption',
    );
    const v3 = await source.getReportDetail(reportId);
    expect(v3.photos.map((p) => [p.messageId, p.caption])).toEqual([[pa!.messageId, null]]);
    await source.createReportVersion(reportId, { ...storedV1(v3), photos: [] }, 'No photos');
    expect((await source.getReportDetail(reportId)).photos).toEqual([]);
  });

  it('places new uploads at their positions, as create_report_version does', async () => {
    const { source, elm, upload } = setup();
    const [a, b, c, d] = [await upload(), await upload(), await upload(), await upload()];
    const { reportId } = await source.createOfficeReport({
      siteId: elm.id,
      date: '2026-10-09',
      data: typed(),
      photos: [
        { path: a.path, mime: 'image/jpeg', caption: 'A', position: 1 },
        { path: b.path, mime: 'image/jpeg', caption: 'B', position: 0 },
      ],
    });
    const v1 = await source.getReportDetail(reportId);
    expect(v1.photos.map((p) => p.caption)).toEqual(['B', 'A']);
    await source.createReportVersion(reportId, storedV1(v1), 'Two more, one first', [
      { path: c.path, mime: 'image/jpeg', caption: 'C' },
      { path: d.path, mime: 'image/jpeg', caption: 'D', position: 0 },
    ]);
    expect((await source.getReportDetail(reportId)).photos.map((p) => p.caption)).toEqual([
      'D',
      'B',
      'A',
      'C',
    ]);
    await expect(
      source.createReportVersion(reportId, storedV1(v1), 'Bad', [
        { path: (await upload()).path, mime: 'image/jpeg', position: -1 },
      ]),
    ).rejects.toThrow('invalid photo position');
  });

  it('finds the report a site-day already has (New report checks before uploading)', async () => {
    const { store, source, elm } = setup();
    const hero = store.data.reports.find((r) => r.report_no === 'RL-2041-0187')!;
    expect(await source.findDayReport(hero.site_id, '2026-10-09')).toEqual({
      reportId: hero.id,
      reportNo: 'RL-2041-0187',
    });
    expect(await source.findDayReport(elm.id, '2026-08-01')).toBeNull();
  });

  it('shows every photo source with the message text as caption for data without a photo list', async () => {
    const { store, source } = setup();
    const hero = store.data.reports.find((r) => r.report_no === 'RL-2041-0187')!;
    const current = await source.getReportDetail(hero.id);
    expect(current.photos.map((p) => p.caption)).toEqual(
      current.data.photos.map((p) => p.caption ?? null),
    );
    // Legacy data: no `photos` key at all.
    const row = store.data.versions.find(
      (v) => v.report_id === hero.id && v.version === hero.current_version,
    )!;
    const { photos: _drop, ...legacy } = row.data as unknown as DailyReportDataV1;
    row.data = legacy as unknown as typeof row.data;
    for (const s of store.data.sources) if (s.report_id === hero.id) s.caption = null;
    const d = await source.getReportDetail(hero.id);
    const photoSources = store.data.sources.filter(
      (s) => s.report_id === hero.id && s.kind === 'photo',
    );
    expect(d.photos.map((p) => p.messageId)).toEqual(photoSources.map((s) => s.message_id));
    expect(d.photos.map((p) => p.caption)).toEqual(
      photoSources.map((s) => store.data.messages.find((m) => m.id === s.message_id)!.body),
    );
  });
});
