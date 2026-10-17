import { describe, expect, it } from 'vitest';
import type { CountryPack } from '../countries.ts';
import { demoPack } from '../demo/countries.ts';
import type { ConsentType, ContactPref, MessageChannel } from '../enums.ts';
import { deadlineInstant, DEFAULT_LADDER, ladderTimes } from './reminders.ts';
import {
  dailyLinkDue,
  dailyLinkInstant,
  DEFAULT_CALL_WINDOW,
  insideWindow,
  ladderDedupeKey,
  remind,
  REMIND_POLICY_DEFAULTS,
  REMIND_STAGES,
  remindChannels,
  type RemindAction,
  type RemindContext,
  type RemindReporter,
  type RemindStage,
} from './remind.ts';

/**
 * W2-05: `remind()` (spec §4.5, §7.4, F11) over every combination of what it reads: the pack's
 * capabilities (two-way SMS, voice number, links in SMS, an outbound trunk), the reporter's
 * preference, the stage; then the flags, the weather, the consent, the owner parameters (§19 Q76,
 * Q77, decided as built) and the quiet hours on DST days in both launch packs' time zones.
 */

const CHICAGO = 'America/Chicago';
const ISTANBUL = 'Europe/Istanbul';

const at = (date: string, hhmm: string, tz = CHICAGO) => deadlineInstant(date, hhmm, tz);

function pack(over: Partial<CountryPack> = {}, code: 'US' | 'TR' = 'US'): CountryPack {
  return { ...demoPack(code), ...over };
}

function reporter(over: Partial<RemindReporter> = {}): RemindReporter {
  return {
    status: 'active',
    contactPref: 'link',
    messageChannel: null,
    consents: new Set<ConsentType>(['sms', 'recording', 'data_processing']),
    ...over,
  };
}

function ctx(over: Partial<RemindContext> = {}): RemindContext {
  return {
    now: at('2026-10-09', '17:46'),
    tz: CHICAGO,
    settings: {
      headsUpEnabled: true,
      reminder1Enabled: true,
      reminder2Enabled: true,
      secondCallEnabled: true,
      callWindow: DEFAULT_CALL_WINDOW,
    },
    weatherObserved: true,
    outboundTrunk: false,
    ...over,
  };
}

const KEY: Record<RemindStage, string> = {
  daily_link: 'daily_link',
  heads_up: 'weather_headsup',
  reminder_1: 'reminder_1',
  reminder_2: 'reminder_2',
};

/**
 * §7.4 read row by row, for an active reporter inside the window with weather observed, every
 * stage on and `auto_call` held: what each cell of the table says.
 */
function expected(
  stage: RemindStage,
  pref: ContactPref,
  caps: { links: boolean; trunk: boolean },
): RemindAction {
  const hasLink = stage !== 'heads_up';
  const msg = (key: string): RemindAction =>
    hasLink && !caps.links
      ? { kind: 'none', reason: 'no_channel' }
      : ({ kind: 'message', key } as RemindAction);
  if (pref === 'link') return msg(KEY[stage]);
  switch (stage) {
    case 'daily_link':
      // W3-17 (§19 Q130): with calls placed, "I'll call you at {time}" (call_coming, with the
      // link); without, Q76 (decided): the daily link.
      return caps.trunk ? msg('call_coming') : msg('daily_link');
    case 'heads_up':
      return msg('weather_headsup');
    case 'reminder_1':
      return caps.trunk ? { kind: 'call', purpose: 'reminder' } : msg('reminder_1');
    case 'reminder_2':
      if (!caps.trunk) return msg('reminder_2');
      return caps.links
        ? { kind: 'call', purpose: 'reminder', message: 'reminder_2' }
        : { kind: 'call', purpose: 'reminder' };
  }
}

