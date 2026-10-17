import { describe, expect, it } from 'vitest';
import { groupBySite, inProgress, statusChip, type HistoryRow } from './status';

const row = (id: string, siteId: string, date: string): HistoryRow => ({
  id,
  reportNo: id,
  status: 'filed',
  siteId,
  siteName: siteId.toUpperCase(),
  date,
  filedAt: null,
  currentVersion: 1,
  isLate: false,
});

describe('Past reports helpers (W2-03)', () => {
  it('groups per site in the order of each site’s newest report', () => {
    const groups = groupBySite([
      row('a', 's2', '2026-10-09'),
      row('b', 's1', '2026-10-09'),
      row('c', 's2', '2026-10-08'),
    ]);
    expect(groups.map((g) => [g.siteName, g.rows.map((r) => r.id)])).toEqual([
      ['S2', ['a', 'c']],
      ['S1', ['b']],
    ]);
  });

  it('gives each status a chip, and tells the reports still in progress', () => {
    expect(statusChip('filed').chip).toContain('chip-filed');
    expect(statusChip('signed_off').chip).toContain('chip-filed');
    expect(statusChip('awaiting_answer').chip).toContain('chip-await');
    expect(statusChip('processing').chip).toContain('chip-review');
    expect(inProgress('awaiting_confirmation')).toBe(true);
    expect(inProgress('filed')).toBe(false);
    expect(inProgress('void')).toBe(false);
  });
});
