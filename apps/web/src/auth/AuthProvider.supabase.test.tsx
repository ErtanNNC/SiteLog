import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import type { OrgSummary } from '@/data/types';
import type * as EnvModule from '@/lib/env';
import { AuthProvider } from './AuthProvider';
import { RequireAuth } from './guards';

/** Supabase mode with a fake auth client: the test drives onAuthStateChange itself. */
const h = vi.hoisted(() => {
  type Listener = (event: string, session: unknown) => void;
  const state: { listener: Listener | null } = { listener: null };
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
  };
});

vi.mock('@/lib/env', async (importOriginal) => {
  const mod = await importOriginal<typeof EnvModule>();
  return { ...mod, isDemo: false, env: { ...mod.env, demo: false } };
});
vi.mock('@/lib/supabase', () => ({ supabase: { auth: h.auth } }));
vi.mock('@/data/supabase/SupabaseSource', () => ({ fetchOrgs: h.fetchOrgs }));

const ORG: OrgSummary = {
  id: 'org-1',
  name: 'Kestrel Builders',
  timezone: 'America/Chicago',
  activeSites: 1,
  role: 'admin',
};

function renderApp() {
  render(
    <MemoryRouter initialEntries={['/reports/new']}>
      <AuthProvider>
        <Routes>
          <Route path="/login" element={<h1>Login page</h1>} />
          <Route element={<RequireAuth />}>
            <Route
              path="/reports/new"
              element={
                <label>
                  Summary
                  <input />
                </label>
              }
            />
          </Route>
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  );
}

describe('AuthProvider (Supabase mode)', () => {
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
