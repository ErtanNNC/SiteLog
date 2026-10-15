import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { toast } from 'sonner';
import { describe, expect, it, vi } from 'vitest';
import { DemoStore, type DemoLoginKey } from '@/data/demo/store';
import { i18n } from '@/i18n/i18n';
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
    expect(screen.getByText('Report deadline 17:30 CT')).toBeInTheDocument();
    expect(screen.getByText('Marco Ruiz')).toBeInTheDocument();
    expect(screen.getByText('Prefers text link · speaks ES & EN')).toBeInTheDocument();
    // P5: Call {first} dials from the office user's phone; no WhatsApp link any more.
    expect(screen.getByRole('link', { name: 'Call Marco' })).toHaveAttribute(
      'href',
      'tel:+15550143378',
    );
    expect(screen.queryByRole('link', { name: /Message Marco/ })).toBeNull();
    expect(document.querySelector('a[href*="wa.me"]')).toBeNull();
    // D30: typed reports stay.
    expect(screen.getByRole('link', { name: 'New report' })).toHaveAttribute(
      'href',
      expect.stringContaining('/reports/new?site='),
    );

    expect(screen.getByRole('grid', { name: 'October 2026' })).toBeInTheDocument();
    const oct9 = screen.getByRole('gridcell', { name: /^Open report for Oct 9 · / });
    // The hero report came in through the text link (channel 'web').
    expect(oct9.querySelector('[data-channel="link"]')).not.toBeNull();

    const latest = screen.getByTestId('latest-card');
    expect(within(latest).getByText('Latest · Oct 9')).toBeInTheDocument();
    expect(within(latest).getByText('24')).toBeInTheDocument();
    expect(within(latest).getByText('192')).toBeInTheDocument();
    expect(within(latest).getByText('3.5')).toBeInTheDocument();
    expect(within(latest).getByRole('button', { name: 'Open report' })).toBeInTheDocument();

    const crew = screen.getByRole('table', { name: 'Crew today, by company' });
    expect(within(crew).getByText('Apex Concrete')).toBeInTheDocument();
    expect(within(crew).getByText('Edited v2')).toBeInTheDocument();
    expect(within(crew).getByText('Confirmed by answer')).toBeInTheDocument();
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

  it('texts Marco today’s link from the header (P5, W1-16’s action)', async () => {
    const success = vi.spyOn(toast, 'success');
    const { store } = renderRiverside(new DemoStore(), 'ops');
    await screen.findByRole('heading', { name: 'Riverside Lofts — Block B' });
    const marco = store.data.reporters.find((r) => r.name === 'Marco Ruiz')!;
    const before = store.data.messages.length;
    await userEvent.click(screen.getByRole('button', { name: 'Text today’s link' }));
    await waitFor(() => expect(success).toHaveBeenCalledWith('Today’s link texted to Marco.'));
    expect(store.data.messages.length).toBe(before + 1);
    expect(store.data.messages.at(-1)).toMatchObject({
      reporter_id: marco.id,
      copy_key: 'daily_link',
    });
    expect(store.data.audit.at(-1)).toMatchObject({ action: 'daily_link.texted' });
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

  it('speaks Turkish when the panel does (W1-18)', async () => {
    await act(() => i18n.changeLanguage('tr'));
    try {
      renderRiverside();
      expect(
        await screen.findByRole('heading', { name: 'Riverside Lofts — Block B' }),
      ).toBeInTheDocument();
      expect(screen.getByRole('link', { name: 'Ara: Marco' })).toHaveAttribute(
        'href',
        'tel:+15550143378',
      );
      expect(screen.getByRole('button', { name: 'Şantiye ayarları' })).toBeInTheDocument();
      expect(screen.getByText(/^Tercih: mesajla link · ES ve EN konuşur$/)).toBeInTheDocument();
      expect(screen.getByRole('grid', { name: 'Ekim 2026' })).toBeInTheDocument();
      expect(screen.getByRole('tab', { name: 'Günlük raporlar' })).toBeInTheDocument();
      const crew = screen.getByRole('table', { name: 'Bugünkü ekip, firmaya göre' });
      expect(within(crew).getByText('Yanıtla onaylandı')).toBeInTheDocument();
      expect(within(crew).getByText('Düzenlendi v2')).toBeInTheDocument();
      expect(screen.getByText('Bu ay şimdiye kadar')).toBeInTheDocument();
    } finally {
      await act(() => i18n.changeLanguage('en'));
    }
  });
});
