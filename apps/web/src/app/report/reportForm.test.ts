import { describe, expect, it } from 'vitest';
import { emptyReportDataV1, type DailyReportDataV1 } from '@sitelog/shared/schemas/report.ts';
import { readReportData } from '@sitelog/shared/report/upgrade.ts';
import { sameReportData, toFormValues, toReportData, withPhotoEntries } from './reportForm';

const base: DailyReportDataV1 = {
  ...emptyReportDataV1('2026-10-09'),
  summary: 'Deck pour.',
  photos: [
    { messageId: 'm1', caption: 'Rebar mats', takenAt: '2026-10-09T14:00:00.000Z' },
    { messageId: 'm2', takenAt: '2026-10-09T15:00:00.000Z' },
  ],
};

describe('sameReportData', () => {
  it('ignores key order (zod’s parse reorders keys) and photo times (the server keeps them)', () => {
    const reordered = Object.fromEntries(Object.entries(base).reverse()) as DailyReportDataV1;
    expect(sameReportData(reordered, base)).toBe(true);
    const retimed = { ...base, photos: base.photos.map((p) => ({ ...p, takenAt: '' })) };
    expect(sameReportData(retimed, base)).toBe(true);
  });

  it('counts a removed, reordered or re-captioned photo as a change', () => {
    expect(sameReportData({ ...base, photos: [base.photos[1]!] }, base)).toBe(false);
    expect(sameReportData({ ...base, photos: [...base.photos].reverse() }, base)).toBe(false);
    expect(
      sameReportData(
        { ...base, photos: [base.photos[0]!, { ...base.photos[1]!, caption: 'Slab edge' }] },
        base,
      ),
    ).toBe(false);
    // A blank caption is no caption.
    expect(
      sameReportData(
        { ...base, photos: [base.photos[0]!, { ...base.photos[1]!, caption: '  ' }] },
        base,
      ),
    ).toBe(true);
  });
});

describe('office edits write report data v2 (W1-12)', () => {
  it('edits a stored v1 version through its v2 view into a v2 version', () => {
    const v1: DailyReportDataV1 = {
      ...emptyReportDataV1('2026-10-02'),
      summary: 'Framing.',
      manpower: [
        {
          companyId: 'apex',
          companyNameHeard: 'Apex',
          companyName: 'Apex Concrete',
          workers: 4,
          hoursPerWorker: 8,
          totalHours: 32,
          hoursBasis: 'reply',
          confidence: 1,
          source: [{ type: 'audio', messageId: 'm1', start: 3 }],
        },
      ],
      photos: [{ messageId: 'p1', takenAt: '2026-10-02T20:00:00Z' }],
    };
    const base = withPhotoEntries(readReportData(v1), [
      { messageId: 'p1', takenAt: '2026-10-02T20:00:00Z' },
    ]);
    const values = toFormValues(base);
    values.manpower[0]!.workers = '5';
    const out = toReportData(values, base, {
      userId: 'u1',
      at: '2026-10-03T12:00:00Z',
      companies: [{ id: 'apex', name: 'Apex Concrete', trade: 'Concrete' } as never],
    });
    expect(out).toMatchObject({ schemaVersion: 2, reportLanguage: 'en', units: 'imperial' });
    expect(out.manpower[0]).toMatchObject({
      workers: 5,
      totalHours: 40,
      hoursBasis: 'office_edit',
    });
    expect(out.manpower[0]!.source).toEqual([
      { type: 'voice_note', uploadId: 'm1', start: 3 },
      { type: 'office_edit', userId: 'u1', at: '2026-10-03T12:00:00Z' },
    ]);
    expect(out.photos).toEqual([{ uploadId: 'p1', takenAt: '2026-10-02T20:00:00Z' }]);
  });
});
