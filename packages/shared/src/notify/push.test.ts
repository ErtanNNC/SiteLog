import { describe, expect, it } from 'vitest';
import { assertE164 } from '../format.ts';
import { messageLink, PUSH_TITLE, pushPayload, pushResult, readPushData } from './push.ts';

describe('web push payload (W2-14)', () => {
  it('carries the §9.2 text, the key as tag, the language and the link', () => {
    expect(
      pushPayload({
        to: assertE164('+15550143378'),
        reporterId: 'r-1',
        body: 'Your draft is ready: https://go.sitelog.app/r/K7Q2MX',
        key: 'draft_ready',
        language: 'es',
        vars: { link: 'https://go.sitelog.app/r/K7Q2MX' },
      }),
    ).toEqual({
      title: PUSH_TITLE,
      body: 'Your draft is ready: https://go.sitelog.app/r/K7Q2MX',
      tag: 'draft_ready',
      lang: 'es',
      url: 'https://go.sitelog.app/r/K7Q2MX',
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
      title: 'SiteLog',
      body: '',
      tag: 'sitelog',
      lang: 'en',
      url: null,
    });
    expect(readPushData('plain text').body).toBe('plain text');
    expect(readPushData({ title: 'x', body: 'y', url: 'data:text/html,hi' }).url).toBeNull();
    expect(readPushData({ body: 'b', url: 'https://go.sitelog.app/r/K7Q2MX' }).url).toBe(
      'https://go.sitelog.app/r/K7Q2MX',
    );
  });

  it('maps the push service status (RFC 8030)', () => {
    expect([201, 202, 200].map(pushResult)).toEqual(['sent', 'sent', 'sent']);
    expect([404, 410].map(pushResult)).toEqual(['gone', 'gone']);
    expect([429, 500, 503].map(pushResult)).toEqual(['retry', 'retry', 'retry']);
    expect([400, 403, 413].map(pushResult)).toEqual(['refused', 'refused', 'refused']);
  });
});
