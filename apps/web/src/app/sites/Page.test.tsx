import { act, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { kestrelDemo } from '@sitelog/shared/demo/kestrel.ts';
import { DemoStore } from '@/data/demo/store';
import { i18n } from '@/i18n/i18n';
import { makeAuthState, renderWithProviders } from '@/test/render';
import SitesPage from './Page';

/** The site card whose text names the site. */
function card(grid: HTMLElement, name: string): HTMLElement {
  const found = within(grid)
    .getAllByTestId('site-card')
    .find((c) => c.textContent?.includes(name));
  if (!found) throw new Error(`No site card for ${name}`);
  return found;
}

describe('SitesPage', () => {
  it('ends a populated grid with the "Connect another site" card', async () => {
    renderWithProviders(<SitesPage />, { route: '/sites' });
    const grid = await screen.findByRole('list', { name: 'Sites' });
    expect(within(grid).getAllByTestId('site-card')).toHaveLength(6);
    expect(within(grid).getByTestId('connect-site-card')).toHaveTextContent('Connect another site');
  });

  it('a new org with no sites: "No sites yet" and connect the first one, not "another"', async () => {
    const d = kestrelDemo();
    renderWithProviders(<SitesPage />, {
      route: '/sites',
      store: new DemoStore({ ...d, sites: [], siteReporters: [], recipients: [] }),
    });
    expect(await screen.findByRole('heading', { name: 'No sites yet' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Connect your first site' })).toHaveAttribute(
      'href',
      '/setup/site',
    );
    expect(screen.queryByTestId('connect-site-card')).toBeNull();
    expect(screen.queryByText('Connect another site')).not.toBeInTheDocument();
  });

  it('only admins get "Add site" and the connect cards (the setup wizard is admin-only)', async () => {
    renderWithProviders(<SitesPage />, { route: '/sites', as: 'ops' });
    const grid = await screen.findByRole('list', { name: 'Sites' });
    expect(within(grid).getAllByTestId('site-card')).toHaveLength(6);
    expect(screen.queryByTestId('connect-site-card')).toBeNull();
    expect(screen.queryByRole('link', { name: 'Add site' })).toBeNull();
  });

  it('a new org with no sites, as a project manager: ask an admin', async () => {
    const d = kestrelDemo();
    renderWithProviders(<SitesPage />, {
      route: '/sites',
      as: 'pm',
      store: new DemoStore({ ...d, sites: [], siteReporters: [], recipients: [] }),
    });
    expect(await screen.findByRole('heading', { name: 'No sites yet' })).toBeInTheDocument();
    expect(
      screen.getByText('An admin connects sites. Ask an admin to connect the first one.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Connect your first site' })).toBeNull();
  });

  it('an org whose only site is paused still shows the paused card in the grid', async () => {
    const d = kestrelDemo();
    const site = { ...d.sites[0]!, status: 'paused' as const, paused_at: '2026-10-01T15:00:00Z' };
    renderWithProviders(<SitesPage />, {
      route: '/sites',
      store: new DemoStore({ ...d, sites: [site] }),
    });
    const grid = await screen.findByRole('list', { name: 'Sites' });
    expect(within(grid).getAllByTestId('site-card')).toHaveLength(1);
    expect(within(grid).getByText('Paused since Oct 1')).toBeInTheDocument();
    expect(screen.queryByText('No sites yet')).not.toBeInTheDocument();
  });

  it('Web-Sites: subtitle, preference icon, crew today and weather days (P4, W1-18)', async () => {
    renderWithProviders(<SitesPage />, { route: '/sites' });
    const grid = await screen.findByRole('list', { name: 'Sites' });
    expect(
      screen.getByText('6 active · each reports daily by text link or call'),
    ).toBeInTheDocument();
    const riverside = card(grid, 'Riverside Lofts');
    expect(within(riverside).getByText('Marco Ruiz')).toBeInTheDocument();
    expect(within(riverside).getByTestId('contact-pref')).toHaveAttribute('data-pref', 'link');
    expect(within(riverside).getByText('Prefers text link')).toBeInTheDocument();
    expect(within(riverside).getByText('2 weather days in Oct')).toBeInTheDocument();
    expect(riverside.querySelector('a[href="tel:+15550143378"]')).not.toBeNull();
    const hillcrest = card(grid, 'Hillcrest');
    expect(within(hillcrest).getByTestId('contact-pref')).toHaveAttribute('data-pref', 'call');
    expect(within(hillcrest).getByText('Prefers call')).toBeInTheDocument();
    expect(within(grid).getByTestId('connect-site-card')).toHaveTextContent(
      '$399 / month · no setup fee',
    );
  });

  it('shows no price on the connect card where TalkOlog set none yet (spec §19 Q9, Q234)', async () => {
    const auth = makeAuthState('admin');
    renderWithProviders(<SitesPage />, {
      route: '/sites',
      auth: { currentOrg: { ...auth.currentOrg!, country: 'TR', locale: 'tr-TR', price: null } },
    });
    const card = await screen.findByTestId('connect-site-card');
    expect(card).toHaveTextContent('Connect another site');
    expect(card).not.toHaveTextContent('/ month');
  });

  it('speaks Turkish when the panel does', async () => {
    await act(() => i18n.changeLanguage('tr'));
    try {
      renderWithProviders(<SitesPage />, { route: '/sites' });
      const grid = await screen.findByRole('list', { name: 'Şantiyeler' });
      expect(
        screen.getByText('6 aktif · her biri her gün mesajdaki linkle ya da telefonla rapor verir'),
      ).toBeInTheDocument();
      const riverside = card(grid, 'Riverside Lofts');
      expect(within(riverside).getByText('Tercih: mesajla link')).toBeInTheDocument();
      expect(within(riverside).getByText('2 hava engeli günü (Eki)')).toBeInTheDocument();
      expect(within(grid).getByTestId('connect-site-card')).toHaveTextContent(
        'Başka bir şantiye bağlayın',
      );
      expect(screen.getByRole('tab', { name: /İlgi gereken/ })).toBeInTheDocument();
    } finally {
      await act(() => i18n.changeLanguage('en'));
    }
  });
});
