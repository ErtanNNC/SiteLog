import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { DemoStore, type DemoLoginKey } from '@/data/demo/store';
import { renderWithProviders } from '@/test/render';
import SiteDetailPage from './Page';

function renderRiverside(store = new DemoStore(), as: DemoLoginKey = 'admin') {
  const site = store.data.sites.find((s) => s.project_code === 'RL-2041')!;
  renderWithProviders(<SiteDetailPage />, {
    store,
    route: `/sites/${site.id}`,
    path: '/sites/:siteId',
    as,
  });
  return { store, site };
}

describe('SiteDetailPage (Riverside Lofts — Block B, Fri Oct 9 2026)', () => {
  it('renders the header meta, the October calendar and the latest report card', async () => {
    renderRiverside();
    expect(
      await screen.findByRole('heading', { name: 'Riverside Lofts — Block B' }),
    ).toBeInTheDocument();
    expect(screen.getByText('RL-2041')).toBeInTheDocument();
    expect(screen.getByText('Deadline 17:30 · America/Chicago')).toBeInTheDocument();
    expect(screen.getByText('Marco Ruiz')).toBeInTheDocument();
    expect(screen.getByText('Speaks ES · EN')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Message Marco' })).toHaveAttribute(
      'href',
      'https://wa.me/15550143378',
    );

    expect(screen.getByRole('grid', { name: 'October 2026' })).toBeInTheDocument();
    expect(screen.getByRole('gridcell', { name: 'Open report for Oct 9' })).toBeInTheDocument();

    const latest = screen.getByTestId('latest-card');
    expect(within(latest).getByText('Latest · Oct 9')).toBeInTheDocument();
    expect(within(latest).getByText('24')).toBeInTheDocument();
    expect(within(latest).getByText('192')).toBeInTheDocument();
    expect(within(latest).getByText('3.5')).toBeInTheDocument();
    expect(within(latest).getByRole('button', { name: 'Open report' })).toBeInTheDocument();

    const crew = screen.getByRole('table', { name: 'Crew today, by company' });
    expect(within(crew).getByText('Apex Concrete')).toBeInTheDocument();
    expect(within(crew).getByText('Edited v2')).toBeInTheDocument();
    expect(within(crew).getByText('Confirmed by reply')).toBeInTheDocument();
    expect(within(crew).getByText('Total').closest('tr')).toHaveTextContent('24');
  });

  it('switches tabs: crew & subs shows the weekly matrix, photos shows the grid', async () => {
    renderRiverside();
    await screen.findByRole('heading', { name: 'Riverside Lofts — Block B' });
    await userEvent.click(screen.getByRole('tab', { name: 'Crew & subs' }));
    const matrix = await screen.findByRole('table', { name: 'Crew & subs this week' });
    expect(within(matrix).getByText('Apex Concrete')).toBeInTheDocument();
    expect(within(matrix).getByText('Delta Mechanical')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open crew hours' })).toHaveAttribute(
      'href',
      expect.stringContaining('/hours?week=2026-W41&site='),
    );

    await userEvent.click(screen.getByRole('tab', { name: /Photos/ }));
    const grid = await screen.findByRole('list', { name: 'Photos' });
    expect(within(grid).getAllByRole('listitem').length).toBeGreaterThan(5);
    await userEvent.click(within(grid).getAllByRole('button')[0]!);
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('link', { name: /Open report RL-2041-/ })).toBeInTheDocument();
  });

  it('saves site settings and recipients through the drawer', async () => {
    const { store, site } = renderRiverside();
    await screen.findByRole('heading', { name: 'Riverside Lofts — Block B' });
    await userEvent.click(screen.getByRole('button', { name: 'Site settings' }));
    const dialog = await screen.findByRole('dialog');
    const hours = within(dialog).getByLabelText('Working hours');
    await userEvent.clear(hours);
    await userEvent.type(hours, '06:30–15:00');
    const recipients = within(dialog).getByLabelText('PDF recipients');
    await userEvent.clear(recipients);
    await userEvent.type(recipients, 'reports@kestrelbuild.example, lena@kestrelbuild.example');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(store.data.sites.find((s) => s.id === site.id)!.working_hours).toBe('06:30–15:00');
    expect(store.data.recipients.filter((r) => r.site_id === site.id).map((r) => r.email)).toEqual([
      'reports@kestrelbuild.example',
      'lena@kestrelbuild.example',
    ]);
  });

  it('offers Pause site to admins only (RLS lets only admins update a site)', async () => {
    renderRiverside();
    await screen.findByRole('heading', { name: 'Riverside Lofts — Block B' });
    await userEvent.click(screen.getByRole('button', { name: 'Site settings' }));
    expect(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Pause site' }),
    ).toBeInTheDocument();
  });

  it('hides Pause site from a project manager', async () => {
    renderRiverside(new DemoStore(), 'pm');
    await screen.findByRole('heading', { name: 'Riverside Lofts — Block B' });
    await userEvent.click(screen.getByRole('button', { name: 'Site settings' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('button', { name: 'Save changes' })).toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: 'Pause site' })).toBeNull();
  });
});