describe('remind(): the §7.4 table over every pack capability, preference and stage', () => {
  const bools = [true, false];
  const rows: Array<[string, RemindAction, RemindAction]> = [];
  for (const twoWay of bools)
    for (const voice of bools)
      for (const links of bools)
        for (const trunk of bools)
          for (const pref of ['link', 'call'] as const)
            for (const stage of REMIND_STAGES) {
              const p = pack({
                twoWaySms: twoWay,
                voiceNumber: voice ? ('+15550100000' as CountryPack['voiceNumber']) : null,
                smsLinksAllowed: links,
                // A pack that forbids links in SMS must list another channel (§4.6); the table
                // reads SMS alone (WhatsApp, built in W2-15, is left out of `implemented`).
                messageChannels: links ? ['sms'] : ['sms', 'whatsapp'],
              });
              const r = reporter({
                contactPref: pref,
                consents: new Set<ConsentType>(['sms', 'auto_call']),
              });
              const got = remind(r, p, stage, ctx({ outboundTrunk: trunk, implemented: ['sms'] }));
              rows.push([
                `twoWay=${twoWay} voice=${voice} links=${links} trunk=${trunk} ${pref} ${stage}`,
                got,
                expected(stage, pref, { links, trunk }),
              ]);
            }

  it('covers 2×2×2×2 packs × 2 preferences × 4 stages', () => {
    expect(rows).toHaveLength(128);
  });

  it.each(rows)('%s', (_label, got, want) => {
    expect(got).toEqual(want);
  });

  it('call_coming and calls only where calls are placed (§19 Q130, W3-17)', () => {
    for (const [label, got] of rows) {
      if (label.includes('trunk=false')) {
        expect(got.kind, label).not.toBe('call');
        if (got.kind === 'message') expect(got.key, label).not.toBe('call_coming');
      }
    }
  });

  it('two-way SMS and the voice number never change the decision (the copy variant does)', () => {
    const byRest = new Map<string, string>();
    for (const [label, got] of rows) {
      const rest = label.replace(/twoWay=\w+ voice=\w+ /, '');
      const seen = byRest.get(rest);
      if (seen) expect(JSON.stringify(got), label).toBe(seen);
      else byRest.set(rest, JSON.stringify(got));
    }
  });
});

describe('remind(): flags, reporter, weather, consent', () => {
  const p = pack();

  it('a stage the org turned off sends nothing', () => {
    const settings = { ...ctx().settings, headsUpEnabled: false, reminder1Enabled: false };
    expect(remind(reporter(), p, 'heads_up', ctx({ settings }))).toEqual({
      kind: 'none',
      reason: 'stage_disabled',
    });
    expect(remind(reporter(), p, 'reminder_1', ctx({ settings }))).toEqual({
      kind: 'none',
      reason: 'stage_disabled',
    });
    expect(remind(reporter(), p, 'reminder_2', ctx({ settings })).kind).toBe('message');
    const r2off = { ...ctx().settings, reminder2Enabled: false };
    expect(remind(reporter(), p, 'reminder_2', ctx({ settings: r2off }))).toEqual({
      kind: 'none',
      reason: 'stage_disabled',
    });
  });

  it('only active reporters hear the ladder', () => {
    for (const status of ['invited', 'opted_out', 'disabled']) {
      expect(remind(reporter({ status }), p, 'reminder_1', ctx())).toEqual({
        kind: 'none',
        reason: 'inactive',
      });
    }
  });

  it('the heads-up only when weather was observed, for both preferences', () => {
    for (const contactPref of ['link', 'call'] as const) {
      expect(
        remind(reporter({ contactPref }), p, 'heads_up', ctx({ weatherObserved: false })),
      ).toEqual({ kind: 'none', reason: 'no_weather' });
      expect(remind(reporter({ contactPref }), p, 'heads_up', ctx())).toEqual({
        kind: 'message',
        key: 'weather_headsup',
      });
    }
  });

  it('with a trunk, a call reporter without auto_call consent gets messages', () => {
    const r = reporter({ contactPref: 'call' });
    expect(remind(r, p, 'reminder_1', ctx({ outboundTrunk: true }))).toEqual({
      kind: 'message',
      key: 'reminder_1',
    });
    expect(remind(r, p, 'reminder_2', ctx({ outboundTrunk: true }))).toEqual({
      kind: 'message',
      key: 'reminder_2',
    });
  });

  it('with a trunk and second_call_enabled off, R2 is the message only', () => {
    const r = reporter({ contactPref: 'call', consents: new Set<ConsentType>(['auto_call']) });
    const settings = { ...ctx().settings, secondCallEnabled: false };
    expect(remind(r, p, 'reminder_2', ctx({ outboundTrunk: true, settings }))).toEqual({
      kind: 'message',
      key: 'reminder_2',
    });
  });

  it('a call outside the call window becomes the message, which the quiet hours then skip', () => {
    const r = reporter({ contactPref: 'call', consents: new Set<ConsentType>(['auto_call']) });
    const late = ctx({ outboundTrunk: true, now: at('2026-10-09', '20:30') });
    expect(remind(r, p, 'reminder_1', late)).toEqual({ kind: 'none', reason: 'quiet_hours' });
    const sendAnyway = {
      ...late,
      policy: { ...REMIND_POLICY_DEFAULTS, quietHours: 'send' as const },
    };
    expect(remind(r, p, 'reminder_1', sendAnyway)).toEqual({ kind: 'message', key: 'reminder_1' });
  });
});

