import { assert, assertEquals, assertNotEquals } from '@std/assert';
import {
  DEVICE_COOKIE_MAX_AGE_S,
  UPLOAD_MAX_BYTES,
  toCountryPack,
  type ConsentRow,
} from '@sitelog/shared';
import { DEMO_COUNTRIES } from '@sitelog/shared/demo/countries.ts';
import {
  allowedReportDates,
  clientIp,
  consentState,
  deviceVerified,
  fieldCountryView,
  fieldOrigins,
  historyStart,
  nearestDeadlineSite,
  needsConsent,
  newDeviceToken,
  newVerifyCode,
  originAllowed,
  questionManpowerIndex,
  questionOptions,
  retryAfterSeconds,
  scopeSites,
  storedObjectProblem,
  verifyCodeHash,
} from './logic.ts';

const bytesOf = (...values: number[]) => {
  let i = 0;
  return (n: number) => Uint8Array.from({ length: n }, () => values[i++ % values.length]!);
};

Deno.test('newVerifyCode: six digits, zero-padded, rejection-sampled', () => {
  assertEquals(newVerifyCode(bytesOf(0, 0, 0, 7)), '000007');
  // 0xFFFFFFFF is above the largest multiple of 10^6 and is drawn again.
  assertEquals(newVerifyCode(bytesOf(0xff, 0xff, 0xff, 0xff, 0, 0, 0x03, 0xe8)), '001000');
  for (let i = 0; i < 50; i++) {
    assert(/^\d{6}$/.test(newVerifyCode((n) => crypto.getRandomValues(new Uint8Array(n)))));
  }
});

Deno.test('newDeviceToken: 32 bytes as 43 base64url characters', () => {
  const t = newDeviceToken((n) => new Uint8Array(n).fill(0xfb));
  assertEquals(t.length, 43);
  assert(/^[A-Za-z0-9_-]+$/.test(t));
});

Deno.test('verifyCodeHash: keyed by the secret and bound to the device', async () => {
  const a = await verifyCodeHash('secret', 'device-1', '123456');
  assertEquals(a.length, 64);
  assertEquals(a, await verifyCodeHash('secret', 'device-1', '123456'));
  assertNotEquals(a, await verifyCodeHash('secret', 'device-2', '123456'));
  assertNotEquals(a, await verifyCodeHash('other', 'device-1', '123456'));
  assertNotEquals(a, await verifyCodeHash('secret', 'device-1', '123457'));
});

Deno.test('consentState and needsConsent: held, revoked, and the required pair', () => {
  const row = (type: ConsentRow['type'], revoked: string | null): ConsentRow => ({
    id: crypto.randomUUID(),
    reporter_id: 'r',
    type,
    method: 'web_checkbox',
    text_version: 'v1',
    evidence: null,
    given_at: '2026-10-01T00:00:00Z',
    revoked_at: revoked,
  });
  const s = consentState([
    row('recording', null),
    row('sms', '2026-10-02T00:00:00Z'),
    row('auto_call', '2026-10-02T00:00:00Z'),
    row('auto_call', null),
  ]);
  assertEquals([...s.held].sort(), ['auto_call', 'recording']);
  assertEquals([...s.revoked], ['sms']);
  assertEquals(needsConsent(s.held), true);
  assertEquals(needsConsent(new Set(['recording', 'data_processing'])), false);
});

Deno.test('fieldCountryView: the pack subset, never the sender or a provider', () => {
  const tr = toCountryPack(DEMO_COUNTRIES.find((c) => c.code === 'TR')!);
  const view = fieldCountryView({ ...tr, smsSenderId: 'SITELOG' });
  assertEquals(view, {
    code: 'TR',
    voiceNumber: null,
    fieldLocales: ['tr-TR', 'en-US'],
    twoWaySms: false,
    messageChannels: ['sms'],
    legalKeys: {},
  });
  assert(!JSON.stringify(view).includes('SITELOG'));
});

