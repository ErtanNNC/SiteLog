import { describe, expect, it } from 'vitest';
import { SmsStandInConfigError, smsApiBases } from './stand-in.ts';

describe('smsApiBases (W4-12, the local SMS stand-in)', () => {
  it('is empty unless SMS_PROVIDER_STUB=true: the bases alone change nothing', () => {
    expect(smsApiBases({})).toEqual({});
    expect(
      smsApiBases({
        SMS_PROVIDER_STUB: 'false',
        TWILIO_API_BASE: 'http://127.0.0.1:4010',
        ILETIMERKEZI_API_BASE: 'http://127.0.0.1:4010',
      }),
    ).toEqual({});
    expect(smsApiBases({ TWILIO_API_BASE: 'http://127.0.0.1:4010' })).toEqual({});
  });

  it('points both drivers at the stand-in when on', () => {
    expect(
      smsApiBases({
        SMS_PROVIDER_STUB: 'true',
        TWILIO_API_BASE: 'http://host.docker.internal:4010/',
        ILETIMERKEZI_API_BASE: 'http://host.docker.internal:4010',
      }),
    ).toEqual({
      twilio: 'http://host.docker.internal:4010',
      iletimerkezi: 'http://host.docker.internal:4010',
    });
    expect(
      smsApiBases({
        SMS_PROVIDER_STUB: true,
        TWILIO_API_BASE: 'http://a.test',
        ILETIMERKEZI_API_BASE: 'https://b.test',
      }),
    ).toEqual({ twilio: 'http://a.test', iletimerkezi: 'https://b.test' });
  });

  it('refuses a stub with a base missing or not http(s): never half real', () => {
    expect(() =>
      smsApiBases({ SMS_PROVIDER_STUB: 'true', TWILIO_API_BASE: 'http://127.0.0.1:4010' }),
    ).toThrow(SmsStandInConfigError);
    expect(() =>
      smsApiBases({
        SMS_PROVIDER_STUB: 'true',
        TWILIO_API_BASE: 'ftp://x',
        ILETIMERKEZI_API_BASE: 'http://127.0.0.1:4010',
      }),
    ).toThrow(/TWILIO_API_BASE must be an http\(s\) URL/);
  });
});
