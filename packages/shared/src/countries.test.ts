import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import {
  CountryRowSchema,
  DEFAULT_SMS_PROVIDER,
  DEFAULT_WHATSAPP_PROVIDER,
  isIanaTimeZone,
  isValidSmsSenderId,
  orgDefaultsFor,
  packCopyGaps,
  reporterDefaultsFor,
  reporterLocaleFor,
  toCountryPack,
  type FieldCountryView,
} from './countries.ts';
import type { CountryRow } from './db/types.ts';
import { DEMO_COUNTRIES, demoPack } from './demo/countries.ts';

/** Type-level equality (both directions, no widening). */
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
// The row schema and the hand-maintained row type describe the same row (db/types.ts, D7).
const rowTypesAgree: Equal<z.infer<typeof CountryRowSchema>, CountryRow> = true;

const us = DEMO_COUNTRIES.find((c) => c.code === 'US')!;

/** A valid row with one change. */
const variant = (patch: Partial<Record<keyof CountryRow, unknown>>) => ({ ...us, ...patch });

/** The synthetic pack of the "new country = new row" tests: no launch value, WhatsApp first. */
const ZZ_ROW: CountryRow = {
  code: 'ZZ',
  default_locale: 'en-US',
  field_locales: ['es-US'],
  units: 'metric',
  paper: 'a4',
  currency: 'EUR',
  default_timezone: 'UTC',
  message_channels: ['whatsapp', 'sms'],
  sms_provider: 'twilio',
  whatsapp_provider: 'twilio',
  sms_sender_type: 'alphanumeric',
  sms_sender_id: null,
  two_way_sms: false,
  sms_links_allowed: false,
  voice_number: null,
  whatsapp_sender_id: null,
  whatsapp_templates: null,
  outbound_trunk_id: null,
  legal_keys: {},
  created_at: '2026-10-14T00:00:00.000Z',
};

