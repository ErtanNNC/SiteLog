import { describe, expect, it } from 'vitest';
import { MessageSendError, WHATSAPP_KEYS, type OutboundMessage } from '../channels.ts';
import { toCountryPack } from '../countries.ts';
import type { CountryRow } from '../db/types.ts';
import { DEMO_COUNTRIES } from '../demo/countries.ts';
import { assertE164 } from '../format.ts';
import type { NotifyRecipient } from '../notify/notifier.ts';
import {
  hasEdgeVariable,
  isWhatsappAuthKey,
  VERIFY_CODE_EXPIRY_MINUTES,
  WHATSAPP_AUTH_KEYS,
  WHATSAPP_TEMPLATE_LANGUAGES,
  whatsappContentSid,
  whatsappContentVariables,
  whatsappRenderOptions,
  whatsappTemplate,
  whatsappTemplatesFor,
} from './templates.ts';
import {
  createTwilioWhatsappTransport,
  createWhatsappRegistration,
  whatsappFailedSinceInbound,
  type LastWhatsappOutbound,
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
    body: 'Kuzey Blok bugünkü rapor: https://go.talkolog.com/r/AB12CD',
    key: 'daily_link',
    language: 'tr',
    vars: { site: 'Kuzey Blok', link: 'https://go.talkolog.com/r/AB12CD' },
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
    const tr = whatsappTemplate('call_coming', 'tr', whatsappRenderOptions(TR_WA));
    expect(tr).toEqual({
      body: 'Bugünkü rapor için sizi saat {{1}} gibi arayacağım. Şimdi yapmak isterseniz: {{2}} - TalkOlog',
      variables: ['time', 'link'],
      category: 'utility',
      contentType: 'twilio/text',
    });
    const en = whatsappTemplate('filed', 'en', whatsappRenderOptions(TR_WA));
    expect(en).toEqual({
      body: 'Filed: Daily Report {{1}}. PDF: {{2}} - TalkOlog',
      variables: ['report_no', 'pdf_link'],
      category: 'utility',
      contentType: 'twilio/text',
    });
    // The pack's voice number decides the "or call {number}" clause.
    const withNumber = whatsappTemplate('reminder_2', 'en', {
      ...whatsappRenderOptions(TR_WA),
      hasVoiceNumber: true,
    });
    expect(withNumber.variables).toEqual(['time', 'link', 'number']);
    expect(whatsappContentVariables(tr, { time: '16:30', link: 'https://x/r/1' })).toEqual({
      '1': '16:30',
      '2': 'https://x/r/1',
    });
    expect(() => whatsappContentVariables(tr, { time: '16:30' })).toThrow('{link}');
    // Punctuation next to the variable still puts it at the end (Meta, 2026-10-23: "Tap {{1}}."
    // rejected), and likewise at the start (§19 Q110).
    const voiced = whatsappTemplate('reminder_2', 'en', {
      ...whatsappRenderOptions(TR_WA),
      hasVoiceNumber: true,
    });
    expect(voiced.body).toBe(
      "Still nothing for today. I'll let the office know at {{1}}. {{2}} or call {{3}}. - TalkOlog",
    );
    expect(hasEdgeVariable('Tap {{1}}.')).toBe(true);
    expect(hasEdgeVariable('Tap {{1}} .)')).toBe(true);
    expect(hasEdgeVariable('"{{1}}" is due')).toBe(true);
    expect(hasEdgeVariable('{{1}}')).toBe(true);
    expect(hasEdgeVariable('TalkOlog: {{1}} (please do not share it).')).toBe(false);
    expect(hasEdgeVariable('Tap {{1}} - TalkOlog')).toBe(false);
    expect(hasEdgeVariable('Rapor: {{1}} (lütfen paylaşmayın).')).toBe(false);
  });

  it('the Meta utility texts of daily_link, reminder_1, missed_call, finish_report and edit_applied (§19 Q377)', () => {
    const options = whatsappRenderOptions(TR_WA);
    const body = (key: Parameters<typeof whatsappTemplate>[0], language: 'en' | 'es' | 'tr') =>
      whatsappTemplate(key, language, options).body;
    expect(body('daily_link', 'en')).toBe(
      'TalkOlog: the daily report for {{1}} is open. Your personal report link for today: {{2}} (please do not share it).',
    );
    expect(body('daily_link', 'tr')).toBe(
      'TalkOlog: {{1}} için bugünkü günlük rapor açıldı. Bugünkü kişisel rapor linkiniz: {{2}} (lütfen paylaşmayın).',
    );
    expect(body('reminder_1', 'en')).toBe(
      'TalkOlog: the daily report for {{1}} has not been received yet today. Your report link: {{2}} (please do not share it).',
    );
    expect(body('reminder_1', 'tr')).toBe(
      'TalkOlog: {{1}} için bugünkü günlük rapor henüz alınmadı. Rapor linkiniz: {{2}} (lütfen paylaşmayın).',
    );
    expect(body('missed_call', 'en')).toBe(
      "TalkOlog: we could not reach you by phone for today's daily report. Your report link: {{1}} (please do not share it).",
    );
    expect(body('missed_call', 'tr')).toBe(
      'TalkOlog: bugünkü günlük rapor için size telefonla ulaşamadık. Rapor linkiniz: {{1}} (lütfen paylaşmayın).',
    );
    expect(body('finish_report', 'en')).toBe(
      "TalkOlog: your call ended before today's report was filed, so the report is not filed yet. Your report link: {{1}} (please do not share it).",
    );
    expect(body('finish_report', 'tr')).toBe(
      'TalkOlog: görüşme bugünkü rapor kaydedilmeden bitti, rapor henüz kaydedilmedi. Rapor linkiniz: {{1}} (lütfen paylaşmayın).',
    );
    expect(body('edit_applied', 'en')).toBe(
      'TalkOlog: your daily report for {{1}} was updated with this change: {{2}}. Version {{3}} of the report has been sent to the office.',
    );
    expect(body('edit_applied', 'tr')).toBe(
      'TalkOlog: {{1}} günlük raporunuz şu değişiklikle güncellendi: {{2}}. Raporun {{3}}. sürümü ofise gönderildi.',
    );
    const vars = {
      daily_link: ['site', 'link'],
      reminder_1: ['site', 'link'],
      missed_call: ['link'],
      finish_report: ['link'],
      edit_applied: ['weekday', 'change', 'v'],
    } as const;
    for (const [key, variables] of Object.entries(vars) as [keyof typeof vars, readonly string[]][])
      for (const language of WHATSAPP_TEMPLATE_LANGUAGES)
        for (const hasVoiceNumber of [false, true]) {
          const t = whatsappTemplate(key, language, { ...options, hasVoiceNumber });
          // The same variables in the same order, with or without a voice number; plain notices.
          expect(t.variables, `${key}.${language}`).toEqual(variables);
          expect(t.body, `${key}.${language}`).toMatch(/^TalkOlog: /);
          expect(hasEdgeVariable(t.body), `${key}.${language}`).toBe(false);
          expect(t.body, `${key}.${language}`).not.toMatch(
            /one tap|plenty|un toque|tek dokunuş|yeterli/i,
          );
        }
  });

  it('lists every key WhatsApp carries in each field language of the pack, the welcome and the code too', () => {
    const all = whatsappTemplatesFor(TR_WA);
    expect(all).toHaveLength(WHATSAPP_KEYS.length * 2);
    expect(new Set(all.map((t) => t.language))).toEqual(new Set(['tr', 'en']));
    // §19 Q372: the first-contact keys have templates.
    expect(all.filter((t) => t.key === 'welcome').map((t) => t.language)).toEqual(['tr', 'en']);
    expect(all.filter((t) => t.key === 'verify_code').map((t) => t.language)).toEqual(['tr', 'en']);
    for (const t of all) {
      // Meta's own authentication text starts with the code: the start/end rule is for ours.
      if (t.category === 'utility')
        expect(hasEdgeVariable(t.body), `${t.key}.${t.language}`).toBe(false);
      expect(t.body).not.toMatch(/\{[a-z_]+\}/);
    }
  });

  it('has a body for every key in every language, on both pack variants (§19 Q372)', () => {
    for (const hasVoiceNumber of [false, true]) {
      const options = { ...whatsappRenderOptions(TR_WA), hasVoiceNumber };
      for (const key of WHATSAPP_KEYS) {
        for (const language of WHATSAPP_TEMPLATE_LANGUAGES) {
          const t = whatsappTemplate(key, language, options);
          expect(t.body.trim().length, `${key}.${language}`).toBeGreaterThan(0);
          expect(t.body, `${key}.${language}`).not.toMatch(/\{[a-z_]+\}/);
          if (t.category === 'utility')
            expect(hasEdgeVariable(t.body), `${key}.${language}`).toBe(false);
          expect(t.category, key).toBe(isWhatsappAuthKey(key) ? 'authentication' : 'utility');
          // Numbered from 1 with no gap, each variable once.
          const numbers = [...t.body.matchAll(/\{\{(\d+)\}\}/g)].map((m) => Number(m[1]));
          expect([...new Set(numbers)].sort(), `${key}.${language}`).toEqual(
            t.variables.map((_v, i) => i + 1),
          );
        }
      }
    }
  });

  it('the welcome: Utility, a notice of the invite (§19 Q373), in EN, ES and TR', () => {
    const options = whatsappRenderOptions(TR_WA);
    const en = whatsappTemplate('welcome', 'en', options);
    expect(en).toMatchObject({ category: 'utility', contentType: 'twilio/text' });
    expect(en.variables).toEqual(['first', 'company', 'site', 'deadline', 'link']);
    expect(en.body).toBe(
      'TalkOlog: {{1}}, {{2}} added you as the daily reporter for {{3}}. Each workday before {{4}}, send your report from this link: {{5}} Reply STOP to opt out.',
    );
    expect(whatsappTemplate('welcome', 'tr', options).body).toBe(
      'TalkOlog: {{1}}, {{2}} sizi {{3}} için günlük raporcu olarak ekledi. Her iş günü {{4}} öncesi raporunuzu bu linkten verin: {{5}} Durdurmak için STOP yazın.',
    );
    expect(whatsappTemplate('welcome', 'es', options).body).toMatch(
      /^TalkOlog: \{\{1\}\}, \{\{2\}\}/,
    );
    // The same template with or without a voice number (no "or call" clause on WhatsApp).
    expect(
      whatsappTemplate('welcome', 'en', { ...options, hasVoiceNumber: true }).variables,
    ).toEqual(['first', 'company', 'site', 'deadline', 'link']);
  });

  it('the device code: an Authentication template, Meta’s fixed text, the code as {{1}}', () => {
    expect([...WHATSAPP_AUTH_KEYS]).toEqual(['verify_code']);
    for (const language of WHATSAPP_TEMPLATE_LANGUAGES) {
      const t = whatsappTemplate('verify_code', language, whatsappRenderOptions(TR_WA));
      expect(t).toMatchObject({
        category: 'authentication',
        contentType: 'whatsapp/authentication',
        variables: ['code'],
      });
      expect(t.body).toContain('{{1}}');
      expect(t.footer).toContain(String(VERIFY_CODE_EXPIRY_MINUTES));
      expect(whatsappContentVariables(t, { code: '042917' })).toEqual({ '1': '042917' });
    }
    expect(whatsappTemplate('verify_code', 'en', whatsappRenderOptions(TR_WA)).body).toBe(
      '{{1}} is your verification code. For your security, do not share this code.',
    );
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
      '2': 'https://go.talkolog.com/r/AB12CD',
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

  it('§19 Q372: not reachable once the last WhatsApp message failed late, until the person writes', async () => {
    let inbound: string | null = null;
    let outbound: LastWhatsappOutbound | null = null;
    const reg = createWhatsappRegistration({
      fetch: async () => new Response('{}'),
      twilio: () => ({}),
      statusCallbackUrl: null,
      lastInbound: async () => inbound,
      lastOutbound: async () => outbound,
      randomUUID: () => 'u',
      now: () => NOW,
    });
    expect(await reg.reachable!(recipient(), 'daily_link')).toBe(true);
    // Twilio took it and it is on its way, or delivered: still reachable.
    outbound = { status: 'sent', provider_message_id: 'SM1', created_at: '2026-10-09T16:30:00Z' };
    expect(await reg.reachable!(recipient(), 'daily_link')).toBe(true);
    // 63003 (not a WhatsApp user) as a late failed status: SMS from now on.
    outbound = { ...outbound, status: 'failed' };
    expect(await reg.reachable!(recipient(), 'daily_link')).toBe(false);
    outbound = { ...outbound, status: 'undeliverable' };
    expect(await reg.reachable!(recipient(), 'daily_link')).toBe(false);
    // A refusal at send time (no provider id: no template, outside the window) is the key's.
    expect(whatsappFailedSinceInbound({ ...outbound, provider_message_id: null }, null)).toBe(
      false,
    );
    // They wrote on WhatsApp since: reachable again (and inside the window).
    inbound = '2026-10-09T16:45:00Z';
    expect(await reg.reachable!(recipient(), 'filed')).toBe(true);
    // Demo orgs are never affected (console).
    inbound = null;
    expect(await reg.reachable!(recipient({ org: { id: 'o', isDemo: true } }), 'filed')).toBe(true);
  });
});
