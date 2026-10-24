import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DemoSource } from '@/data/demo/DemoSource';
import { i18n } from '@/i18n/i18n';
import { useCopy } from '@/i18n/useCopy';
import { storage } from '@/lib/utils';
import { AuthProvider } from './AuthProvider';
import { DEMO_SESSION_KEY } from './session';
import { RequireAuth } from './guards';

function renderApp(home: ReactNode = <h1>Overview page</h1>) {
  storage.set(DEMO_SESSION_KEY, { key: 'admin' });
  render(
    <MemoryRouter initialEntries={['/']}>
      <AuthProvider>
        <Routes>
          <Route path="/login" element={<h1>Login page</h1>} />
          <Route path="/setup" element={<h1>Setup wizard</h1>} />
          <Route element={<RequireAuth />}>
            <Route path="/" element={home} />
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

describe('AuthProvider + RequireAuth', () => {
  afterEach(() => {
    rendered.length = 0;
    vi.unstubAllGlobals();
  });

  it('applies a tr-TR org’s locale before the shell’s first render (no saved choice)', async () => {
    vi.stubGlobal('navigator', { ...navigator, languages: ['en-US'], language: 'en-US' });
    const getOrgs = DemoSource.prototype.getOrgs;
    vi.spyOn(DemoSource.prototype, 'getOrgs').mockImplementation(async function (this: DemoSource) {
      const orgs = await getOrgs.call(this);
      // The demo org is typed en-US; a Turkish customer's org is the same shape.
      return orgs.map((o) => ({ ...o, locale: 'tr-TR' })) as unknown as typeof orgs;
    });
    expect(i18n.language).toBe('en');
    renderApp(<ShellProbe />);
    expect(await screen.findByRole('heading', { name: 'Genel bakış' })).toBeInTheDocument();
    expect(rendered[0]).toBe('tr');
    expect(new Set(rendered)).toEqual(new Set(['tr']));
  });

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
