import { describe, expect, it } from 'vitest';
import { assertE164 } from '../format.ts';
import { PushSubscribeRequestSchema } from '../field-api.ts';
import {
  isAllowedPushEndpoint,
  messageLink,
  PUSH_TITLE,
  pushPayload,
  pushResult,
  readPushData,
} from './push.ts';

describe('web push payload (W2-14)', () => {
  it('carries the §9.2 text, the key as tag, the language and the link', () => {
    expect(
      pushPayload({
        to: assertE164('+15550143378'),
        reporterId: 'r-1',
        body: 'Your draft is ready: https://go.talkolog.com/r/K7Q2MX',
        key: 'draft_ready',
        language: 'es',
        vars: { link: 'https://go.talkolog.com/r/K7Q2MX' },
      }),
    ).toEqual({
      title: PUSH_TITLE,
      body: 'Your draft is ready: https://go.talkolog.com/r/K7Q2MX',
      tag: 'draft_ready',
      lang: 'es',
      url: 'https://go.talkolog.com/r/K7Q2MX',
    });
  });

  it('takes link, else pdf_link, and never a non-URL', () => {
    expect(messageLink({ pdf_link: 'https://x.test/a.pdf' })).toBe('https://x.test/a.pdf');
    expect(messageLink({ link: 'https://a.test', pdf_link: 'https://b.test' })).toBe(
      'https://a.test',
    );
    expect(messageLink({ link: 'javascript:alert(1)' })).toBeNull();
    expect(messageLink({})).toBeNull();
  });

  it('reads any payload safely in the service worker', () => {
    expect(readPushData(null)).toEqual({
      title: 'TalkOlog',
      body: '',
      tag: 'sitelog',
      lang: 'en',
      url: null,
    });
    expect(readPushData('plain text').body).toBe('plain text');
    expect(readPushData({ title: 'x', body: 'y', url: 'data:text/html,hi' }).url).toBeNull();
    expect(readPushData({ body: 'b', url: 'https://go.talkolog.com/r/K7Q2MX' }).url).toBe(
      'https://go.talkolog.com/r/K7Q2MX',
    );
  });

  it('maps the push service status (RFC 8030)', () => {
    expect([201, 202, 200].map((s) => pushResult(s))).toEqual(['sent', 'sent', 'sent']);
    expect([404, 410].map((s) => pushResult(s))).toEqual(['gone', 'gone']);
    expect([429, 500, 503].map((s) => pushResult(s))).toEqual(['retry', 'retry', 'retry']);
    // W2-15/16 review: a bare 400 or 403 may be TalkOlog's VAPID JWT (key or clock), and 413 is
    // TalkOlog's payload: refused for this message, the subscription kept.
    expect([400, 403, 413].map((s) => pushResult(s))).toEqual(['refused', 'refused', 'refused']);
    expect(pushResult(403, '{"reason":"BadJwtToken"}')).toBe('refused');
    expect(pushResult(403, '{"reason":"ExpiredJwtToken"}')).toBe('refused');
    expect(pushResult(401, 'UnauthorizedRegistration')).toBe('refused');
    // …unless the body names the subscription itself.
    expect(
      pushResult(
        403,
        'the VAPID credentials in the authorization header do not correspond to the credentials used to create the subscriptions.',
      ),
    ).toBe('gone');
    expect(pushResult(400, 'UnauthorizedRegistration')).toBe('gone');
    expect(pushResult(400, '{"reason":"BadDeviceToken"}')).toBe('gone');
    expect(pushResult(400, '{"reason":"DeviceTokenNotForTopic"}')).toBe('gone');
    expect([0, 301, 401, 415].map((s) => pushResult(s))).toEqual([
      'refused',
      'refused',
      'refused',
      'refused',
    ]);
  });
});

describe('push endpoint hosts (W2-14 review, spec §19 Q115)', () => {
  const allowed = [
    'https://fcm.googleapis.com/fcm/send/abc:APA91b',
    'https://updates.push.services.mozilla.com/wpush/v2/gAAAA',
    'https://wns2-par02p.notify.windows.com/w/?token=BQYAAAB',
    'https://web.push.apple.com/QGuQyavXutnMH',
    'https://api.push.apple.com/3/device/x',
    'https://FCM.googleapis.com/fcm/send/upper',
  ];
  const refused = [
    'https://push.example/x',
    'https://169.254.169.254/latest/meta-data',
    'https://localhost/x',
    'http://fcm.googleapis.com/fcm/send/x',
    'https://fcm.googleapis.com.evil.test/x',
    'https://evilfcm.googleapis.com/x',
    'https://fcm.googleapis.com:8443/x',
    'https://user@fcm.googleapis.com/x',
    'https://fcm.googleapis.com@evil.test/x',
    'https://fcm.googleapis.com\\@evil.test/x',
    'https://push.services.mozilla.com/x',
    'https://notify.windows.com/x',
    'https://push.apple.com/x',
    'https://evil.test/web.push.apple.com',
    'https://fcm.googleapis.com/a b',
    `https://fcm.googleapis.com/${'a'.repeat(2048)}`,
  ];

  it.each(allowed)('allows %s', (endpoint) => {
    expect(isAllowedPushEndpoint(endpoint)).toBe(true);
  });

  it.each(refused)('refuses %s', (endpoint) => {
    expect(isAllowedPushEndpoint(endpoint)).toBe(false);
  });

  it('the subscribe request takes only those endpoints', () => {
    const body = (endpoint: string) => ({
      subscription: { endpoint, keys: { p256dh: 'BPk', auth: 'aa' } },
      textVersion: 'field.push.v1',
    });
    for (const endpoint of allowed) {
      expect(PushSubscribeRequestSchema.safeParse(body(endpoint)).success, endpoint).toBe(true);
    }
    for (const endpoint of refused) {
      expect(PushSubscribeRequestSchema.safeParse(body(endpoint)).success, endpoint).toBe(false);
    }
  });
});
