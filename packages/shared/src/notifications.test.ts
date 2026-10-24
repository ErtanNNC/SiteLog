import { describe, expect, it } from 'vitest';
import { kestrelDemo } from './demo/kestrel.ts';
import { optOutNotification } from './sms/inbound.ts';
import { NOTICE_KEYS, noticeData, parseNoticeData } from './notifications.ts';

describe('notice data (notifications.data, 20261015000080)', () => {
  it('parses what the producers write', () => {
    const late = noticeData('late_upload', {
      site: 'Riverside',
      media: 'audio',
      date: '2026-10-26',
      reporter: null,
      reportNo: 'RL-2041-0190',
    });
    expect(parseNoticeData(JSON.parse(JSON.stringify(late)))).toEqual(late);
    expect(parseNoticeData({ key: 'unknown_contact', params: {} })).toEqual({
      key: 'unknown_contact',
      params: {},
    });
  });

  it('reads no data, an unknown key or bad values as null (the stored English text shows)', () => {
    expect(parseNoticeData(null)).toBeNull();
    expect(parseNoticeData(undefined)).toBeNull();
    expect(parseNoticeData({ key: 'from_the_future', params: {} })).toBeNull();
    expect(
      parseNoticeData({ key: 'missing_report', params: { site: 'Elm', first: 3 } }),
    ).toBeNull();
    expect(
      parseNoticeData({
        key: 'pack_ready',
        params: { site: 'Elm', from: 'Sep 1', to: '2026-09-30' },
      }),
    ).toBeNull();
  });

  it('lists every key once', () => {
    expect(new Set(NOTICE_KEYS).size).toBe(NOTICE_KEYS.length);
    expect(NOTICE_KEYS).toContain('late_upload');
    expect(NOTICE_KEYS).toContain('missing_report');
  });

  it('gives a STOP notice its data, with the phone formatted', () => {
    const n = optOutNotification({ orgId: 'o', name: 'Marco Ruiz', phone: '+15550143378' });
    expect(n.data).toEqual({
      key: 'reporter_stop',
      params: { name: 'Marco Ruiz', phone: '+1 555 014 3378' },
    });
  });

  it('gives every Kestrel demo notice valid data', () => {
    const d = kestrelDemo();
    expect(d.notifications.length).toBeGreaterThan(0);
    for (const n of d.notifications) {
      const data = parseNoticeData(n.data);
      expect(data, n.kind).not.toBeNull();
    }
  });
});