describe('remind(): outbound calls (W3-17, §19 Q129, Q130, Q131)', () => {
  const p = pack();
  const caller = reporter({
    contactPref: 'call',
    consents: new Set<ConsentType>(['sms', 'auto_call']),
  });
  const r1At = at('2026-10-09', '17:45');
  const at17 = ctx({ outboundTrunk: true, now: at('2026-10-09', '17:00'), r1At });

  it('the 17:00 call_coming only when the R1 call will be placed', () => {
    expect(remind(caller, p, 'daily_link', at17)).toEqual({ kind: 'message', key: 'call_coming' });
    // No auto_call consent: no call comes, so the daily link (Q76).
    expect(remind(reporter({ contactPref: 'call' }), p, 'daily_link', at17)).toEqual({
      kind: 'message',
      key: 'daily_link',
    });
    // R1 after the call window closes: no call comes.
    const lateR1 = { ...at17, r1At: at('2026-10-09', '20:15') };
    expect(remind(caller, p, 'daily_link', lateR1)).toEqual({ kind: 'message', key: 'daily_link' });
    // The org turned automated calls off (auto_call_enabled, M10's control).
    const off = { ...at17, settings: { ...at17.settings, autoCallEnabled: false } };
    expect(remind(caller, p, 'daily_link', off)).toEqual({ kind: 'message', key: 'daily_link' });
    expect(remind(caller, p, 'reminder_1', { ...off, now: r1At })).toEqual({
      kind: 'message',
      key: 'reminder_1',
    });
    // §19 Q130 as a parameter: none.
    const quiet = { ...at17, policy: { ...REMIND_POLICY_DEFAULTS, callComing: 'none' as const } };
    expect(remind(caller, p, 'daily_link', quiet)).toEqual({
      kind: 'none',
      reason: 'call_reporter',
    });
  });

  it('"Don\'t call me today" turns the calls into the messages a link reporter gets (§19 Q129)', () => {
    const notToday = { ...caller, noCallsUntil: at('2026-10-10', '00:00') };
    expect(remind(notToday, p, 'daily_link', at17)).toEqual({
      kind: 'message',
      key: 'daily_link',
    });
    expect(remind(notToday, p, 'reminder_1', ctx({ outboundTrunk: true, now: r1At }))).toEqual({
      kind: 'message',
      key: 'reminder_1',
    });
    expect(
      remind(
        notToday,
        p,
        'reminder_2',
        ctx({ outboundTrunk: true, now: at('2026-10-09', '18:30') }),
      ),
    ).toEqual({ kind: 'message', key: 'reminder_2' });
    // Yesterday's "not today" is over.
    const yesterday = { ...caller, noCallsUntil: '2026-10-09T05:00:00.000Z' };
    expect(remind(yesterday, p, 'reminder_1', ctx({ outboundTrunk: true, now: r1At }))).toEqual({
      kind: 'call',
      purpose: 'reminder',
    });
  });

  it('a link reporter never gets a call or call_coming, whatever the org places', () => {
    const link = reporter({ consents: new Set<ConsentType>(['sms', 'auto_call']) });
    expect(remind(link, p, 'daily_link', at17)).toEqual({ kind: 'message', key: 'daily_link' });
    expect(remind(link, p, 'reminder_1', ctx({ outboundTrunk: true, now: r1At }))).toEqual({
      kind: 'message',
      key: 'reminder_1',
    });
  });
});