Deno.test('scopeSites: a personal link covers every site, a daily link its own', () => {
  const sites = [{ id: 'a' }, { id: 'b' }];
  assertEquals(scopeSites({ site_id: null }, sites), sites);
  assertEquals(scopeSites({ site_id: 'b' }, sites), [{ id: 'b' }]);
  assertEquals(scopeSites({ site_id: 'z' }, sites), []);
});

Deno.test(
  'allowedReportDates: the link date; else today, and before noon the previous working day',
  () => {
    const site = { timezone: 'America/Chicago' };
    // Mon Oct 12, 08:00 in Chicago: today and Friday.
    const mon = new Date('2026-10-12T13:00:00Z');
    assertEquals(allowedReportDates({ report_date: null }, site, mon, [1, 2, 3, 4, 5]), [
      '2026-10-12',
      '2026-10-09',
    ]);
    // 11:59 still asks; from 12:00 site time today only (F5).
    assertEquals(
      allowedReportDates({ report_date: null }, site, new Date('2026-10-12T16:59:00Z'), null),
      ['2026-10-12', '2026-10-09'],
    );
    assertEquals(
      allowedReportDates({ report_date: null }, site, new Date('2026-10-12T17:00:00Z'), null),
      ['2026-10-12'],
    );
    // A six-day org: Saturday is the working day before Monday.
    assertEquals(allowedReportDates({ report_date: null }, site, mon, [1, 2, 3, 4, 5, 6]), [
      '2026-10-12',
      '2026-10-10',
    ]);
    // Noon in the site's zone, not the server's: 10:00 in Istanbul is 07:00 UTC.
    assertEquals(
      allowedReportDates(
        { report_date: null },
        { timezone: 'Europe/Istanbul' },
        new Date('2026-10-13T07:00:00Z'),
        null,
      ),
      ['2026-10-13', '2026-10-12'],
    );
    assertEquals(allowedReportDates({ report_date: '2026-10-09' }, site, mon, null), [
      '2026-10-09',
    ]);
    // 01:30 UTC on Oct 13 is still Oct 12 (20:30) in Chicago.
    assertEquals(
      allowedReportDates({ report_date: null }, site, new Date('2026-10-13T01:30:00Z'), null),
      ['2026-10-12'],
    );
  },
);

Deno.test('deviceVerified: from verification for 180 days, never once revoked', () => {
  const at = '2026-01-01T00:00:00.000Z';
  const t = (ms: number) => new Date(new Date(at).getTime() + ms);
  const max = DEVICE_COOKIE_MAX_AGE_S * 1000;
  assertEquals(deviceVerified({ verified_at: at, revoked_at: null }, t(max - 1)), true);
  assertEquals(deviceVerified({ verified_at: at, revoked_at: null }, t(max)), false);
  assertEquals(deviceVerified({ verified_at: null, revoked_at: null }, t(0)), false);
  assertEquals(deviceVerified({ verified_at: at, revoked_at: at }, t(1)), false);
});

Deno.test('storedObjectProblem: there, of the named base type, within 50 MB', () => {
  assertEquals(storedObjectProblem('audio/webm', null), 'upload_missing');
  assertEquals(
    storedObjectProblem('audio/webm', { contentType: 'audio/webm;codecs=opus', size: 10 }),
    null,
  );
  assertEquals(storedObjectProblem('audio/webm', { contentType: 'Audio/WebM', size: 10 }), null);
  assertEquals(
    storedObjectProblem('image/jpeg', { contentType: 'text/html', size: 10 }),
    'media_type_not_allowed',
  );
  assertEquals(
    storedObjectProblem('image/jpeg', { contentType: null, size: 10 }),
    'media_type_not_allowed',
  );
  assertEquals(
    storedObjectProblem('audio/mp4', { contentType: 'audio/mp4', size: UPLOAD_MAX_BYTES }),
    null,
  );
  assertEquals(
    storedObjectProblem('audio/mp4', { contentType: 'audio/mp4', size: UPLOAD_MAX_BYTES + 1 }),
    'upload_too_large',
  );
  assertEquals(
    storedObjectProblem('audio/mp4', { contentType: 'audio/mp4', size: null }),
    'upload_too_large',
  );
});

