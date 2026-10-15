import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as Env from '@/lib/env';
import type { Db } from '@/lib/supabase';
import { CodedError } from '@/lib/utils';
import { SupabaseSource } from './SupabaseSource';

vi.mock('@/lib/env', async (importOriginal) => ({
  ...(await importOriginal<typeof Env>()),
  functionsUrl: (name: string) => `https://functions.test/v1/${name}`,
}));

/** api-text-daily-link's answers as the panel reads them (W1-18). */
function source(response: Response) {
  const fetch = vi.fn(async () => response);
  vi.stubGlobal('fetch', fetch);
  const user = { id: 'u-1', email: 'a@b.example', name: 'A', role: 'ops' as const };
  return { fetch, source: new SupabaseSource({} as Db, 'org-1', user, async () => 'token') };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

afterEach(() => vi.unstubAllGlobals());

describe('SupabaseSource.textDailyLink', () => {
  it('throws the 409’s details.code as a CodedError, with the server’s message', async () => {
    const { source: s } = source(
      json(409, {
        error: 'No site manager is linked to this site',
        details: { code: 'no_reporter' },
      }),
    );
    const err = await s.textDailyLink('site-1', 'req-1').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CodedError);
    expect(err).toMatchObject({
      code: 'no_reporter',
      message: 'No site manager is linked to this site',
    });
  });

  it('throws a plain Error when the answer has no code', async () => {
    const { source: s } = source(json(409, { error: 'This site is not active' }));
    const err = await s.textDailyLink('site-1', 'req-1').catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(CodedError);
    expect(err).toMatchObject({ message: 'This site is not active' });
  });

  it('maps a sent text', async () => {
    const { source: s, fetch } = source(
      json(200, { sent: true, reporterId: 'r-1', channel: 'sms', reportDate: '2026-10-15' }),
    );
    expect(await s.textDailyLink('site-1', 'req-1')).toEqual({ sent: true, channel: 'sms' });
    expect(fetch).toHaveBeenCalledWith(
      'https://functions.test/v1/api-text-daily-link',
      expect.objectContaining({ method: 'POST' }),
    );
  });
});
