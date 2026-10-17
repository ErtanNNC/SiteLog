import { assert, assertEquals, assertNotEquals } from '@std/assert';
import {
  DEVICE_COOKIE_MAX_AGE_S,
  UPLOAD_MAX_BYTES,
  toCountryPack,
  type ConsentRow,
} from '@sitelog/shared';
import { DEMO_COUNTRIES } from '@sitelog/shared/demo/countries.ts';
import {
  correctionView,
  openCorrectionView,
  allowedReportDates,
  lateClipAllowed,
  reportWindowEnd,
  clientIp,
  consentState,
  dayOffPlan,
  deviceVerified,
  fieldCountryView,
  fieldOrigins,
  filedPhotosUntil,
  historyStart,
  linkMayAddPhotos,
  nearestDeadlineSite,
  needsConsent,
  newDeviceToken,
  newVerifyCode,
  originAllowed,
  questionManpowerIndex,
  questionOptions,
  retryAfterSeconds,
  scopeSites,
  settingsView,
  storedObjectProblem,
  textsOptedOut,
  verifyCodeHash,
  voiceAnswerView,
  lastVoiceAnswerView,
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
    messageChannels: ['push', 'whatsapp', 'sms'],
    legalKeys: {},
  });
  assert(!JSON.stringify(view).includes('SITELOG'));
  // Nor the WhatsApp sender or its templates (W2-15).
  const wa = fieldCountryView({ ...tr, whatsappSenderId: '+905320000099' as never });
  assert(!JSON.stringify(wa).includes('905320000099'));
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

Deno.test('reportWindowEnd and lateClipAllowed (spec §19 Q53)', () => {
  const site = { timezone: 'America/Chicago' };
  const weekdays = [1, 2, 3, 4, 5];
  // Thursday's window ends Friday at noon; Friday's ends Monday at noon; Saturday's at its end.
  assertEquals(
    reportWindowEnd('2026-10-08', site, weekdays).toISOString(),
    '2026-10-09T17:00:00.000Z',
  );
  assertEquals(reportWindowEnd('2026-10-09', site, null).toISOString(), '2026-10-12T17:00:00.000Z');
  assertEquals(
    reportWindowEnd('2026-10-10', site, weekdays).toISOString(),
    '2026-10-11T05:00:00.000Z',
  );
  const personal = { report_date: null };
  const fridayEvening = '2026-10-10T01:30:00Z'; // Fri Oct 9, 20:30 Chicago
  const tuesday = new Date('2026-10-13T15:00:00Z');
  assertEquals(
    lateClipAllowed(personal, site, '2026-10-09', fridayEvening, tuesday, weekdays),
    true,
  );
  // Past Monday noon + 48 h.
  assertEquals(
    lateClipAllowed(
      personal,
      site,
      '2026-10-09',
      fridayEvening,
      new Date('2026-10-14T17:01:00Z'),
      weekdays,
    ),
    false,
  );
  // No recording time, a bad one, a future one, a daily link.
  assertEquals(lateClipAllowed(personal, site, '2026-10-09', null, tuesday, weekdays), false);
  assertEquals(lateClipAllowed(personal, site, '2026-10-09', 'soon', tuesday, weekdays), false);
  assertEquals(
    lateClipAllowed(personal, site, '2026-10-09', '2026-10-13T16:00:00Z', tuesday, weekdays),
    false,
  );
  assertEquals(
    lateClipAllowed(
      { report_date: '2026-10-09' },
      site,
      '2026-10-08',
      fridayEvening,
      tuesday,
      weekdays,
    ),
    false,
  );
  // "Yesterday" picked Monday 11:00 for Friday, sent Monday 14:00.
  assertEquals(
    lateClipAllowed(
      personal,
      site,
      '2026-10-09',
      '2026-10-12T16:00:00Z',
      new Date('2026-10-12T19:00:00Z'),
      weekdays,
    ),
    true,
  );
});

Deno.test('settingsView: the built channels, and every consent given with its state (F15)', () => {
  const us = toCountryPack(DEMO_COUNTRIES.find((c) => c.code === 'US')!);
  const view = settingsView(
    { contact_pref: 'call', locale: 'es-US', message_channel: null },
    { ...us, messageChannels: ['whatsapp', 'sms'] },
    [
      { type: 'recording', revoked_at: null },
      { type: 'sms', revoked_at: '2026-10-09T22:00:00Z' },
      { type: 'data_processing', revoked_at: null },
      // Given again after a revocation: held.
      { type: 'recording', revoked_at: '2026-10-01T00:00:00Z' },
    ],
    false,
  );
  assertEquals(view, {
    contactPref: 'call',
    locale: 'es-US',
    messageChannel: null,
    // W2-15: WhatsApp is built, and its consent listed for Turn on where the pack lists it.
    messageChannels: ['whatsapp', 'sms'],
    consents: [
      { type: 'sms', held: false },
      { type: 'recording', held: true },
      { type: 'data_processing', held: true },
      { type: 'whatsapp', held: false },
    ],
    textsOptedOut: false,
    push: { offered: false, on: false },
    placesCalls: false,
    noCallsUntil: null,
  });
});

