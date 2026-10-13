import { describe, expect, it } from 'vitest';
import { emptyReportData, type DailyReportData } from '@sitelog/shared/schemas/report.ts';
import { sameReportData } from './reportForm';

const base: DailyReportData = {
  ...emptyReportData('2026-10-09'),
  summary: 'Deck pour.',
  photos: [
    { messageId: 'm1', caption: 'Rebar mats', takenAt: '2026-10-09T14:00:00.000Z' },
    { messageId: 'm2', takenAt: '2026-10-09T15:00:00.000Z' },
  ],
};

describe('sameReportData', () => {
  it('ignores key order (zod’s parse reorders keys) and photo times (the server keeps them)', () => {
    const reordered = Object.fromEntries(Object.entries(base).reverse()) as DailyReportData;
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
