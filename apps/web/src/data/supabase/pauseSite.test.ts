import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as Env from '@/lib/env';
import type { Db } from '@/lib/supabase';
import { SupabaseSource } from './SupabaseSource';

vi.mock('@/lib/env', async (importOriginal) => ({
  ...(await importOriginal<typeof Env>()),
  functionsUrl: (name: string) => `https://functions.test/v1/${name}`,
}));

/**
 * W4-10 (docs/AUDIT_BACKLOG.md "Site settings drawer … open to pm/ops; in Supabase, pause and edit
 * silently do nothing but toast success"): the update reads the row back, so a write RLS refused
 * (no row) fails instead of reporting success, and no quantity sync follows it. A failed sync is
 * left to the `billing_sync` job the database queued (20261017000450).
 */
function setup(opts: { rows: number; billing: number }) {
  const updates: unknown[] = [];
  const sb = {
    from(_table: string) {
      return {
        update(patch: unknown) {
          updates.push(patch);
          return {
            eq: () => ({
              select: async () => ({
                data: Array.from({ length: opts.rows }, () => ({ id: 'site-1' })),
                error: null,
              }),
            }),
          };
        },
      };
    },
  };
  const fetchMock = vi.fn(
    async (_url: string, _init?: RequestInit) =>
      new Response(JSON.stringify(opts.billing === 200 ? { synced: true } : { error: 'down' }), {
        status: opts.billing,
        headers: { 'content-type': 'application/json' },
      }),
  );
  vi.stubGlobal('fetch', fetchMock);
  const source = new SupabaseSource(
    sb as unknown as Db,
    'org-1',
    { id: 'user-1', email: 'lena@kestrel.test', name: 'Lena', role: 'pm' },
    async () => 'token',
  );
  return { source, updates, fetchMock };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('SupabaseSource pause / resume', () => {
  it('fails loudly when RLS refused the write (a pm or ops user), with no sync', async () => {
    const { source, fetchMock } = setup({ rows: 0, billing: 200 });
    await expect(source.pauseSite('site-1')).rejects.toThrow('You’re not allowed to do that.');
    await expect(source.resumeSite('site-1')).rejects.toThrow('You’re not allowed to do that.');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('pauses, then syncs the quantity; a failed sync does not fail the pause', async () => {
    const { source, updates, fetchMock } = setup({ rows: 1, billing: 502 });
    await expect(source.pauseSite('site-1')).resolves.toBeUndefined();
    expect(updates[0]).toMatchObject({ status: 'paused' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]![0])).toBe('https://functions.test/v1/api-billing');
  });
});
