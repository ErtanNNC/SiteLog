import { describe, expect, it, vi } from 'vitest';
import type { Db } from '@/lib/supabase';
import { makeSource } from '@/test/render';
import { SupabaseSource } from '@/data/supabase/SupabaseSource';
import type { DataSource } from '@/data/source';
import { saveEmailLanguage, signInEmailData } from './emailLanguage';

vi.mock('@/lib/sentry', () => ({ captureError: vi.fn(() => null) }));
const { captureError } = await import('@/lib/sentry');

const user = { id: 'u-1', email: 'lena@example.com', name: 'Lena', role: 'admin' as const };

/** A SupabaseSource over a stand-in `auth` whose session carries `meta`. */
function sourceWith(meta: Record<string, unknown> | null, updateError: Error | null = null) {
  const updateUser = vi.fn(async (_attrs: { data: Record<string, unknown> }) => ({
    data: { user: null },
    error: updateError,
  }));
  const getSession = vi.fn(async () => ({
    data: { session: meta ? { user: { id: 'u-1', user_metadata: meta } } : null },
    error: null,
  }));
  const sb = { auth: { getSession, updateUser } } as unknown as Db;
  return { source: new SupabaseSource(sb, 'org-1', user, async () => null), updateUser };
}

describe('signInEmailData', () => {
  it('writes the templates’ ui_locale', () => {
    expect(signInEmailData('tr')).toEqual({ ui_locale: 'tr-TR' });
    expect(signInEmailData('en')).toEqual({ ui_locale: 'en-US' });
  });
});

describe('SupabaseSource.saveEmailLanguage (§19 Q340)', () => {
  it('writes the chosen language into the Auth metadata when it changes', async () => {
    const { source, updateUser } = sourceWith({ ui_locale: 'en-US', name: 'Lena' });
    await expect(source.saveEmailLanguage('tr')).resolves.toEqual({ updated: true });
    expect(updateUser).toHaveBeenCalledExactlyOnceWith({ data: { ui_locale: 'tr-TR' } });
  });

  it('writes it for a user whose metadata has no language yet', async () => {
    const { source, updateUser } = sourceWith({});
    await expect(source.saveEmailLanguage('en')).resolves.toEqual({ updated: true });
    expect(updateUser).toHaveBeenCalledExactlyOnceWith({ data: { ui_locale: 'en-US' } });
  });

  it('writes nothing when the metadata already says so', async () => {
    const { source, updateUser } = sourceWith({ ui_locale: 'tr-TR' });
    await expect(source.saveEmailLanguage('tr')).resolves.toEqual({ updated: false });
    expect(updateUser).not.toHaveBeenCalled();
  });

  it('writes nothing without a session', async () => {
    const { source, updateUser } = sourceWith(null);
    await expect(source.saveEmailLanguage('tr')).resolves.toEqual({ updated: false });
    expect(updateUser).not.toHaveBeenCalled();
  });

  it('rejects with Auth’s error, for the caller to report', async () => {
    const { source } = sourceWith({ ui_locale: 'en-US' }, new Error('network'));
    await expect(source.saveEmailLanguage('tr')).rejects.toThrow('network');
  });
});

describe('saveEmailLanguage (best effort)', () => {
  it('asks the source to write the language', async () => {
    const { source, updateUser } = sourceWith({ ui_locale: 'en-US' });
    saveEmailLanguage(source, 'tr');
    await vi.waitFor(() =>
      expect(updateUser).toHaveBeenCalledExactlyOnceWith({ data: { ui_locale: 'tr-TR' } }),
    );
  });

  it('skips the demo and a viewer without a source', () => {
    const demo = makeSource('admin');
    const spy = vi.spyOn(demo, 'saveEmailLanguage');
    saveEmailLanguage(demo, 'tr');
    saveEmailLanguage(null, 'tr');
    expect(spy).not.toHaveBeenCalled();
  });

  it('reports a failure and never throws', async () => {
    vi.mocked(captureError).mockClear();
    const { source } = sourceWith({ ui_locale: 'en-US' }, new Error('network'));
    expect(() => saveEmailLanguage(source, 'tr')).not.toThrow();
    await vi.waitFor(() => expect(captureError).toHaveBeenCalledOnce());
    expect(vi.mocked(captureError).mock.calls[0]?.[0]).toEqual(new Error('network'));

    const throwing = {
      mode: 'supabase',
      saveEmailLanguage: () => {
        throw new Error('sync');
      },
    } as unknown as DataSource;
    expect(() => saveEmailLanguage(throwing, 'en')).not.toThrow();
    expect(captureError).toHaveBeenCalledTimes(2);
  });
});