describe('country pack rows (spec §4.6)', () => {
  it('parses the launch packs, ordered by code', () => {
    expect(rowTypesAgree).toBe(true);
    expect(DEMO_COUNTRIES.map((c) => c.code)).toEqual(['TR', 'US']);
    for (const row of DEMO_COUNTRIES) expect(CountryRowSchema.parse(row)).toEqual(row);
  });

  it('seeds no per-environment value: every launch pack sends through console (D47)', () => {
    for (const row of DEMO_COUNTRIES) {
      expect(row.sms_sender_id, row.code).toBeNull();
      expect(row.voice_number, row.code).toBeNull();
      // W3-17 (§19 Q125): no outbound trunk in any migration.
      expect(row.outbound_trunk_id, row.code).toBeNull();
      expect(toCountryPack(row).outboundTrunkId, row.code).toBeNull();
      expect(row.legal_keys, row.code).toEqual({});
      // W2-14 (§19 Q107): push first, reached only by a reporter who turned notifications on;
      // §19 Q372 (20261020000100): WhatsApp then SMS on both (W2-16 had US SMS first);
      // §19 Q374 (20261023000100): SMS passive in every pack, WhatsApp only.
      expect(row.message_channels, row.code).toEqual(['push', 'whatsapp']);
    }
  });

  it('takes an outbound trunk (ST_…) only with the voice number as its caller id (§19 Q125, Q126)', () => {
    const withTrunk = variant({ voice_number: '+15550142290', outbound_trunk_id: 'ST_abc123XYZ' });
    expect(toCountryPack(withTrunk as CountryRow).outboundTrunkId).toBe('ST_abc123XYZ');
    expect(CountryRowSchema.safeParse(variant({ outbound_trunk_id: 'ST_abc123XYZ' })).success).toBe(
      false,
    );
    expect(
      CountryRowSchema.safeParse(
        variant({ voice_number: '+15550142290', outbound_trunk_id: 'trunk-1' }),
      ).success,
    ).toBe(false);
    // A row read before 20261016000380 (no column) has no trunk.
    const { outbound_trunk_id: _dropped, ...before } = us;
    expect(CountryRowSchema.parse(before).outbound_trunk_id).toBeNull();
  });

  it('defaults to Twilio for SMS and WhatsApp; TR too since §19 Q370 (a long code)', () => {
    expect([DEFAULT_SMS_PROVIDER, DEFAULT_WHATSAPP_PROVIDER]).toEqual(['twilio', 'twilio']);
    expect(demoPack('US').smsProvider).toBe('twilio');
    expect(demoPack('TR').smsProvider).toBe('twilio');
    expect(demoPack('TR').smsSenderType).toBe('long_code');
    expect(demoPack('TR').whatsappProvider).toBe('twilio');
  });

  it('maps a row to the camelCase pack', () => {
    expect(demoPack('TR')).toEqual({
      code: 'TR',
      defaultLocale: 'tr-TR',
      fieldLocales: ['tr-TR', 'en-US'],
      units: 'metric',
      paper: 'a4',
      currency: 'TRY',
      defaultTimezone: 'Europe/Istanbul',
      messageChannels: ['push', 'whatsapp'],
      smsProvider: 'twilio',
      whatsappProvider: 'twilio',
      smsSenderType: 'long_code',
      smsSenderId: null,
      twoWaySms: false,
      smsLinksAllowed: true,
      voiceNumber: null,
      whatsappSenderId: null,
      whatsappTemplates: {},
      outboundTrunkId: null,
      legalKeys: {},
    });
    const set = toCountryPack({
      ...us,
      sms_sender_id: '+18885550142',
      voice_number: '+15550142290',
      legal_keys: { privacy_notice: 'US.privacy.v1', consent: 'US.consent.v1' },
    });
    expect(set.smsSenderId).toBe('+18885550142');
    expect(set.voiceNumber).toBe('+15550142290');
    expect(set.legalKeys).toEqual({ privacyNotice: 'US.privacy.v1', consent: 'US.consent.v1' });
    const field: FieldCountryView = set;
    expect(field.code).toBe('US');
  });

  it('presets an org and a new reporter from the pack', () => {
    expect(orgDefaultsFor(demoPack('US'))).toEqual({
      country: 'US',
      locale: 'en-US',
      units: 'imperial',
      currency: 'USD',
      timezone: 'America/Chicago',
      pdfPaper: 'letter',
    });
    expect(orgDefaultsFor(demoPack('TR'))).toEqual({
      country: 'TR',
      locale: 'tr-TR',
      units: 'metric',
      currency: 'TRY',
      timezone: 'Europe/Istanbul',
      pdfPaper: 'a4',
    });
    expect(reporterDefaultsFor(demoPack('US'))).toEqual({ locale: 'en-US', languages: ['en'] });
    expect(reporterDefaultsFor(demoPack('TR'))).toEqual({ locale: 'tr-TR', languages: ['tr'] });
  });

  it("picks a reporter's locale from the languages the office says they speak (F2, F3)", () => {
    const us = demoPack('US');
    const tr = demoPack('TR');
    expect(reporterLocaleFor(us, ['es'])).toBe('es-US');
    // The pack's order decides when both match; the office's order does not.
    expect(reporterLocaleFor(us, ['es', 'en'])).toBe('en-US');
    expect(reporterLocaleFor(us, ['EN'])).toBe('en-US');
    expect(reporterLocaleFor(tr, ['en'])).toBe('en-US');
    expect(reporterLocaleFor(tr, ['es'])).toBeNull(); // the TR pack has no Spanish
    expect(reporterLocaleFor(us, ['pl', 'hi'])).toBeNull();
    expect(reporterLocaleFor(us, [])).toBeNull();
    expect(reporterLocaleFor(us, undefined)).toBeNull();
  });

  it('takes a new country as a row (ZZ)', () => {
    const zz = toCountryPack(ZZ_ROW);
    expect(zz.messageChannels).toEqual(['whatsapp', 'sms']);
    expect(packCopyGaps(zz)).toEqual([]); // Spanish, one-way: every key it can be sent exists
    expect(orgDefaultsFor(zz)).toMatchObject({ country: 'ZZ', timezone: 'UTC', pdfPaper: 'a4' });
    expect(reporterDefaultsFor(zz)).toEqual({ locale: 'es-US', languages: ['es'] });
  });

  it('has all the SMS copy each launch pack can send (packCopyGaps)', () => {
    for (const row of DEMO_COUNTRIES)
      expect(packCopyGaps(toCountryPack(row)), row.code).toEqual([]);
  });

  it('finds a two-way TR pack complete: Turkish has its two-way texts and reply hint', () => {
    // A valid row (a long code can take replies). Turkish has the two-way texts since W2-16 and
    // the welcome reply hint since §19 Q372 (both for WhatsApp, which is always two-way): a new
    // country is a row only when its languages have the copy (spec §4.6), which this one has.
    const trTwoWay = toCountryPack({
      ...DEMO_COUNTRIES.find((c) => c.code === 'TR')!,
      sms_sender_type: 'long_code',
      two_way_sms: true,
    });
    expect(packCopyGaps(trTwoWay)).toEqual([]);
    expect(packCopyGaps({ ...trTwoWay, fieldLocales: ['en-US'] })).toEqual([]);
  });

  it.each([
    ['a lowercase code', { code: 'us' }],
    ['a three-letter code', { code: 'USA' }],
    ['an unsupported org locale', { default_locale: 'fr-FR' }],
    ['an unsupported field locale', { field_locales: ['en-US', 'de-DE'] }],
    ['no field locale', { field_locales: [] }],
    ['a field locale twice', { field_locales: ['en-US', 'en-US'] }],
    ['an unknown unit system', { units: 'stone' }],
    ['an unknown paper size', { paper: 'legal' }],
    ['a lowercase currency', { currency: 'usd' }],
    ['an unknown time zone', { default_timezone: 'Mars/Olympus' }],
    ['an empty time zone', { default_timezone: '' }],
    ['no message channel', { message_channels: [] }],
    ['a message channel twice', { message_channels: ['sms', 'sms'] }],
    ['an unknown message channel', { message_channels: ['telegram'] }],
    ['an SMS provider without a driver', { sms_provider: 'vonage' }],
    ['a WhatsApp provider without a driver', { whatsapp_provider: 'meta' }],
    ['an unknown sender type', { sms_sender_type: 'email' }],
    ['a voice number that is not E.164', { voice_number: '555-0142' }],
    ['an empty sender id', { sms_sender_id: '' }],
    ['a toll-free sender that is not a number', { sms_sender_id: 'TALKOLOG' }],
    [
      'a padded sender title (the table stores it trimmed)',
      { sms_sender_type: 'alphanumeric', two_way_sms: false, sms_sender_id: 'TALKOLOG ' },
    ],
    ['a two-way alphanumeric sender', { sms_sender_type: 'alphanumeric', two_way_sms: true }],
    [
      'no links in SMS and no other channel',
      { sms_links_allowed: false, message_channels: ['sms'] },
    ],
    ['an order that ends with push (§9.3, W2-14)', { message_channels: ['sms', 'push'] }],
    ['push alone', { message_channels: ['push'] }],
    ['an unknown legal key', { legal_keys: { terms: 'US.terms.v1' } }],
    ['an empty legal key', { legal_keys: { consent: '' } }],
  ])('rejects %s', (_label, patch) => {
    expect(CountryRowSchema.safeParse(variant(patch)).success).toBe(false);
  });

  it('accepts a pack without links in SMS when it lists WhatsApp or push', () => {
    for (const channels of [['whatsapp', 'sms'], ['push', 'sms'], ['whatsapp']])
      expect(
        CountryRowSchema.safeParse(
          variant({ sms_links_allowed: false, message_channels: channels }),
        ).success,
        channels.join(','),
      ).toBe(true);
  });

  it('drops columns it does not know (a later migration)', () => {
    expect(CountryRowSchema.parse({ ...us, whatsapp_sender_id: null })).toEqual(us);
  });
});

