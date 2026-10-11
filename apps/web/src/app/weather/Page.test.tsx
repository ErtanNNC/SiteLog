import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
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
    expect(within(dialog).getByTestId('pack-summary')).toHaveTextContent(
      '10 site-days · 36.5 h lost',
    );
    await userEvent.click(within(dialog).getByRole('checkbox', { name: 'Photos' }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Generate PDF pack' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    const pack = store.data.packs[0]!;
    expect(pack.sections).toEqual(['summary', 'reports', 'transcripts', 'weather']);
    expect(pack.period_start).toBe('2026-10-01');
    const history = await screen.findByTestId('pack-history');
    await waitFor(() =>
      expect(within(history).getAllByTestId('pack-status')[0]).toHaveTextContent('Queued'),
    );
    store.dispose();
  });
});
