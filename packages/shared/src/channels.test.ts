import { describe, expect, it } from 'vitest';
import {
  pickSmsDriver,
  SMS_DRIVER_TWO_WAY,
  SMS_DRIVERS,
  voiceNumberFor,
  type Notifier,
  type SmsTransport,
} from './channels.ts';
import { assertE164 } from './format.ts';

describe('channel layer (§4.5)', () => {
  it('knows which drivers are two-way', () => {
    expect([...SMS_DRIVERS]).toEqual(['twilio', 'iletimerkezi', 'console']);
    expect(SMS_DRIVER_TWO_WAY).toEqual({ twilio: true, iletimerkezi: false, console: true });
  });

  it('always uses console for demo orgs', () => {
    const env = { SMS_US_PROVIDER: 'twilio', SMS_TR_PROVIDER: 'iletimerkezi' };
    expect(pickSmsDriver({ country: 'US', isDemo: true }, env)).toBe('console');
    expect(pickSmsDriver({ country: 'TR', isDemo: true }, env)).toBe('console');
  });

  it('picks the driver per org country from env, console when unset', () => {
    const env = { SMS_US_PROVIDER: 'twilio', SMS_TR_PROVIDER: ' iletimerkezi ' };
    expect(pickSmsDriver({ country: 'US', isDemo: false }, env)).toBe('twilio');
    expect(pickSmsDriver({ country: 'TR', isDemo: false }, env)).toBe('iletimerkezi');
    expect(pickSmsDriver({ country: 'US', isDemo: false }, {})).toBe('console');
    expect(pickSmsDriver({ country: 'TR', isDemo: false }, { SMS_TR_PROVIDER: '' })).toBe(
      'console',
    );
    expect(pickSmsDriver({ country: 'TR', isDemo: false }, { SMS_TR_PROVIDER: 'console' })).toBe(
      'console',
    );
  });

  it('rejects a driver that does not serve the country', () => {
    expect(() =>
      pickSmsDriver({ country: 'TR', isDemo: false }, { SMS_TR_PROVIDER: 'twilio' }),
    ).toThrow('SMS_TR_PROVIDER=twilio is not a TR SMS driver (iletimerkezi | console)');
    expect(() =>
      pickSmsDriver({ country: 'US', isDemo: false }, { SMS_US_PROVIDER: 'iletimerkezi' }),
    ).toThrow(/not a US SMS driver/);
  });

  it('reads the voice number per country; none yet in TR (§9.2, §18.2)', () => {
    const env = { VOICE_NUMBER_US: '+15550142290', VOICE_NUMBER_TR: '' };
    expect(voiceNumberFor('US', env)).toBe('+15550142290');
    expect(voiceNumberFor('TR', env)).toBeNull();
    expect(voiceNumberFor('TR', {})).toBeNull();
    expect(() => voiceNumberFor('US', { VOICE_NUMBER_US: '555 0142' })).toThrow(/E\.164/);
  });

  it('types a transport and a notifier that fakes can implement', async () => {
    const sent: Array<{ to: string; body: string }> = [];
    const transport: SmsTransport = {
      twoWay: SMS_DRIVER_TWO_WAY.console,
      async send(to, body) {
        sent.push({ to, body });
        return { providerId: `console-${sent.length}` };
      },
    };
    const texts: string[] = [];
    const notifier: Notifier = {
      async text(reporterId, key) {
        texts.push(`${reporterId}:${key}`);
      },
      async call() {},
    };
    await expect(transport.send(assertE164('+15550143378'), 'hi', {})).resolves.toEqual({
      providerId: 'console-1',
    });
    await notifier.text('r1', 'filed', { report_no: 'RL-2041-0187', pdf_link: 'x' });
    await notifier.call('r1', 'reminder', { siteId: 's1', date: '2026-10-09' });
    expect(sent).toEqual([{ to: '+15550143378', body: 'hi' }]);
    expect(texts).toEqual(['r1:filed']);
  });
});
