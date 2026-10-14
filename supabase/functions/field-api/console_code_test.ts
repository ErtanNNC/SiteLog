import { assertEquals } from '@std/assert';
import { toCountryPack, type ConsentType, type ReporterRow } from '@sitelog/shared';
import { DEMO_COUNTRIES } from '@sitelog/shared/demo/countries.ts';
import type { AppClient } from '../_shared/supabase.ts';
import type { VerifyCodeMessage } from './app.ts';
import { consoleVerifyCodeSender, verifyCodeChannel, verifyCodeText } from './console_code.ts';

/** The W1-07 `verify_code` sender's decision and text (the Notifier's rules, spec §4.5, §19 Q25). */

const pack = (code: 'US' | 'TR') => toCountryPack(DEMO_COUNTRIES.find((c) => c.code === code)!);

function message(
  over: Partial<ReporterRow> = {},
  held: ConsentType[] = [],
  revoked: ConsentType[] = [],
  country: 'US' | 'TR' = 'US',
  isDemo = false,
): VerifyCodeMessage {
  return {
    org: {
      id: 'o',
      name: 'Org',
      country,
      locale: 'en-US',
      timezone: 'America/Chicago',
      is_demo: isDemo,
    },
    pack: pack(country),
    reporter: {
      id: 'r',
      org_id: 'o',
      name: 'Marco Ruiz',
      phone_e164: '+15550143378',
      role: 'site_manager',
      languages: ['en'],
      status: 'invited',
      invited_at: null,
      verified_at: null,
      last_invite_error: null,
      created_at: '2026-10-01T00:00:00Z',
      locale: 'en-US',
      contact_pref: 'link',
      activated_at: null,
      opted_out_at: null,
      message_channel: null,
      ...over,
    },
    consents: { held: new Set(held), revoked: new Set(revoked) },
    code: '042917',
  };
}

Deno.test('verify_code goes by SMS before any consent answer (spec §19 Q25)', () => {
  assertEquals(verifyCodeChannel(message()), { channel: 'sms' });
  // ... whatever the person's preferred channel.
  assertEquals(verifyCodeChannel(message({ message_channel: 'whatsapp' })), { channel: 'sms' });
});

Deno.test('verify_code is not sent after an opt-out or a refused SMS consent', () => {
  assertEquals(verifyCodeChannel(message({ status: 'opted_out' })), {
    channel: null,
    reason: 'opted_out',
  });
  // Answered the consent prompt without texts: no SMS at all.
  assertEquals(verifyCodeChannel(message({}, ['recording', 'data_processing'])), {
    channel: null,
    reason: 'no_consent',
  });
  assertEquals(verifyCodeChannel(message({}, ['recording', 'sms'])), { channel: 'sms' });
  assertEquals(verifyCodeChannel(message({}, [], ['sms'])), {
    channel: null,
    reason: 'no_consent',
  });
});

Deno.test('the text is the §9.2 verify_code in the reporter language', () => {
  assertEquals(verifyCodeText(message()), 'SiteLog code: 042917. It expires in 10 minutes.');
  assertEquals(
    verifyCodeText(message({ locale: 'tr-TR' }, [], [], 'TR')),
    'SiteLog kodunuz: 042917. 10 dakika geçerlidir.',
  );
});

/** A service-role client that records the writes the console sender makes. */
function recordingAdmin() {
  const writes: { table: string; row: Record<string, unknown> }[] = [];
  const done = { throwOnError: () => Promise.resolve({ data: null, error: null }) };
  const admin = {
    from: (table: string) => ({
      insert: (row: Record<string, unknown>) => {
        writes.push({ table, row });
        return done;
      },
    }),
    rpc: (fn: string, args: Record<string, unknown>) => {
      writes.push({ table: `rpc:${fn}`, row: args });
      return done;
    },
  };
  return { admin: admin as unknown as AppClient, writes };
}

Deno.test(
  'the console code goes to demo orgs only: a real org gets no_channel and no row',
  async () => {
    const real = recordingAdmin();
    assertEquals(await consoleVerifyCodeSender(real.admin)(message()), {
      channel: null,
      reason: 'no_channel',
    });
    assertEquals(real.writes, [], 'no messages row an office user could read the code from');

    const demo = recordingAdmin();
    const sent = await consoleVerifyCodeSender(demo.admin)(message({}, [], [], 'US', true));
    assertEquals(sent.channel, 'sms');
    assertEquals(
      demo.writes.map((w) => w.table),
      ['messages', 'rpc:log_audit'],
    );
    assertEquals(demo.writes[0]!.row.body, 'SiteLog code: 042917. It expires in 10 minutes.');
    assertEquals(demo.writes[0]!.row.provider, 'console');
    // The opt-out still applies on a demo org.
    const optedOut = recordingAdmin();
    assertEquals(
      await consoleVerifyCodeSender(optedOut.admin)(
        message({ status: 'opted_out' }, [], [], 'US', true),
      ),
      { channel: null, reason: 'opted_out' },
    );
    assertEquals(optedOut.writes, []);
  },
);
