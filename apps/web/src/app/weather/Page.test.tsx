import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { kestrelDemo } from '@sitelog/shared/demo/kestrel.ts';
import { PACK_START_GRACE_MS } from '@/data/assemble';
import { DemoStore } from '@/data/demo/store';
import { renderWithProviders } from '@/test/render';
import WeatherPage from './Page';

describe('WeatherPage (demo data, October 2026)', () => {
  it('shows the §18 KPIs, the heatmap and the delay log', async () => {
    renderWithProviders(<WeatherPage />, { route: '/weather' });
    expect(await screen.findByRole('heading', { name: 'Weather & delays' })).toBeInTheDocument();
    expect(screen.getByTestId('kpi-site-days')).toHaveTextContent('10');
    expect(screen.getByTestId('kpi-hours')).toHaveTextContent('36.5');
    expect(screen.getByTestId('kpi-claim-ready')).toHaveTextContent('7 / 10');
    expect(screen.getByText('audio + photo + weather data')).toBeInTheDocument();

    const heat = screen.getByRole('table', { name: 'Stoppage hours by site and day' });
    expect(within(heat).getByLabelText('Hillcrest School Extension, Oct 6: 8 h lost')).toHaveClass(
      'bg-heat-6',
    );
    expect(
      within(heat).getByLabelText('Riverside Lofts — Block B, Oct 9: 3.5 h lost'),
    ).toHaveTextContent('3.5');
    expect(
      within(heat).getByLabelText('Oakmont Medical Center, Oct 9: 0 h lost'),
    ).toHaveTextContent('');

    const log = screen.getByTestId('delay-log');
    expect(within(log).getAllByTestId('delay-entry')).toHaveLength(6);
    expect(log).toHaveTextContent('FRIDAY, OCT 9 · HILLCREST');
    expect(within(log).getAllByText('Photo requested').length).toBeGreaterThan(0);
    await userEvent.click(screen.getByRole('button', { name: 'Show more' }));
    expect(within(log).getAllByTestId('delay-entry')).toHaveLength(10);
  });

  it('filters by site from the URL', async () => {
    const store = new DemoStore();
    const hillcrest = store.data.sites.find((s) => s.project_code === 'HS-0418')!;
    renderWithProviders(<WeatherPage />, {
      route: `/weather?site=${hillcrest.id}&month=2026-10`,
      store,
    });
    expect(await screen.findByTestId('kpi-site-days')).toHaveTextContent('3');
    expect(screen.getByTestId('kpi-hours')).toHaveTextContent('17');
  });

  it('requests an EOT evidence pack and lists it in the pack history', async () => {
    const store = new DemoStore();
    renderWithProviders(<WeatherPage />, { route: '/weather', store });
    await userEvent.click(await screen.findByRole('button', { name: 'Build EOT evidence pack' }));
    const dialog = await screen.findByRole('dialog');
    // A pack is for one site (F16): unfiltered, the site with the most lost hours is preselected.
    expect(within(dialog).getByTestId('pack-summary')).toHaveTextContent('3 site-days · 17 h lost');
    await userEvent.click(within(dialog).getByRole('checkbox', { name: 'Photos' }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Generate PDF pack' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    const pack = store.data.packs[0]!;
    expect(pack.sections).toEqual(['summary', 'reports', 'transcripts', 'weather']);
    expect(pack.period_start).toBe('2026-10-01');
    expect(store.data.sites.find((x) => x.id === pack.site_id)?.name).toMatch(/^Hillcrest/);
    const history = await screen.findByTestId('pack-history');
    await waitFor(() =>
      expect(within(history).getAllByTestId('pack-status')[0]).toHaveTextContent('Queued'),
    );
    store.dispose();
  });
});

/** A new org: its members and self-perform crew, no sites and no reports yet. */
function noSites(): DemoStore {
  const d = kestrelDemo();
  return new DemoStore({
    ...d,
    sites: [],
    reporters: [],
    siteReporters: [],
    recipients: [],
    companies: d.companies.filter((c) => c.is_self_perform),
    conversations: [],
    messages: [],
    transcripts: [],
    unknownContacts: [],
    siteDays: [],
    reports: [],
    versions: [],
    sources: [],
    manpower: [],
    workItems: [],
    weatherEvents: [],
    questions: [],
    invoices: [],
    packs: [],
    notifications: [],
    audit: [],
  });
}

describe('WeatherPage edge cases', () => {
  it('explains an org with no sites instead of an empty heatmap, and cannot build a pack', async () => {
    renderWithProviders(<WeatherPage />, { route: '/weather', store: noSites() });
    expect(await screen.findByText('No sites yet')).toBeInTheDocument();
    expect(
      screen.queryByRole('table', { name: 'Stoppage hours by site and day' }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Add site' })).toHaveAttribute('href', '/setup/site');
    expect(screen.getByRole('button', { name: 'Build EOT evidence pack' })).toBeDisabled();
  });

  it('offers Add site only to the roles that can add one', async () => {
    renderWithProviders(<WeatherPage />, { route: '/weather', store: noSites(), as: 'pm' });
    expect(await screen.findByText('No sites yet')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Add site' })).not.toBeInTheDocument();
  });

  it('explains a month with no workdays yet instead of an empty heatmap', async () => {
    const store = new DemoStore();
    store.data.now = '2026-11-01T17:00:00.000Z'; // Sunday Nov 1
    renderWithProviders(<WeatherPage />, { route: '/weather', store });
    expect(await screen.findByText('No workdays in this month yet.')).toBeInTheDocument();
    expect(
      screen.queryByRole('table', { name: 'Stoppage hours by site and day' }),
    ).not.toBeInTheDocument();
  });

  it('falls back to this month for a month that does not exist', async () => {
    renderWithProviders(<WeatherPage />, { route: '/weather?month=2026-13' });
    expect(await screen.findByTestId('kpi-site-days')).toHaveTextContent('10');
    expect(screen.getByTestId('month-select')).toHaveTextContent('October 2026');
    expect(screen.queryByText(/undefined/)).not.toBeInTheDocument();
  });

  it('keeps every site in the picker when filtered and shows only that site in the heatmap', async () => {
    const store = new DemoStore();
    const hillcrest = store.data.sites.find((s) => s.project_code === 'HS-0418')!;
    renderWithProviders(<WeatherPage />, {
      route: `/weather?site=${hillcrest.id}&month=2026-10`,
      store,
    });
    expect(await screen.findByTestId('kpi-site-days')).toHaveTextContent('3');
    const heat = screen.getByRole('table', { name: 'Stoppage hours by site and day' });
    expect(
      within(heat)
        .getAllByRole('rowheader')
        .map((h) => h.textContent),
    ).toEqual(['Hillcrest']);
    await userEvent.click(screen.getByRole('combobox', { name: 'Site' }));
    const options = await screen.findAllByRole('option');
    expect(options).toHaveLength(store.data.sites.length + 1);
  });

  it('shows every site for a site that is not in the org', async () => {
    renderWithProviders(<WeatherPage />, { route: '/weather?site=not-a-site' });
    await waitFor(() => expect(screen.getByTestId('kpi-site-days')).toHaveTextContent('10'));
    expect(screen.getByRole('combobox', { name: 'Site' })).toHaveTextContent('All sites');
  });

  it('says when a pack has not started after ten minutes', async () => {
    const store = new DemoStore();
    store.data.packs.unshift({
      ...store.data.packs[0]!,
      id: 'pack-stuck',
      status: 'queued',
      pdf_path: null,
      ready_at: null,
      created_at: new Date(store.now.getTime() - PACK_START_GRACE_MS - 60_000).toISOString(),
    });
    renderWithProviders(<WeatherPage />, { route: '/weather', store });
    const history = await screen.findByTestId('pack-history');
    expect(within(history).getAllByTestId('pack-not-started')).toHaveLength(1);
    expect(within(history).getByTestId('pack-not-started')).toHaveTextContent(
      'Not started after 10 minutes. Evidence packs aren’t being built for your company right now. Contact SiteLog support.',
    );
  });

  it('says the pack summary covers the loaded month only when the period reaches past it', async () => {
    renderWithProviders(<WeatherPage />, { route: '/weather' });
    await userEvent.click(await screen.findByRole('button', { name: 'Build EOT evidence pack' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByTestId('pack-summary')).toHaveTextContent(
      /^3 site-days · 17 h lost$/,
    );
    fireEvent.change(within(dialog).getByLabelText('From'), { target: { value: '2026-09-20' } });
    expect(within(dialog).getByTestId('pack-summary')).toHaveTextContent(
      'October 2026 only: 3 site-days · 17 h lost',
    );
  });
});
