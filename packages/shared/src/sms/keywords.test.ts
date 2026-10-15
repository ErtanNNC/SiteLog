import { describe, expect, it } from 'vitest';
import { toCountryPack } from '../countries.ts';
import { DEMO_COUNTRIES, demoPack } from '../demo/countries.ts';
import {
  keywordOf,
  orderInboundReporters,
  parseSmsKeyword,
  planInboundSms,
  type InboundReporter,
} from './keywords.ts';

const US = demoPack('US');
const TR = demoPack('TR');
const NOW = new Date('2026-10-09T23:00:00Z');

const reporter = (patch: Partial<InboundReporter> = {}): InboundReporter => ({
  id: 'r-marco',
  orgId: 'org-kestrel',
  status: 'active',
  contactPref: 'link',
  activatedAt: '2026-03-02T15:40:00Z',
  createdAt: '2026-03-02T15:05:00Z',
  optedOutAt: null,
  ...patch,
});

const plan = (
  body: string,
  reporters: InboundReporter[],
  extra: Partial<Parameters<typeof planInboundSms>[0]> = {},
) =>
  planInboundSms({
    pack: US,
    body,
    optOutType: null,
    reporters,
    pendingUnknown: false,
    now: NOW,
    ...extra,
  });

describe('§9.5 SMS keywords', () => {
  it('matches the whole text, any case, trailing punctuation ignored', () => {
    expect(
      ['STOP', 'stop', ' Stop. ', 'HELP!', 'call', 'Text', 'start\n'].map(parseSmsKeyword),
    ).toEqual(['stop', 'stop', 'stop', 'help', 'call', 'text', 'start']);
    expect(['please stop', 'stop it', 'OK', 'NO WORK', '', 'stopp'].map(parseSmsKeyword)).toEqual([
      null,
      null,
      null,
      null,
      null,
      null,
    ]);
  });

  it('reads the standard opt-out, opt-in and help synonyms (FCC 2025, Twilio defaults)', () => {
    expect(
      [
        'STOPALL',
        'Unsubscribe',
        'cancel',
        'END.',
        'quit!',
        'REVOKE',
        'optout',
        'OPT OUT',
        'opt-out',
        ' Opt  out ',
      ].map(parseSmsKeyword),
    ).toEqual(Array(10).fill('stop'));
    expect(['UNSTOP', 'unstop!'].map(parseSmsKeyword)).toEqual(['start', 'start']);
    expect(parseSmsKeyword('Info')).toBe('help');
    // Not synonyms: a sentence, YES (an M6 answer), and words that only contain one.
    expect(['cancel today', 'YES', 'the end', 'ending', 'opt'].map(parseSmsKeyword)).toEqual([
      null,
      null,
      null,
      null,
      null,
    ]);
  });

  it("Twilio's OptOutType wins (its synonyms, e.g. UNSUBSCRIBE)", () => {
    expect(keywordOf('UNSUBSCRIBE', 'STOP')).toBe('stop');
    expect(keywordOf('unstop', 'START')).toBe('start');
    expect(keywordOf('info', 'HELP')).toBe('help');
    expect(keywordOf('call', null)).toBe('call');
  });
});

