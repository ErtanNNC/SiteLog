import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as Env from '@/lib/env';
import type { Db } from '@/lib/supabase';
import { CodedError } from '@/lib/utils';
import { SupabaseSource } from './SupabaseSource';

vi.mock('@/lib/env', async (importOriginal) => ({
  ...(await importOriginal<typeof Env>()),
  functionsUrl: (name: string) => `https://functions.test/v1/${name}`,
}));

/** W4-03: Team's RPCs and functions as the panel calls them against a database. */

const user = { id: 'u-1', email: 'a@b.example', name: 'A', role: 'ops' as const };

function rpcSource(answer: { data?: unknown; error?: { message: string } | null }) {
  const rpc = vi.fn(async () => ({ data: answer.data ?? null, error: answer.error ?? null }));
  const source = new SupabaseSource({ rpc } as unknown as Db, 'org-1', user, async () => null);
  return { rpc, source };
}

afterEach(() => vi.unstubAllGlobals());

describe('SupabaseSource Team (W4-03)', () => {
  it('update_reporter_contact: the whole state, attested; a refusal is a CodedError', async () => {
    const ok = rpcSource({ data: { id: 'r-1', changed: true } });
    expect(
      await ok.source.updateReporterContact({
        reporterId: 'r-1',
        contactPref: 'link',
        messageChannel: 'whatsapp',
        locale: 'en-US',
        attested: true,
      }),
    ).toEqual({ changed: true });
    expect(ok.rpc).toHaveBeenCalledWith('update_reporter_contact', {
      p_reporter_id: 'r-1',
      p_contact_pref: 'link',
      p_message_channel: 'whatsapp',
      p_locale: 'en-US',
      p_attested: true,
    });
    const refused = rpcSource({ error: { message: 'attestation_required' } });
    const err = await refused.source
      .updateReporterContact({
        reporterId: 'r-1',
        contactPref: 'call',
        messageChannel: null,
        locale: 'en-US',
        attested: false,
      })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CodedError);
    expect(err).toMatchObject({ code: 'attestation_required' });
    const other = rpcSource({ error: { message: 'not allowed' } });
    const plain = await other.source.revokeReporterDevices('r-1').catch((e: unknown) => e);
    expect(plain).not.toBeInstanceOf(CodedError);
  });

  it('revoke_reporter_devices and clear_reporter_opt_out with the attestation’s wording version', async () => {
    const { rpc, source } = rpcSource({ data: { devices: 2 } });
    expect(await source.revokeReporterDevices('r-1')).toEqual({ devices: 2 });
    await source.clearReporterOptOut('r-1', true);
    expect(rpc).toHaveBeenLastCalledWith('clear_reporter_opt_out', {
      p_reporter_id: 'r-1',
      p_text_version: 'team.texts_again.v1',
      p_attested: true,
    });
  });

  it('names the reporter to api-text-daily-link and the UI language to api-invite-office-user', async () => {
    const fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ sent: true, channel: 'sms', ok: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    vi.stubGlobal('fetch', fetch);
    const source = new SupabaseSource({} as Db, 'org-1', user, async () => 'token');
    await source.textDailyLink('site-1', 'req-1', 'r-1');
    await source.addOfficeUser({ email: 'dana@x.example', role: 'pm', uiLocale: 'tr-TR' });
    const bodies = (fetch.mock.calls as unknown as Array<[string, RequestInit]>).map(
      ([, init]) => JSON.parse(init.body as string) as unknown,
    );
    expect(bodies[0]).toEqual({ siteId: 'site-1', requestId: 'req-1', reporterId: 'r-1' });
    expect(bodies[1]).toEqual({
      orgId: 'org-1',
      email: 'dana@x.example',
      role: 'pm',
      uiLocale: 'tr-TR',
    });
  });
});