Deno.test(
  'settingsView W3-17: the automated-call row where calls are placed, and "not today"',
  () => {
    const us = toCountryPack(DEMO_COUNTRIES.find((c) => c.code === 'US')!);
    const given = [
      { type: 'recording', revoked_at: null },
      { type: 'data_processing', revoked_at: null },
    ] as const;
    const reporter = {
      contact_pref: 'call',
      locale: 'en-US',
      message_channel: null,
      no_calls_until: '2026-10-13T05:00:00.000Z',
    } as const;
    const placed = settingsView(reporter, us, given, false, undefined, true);
    assertEquals(placed.placesCalls, true);
    assertEquals(placed.noCallsUntil, '2026-10-13T05:00:00.000Z');
    assertEquals(
      placed.consents.find((c) => c.type === 'auto_call'),
      {
        type: 'auto_call',
        held: false,
      },
    );
    // No calls placed: no row, unless the consent is still held (Turn off stays possible).
    const none = settingsView(reporter, us, given, false, undefined, false);
    assertEquals(none.placesCalls, false);
    assertEquals(
      none.consents.some((c) => c.type === 'auto_call'),
      false,
    );
    const held = settingsView(
      reporter,
      us,
      [...given, { type: 'auto_call', revoked_at: null }],
      false,
      undefined,
      false,
    );
    assertEquals(
      held.consents.find((c) => c.type === 'auto_call'),
      {
        type: 'auto_call',
        held: true,
      },
    );
  },
);

Deno.test('W4-04 (§19 Q131): the office’s auto_call attestation is not the reporter’s own', () => {
  const us = toCountryPack(DEMO_COUNTRIES.find((c) => c.code === 'US')!);
  const rows = [
    { type: 'recording', revoked_at: null, method: 'web_checkbox' },
    { type: 'data_processing', revoked_at: null, method: 'web_checkbox' },
    { type: 'auto_call', revoked_at: null, method: 'office_attested' },
  ] as const;
  const reporter = { contact_pref: 'call', locale: 'en-US', message_channel: null } as const;
  const view = settingsView(reporter, us, rows, false, undefined, true);
  assertEquals(
    view.consents.find((c) => c.type === 'auto_call'),
    { type: 'auto_call', held: false },
  );
  const state = consentState(
    rows.map((r) => ({
      ...r,
      id: crypto.randomUUID(),
      reporter_id: 'r',
      text_version: 'v1',
      evidence: null,
      given_at: '2026-10-17T00:00:00Z',
    })) as ConsentRow[],
  );
  assertEquals([...state.held].sort(), ['data_processing', 'recording']);
});

Deno.test('settingsView: push is the toggle, offered with the pack and a key pair (W2-14)', () => {
  const us = {
    ...toCountryPack(DEMO_COUNTRIES.find((c) => c.code === 'US')!),
    messageChannels: ['push', 'sms'] as const,
  };
  const reporter = { contact_pref: 'link', locale: 'en-US', message_channel: null } as const;
  const given = [
    { type: 'recording', revoked_at: null },
    { type: 'data_processing', revoked_at: null },
    { type: 'push', revoked_at: null },
  ] as const;
  const on = settingsView(reporter, us, given, false, { keySet: true, deviceSubscribed: true });
  assertEquals(on.push, { offered: true, on: true });
  assertEquals(on.messageChannels, ['sms']);
  assertEquals(
    on.consents.map((c) => c.type),
    ['sms', 'recording', 'data_processing'],
  );
  // Another phone's subscription, or no consent: off on this one.
  assertEquals(
    settingsView(reporter, us, given, false, { keySet: true, deviceSubscribed: false }).push,
    { offered: true, on: false },
  );
  assertEquals(
    settingsView(reporter, us, given.slice(0, 2), false, { keySet: true, deviceSubscribed: true })
      .push,
    { offered: true, on: false },
  );
  assertEquals(
    settingsView(reporter, { ...us, messageChannels: ['sms'] }, given, false, {
      keySet: true,
      deviceSubscribed: true,
    }).push.offered,
    false,
  );
});

