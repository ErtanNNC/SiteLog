import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { DemoSource } from '@/data/demo/DemoSource';
import { storage } from '@/lib/utils';
import { AuthProvider, DEMO_SESSION_KEY } from './AuthProvider';
import { RequireAuth } from './guards';

function renderApp() {
  storage.set(DEMO_SESSION_KEY, { key: 'admin' });
  render(
    <MemoryRouter initialEntries={['/']}>
      <AuthProvider>
        <Routes>
          <Route path="/login" element={<h1>Login page</h1>} />
          <Route path="/setup" element={<h1>Setup wizard</h1>} />
          <Route element={<RequireAuth />}>
            <Route path="/" element={<h1>Overview page</h1>} />
          </Route>
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  );
}

describe('AuthProvider + RequireAuth', () => {
  it('a failed org load shows Retry instead of an endless skeleton, and Retry signs in', async () => {
    const getOrgs = vi
      .spyOn(DemoSource.prototype, 'getOrgs')
      .mockRejectedValueOnce(new Error('network down'));
    renderApp();
    expect(await screen.findByText('Couldn’t load your companies.')).toBeInTheDocument();
    expect(screen.getByText('network down')).toBeInTheDocument();
    // Not treated as "no orgs": that would send an existing customer to create a second company.
    expect(screen.queryByRole('heading', { name: 'Setup wizard' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('heading', { name: 'Overview page' })).toBeInTheDocument();
    expect(getOrgs).toHaveBeenCalledTimes(2);
  });

  it('offers Sign out from the error', async () => {
    vi.spyOn(DemoSource.prototype, 'getOrgs').mockRejectedValue(new Error('network down'));
    renderApp();
    await userEvent.click(await screen.findByRole('button', { name: 'Sign out' }));
    expect(await screen.findByRole('heading', { name: 'Login page' })).toBeInTheDocument();
    expect(storage.get(DEMO_SESSION_KEY, null)).toBeNull();
  });
});
