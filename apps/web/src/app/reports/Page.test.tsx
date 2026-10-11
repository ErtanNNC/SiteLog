import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { renderWithProviders } from '@/test/render';
import ReportsPage from './Page';

function renderReports(route = '/reports') {
  renderWithProviders(<ReportsPage />, { route, path: '/reports' });
}

const rowsOf = (table: HTMLElement) => [...table.querySelectorAll<HTMLElement>('tbody tr')];

describe('ReportsPage (demo archive)', () => {
  it('lists the first page of 50 reports, newest first', async () => {
    renderReports();
    expect(await screen.findByRole('heading', { name: 'Reports' })).toBeInTheDocument();
    const table = await screen.findByRole('table', { name: 'Reports' });
    const rows = rowsOf(table);
    expect(rows).toHaveLength(50);
    expect(rows[0]).toHaveTextContent('Fri Oct 9');
    expect(screen.getByTestId('result-count')).toHaveTextContent(/^\d+ reports$/);
    expect(screen.getByText(/Page 1 of \d+/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Download PDF RL-2041-0187' })).toBeInTheDocument();
  });

  it('weather toggle narrows to the 10 delay reports and offers the EOT pack action', async () => {
    renderReports();
    await screen.findByRole('table', { name: 'Reports' });
    await userEvent.click(screen.getByRole('button', { name: 'Has weather delay' }));
    await waitFor(() => expect(screen.getByTestId('result-count')).toHaveTextContent('10 reports'));
    expect(screen.getByRole('button', { name: 'Has weather delay' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    const pack = screen.getByTestId('build-pack');
    expect(pack).toHaveTextContent('Build EOT evidence pack from these');
    expect(pack).toHaveTextContent('36.5 h lost to weather in this set');
    expect(pack).toHaveAttribute('href', expect.stringContaining('/weather?'));
  });

  it('searches transcripts and shows the flags of the hero report', async () => {
    renderReports();
    await screen.findByRole('table', { name: 'Reports' });
    await userEvent.type(screen.getByLabelText('Search report text and transcripts'), 'llovió');
    await waitFor(() => expect(screen.getByTestId('result-count')).toHaveTextContent('1 report'));
    const row = rowsOf(screen.getByRole('table', { name: 'Reports' }))[0]!;
    expect(within(row).getByRole('link', { name: 'RL-2041-0187' })).toHaveAttribute(
      'href',
      expect.stringContaining('/reports/'),
    );
    expect(within(row).getByText('Rain 3.5 h')).toBeInTheDocument();
    expect(within(row).getByText('v2')).toBeInTheDocument();
    expect(within(row).getByText('Late 17:38')).toBeInTheDocument();
    expect(within(row).getByText('Filed')).toBeInTheDocument();
  });

  it('reads filters from the URL and selects rows for export', async () => {
    renderReports('/reports?status=needs_review&edited=0');
    await screen.findByRole('table', { name: 'Reports' });
    await waitFor(() => expect(screen.getByTestId('result-count')).toHaveTextContent('1 report'));
    const row = rowsOf(screen.getByRole('table', { name: 'Reports' }))[0]!;
    expect(within(row).getByText('Unknown sub')).toBeInTheDocument();
    expect(within(row).getByText('Needs review')).toBeInTheDocument();
    await userEvent.click(within(row).getByRole('checkbox', { name: /Select OM-1187-/ }));
    expect(screen.getByTestId('result-count')).toHaveTextContent('1 report · 1 selected');
    await userEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    await waitFor(() =>
      expect(screen.getByTestId('result-count')).not.toHaveTextContent('1 report'),
    );
  });
});
