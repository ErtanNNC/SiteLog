import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  DailyReportDataSchema,
  emptyReportData,
  officePhotoStoragePath,
  type DailyReportData,
  type EvidencePackRow,
  type MessageRow,
} from '@sitelog/shared';
import type { PdfPhoto } from '@sitelog/pdf';
import { createHarness, ORG_ID, SITE_RIVERSIDE } from '../test/harness';
import { buildEvidencePackInput, buildReportPdfInput } from './render';

/**
 * A version's PDF shows that version's photos (data.photos): an office edit that removes a photo,
 * changes a caption or uploads a new one (20261013000005_office_photos.sql) changes the new
 * version's PDF only.
 */

const LENA = '00000000-0000-4000-8000-00000000e001';
const DATE = '2026-10-08';

async function setup() {
  const h = createHarness();
  const site = (await h.db.siteContext(SITE_RIVERSIDE))!;
  const day = await h.db.getOrCreateSiteDay(SITE_RIVERSIDE, DATE, new Date('2026-10-08T22:30:00Z'));
  const report = await h.db.insertReport({
    org_id: ORG_ID,
    site_id: SITE_RIVERSIDE,
    site_day_id: day.id,
    report_no: 'RL-2041-0190',
    reporter_id: h.marco.id,
    received_at: '2026-10-08T21:00:00Z',
    kind: 'daily',
    status: 'filed',
  });

  // A photo the site manager sent on WhatsApp, and two photos the office uploaded in the panel.
  const convo = await h.conversation('idle');
  const wa = await h.inbound(convo, {
    type: 'image',
    body: 'Level 2 deck',
    storage_path: `${ORG_ID}/${SITE_RIVERSIDE}/${DATE}/wa.jpg`,
    created_at: '2026-10-08T21:00:30Z',
  });
  const office = (caption: string | null, mime: 'image/png' | 'image/jpeg', at: string) => {
    const row: MessageRow = {
      id: randomUUID(),
      conversation_id: null,
      org_id: ORG_ID,
      direction: 'in',
      wa_message_id: null,
      type: 'image',
      body: caption,
      payload: { source: 'office_upload', uploaded_by: LENA },
      media_id: null,
      media_mime: mime,
      storage_path: officePhotoStoragePath(ORG_ID, SITE_RIVERSIDE, randomUUID(), mime),
      duration_s: null,
      template_name: null,
      status: 'received',
      error: null,
      created_at: at,
    };
    h.db.data.messages.set(row.id, row);
    return row;
  };
  const north = office('North wall', 'image/png', '2026-10-09T14:00:00Z');
  const stair = office(null, 'image/jpeg', '2026-10-09T14:05:00Z');
  for (const m of [wa, north, stair]) {
    await h.db.insertReportSource({
      report_id: report.id,
      message_id: m.id,
      kind: 'photo',
      caption: m.body,
      taken_at: m.created_at,
    });
    await h.storage.upload('photos', m.storage_path!, Buffer.from(m.id), m.media_mime!);
  }

  const base: DailyReportData = DailyReportDataSchema.parse({
    ...emptyReportData(DATE),
    summary: 'Deck formwork.',
    weather: {
      conditionsText: 'Rain',
      periods: [{ condition: 'Rain', lostHours: 2, source: [] }],
    },
  });
  const v1Data: DailyReportData = {
    ...base,
    photos: [
      { messageId: wa.id, caption: 'Level 2 deck', takenAt: wa.created_at },
      { messageId: north.id, caption: 'North wall', takenAt: north.created_at },
      { messageId: stair.id, takenAt: stair.created_at },
    ],
  };
  // Office edit: North wall removed, the stair photo captioned and moved first.
  const v2Data: DailyReportData = {
    ...base,
    photos: [
      { messageId: stair.id, caption: 'East stair', takenAt: stair.created_at },
      { messageId: wa.id, caption: 'Level 2 deck', takenAt: wa.created_at },
    ],
  };
  const v1 = await h.db.insertVersion({
    report_id: report.id,
    version: 1,
    data: v1Data,
    summary: v1Data.summary,
    author: 'agent',
  });
  const v2 = await h.db.insertVersion({
    report_id: report.id,
    version: 2,
    data: v2Data,
    summary: v2Data.summary,
    author: 'office_user',
    author_user_id: LENA,
    change_note: 'Photos updated',
  });
  const current = await h.db.updateReport(report.id, { current_version: 2 });
  return { h, site, report: current, wa, north, stair, v1, v2, v1Data, v2Data };
}