describe('sender ids and time zones', () => {
  it('checks a sender id against its type, as set_country_endpoints() does', () => {
    expect(isValidSmsSenderId('alphanumeric', 'TALKOLOG')).toBe(true);
    expect(isValidSmsSenderId('alphanumeric', 'TALKO LOG 2')).toBe(true);
    expect(isValidSmsSenderId('alphanumeric', 'TALKOLOGAPP1')).toBe(false); // 12 characters
    expect(isValidSmsSenderId('alphanumeric', 'TALKOLOĞ')).toBe(false); // GSM-safe ASCII only
    expect(isValidSmsSenderId('alphanumeric', '+18885550142')).toBe(false);
    expect(isValidSmsSenderId('toll_free', '+18885550142')).toBe(true);
    expect(isValidSmsSenderId('long_code', '+15550142290')).toBe(true);
    expect(isValidSmsSenderId('toll_free', '8885550142')).toBe(false);
    expect(isValidSmsSenderId('short_code', '24680')).toBe(true);
    expect(isValidSmsSenderId('short_code', '12')).toBe(false);
  });

  it('knows IANA time zones', () => {
    for (const tz of ['America/Chicago', 'Europe/Istanbul', 'UTC'])
      expect(isIanaTimeZone(tz), tz).toBe(true);
    for (const tz of ['', 'Mars/Olympus', 'GMT+25']) expect(isIanaTimeZone(tz), tz).toBe(false);
  });
});