describe('remind(): §19 Q76 (daily link for call reporters while no call is placed)', () => {
  const call = reporter({ contactPref: 'call' });
  const at17 = ctx({ now: at('2026-10-09', '17:00') });

  it('default: the 17:00 daily link, like link reporters', () => {
    expect(REMIND_POLICY_DEFAULTS.callReporterDailyLink).toBe('daily_link');
    expect(remind(call, pack(), 'daily_link', at17)).toEqual({
      kind: 'message',
      key: 'daily_link',
    });
  });

  it('none: nothing until R1, which is a message while no pack places calls', () => {
    const none = {
      ...at17,
      policy: { ...REMIND_POLICY_DEFAULTS, callReporterDailyLink: 'none' as const },
    };
    expect(remind(call, pack(), 'daily_link', none)).toEqual({
      kind: 'none',
      reason: 'call_reporter',
    });
    expect(remind(call, pack(), 'reminder_1', { ...none, now: at('2026-10-09', '17:45') })).toEqual(
      {
        kind: 'message',
        key: 'reminder_1',
      },
    );
  });

  it('link reporters are untouched by it', () => {
    const none = {
      ...at17,
      policy: { ...REMIND_POLICY_DEFAULTS, callReporterDailyLink: 'none' as const },
    };
    expect(remind(reporter(), pack(), 'daily_link', none)).toEqual({
      kind: 'message',
      key: 'daily_link',
    });
  });
});

describe('remind(): §19 Q77 quiet hours (the org call window, §19 Q30), both ways', () => {
  const window = { start: '08:00:00', end: '18:00:00' };
  const settings = { ...ctx().settings, callWindow: window };

  it('default skip: a stage outside the window sends nothing; inside it does', () => {
    expect(REMIND_POLICY_DEFAULTS.quietHours).toBe('skip');
    for (const stage of REMIND_STAGES) {
      expect(
        remind(reporter(), pack(), stage, ctx({ settings, now: at('2026-10-09', '18:30') })),
      ).toEqual({ kind: 'none', reason: 'quiet_hours' });
      expect(
        remind(reporter(), pack(), stage, ctx({ settings, now: at('2026-10-09', '17:59') })).kind,
      ).toBe('message');
    }
  });

  it('send: the message goes out outside the window too', () => {
    const policy = { ...REMIND_POLICY_DEFAULTS, quietHours: 'send' as const };
    expect(
      remind(
        reporter(),
        pack(),
        'reminder_2',
        ctx({ settings, policy, now: at('2026-10-09', '18:30') }),
      ),
    ).toEqual({ kind: 'message', key: 'reminder_2' });
  });

  it('the window is start-inclusive, end-exclusive, at the site', () => {
    expect(insideWindow(at('2026-10-09', '07:59'), CHICAGO, window)).toBe(false);
    expect(insideWindow(at('2026-10-09', '08:00'), CHICAGO, window)).toBe(true);
    expect(insideWindow(at('2026-10-09', '17:59'), CHICAGO, window)).toBe(true);
    expect(insideWindow(at('2026-10-09', '18:00'), CHICAGO, window)).toBe(false);
  });

  it('a window over midnight, and an empty one', () => {
    const night = { start: '22:00', end: '06:00' };
    expect(insideWindow(at('2026-10-09', '23:00'), CHICAGO, night)).toBe(true);
    expect(insideWindow(at('2026-10-09', '05:59'), CHICAGO, night)).toBe(true);
    expect(insideWindow(at('2026-10-09', '12:00'), CHICAGO, night)).toBe(false);
    expect(insideWindow(at('2026-10-09', '12:00'), CHICAGO, { start: '09:00', end: '09:00' })).toBe(
      false,
    );
  });
});

