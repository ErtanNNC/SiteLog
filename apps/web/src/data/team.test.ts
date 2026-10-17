import { describe, expect, it } from 'vitest';
import { DemoStore } from './demo/store';
import { demoOrgPack } from './demo/demoPhone';
import { assembleTeam, welcomeUndeliverable } from './assemble';
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
      settingsChannels: ['sms', 'whatsapp'],
      twoWaySms: true,
    });
    expect(team.orgLocale).toBe('en-US');
  });
});
