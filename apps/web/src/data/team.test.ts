import { describe, expect, it } from 'vitest';
import { DemoStore } from './demo/store';
import { demoOrgPack } from './demo/demoPhone';
import { assembleTeam, callTodayOf, welcomeUndeliverable } from './assemble';
import type { WelcomeAttempt } from './types';

/** W4-03: Team's statuses from v1.2 data (P10), on the assembler both sources share. */

const attempt = (over: Partial<WelcomeAttempt>): WelcomeAttempt => ({
  status: 'sent',
  channel: 'sms',
  provider_message_id: 'SM1',
  attempt: 1,
  dedupe_key: 'welcome:r',
  ...over,
});

describe('welcomeUndeliverable', () => {
  it('is true only when nothing went out and the walk ended on a final failure', () => {
    expect(welcomeUndeliverable([])).toBe(false);
    expect(welcomeUndeliverable([attempt({ status: 'delivered' })])).toBe(false);
    expect(
      welcomeUndeliverable([attempt({ status: 'undeliverable', provider_message_id: null })]),
    ).toBe(true);
    // A failed callback after the provider took it is final; a failed send without one retries.
    expect(welcomeUndeliverable([attempt({ status: 'failed' })])).toBe(true);
    expect(welcomeUndeliverable([attempt({ status: 'failed', provider_message_id: null })])).toBe(
      false,
    );
    // The walk moved on to WhatsApp, still pending: not yet.
    expect(
      welcomeUndeliverable([
        attempt({ status: 'undeliverable', provider_message_id: null }),
        attempt({ status: 'queued', channel: 'whatsapp', provider_message_id: null, attempt: 2 }),
      ]),
    ).toBe(false);
    // One attempt that went out wins over any failure.
    expect(
      welcomeUndeliverable([
        attempt({ status: 'undeliverable', provider_message_id: null }),
        attempt({ status: 'delivered', channel: 'whatsapp', attempt: 2 }),
      ]),
    ).toBe(false);
  });
});

describe('assembleTeam (W4-03)', () => {
  it('names who stopped texts, the channel without consent and the automatic re-send', () => {
    const store = new DemoStore();
    const [marco, jorge] = ['Marco Ruiz', 'Jorge Medina'].map((n) =>
      store.data.reporters.find((r) => r.name === n)!,
    );
    marco!.message_channel = 'whatsapp';
    Object.assign(jorge!, { status: 'opted_out', opted_out_at: store.nowIso() });
    const states = store.teamStates().map((s) =>
      s.reporterId === jorge!.id
        ? {
            ...s,
            optOutMethod: 'provider_opt_out' as const,
            welcome: [attempt({ dedupe_key: 'welcome_resend:x', status: 'queued' })],
          }
        : s,
    );
    const team = assembleTeam(
      store.rows(),
      { now: store.now, userId: 'u' },
      { pack: demoOrgPack(store.data), states },
    );
    const byName = new Map(team.reporters.map((r) => [r.name, r]));
    expect(byName.get('Marco Ruiz')).toMatchObject({
      chipStatus: 'active',
      messageChannel: 'whatsapp',
      channelUnreachable: true,
      devices: 1,
    });
    expect(byName.get('Jorge Medina')).toMatchObject({
      chipStatus: 'opted_out',
      optOutBy: 'provider',
      // The automatic re-send shows only on an invite still waiting.
      autoResent: false,
    });
    expect(team.pack).toMatchObject({
      code: 'US',
      // §19 Q374: SMS passive in every pack.
      settingsChannels: ['whatsapp'],
      twoWaySms: true,
    });
    expect(team.orgLocale).toBe('en-US');
  });
});

/** W4-04 (F3, §19 Q230): the latest outbound call today, as Team and Site detail show it. */
describe('callTodayOf', () => {
  const tz = 'America/Chicago';
  const now = new Date('2026-10-09T23:05:00Z'); // 18:05 in Chicago
  const call = (over: Record<string, unknown>) => ({
    id: 'c',
    reporter_id: 'r',
    site_id: 's',
    direction: 'outbound' as const,
    purpose: 'daily_report',
    status: 'ringing' as const,
    created_at: '2026-10-09T23:00:00Z',
    ...over,
  });
  it('picks today’s latest outbound call of the reporter, live while queued or ringing', () => {
    const calls = [
      call({ id: 'yesterday', created_at: '2026-10-09T03:00:00Z' }),
      call({
        id: 'r1',
        purpose: 'reminder',
        status: 'no_answer',
        created_at: '2026-10-09T22:45:00Z',
      }),
      call({ id: 'office' }),
      call({ id: 'inbound', direction: 'inbound', created_at: '2026-10-09T23:04:00Z' }),
      call({ id: 'other', reporter_id: 'x', created_at: '2026-10-09T23:04:00Z' }),
    ];
    expect(callTodayOf(calls, 'r', tz, now)).toEqual({
      id: 'office',
      progress: 'ringing',
      at: '2026-10-09T23:00:00Z',
      byOffice: true,
      live: true,
    });
    expect(callTodayOf(calls.slice(0, 2), 'r', tz, now)).toMatchObject({
      id: 'r1',
      progress: 'not_reached',
      byOffice: false,
      live: false,
    });
    expect(callTodayOf(calls, 'r', tz, now, 'elsewhere')).toBeNull();
  });

  it('Team carries it per reporter, and whether the org places calls', () => {
    const store = new DemoStore();
    const team = assembleTeam(
      store.rows(),
      { now: store.now, userId: 'u' },
      {
        pack: demoOrgPack(store.data),
        states: store.teamStates(),
      },
    );
    expect(team.placesCalls).toBe(true);
    // §18.1: Aisha's R1 call at 17:45 was not answered.
    expect(team.reporters.find((r) => r.name === 'Aisha Bello')!.callToday).toMatchObject({
      progress: 'not_reached',
      byOffice: false,
    });
    store.data.org.is_demo = false;
    expect(
      assembleTeam(
        store.rows(),
        { now: store.now, userId: 'u' },
        {
          pack: demoOrgPack(store.data),
          states: store.teamStates(),
        },
      ).placesCalls,
    ).toBe(false);
  });
});
