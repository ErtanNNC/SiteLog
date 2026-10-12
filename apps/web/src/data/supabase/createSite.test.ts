import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as Env from '@/lib/env';
import type { Db } from '@/lib/supabase';
import { SupabaseSource } from './SupabaseSource';

vi.mock('@/lib/env', async (importOriginal) => ({
  ...(await importOriginal<typeof Env>()),
  functionsUrl: (name: string) => `https://functions.test/v1/${name}`,
}));

/**
 * createSite / updateOrg against a minimal PostgREST + edge-function stand-in: the site insert,
 * the recipients rows, the api-invite-reporter and api-billing calls, and the update_org RPC.
 */
function setup(opts: { siteInsert?: 'ok' | 'fail'; recipients?: 'ok' | 'fail'; invite?: number }) {
  const inserted: Array<{ table: string; payload: unknown }> = [];
  const rpc = vi.fn(async (_fn: string, _args: unknown) => ({
    data: { changed: true },
    error: null,
  }));
  const sb = {
    from(table: string) {
      return {
        insert(payload: unknown) {
          inserted.push({ table, payload });
          const res =
            table === 'sites'
              ? opts.siteInsert === 'fail'
                ? {
                    data: null,
                    error: { message: 'duplicate key value violates unique constraint' },
                  }
                : { data: { id: 'site-1' }, error: null }
              : opts.recipients === 'fail'
                ? { data: null, error: { message: 'permission denied for site_recipients' } }
                : { data: null, error: null };
          return {
            select: () => ({ single: async () => res }),
            then: (ok: (v: typeof res) => unknown, ko: (e: unknown) => unknown) =>
              Promise.resolve(res).then(ok, ko),
          };
        },
        delete() {
          return { eq: async () => ({ error: null }) };
        },
      };
    },
    rpc,
  };
  const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
    const status = url.endsWith('/api-invite-reporter') ? (opts.invite ?? 200) : 200;
    const body = status === 200 ? { ok: true } : { error: 'WhatsApp template rejected' };
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', fetchMock);
  const source = new SupabaseSource(
    sb as unknown as Db,
    'org-1',
    { id: 'user-1', email: 'lena@kestrel.test', name: 'Lena', role: 'admin' },
    async () => 'token',
  );
  const functionCalls = () =>
    fetchMock.mock.calls.map(([url, init]) => ({
      name: url.split('/').at(-1),
      body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
    }));
  return { source, inserted, rpc, functionCalls };
}

const input = {
  name: 'Harbor View Apartments',
  projectCode: 'HV-5120',
  timezone: 'America/Chicago',
  recipients: ['pm@kestrelbuild.example'],
  reporter: {
    name: 'Elena Vasquez',
    phone: '+15550148001',
    role: 'site_manager' as const,
    siteIds: [],
    languages: ['en'],
  },
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('SupabaseSource.createSite', () => {
  it('returns the created site with the failed invite instead of throwing', async () => {
    const { source, inserted, functionCalls } = setup({ invite: 502 });
    await expect(source.createSite(input)).resolves.toEqual({
      siteId: 'site-1',
      inviteError: 'WhatsApp template rejected',
      recipientsError: null,
    });
    expect(inserted.map((i) => i.table)).toEqual(['sites', 'site_recipients']);
    expect(functionCalls()).toEqual([
      {
        name: 'api-invite-reporter',
        body: expect.objectContaining({ orgId: 'org-1', siteIds: ['site-1'] }),
      },
      // The subscription quantity follows the active sites (as after pause / resume).
      { name: 'api-billing', body: { action: 'sync', orgId: 'org-1' } },
    ]);
  });

  it('still invites the manager when saving the recipients fails', async () => {
    const { source, functionCalls } = setup({ recipients: 'fail' });
    await expect(source.createSite(input)).resolves.toEqual({
      siteId: 'site-1',
      inviteError: null,
      recipientsError: 'permission denied for site_recipients',
    });
    expect(functionCalls().map((c) => c.name)).toEqual(['api-invite-reporter', 'api-billing']);
  });

  it('rejects when the site itself is not created', async () => {
    const { source, functionCalls } = setup({ siteInsert: 'fail' });
    await expect(source.createSite(input)).rejects.toThrow(/duplicate key/);
    expect(functionCalls()).toEqual([]);
  });
});

describe('SupabaseSource.updateOrg', () => {
  it('edits the current org through update_org (never create_org)', async () => {
    const { source, rpc } = setup({});
    await source.updateOrg({
      name: 'Kestrel Build Group LLC',
      timezone: 'America/Denver',
      address: null,
      licenseNo: 'GC-1234',
    });
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith('update_org', {
      p_org_id: 'org-1',
      p_name: 'Kestrel Build Group LLC',
      p_timezone: 'America/Denver',
      p_address: null,
      p_license_no: 'GC-1234',
    });
  });
});