describe('DST: the ladder in site time on both packs’ change days', () => {
  // America/Chicago: spring forward 2026-03-08 (02:00 → 03:00), fall back 2026-11-01.
  // Europe/Istanbul: fixed UTC+3 all year, so the EU change days (2026-03-29, 2026-10-25) move
  // nothing there.
  const days: Array<[string, string, string, string]> = [
    // tz, date, the daily link at 17:00 in UTC, the window's 20:00 end in UTC
    [CHICAGO, '2026-03-07', '2026-03-07T23:00:00.000Z', '2026-03-08T02:00:00.000Z'],
    [CHICAGO, '2026-03-08', '2026-03-08T22:00:00.000Z', '2026-03-09T01:00:00.000Z'],
    [CHICAGO, '2026-10-31', '2026-10-31T22:00:00.000Z', '2026-11-01T01:00:00.000Z'],
    [CHICAGO, '2026-11-01', '2026-11-01T23:00:00.000Z', '2026-11-02T02:00:00.000Z'],
    [ISTANBUL, '2026-03-28', '2026-03-28T14:00:00.000Z', '2026-03-28T17:00:00.000Z'],
    [ISTANBUL, '2026-03-29', '2026-03-29T14:00:00.000Z', '2026-03-29T17:00:00.000Z'],
    [ISTANBUL, '2026-10-24', '2026-10-24T14:00:00.000Z', '2026-10-24T17:00:00.000Z'],
    [ISTANBUL, '2026-10-25', '2026-10-25T14:00:00.000Z', '2026-10-25T17:00:00.000Z'],
  ];

  it.each(days)('%s %s: 17:00 and 20:00 are wall-clock at the site', (tz, date, link, end) => {
    expect(dailyLinkInstant(date, null, tz).toISOString()).toBe(link);
    expect(dailyLinkInstant(date, '17:00:00', tz).toISOString()).toBe(link);
    const windowEnd = new Date(end);
    const p = tz === ISTANBUL ? pack({}, 'TR') : pack();
    const c = (now: Date) => ctx({ tz, now });
    expect(
      remind(reporter(), p, 'reminder_2', c(new Date(windowEnd.getTime() - 60_000))).kind,
    ).toBe('message');
    expect(remind(reporter(), p, 'reminder_2', c(windowEnd))).toEqual({
      kind: 'none',
      reason: 'quiet_hours',
    });
  });

  it('the stages keep their minutes after the deadline across the change', () => {
    for (const [tz, date] of days) {
      const deadline = deadlineInstant(date, '17:30', tz);
      const t = ladderTimes(deadline, DEFAULT_LADDER);
      expect(t.reminder1At.getTime() - deadline.getTime()).toBe(15 * 60_000);
      const link = dailyLinkInstant(date, '17:00', tz);
      expect(deadline.getTime() - link.getTime()).toBe(30 * 60_000);
    }
  });
});

describe('dailyLinkDue and the daily link key', () => {
  const dailyLinkAt = dailyLinkInstant('2026-10-09', null, CHICAGO);
  const due = (hhmm: string, currentStage = 0) =>
    dailyLinkDue({ now: at('2026-10-09', hhmm), dailyLinkAt, currentStage });

  it('from daily_link_time while the day has not reached R1', () => {
    expect(due('16:59')).toBe(false);
    expect(due('17:00')).toBe(true);
    expect(due('17:46')).toBe(true); // a tick that finds R1 due too sends both, the link first
    expect(due('17:10', 1)).toBe(true); // after the heads-up
    expect(due('17:50', 2)).toBe(false);
  });

  it('is keyed per key, site-day and reporter', () => {
    expect(ladderDedupeKey('daily_link', 'sd', 'rep')).toBe('notify:daily_link:sd:rep');
    expect(ladderDedupeKey('reminder_1', 'sd', 'rep')).toBe('notify:reminder_1:sd:rep');
  });
});

describe('remindChannels', () => {
  it('the person’s preference first when the pack offers it, then the pack; built only', () => {
    const p = pack({ messageChannels: ['whatsapp', 'sms'] });
    const order = (messageChannel: MessageChannel | null, implemented: MessageChannel[]) =>
      remindChannels(p, { messageChannel }, 'reminder_1', implemented);
    expect(order(null, ['sms'])).toEqual(['sms']);
    expect(order(null, ['sms', 'whatsapp'])).toEqual(['whatsapp', 'sms']);
    expect(order('sms', ['sms', 'whatsapp'])).toEqual(['sms', 'whatsapp']);
    expect(order('push', ['sms', 'whatsapp'])).toEqual(['whatsapp', 'sms']);
  });

  it('drops SMS for a key with a link when the pack forbids links; keeps it for the heads-up', () => {
    const p = pack({ smsLinksAllowed: false, messageChannels: ['sms', 'whatsapp'] });
    expect(remindChannels(p, { messageChannel: null }, 'daily_link', ['sms'])).toEqual([]);
    // W2-15: WhatsApp is built, so it carries the link.
    expect(remindChannels(p, { messageChannel: null }, 'daily_link')).toEqual(['whatsapp']);
    expect(remindChannels(p, { messageChannel: null }, 'weather_headsup')).toEqual([
      'sms',
      'whatsapp',
    ]);
    expect(remindChannels(p, { messageChannel: null }, 'daily_link', ['sms', 'whatsapp'])).toEqual([
      'whatsapp',
    ]);
  });
});