Deno.test('nearestDeadlineSite: the deadline nearest now (F14)', () => {
  const now = new Date('2026-10-09T22:00:00Z'); // 17:00 Chicago, 01:00 Istanbul (Oct 10)
  const sites = [
    { id: 'early', timezone: 'America/Chicago', deadline: '12:00:00' },
    { id: 'soon', timezone: 'America/Chicago', deadline: '17:30:00' },
    { id: 'late', timezone: 'America/Chicago', deadline: null }, // org default 19:00
  ];
  assertEquals(nearestDeadlineSite(sites, { default_deadline: '19:00:00' }, now)?.id, 'soon');
  assertEquals(nearestDeadlineSite([], null, now), null);
});

Deno.test('historyStart: 14 days including today, in the site time zone', () => {
  assertEquals(historyStart(new Date('2026-10-23T03:00:00Z'), 'America/Chicago', 14), '2026-10-09');
  assertEquals(historyStart(new Date('2026-10-23T03:00:00Z'), 'Europe/Istanbul', 14), '2026-10-10');
});

Deno.test('origins: FIELD_APP_URL and CORS_EXTRA_ORIGINS; no Origin header is fine', () => {
  const allowed = fieldOrigins(
    'https://go.sitelog.app/',
    ' https://pr-1--field.netlify.app , not a url,',
  );
  assertEquals(allowed, ['https://go.sitelog.app', 'https://pr-1--field.netlify.app']);
  assertEquals(originAllowed(undefined, allowed), true);
  assertEquals(originAllowed('https://go.sitelog.app', allowed), true);
  assertEquals(originAllowed('https://evil.test', allowed), false);
  assertEquals(fieldOrigins(undefined, undefined), []);
});

Deno.test('questionOptions keeps {id,label} entries only', () => {
  assertEquals(questionOptions([{ id: 'a', label: '4' }, 'x', { id: 1, label: 'y' }]), [
    { id: 'a', label: '4' },
  ]);
  assertEquals(questionOptions(['4', '5']), null);
  assertEquals(questionOptions(null), null);
});

Deno.test('questionManpowerIndex: the crew a question names, else null (W1-13)', () => {
  assertEquals(questionManpowerIndex({ manpowerIndex: 2, path: 'manpower.workers:Apex' }), 2);
  assertEquals(questionManpowerIndex({ manpowerIndex: 0 }), 0);
  assertEquals(questionManpowerIndex({ manpowerIndex: -1 }), null);
  assertEquals(questionManpowerIndex({ manpowerIndex: '1' }), null);
  assertEquals(questionManpowerIndex({ path: 'safety' }), null);
  assertEquals(questionManpowerIndex(null), null);
  assertEquals(questionManpowerIndex([1]), null);
});

Deno.test('clientIp and retryAfterSeconds', () => {
  assertEquals(
    clientIp(new Headers({ 'x-forwarded-for': '203.0.113.9, 10.0.0.1' })),
    '203.0.113.9',
  );
  assertEquals(
    clientIp(
      new Headers({ 'x-nf-client-connection-ip': '198.51.100.7', 'x-forwarded-for': '1.1.1.1' }),
    ),
    '198.51.100.7',
  );
  assertEquals(clientIp(new Headers()), null);
  const now = new Date('2026-10-09T22:00:00Z');
  assertEquals(retryAfterSeconds('2026-10-09T22:00:30.200Z', now), 31);
  assertEquals(retryAfterSeconds('2026-10-09T21:00:00Z', now), 1);
});