/** The worker embeds bytes; each stored photo here holds its message id. */
const bytesOf = (p: PdfPhoto) => ('data' in p ? Buffer.from(p.data).toString() : p.url);
const shown = (photos: PdfPhoto[]) => photos.map((p) => [bytesOf(p), p.caption, p.takenAt]);

describe('PDF photos follow the version', () => {
  it('prints each version with its own photos, order and captions', async () => {
    const { h, site, report, wa, north, stair, v1, v2, v1Data, v2Data } = await setup();

    const first = await buildReportPdfInput(h.ctx, { report, version: v1, site, data: v1Data });
    expect(shown(first.photos)).toEqual([
      [wa.id, 'Level 2 deck', wa.created_at],
      [north.id, 'North wall', north.created_at],
      [stair.id, null, stair.created_at],
    ]);

    const second = await buildReportPdfInput(h.ctx, { report, version: v2, site, data: v2Data });
    expect(shown(second.photos)).toEqual([
      [stair.id, 'East stair', stair.created_at],
      [wa.id, 'Level 2 deck', wa.created_at],
    ]);
    expect(second.report.version).toBe(2);
  });

  it('prints no photos for a version that lists none, and stops at the PDF maximum', async () => {
    const { h, site, report, v2, v1, v1Data, v2Data } = await setup();
    const none = await buildReportPdfInput(h.ctx, {
      report,
      version: v2,
      site,
      data: { ...v2Data, photos: [] },
    });
    expect(none.photos).toEqual([]);

    const two = await buildReportPdfInput(h.ctx, {
      report,
      version: v1,
      site: { ...site, settings: { ...site.settings, pdf_max_photos: 2 } },
      data: v1Data,
    });
    expect(two.photos).toHaveLength(2);
  });

  it('prints every photo of the report for legacy data without data.photos', async () => {
    const { h, site, report, v1, v1Data, wa, north, stair } = await setup();
    const { photos: _photos, ...legacy } = v1Data;
    void _photos;
    const input = await buildReportPdfInput(h.ctx, {
      report,
      version: v1,
      site,
      data: legacy as DailyReportData,
    });
    expect(shown(input.photos)).toEqual([
      [wa.id, 'Level 2 deck', wa.created_at],
      [north.id, 'North wall', north.created_at],
      [stair.id, null, stair.created_at],
    ]);
  });

  it('skips a photo whose file is gone and keeps the rest', async () => {
    const { h, site, report, v1, v1Data, north } = await setup();
    await h.storage.remove('photos', [north.storage_path!]);
    const input = await buildReportPdfInput(h.ctx, { report, version: v1, site, data: v1Data });
    expect(input.photos.map(bytesOf)).not.toContain(north.id);
    expect(input.photos).toHaveLength(2);
  });

  it('builds the evidence pack day from the current version’s photos', async () => {
    const { h, site, wa, stair } = await setup();
    const pack = {
      id: randomUUID(),
      org_id: ORG_ID,
      site_id: SITE_RIVERSIDE,
      period_start: '2026-10-05',
      period_end: '2026-10-09',
      status: 'queued',
      pdf_path: null,
      sections: [],
      error: null,
      created_by: null,
      created_at: '2026-10-10T00:00:00Z',
      ready_at: null,
    } as EvidencePackRow;
    const input = await buildEvidencePackInput(h.ctx, pack, site);
    expect(input.days).toHaveLength(1);
    const day = input.days[0]!;
    expect(day.version).toBe(2);
    expect(day.photoCount).toBe(2);
    expect(day.photos.map((p) => [bytesOf(p), p.caption])).toEqual([
      [stair.id, 'East stair'],
      [wa.id, 'Level 2 deck'],
    ]);
  });
});
