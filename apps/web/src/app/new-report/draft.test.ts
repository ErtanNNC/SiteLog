import { afterEach, describe, expect, it, vi } from 'vitest';
import { emptyReportDataV1 } from '@sitelog/shared/schemas/report.ts';
import { toFormValues } from '../report/reportForm';
import { newReportDraftKey, readNewReportDraft, writeNewReportDraft } from './draft';

const blank = toFormValues(emptyReportDataV1('2026-10-09'));
const key = newReportDraftKey('org-1', 'user-1');

afterEach(() => vi.restoreAllMocks());

describe('New report draft', () => {
  it('is kept per org and user, and read back as written', () => {
    expect(key).toBe('sitelog:new-report:org-1:user-1');
    const draft = {
      v: 1 as const,
      siteId: 'site-1',
      date: '2026-10-08',
      values: { ...blank, summary: 'Pour on level 3.' },
    };
    writeNewReportDraft(key, draft);
    expect(readNewReportDraft(key, blank)).toEqual(draft);
    writeNewReportDraft(key, null);
    expect(readNewReportDraft(key, blank)).toBeNull();
  });

  it('drops a draft that is not JSON or does not fit the form', () => {
    const put = (value: string) => window.sessionStorage.setItem(key, value);
    put('{not json');
    expect(readNewReportDraft(key, blank)).toBeNull();
    const ok = { v: 1, siteId: 's', date: '2026-10-08', values: blank };
    for (const bad of [
      { ...ok, v: 2 },
      { ...ok, date: 'yesterday' },
      { ...ok, siteId: 7 },
      { ...ok, values: { ...blank, manpower: 'none' } },
      { ...ok, values: { ...blank, safety: null } },
      { ...ok, values: { ...blank, summary: 3 } },
      null,
    ]) {
      put(JSON.stringify(bad));
      expect(readNewReportDraft(key, blank)).toBeNull();
    }
  });

  it('works without storage (private window, blocked site data)', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('QuotaExceededError');
    });
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('SecurityError');
    });
    expect(() =>
      writeNewReportDraft(key, { v: 1, siteId: 's', date: '2026-10-08', values: blank }),
    ).not.toThrow();
    expect(readNewReportDraft(key, blank)).toBeNull();
  });
});
