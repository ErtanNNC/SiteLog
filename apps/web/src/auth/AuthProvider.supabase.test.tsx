import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as SupabaseSourceModule from '@/data/supabase/SupabaseSource';
import type { OrgSummary } from '@/data/types';
import { i18n } from '@/i18n/i18n';
import { useCopy } from '@/i18n/useCopy';
import type * as EnvModule from '@/lib/env';
import type { Db } from '@/lib/supabase';
import { fakeOrgsDb } from '@/test/fakeOrgsDb';
import { AuthProvider } from './AuthProvider';
import { RequireAuth } from './guards';

/** Supabase mode with a fake auth client: the test drives onAuthStateChange itself. */
const h = vi.hoisted(() => {
  type Listener = (event: string, session: unknown) => void;
  const state: { listener: Listener | null; db: Db | null } = { listener: null, db: null };
  const session = {
    access_token: 'token',
    user: { id: 'user-lena', email: 'lena@example.com', user_metadata: { full_name: 'Lena' } },
  };
  return {
    state,
    session,
    auth: {
      getSession: async () => ({ data: { session } }),
      onAuthStateChange: (cb: Listener) => {
        state.listener = cb;
        return { data: { subscription: { unsubscribe: () => (state.listener = null) } } };
      },
      setSession: async () => ({ error: null }),
      signOut: async () => ({ error: null }),
    },
    fetchOrgs: vi.fn<(sb: unknown, userId: string) => Promise<OrgSummary[]>>(),
    realFetchOrgs: null as typeof SupabaseSourceModule.fetchOrgs | null,
  };
});

vi.mock('@/lib/env', async (importOriginal) => {
  const mod = await importOriginal<typeof EnvModule>();
  return { ...mod, isDemo: false, env: { ...mod.env, demo: false } };
});
// PostgREST reads go to the test's fake database (`h.state.db`).
vi.mock('@/lib/supabase', () => ({
  supabase: {
    auth: h.auth,
    from: (table: string) => (h.state.db as unknown as { from(t: string): unknown }).from(table),
  },
}));
vi.mock('@/data/supabase/SupabaseSource', async (importOriginal) => {
  h.realFetchOrgs = (await importOriginal<typeof SupabaseSourceModule>()).fetchOrgs;
  return { fetchOrgs: h.fetchOrgs };
});

const ORG: OrgSummary = {
  id: 'org-1',
  name: 'Kestrel Builders',
  timezone: 'America/Chicago',
  activeSites: 1,
  role: 'admin',
};

function renderApp(
  page: ReactNode = (
    <label>
      Summary
      <input />
    </label>
  ),
) {
  render(
    <MemoryRouter initialEntries={['/reports/new']}>
      <AuthProvider>
        <Routes>
          <Route path="/login" element={<h1>Login page</h1>} />
          <Route element={<RequireAuth />}>
            <Route path="/reports/new" element={page} />
          </Route>
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  );
}

/** Records the panel's language on every render of the signed-in page (the shell's stand-in). */
const rendered: string[] = [];
function ShellProbe() {
  const { t, language } = useCopy();
  rendered.push(language);
  return <h1>{t('nav.overview')}</h1>;
}

describe('AuthProvider (Supabase mode)', () => {
  afterEach(() => {
    rendered.length = 0;
    h.state.db = null;
    h.fetchOrgs.mockReset();
    vi.unstubAllGlobals();
  });

  it('opens the panel in Turkish for a member of a tr-TR org, from the real org query (§6.3, §11.2)', async () => {
    // No saved choice and an English browser: only the org's tr-TR can make it Turkish.
    vi.stubGlobal('navigator', { ...navigator, languages: ['en-US'], language: 'en-US' });
    h.state.db = fakeOrgsDb({
      orgs: [
        { id: 'org-tr', name: 'Demir Yapı A.Ş.', timezone: 'Europe/Istanbul', locale: 'tr-TR' },
      ],
      org_members: [{ org_id: 'org-tr', user_id: h.session.user.id, role: 'admin' }],
      site_options: [{ id: 'site-1', org_id: 'org-tr', status: 'active' }],
    }).db;
    h.fetchOrgs.mockImplementation((sb, userId) => h.realFetchOrgs!(sb as Db, userId));
    expect(i18n.language).toBe('en');
    renderApp(<ShellProbe />);
    expect(await screen.findByRole('heading', { name: 'Genel bakış' })).toBeInTheDocument();
    expect(rendered[0]).toBe('tr');
    expect(new Set(rendered)).toEqual(new Set(['tr']));
  });

  it('keeps the page and its unsaved input when a SIGNED_IN for the same user fails to reload the orgs', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    h.fetchOrgs.mockResolvedValueOnce([ORG]).mockRejectedValue(new Error('network down'));
    renderApp();
    const input = await screen.findByLabelText('Summary');
    await userEvent.type(input, 'Poured the slab');

    // auth-js re-emits SIGNED_IN with the same session when the tab regains focus.
    await act(async () => {
      h.state.listener?.('SIGNED_IN', h.session);
    });
    await waitFor(() => expect(h.fetchOrgs).toHaveBeenCalledTimes(2));

    expect(screen.queryByText('Couldn’t load your companies.')).toBeNull();
    expect(screen.getByLabelText('Summary')).toHaveValue('Poured the slab');
  });

  it('still shows the error screen when the first org load for a user fails', async () => {
    h.fetchOrgs.mockRejectedValue(new Error('network down'));
    renderApp();
    expect(await screen.findByText('Couldn’t load your companies.')).toBeInTheDocument();
    expect(screen.queryByLabelText('Summary')).toBeNull();
  });
});
