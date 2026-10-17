import { describe, expect, it } from 'vitest';
import { MessageSendError, WHATSAPP_KEYS, type OutboundMessage } from '../channels.ts';
import { toCountryPack } from '../countries.ts';
import type { CountryRow } from '../db/types.ts';
import { DEMO_COUNTRIES } from '../demo/countries.ts';
import { assertE164 } from '../format.ts';
import type { NotifyRecipient } from '../notify/notifier.ts';
import {
  whatsappContentSid,
  whatsappContentVariables,
  whatsappRenderOptions,
  whatsappTemplate,
  whatsappTemplatesFor,
} from './templates.ts';
import {
  createTwilioWhatsappTransport,
  createWhatsappRegistration,
  fromWhatsappAddress,
  whatsappAddress,
  WhatsappConfigError,
} from './transport.ts';

const SID = `HX${'0123456789abcdef'.repeat(2)}`;
const pack = (code: 'US' | 'TR', patch: Partial<CountryRow> = {}) =>
  toCountryPack({ ...DEMO_COUNTRIES.find((c) => c.code === code)!, ...patch });
const TR_WA = pack('TR', {
  whatsapp_sender_id: '+905320000099',
  whatsapp_templates: { daily_link: { tr: SID } },
});
const NOW = new Date('2026-10-09T17:00:00Z');

function message(over: Partial<OutboundMessage> = {}): OutboundMessage {
  return {
    to: assertE164('+905321234567'),
    reporterId: 'r-emre',
    body: 'Kuzey Blok bugünkü rapor: https://go.sitelog.app/r/AB12CD',
    key: 'daily_link',
    language: 'tr',
    vars: { site: 'Kuzey Blok', link: 'https://go.sitelog.app/r/AB12CD' },
    pack: TR_WA,
    ...over,
  };
}

/** A mocked Twilio Messages API: records each form, answers with `reply`. */
function twilio(reply: { status: number; json: unknown } = { status: 201, json: { sid: 'SM1' } }) {
  const forms: URLSearchParams[] = [];
  const fetch = async (_url: string, init: RequestInit) => {
    forms.push(new URLSearchParams(String(init.body)));
    return new Response(JSON.stringify(reply.json), { status: reply.status });
  };
  return { fetch, forms };
}

describe('WhatsApp templates (W2-15, §9.2)', () => {
  it('numbers a key’s §9.2 variables in order; Meta’s start and end rule', () => {
    const tr = whatsappTemplate('daily_link', 'tr', whatsappRenderOptions(TR_WA));
    expect(tr).toEqual({
      body: 'SiteLog: {{1}} bugünkü rapor: {{2}} - SiteLog',
      variables: ['site', 'link'],
    });
    const en = whatsappTemplate('filed', 'en', whatsappRenderOptions(TR_WA));
    expect(en).toEqual({
      body: 'Filed: Daily Report {{1}}. PDF: {{2}} - SiteLog',
      variables: ['report_no', 'pdf_link'],
    });
    // The pack's voice number decides the "or call {number}" clause.
    const withNumber = whatsappTemplate('reminder_2', 'en', {
      ...whatsappRenderOptions(TR_WA),
      hasVoiceNumber: true,
    });
    expect(withNumber.variables).toEqual(['time', 'link', 'number']);
    expect(whatsappContentVariables(tr, { site: 'Kuzey', link: 'https://x/r/1' })).toEqual({
      '1': 'Kuzey',
      '2': 'https://x/r/1',
    });
    expect(() => whatsappContentVariables(tr, { site: 'Kuzey' })).toThrow('{link}');
  });

  it('lists every key WhatsApp carries in each field language of the pack, never the welcome', () => {
    const all = whatsappTemplatesFor(TR_WA);
    expect(all).toHaveLength(WHATSAPP_KEYS.length * 2);
    expect(new Set(all.map((t) => t.language))).toEqual(new Set(['tr', 'en']));
    expect(all.some((t) => (t.key as string) === 'welcome')).toBe(false);
    for (const t of all) {
      expect(t.body, `${t.key}.${t.language}`).not.toMatch(/^\{\{|\}\}$/);
      expect(t.body).not.toMatch(/\{[a-z_]+\}/);
    }
  });

  it('finds the approved content sid of a key and language, or null', () => {
    expect(whatsappContentSid(TR_WA, 'daily_link', 'tr')).toBe(SID);
    expect(whatsappContentSid(TR_WA, 'daily_link', 'en')).toBeNull();
    expect(whatsappContentSid(TR_WA, 'filed', 'tr')).toBeNull();
    expect(whatsappContentSid(pack('US'), 'daily_link', 'en')).toBeNull();
  });
});

describe('whatsapp: addresses', () => {
  it('reads and writes whatsapp:+E.164', () => {
    expect(whatsappAddress('+15550100000')).toBe('whatsapp:+15550100000');
    expect(fromWhatsappAddress('whatsapp:+15550100000')).toBe('+15550100000');
    expect(fromWhatsappAddress('+15550100000')).toBeNull();
    expect(fromWhatsappAddress('whatsapp:5550100000')).toBeNull();
  });
});