Deno.test(
  'settingsView: texts listed for Turn on when never given, while the pack texts (Q86)',
  () => {
    const us = {
      ...toCountryPack(DEMO_COUNTRIES.find((c) => c.code === 'US')!),
      messageChannels: ['push', 'sms'] as const,
    };
    const reporter = { contact_pref: 'link', locale: 'en-US', message_channel: null } as const;
    const given = [
      { type: 'recording', revoked_at: null },
      { type: 'data_processing', revoked_at: null },
    ] as const;
    assertEquals(settingsView(reporter, us, given, true).consents, [
      { type: 'sms', held: false },
      { type: 'recording', held: true },
      { type: 'data_processing', held: true },
    ]);
    assertEquals(settingsView(reporter, us, given, true).textsOptedOut, true);
    // A pack that sends no texts lists no texts consent.
    assertEquals(
      settingsView(reporter, { ...us, messageChannels: ['whatsapp'] }, given, false).consents.map(
        (c) => c.type,
      ),
      ['recording', 'data_processing', 'whatsapp'],
    );
  },
);

Deno.test('textsOptedOut: the reporter row or the phone on the pack (§9.5)', () => {
  assertEquals(textsOptedOut({ status: 'active' }, false), false);
  assertEquals(textsOptedOut({ status: 'opted_out' }, false), true);
  assertEquals(textsOptedOut({ status: 'active' }, true), true);
});

Deno.test(
  'linkMayAddPhotos (F9, spec §19 Q89): photos links always, web links by the parameter',
  () => {
    const S = 'site-a';
    const photos = { kind: 'photos' as const, site_id: S, report_date: '2026-10-09' };
    const daily = { kind: 'daily' as const, site_id: S, report_date: '2026-10-09' };
    const personal = { kind: 'personal' as const, site_id: null, report_date: null };
    assert(linkMayAddPhotos(photos, S, '2026-10-09'));
    assert(!linkMayAddPhotos(photos, S, '2026-10-08'));
    assert(!linkMayAddPhotos(photos, 'site-b', '2026-10-09'));
    assert(linkMayAddPhotos(photos, S, '2026-10-09', false));
    // The default (Q89, decided as built): the web links of that day too.
    assert(linkMayAddPhotos(daily, S, '2026-10-09'));
    assert(!linkMayAddPhotos(daily, S, '2026-10-08'));
    assert(linkMayAddPhotos(personal, S, '2026-10-09'));
    // The other reading: photos links only.
    assert(!linkMayAddPhotos(daily, S, '2026-10-09', false));
    assert(!linkMayAddPhotos(personal, S, '2026-10-09', false));
  },
);

Deno.test('filedPhotosUntil: 23:59 the next day at the site (F9)', () => {
  assertEquals(
    filedPhotosUntil('2026-10-09', { timezone: 'America/Chicago' }),
    '2026-10-11T04:59:00.000Z',
  );
  assertEquals(
    filedPhotosUntil('2026-10-09', { timezone: 'Europe/Istanbul' }),
    '2026-10-10T20:59:00.000Z',
  );
});

Deno.test(
  'dayOffPlan (W2-08): the details as answered questions in the reporter language, data in code',
  () => {
    let n = 0;
    const plan = dayOffPlan({
      status: 'weather_day',
      date: '2026-10-13',
      site: { name: 'Ataşehir', working_hours: '08:00–18:00' },
      org: { locale: 'tr-TR', units: 'metric' },
      defaultShiftHours: 9,
      reporterLocale: 'es-US',
      details: { since: 'never_started', workersBefore: 7 },
      newId: () => `00000000-0000-4000-8000-00000000000${++n}`,
    });
    assertEquals(
      plan.questions.map((q) => [q.field, q.prompt, q.answer.text]),
      [
        ['weather.impact', '¿Desde cuándo?', 'Nunca empezó'],
        ['manpower.workers', '¿Cuántos había en la obra antes?', '7'],
      ],
    );
    assertEquals(plan.data.reportLanguage, 'tr');
    assertEquals(plan.data.weather.periods[0]!.lostHours, 9);
    assertEquals(plan.data.manpower[0]!.totalHours, 0);
    const noWork = dayOffPlan({
      status: 'no_work',
      date: '2026-10-13',
      site: { name: 'Pier 9', working_hours: null },
      org: { locale: 'en-US', units: 'imperial' },
      defaultShiftHours: 8,
      reporterLocale: 'en-US',
      details: { since: '09:00' },
      newId: () => 'x',
    });
    assertEquals(noWork.questions, []);
    assertEquals(noWork.data.summary, 'No work at Pier 9 today.');
  },
);