describe('planInboundSms (F13, F15)', () => {
  it('a one-way pack stores the text and does nothing else, keywords included', () => {
    for (const body of ['STOP', 'HELP', 'CALL', 'hello']) {
      const p = planInboundSms({
        pack: TR,
        body,
        optOutType: null,
        reporters: [reporter()],
        pendingUnknown: false,
        now: NOW,
      });
      expect(p).toEqual({
        keyword: null,
        reporterId: 'r-marco',
        changes: [],
        reply: null,
        unknownContact: false,
        phoneOptOut: null,
      });
    }
  });

  it('STOP opts every reporter of the phone out and confirms once', () => {
    const other = reporter({ id: 'r-other', orgId: 'org-2', createdAt: '2026-05-01T00:00:00Z' });
    const p = plan('Stop', [reporter(), other]);
    expect(p.keyword).toBe('stop');
    expect(p.changes).toEqual([
      {
        reporterId: 'r-other',
        patch: { status: 'opted_out', opted_out_at: NOW.toISOString() },
        action: 'reporter.opted_out',
      },
      {
        reporterId: 'r-marco',
        patch: { status: 'opted_out', opted_out_at: NOW.toISOString() },
        action: 'reporter.opted_out',
      },
    ]);
    expect(p.reply).toEqual({ key: 'stop_confirm', reporterId: 'r-other' });
    expect(p.phoneOptOut).toBe('record');
  });

  it('a synonym is STOP too: CANCEL opts out', () => {
    expect(plan('CANCEL', [reporter()])).toMatchObject({
      keyword: 'stop',
      phoneOptOut: 'record',
      reply: { key: 'stop_confirm', reporterId: 'r-marco' },
    });
  });

  it('STOP sticks to a disabled reporter and to a number with no reporter', () => {
    // A disabled reporter keeps its status; opted_out_at makes a later re-invite land opted out.
    const off = reporter({ id: 'r-off', status: 'disabled' });
    expect(plan('STOP', [off])).toEqual({
      keyword: 'stop',
      reporterId: null,
      changes: [
        {
          reporterId: 'r-off',
          patch: { opted_out_at: NOW.toISOString() },
          action: 'reporter.opted_out',
        },
      ],
      reply: null,
      unknownContact: false,
      phoneOptOut: 'record',
    });
    // Already recorded: nothing to change, the phone's opt-out is recorded again (idempotent).
    expect(
      plan('STOP', [
        reporter({ id: 'r-off', status: 'disabled', optedOutAt: '2026-10-01T00:00:00Z' }),
      ]).changes,
    ).toEqual([]);
    // No reporter at all: only the phone's opt-out, no reply, no unknown contact.
    expect(plan('STOP', [])).toEqual({
      keyword: 'stop',
      reporterId: null,
      changes: [],
      reply: null,
      unknownContact: false,
      phoneOptOut: 'record',
    });
  });

  it('START clears the phone opt-out and a disabled reporter’s, which stays disabled', () => {
    const off = reporter({ id: 'r-off', status: 'disabled', optedOutAt: '2026-10-01T00:00:00Z' });
    const p = plan('START', [off]);
    expect(p.phoneOptOut).toBe('clear');
    expect(p.changes).toEqual([
      { reporterId: 'r-off', patch: { opted_out_at: null }, action: 'reporter.opted_in' },
    ]);
    // An unknown number that texts START gets the F13 answer like any other text.
    expect(plan('START', [])).toMatchObject({
      phoneOptOut: 'clear',
      unknownContact: true,
      reply: { key: 'unknown_number', reporterId: null },
    });
  });

  it('START restores the status the reporter had: active after a consent, else invited', () => {
    const p = plan('START', [
      reporter({ status: 'opted_out' }),
      reporter({
        id: 'r-new',
        status: 'opted_out',
        activatedAt: null,
        createdAt: '2026-01-01T00:00:00Z',
      }),
      reporter({ id: 'r-on', status: 'active' }),
    ]);
    expect(p.changes).toEqual([
      {
        reporterId: 'r-marco',
        patch: { status: 'active', opted_out_at: null },
        action: 'reporter.opted_in',
      },
      {
        reporterId: 'r-new',
        patch: { status: 'invited', opted_out_at: null },
        action: 'reporter.opted_in',
      },
    ]);
    expect(p.reply).toBeNull();
    expect(p.phoneOptOut).toBe('clear');
  });

  it('HELP answers with help, also after an opt-out', () => {
    expect(plan('help', [reporter({ status: 'opted_out' })]).reply).toEqual({
      key: 'help',
      reporterId: 'r-marco',
    });
  });

  it('CALL and TEXT set the report mode of reporters still opted in, and confirm it (§19 Q46)', () => {
    const p = plan('CALL', [reporter(), reporter({ id: 'r-out', status: 'opted_out' })]);
    expect(p.changes).toEqual([
      {
        reporterId: 'r-marco',
        patch: { contact_pref: 'call' },
        action: 'reporter.preferences_changed',
      },
    ]);
    expect(p.reply).toEqual({ key: 'pref_call_ok', reporterId: 'r-marco' });
    const text = plan('TEXT', [reporter()]);
    expect(text.changes).toEqual([]);
    expect(text.reply).toEqual({ key: 'pref_text_ok', reporterId: 'r-marco' });
    // An opted-out person gets no confirmation (nothing changed for them).
    expect(plan('CALL', [reporter({ status: 'opted_out' })]).reply).toBeNull();
  });

  it('sends no reply of its own when Twilio recognised the keyword (OptOutType, §19 Q45)', () => {
    const stop = plan('STOP', [reporter()], { optOutType: 'STOP' });
    expect(stop.changes).toHaveLength(1);
    expect(stop.phoneOptOut).toBe('record');
    expect(stop.reply).toBeNull();
    expect(plan('INFO', [reporter()], { optOutType: 'HELP' }).reply).toBeNull();
    expect(plan('help', [reporter()]).reply).toEqual({ key: 'help', reporterId: 'r-marco' });
  });

  it('any other text is stored for M6', () => {
    expect(plan('Running late, will send at 6', [reporter()])).toEqual({
      keyword: null,
      reporterId: 'r-marco',
      changes: [],
      reply: null,
      unknownContact: false,
      phoneOptOut: null,
    });
  });

  it('an unknown number gets the F13 reply and an unknown contact, once', () => {
    expect(plan('hello?', [])).toEqual({
      keyword: null,
      reporterId: null,
      changes: [],
      reply: { key: 'unknown_number', reporterId: null },
      unknownContact: true,
      phoneOptOut: null,
    });
    expect(plan('hello again', [], { pendingUnknown: true })).toMatchObject({
      reply: null,
      unknownContact: false,
    });
    // Never text a number that just said STOP.
    expect(plan('STOP', [])).toMatchObject({ reply: null, unknownContact: false });
    // A disabled reporter counts as unknown.
    expect(plan('hi', [reporter({ status: 'disabled' })]).unknownContact).toBe(true);
  });

  it('HELP needs links in SMS (its text carries the link)', () => {
    const noLinks = toCountryPack({
      ...DEMO_COUNTRIES.find((c) => c.code === 'US')!,
      sms_links_allowed: false,
      message_channels: ['sms', 'whatsapp'],
    });
    expect(plan('HELP', [reporter()], { pack: noLinks }).reply).toBeNull();
    expect(plan('STOP', [reporter()], { pack: noLinks }).reply).toEqual({
      key: 'stop_confirm',
      reporterId: 'r-marco',
    });
  });

  it('orders a shared phone: opted in, active, newest', () => {
    const ordered = orderInboundReporters([
      reporter({ id: 'old-active', createdAt: '2026-01-01T00:00:00Z' }),
      reporter({ id: 'invited', status: 'invited', createdAt: '2026-09-01T00:00:00Z' }),
      reporter({ id: 'new-active', createdAt: '2026-06-01T00:00:00Z' }),
      reporter({ id: 'out', status: 'opted_out' }),
      reporter({ id: 'off', status: 'disabled' }),
    ]);
    expect(ordered.map((r) => r.id)).toEqual(['new-active', 'old-active', 'invited', 'out']);
  });
});
