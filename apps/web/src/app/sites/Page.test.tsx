import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { kestrelDemo } from '@sitelog/shared/demo/kestrel.ts';
import { DemoStore } from '@/data/demo/store';
import { renderWithProviders } from '@/test/render';
import SitesPage from './Page';

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
});