Deno.test('W2-09: the spoken answer on the question and the last one settled', () => {
  const at = '2026-10-09T22:40:00Z';
  assertEquals(voiceAnswerView({ voice_answers: [] }), null);
  assertEquals(voiceAnswerView({ voice_answers: [{ uploadId: 'u1', at, status: 'listening' }] }), {
    state: 'listening',
    unclear: 0,
  });
  assertEquals(
    voiceAnswerView({
      voice_answers: [
        { uploadId: 'u1', at, status: 'unclear' },
        { uploadId: 'u2', at, status: 'listening' },
      ],
    }),
    { state: 'listening', unclear: 1 },
  );
  assertEquals(voiceAnswerView({ voice_answers: [{ uploadId: 'u1', at, status: 'unclear' }] }), {
    state: 'retry',
    unclear: 1,
  });
  // A stale try (answered by a tap meanwhile) shows nothing; neither does a malformed column.
  assertEquals(voiceAnswerView({ voice_answers: [{ uploadId: 'u1', at, status: 'stale' }] }), null);
  assertEquals(voiceAnswerView({ voice_answers: {} }), null);

  const confirmation = {
    kind: 'crew' as const,
    company: 'Delta Mechanical',
    workers: 5,
    hoursPerWorker: 8,
    totalHours: 40,
  };
  assertEquals(
    lastVoiceAnswerView([
      { id: 'q0', answered_at: '2026-10-09T22:30:00Z', answer: { unclear: true } },
      { id: 'q1', answered_at: at, answer: { voice: { uploadId: 'u1' }, confirmation } },
    ]),
    { questionId: 'q1', outcome: 'applied', confirmation },
  );
  // The latest answered question was tapped: no spoken line.
  assertEquals(
    lastVoiceAnswerView([
      { id: 'q1', answered_at: '2026-10-09T22:30:00Z', answer: { voice: {}, confirmation } },
      { id: 'q2', answered_at: at, answer: { optionId: 'o2' } },
    ]),
    null,
  );
  assertEquals(
    lastVoiceAnswerView([
      { id: 'q3', answered_at: at, answer: { unanswered: true, unclear: true } },
    ]),
    { questionId: 'q3', outcome: 'unclear' },
  );
  // Timed out (§7.2), not unclear: no spoken line.
  assertEquals(
    lastVoiceAnswerView([
      { id: 'q4', answered_at: at, answer: { unanswered: true, timeout: true } },
    ]),
    null,
  );
});

Deno.test(
  'correctionView (W2-10): the preview when ready; a fix listening too long is unclear',
  () => {
    const row = {
      id: 'c1',
      status: 'listening' as const,
      via: 'voice' as const,
      changes: null,
      clarification: null,
      reason: null,
      base_version: null,
      base_rev: null,
      created_at: '2026-10-09T22:00:00Z',
    };
    const at = (s: number) => new Date(Date.parse(row.created_at) + s * 1000);
    assertEquals(correctionView(row, at(60)).status, 'listening');
    assertEquals(
      [correctionView(row, at(301)).status, correctionView(row, at(301)).reason],
      ['unclear', 'timeout'],
    );
    const lines = [{ kind: 'section', section: 'work' }];
    const ready = correctionView(
      { ...row, status: 'ready', changes: lines, base_version: 1, base_rev: 3 },
      at(10),
    );
    assertEquals([ready.changes, ready.version, ready.draftRev], [lines, 1, 3]);
    const unclear = correctionView(
      { ...row, status: 'unclear', reason: 'clarification', clarification: 'Which crew?' },
      at(10),
    );
    assertEquals([unclear.clarification, unclear.changes], ['Which crew?', null]);
    // Applied, stale and discarded fixes are not shown on the draft.
    for (const status of ['applied', 'stale', 'discarded'] as const)
      assertEquals(openCorrectionView({ ...row, status }, at(10)), null);
    assertEquals(openCorrectionView(null, at(10)), null);
    // W2-10 review: a fix the report moved on from is shown stale for 10 minutes after it settled.
    const moved = {
      ...row,
      status: 'stale' as const,
      reason: 'report_moved_on',
      settled_at: '2026-10-09T22:00:30Z',
    };
    assertEquals(openCorrectionView(moved, at(60))?.status, 'stale');
    assertEquals(openCorrectionView(moved, at(30 + 601)), null);
    assertEquals(openCorrectionView({ ...moved, reason: 'draft_changed' }, at(60)), null);
  },
);