describe('Twilio WhatsApp transport (W2-15)', () => {
  const opts = { sender: '+905320000099', statusCallback: 'https://x/sms-webhook/status' };

  it('outside the 24-hour window: the approved template with its variables', async () => {
    const t = twilio();
    const transport = createTwilioWhatsappTransport(
      { accountSid: 'AC1', authToken: 'tok' },
      t.fetch,
      { lastInbound: async () => null, now: () => NOW },
    );
    expect(await transport.send(message(), opts)).toEqual({
      providerId: 'SM1',
      payload: { whatsapp_mode: 'template', content_sid: SID },
    });
    const form = t.forms[0]!;
    expect(form.get('To')).toBe('whatsapp:+905321234567');
    expect(form.get('From')).toBe('whatsapp:+905320000099');
    expect(form.get('ContentSid')).toBe(SID);
    expect(JSON.parse(form.get('ContentVariables')!)).toEqual({
      '1': 'Kuzey Blok',
      '2': 'https://go.sitelog.app/r/AB12CD',
    });
    expect(form.get('Body')).toBeNull();
    expect(form.get('StatusCallback')).toBe(opts.statusCallback);
  });

  it('inside the window: free-form text (a session message)', async () => {
    const t = twilio();
    const asked: Array<[string, string]> = [];
    const transport = createTwilioWhatsappTransport(
      { accountSid: 'AC1', authToken: 'tok' },
      t.fetch,
      {
        lastInbound: async (phone, sender) => {
          asked.push([phone, sender]);
          return '2026-10-09T09:00:00Z';
        },
        now: () => NOW,
      },
    );
    const sent = await transport.send(message({ key: 'filed', vars: {} }), opts);
    expect(sent.payload).toEqual({ whatsapp_mode: 'session' });
    // The window is the one on the sender this goes from (W2-15/16 review), not any message.
    expect(asked).toEqual([['+905321234567', '+905320000099']]);
    expect(t.forms[0]!.get('Body')).toBe(message().body);
    expect(t.forms[0]!.get('ContentSid')).toBeNull();
  });

  it('no approved template for the key and language outside the window: undeliverable', async () => {
    const t = twilio();
    const transport = createTwilioWhatsappTransport(
      { accountSid: 'AC1', authToken: 'tok' },
      t.fetch,
      { lastInbound: async () => '2026-10-08T09:00:00Z', now: () => NOW },
    );
    const err = await transport.send(message({ language: 'en' }), opts).catch((e) => e);
    expect(err).toBeInstanceOf(MessageSendError);
    expect([err.channel, err.undeliverable, err.retryable, err.opts.code]).toEqual([
      'whatsapp',
      true,
      false,
      'no_template',
    ]);
    // A reply outside the window has no template either.
    const reply = await transport
      .send(message({ key: 'help' as never, reply: true }), opts)
      .catch((e) => e);
    expect(reply.opts.code).toBe('outside_window');
    expect(t.forms).toHaveLength(0);
  });

  it('a template Twilio refuses falls back; 429 / 5xx retry; bad credentials are not the person’s', async () => {
    const send = async (status: number, json: unknown) =>
      createTwilioWhatsappTransport(
        { accountSid: 'AC1', authToken: 'tok' },
        twilio({ status, json }).fetch,
        {
          lastInbound: async () => null,
          now: () => NOW,
        },
      )
        .send(message(), opts)
        .then(
          () => {
            throw new Error('sent');
          },
          (e: MessageSendError) => e,
        );
    const template = await send(400, { code: 63027, message: 'template does not exist' });
    expect([template.undeliverable, template.retryable, template.opts.code]).toEqual([
      true,
      false,
      '63027',
    ]);
    const busy = await send(503, { message: 'unavailable' });
    expect([busy.undeliverable, busy.retryable]).toEqual([false, true]);
    const auth = await send(401, { code: 20003, message: 'Authenticate' });
    expect([auth.undeliverable, auth.retryable]).toEqual([false, false]);
  });
});

describe('the WhatsApp channel registration (W2-15)', () => {
  const recipient = (over: Partial<NotifyRecipient> = {}): NotifyRecipient => ({
    reporter: {
      id: 'r-emre',
      org_id: 'org-tr',
      phone_e164: '+905321234567',
      locale: 'tr-TR',
      status: 'active',
      message_channel: null,
    },
    org: { id: 'org-tr', isDemo: false },
    pack: TR_WA,
    consents: { held: new Set(['whatsapp']), revoked: new Set() },
    ...over,
  });

  it('reachable: a demo org always; a real one with a sender and an open window or a template', async () => {
    let last: string | null = null;
    const senders: string[] = [];
    const reg = createWhatsappRegistration({
      fetch: async () => new Response('{}'),
      twilio: () => ({}),
      statusCallbackUrl: 'https://x/status',
      lastInbound: async (_phone, sender) => {
        senders.push(sender);
        return last;
      },
      randomUUID: () => 'u',
      now: () => NOW,
    });
    expect(await reg.reachable!(recipient(), 'daily_link')).toBe(true);
    expect(await reg.reachable!(recipient(), 'filed')).toBe(false);
    last = '2026-10-09T16:00:00Z';
    expect(await reg.reachable!(recipient(), 'filed')).toBe(true);
    // Read on the pack's own WhatsApp sender (W2-15/16 review).
    expect(new Set(senders)).toEqual(new Set([TR_WA.whatsappSenderId]));
    expect(await reg.reachable!(recipient({ pack: pack('TR') }), 'daily_link')).toBe(false);
    expect(
      await reg.reachable!(
        recipient({ org: { id: 'o', isDemo: true }, pack: pack('TR') }),
        'filed',
      ),
    ).toBe(true);
    expect(reg.statusCallback!('twilio')).toBe('https://x/status');
    expect(reg.statusCallback!('console')).toBeNull();
    expect(reg.transport('console').driver).toBe('console');
    expect(() => reg.transport('twilio')).toThrow(WhatsappConfigError);
  });
});
