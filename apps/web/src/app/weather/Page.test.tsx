import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { kestrelDemo } from '@sitelog/shared/demo/kestrel.ts';
import { PACK_START_GRACE_MS } from '@/data/assemble';
import { DemoStore } from '@/data/demo/store';
import { i18n } from '@/i18n/i18n';
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

// W3-07: Weather & delays on v1.2 — Turkish, call chips, units, spec §19 Q134.
describe('WeatherPage on v1.2 (W3-07)', () => {
  it('reads in Turkish: dates, hours in "sa", the chips and the pack dialog', async () => {
    await act(() => i18n.changeLanguage('tr'));
    try {
      renderWithProviders(<WeatherPage />, { route: '/weather' });
      expect(
        await screen.findByRole('heading', { name: 'Hava durumu ve gecikmeler' }),
      ).toBeInTheDocument();
      expect(screen.getByTestId('kpi-hours')).toHaveTextContent('36,5');
      expect(screen.getByText('ses + fotoğraf + hava verisi')).toBeInTheDocument();
      const heat = screen.getByRole('table', { name: 'Şantiye ve güne göre duruş saatleri' });
      expect(
        within(heat).getByLabelText('Riverside Lofts — Block B, 9 Eki: 3,5 sa kayıp'),
      ).toHaveTextContent('3,5');
      const log = screen.getByTestId('delay-log');
      // Dates in the panel's language; site names in their own (the org's locale).
      expect(log).toHaveTextContent('CUMA, 9 EKİ · HILLCREST');
      expect(log).toHaveTextContent('Arama 0:41');
      expect(within(log).getAllByText('Fotoğraf istendi').length).toBeGreaterThan(0);
      expect(within(log).getAllByText(/^Sesli not \d+:\d\d$/).length).toBeGreaterThan(0);
      await userEvent.click(
        screen.getByRole('button', { name: 'Süre uzatımı kanıt dosyası oluştur' }),
      );
      const dialog = await screen.findByRole('dialog');
      expect(within(dialog).getByTestId('pack-summary')).toHaveTextContent(
        '3 şantiye günü · 17 sa kayıp',
      );
      expect(within(dialog).getByRole('checkbox', { name: 'Döküm alıntıları' })).toBeChecked();
    } finally {
      await act(() => i18n.changeLanguage('en'));
    }
  });

  it('shows a call second as a Call chip that opens the report’s player there', async () => {
    const store = new DemoStore();
    // Hillcrest's Oct 9 rain came in on the R1 call-back (§18.1): its period cites the call.
    const hillcrest = store.data.sites.find((s) => s.project_code === 'HS-0418')!;
    const call = store.data.calls.find(
      (c) => c.site_id === hillcrest.id && c.report_id !== null && c.status === 'completed',
    )!;
    renderWithProviders(<WeatherPage />, { route: '/weather', store });
    const log = await screen.findByTestId('delay-log');
    const chip = within(log).getByRole('link', { name: /^Open report HS-0418-\d+ at call 0:41$/ });
    expect(chip).toHaveTextContent('Call 0:41');
    expect(chip.getAttribute('href')).toBe(`/reports/${call.report_id}?clip=${call.id}&at=41`);
    const voice = within(log).getAllByRole('link', { name: /at voice note 0:41$/ })[0]!;
    expect(voice.getAttribute('href')).toMatch(/\?clip=[^&]+&at=41$/);
  });

  it('counts a day filed without confirmation as claim-ready only once signed off (Q134)', async () => {
    const store = new DemoStore();
    const ready = store.data.weatherEvents.find(
      (w) => w.claim_ready && w.date.startsWith('2026-10'),
    )!;
    const report = store.data.reports.find((r) => r.id === ready.report_id)!;
    report.confirmed_at = null;
    report.confirmed_via = null;
    report.review_reasons = ['unconfirmed'];
    report.status = 'filed';
    const { unmount } = renderWithProviders(<WeatherPage />, { route: '/weather', store });
    expect(await screen.findByTestId('kpi-claim-ready')).toHaveTextContent('6 / 10');
    await userEvent.click(screen.getByRole('button', { name: 'Show more' }));
    expect(screen.getAllByTestId('awaiting-sign-off')).toHaveLength(1);
    expect(screen.getByTestId('awaiting-sign-off')).toHaveTextContent(
      'Not confirmed by the site manager: claim-ready once signed off',
    );
    unmount();
    report.status = 'signed_off';
    renderWithProviders(<WeatherPage />, { route: '/weather', store });
    expect(await screen.findByTestId('kpi-claim-ready')).toHaveTextContent('7 / 10');
    expect(screen.queryByTestId('awaiting-sign-off')).not.toBeInTheDocument();
  });

  it('shows observed precipitation in the org’s units', async () => {
    const store = new DemoStore();
    store.data.org.units = 'metric';
    renderWithProviders(<WeatherPage />, { route: '/weather', store });
    const log = await screen.findByTestId('delay-log');
    expect(within(log).getAllByText(/Observed precip \d+(\.\d)? mm/).length).toBeGreaterThan(0);
    expect(within(log).queryByText(/\d in\b/)).not.toBeInTheDocument();
  });
});
