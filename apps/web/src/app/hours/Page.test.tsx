import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { DemoStore } from '@/data/demo/store';
import { renderWithProviders } from '@/test/render';
import HoursPage from './Page';

describe('HoursPage (demo data, week 2026-W41)', () => {
  it('shows the week picker, KPIs and the matrix totals from §18', async () => {
    renderWithProviders(<HoursPage />, { route: '/hours' });
    expect(await screen.findByRole('heading', { name: 'Crew hours' })).toBeInTheDocument();
    expect(screen.getByTestId('week-label')).toHaveTextContent('OCT 5 – OCT 9, 2026');
    expect(screen.getByTestId('kpi-sub-hours')).toHaveTextContent('1,804');
    expect(screen.getByText('Companies on site').parentElement).toHaveTextContent('7');
    expect(screen.getByTestId('kpi-gaps')).toHaveTextContent('2');
    expect(screen.getByText('+24 h · 2 subs')).toBeInTheDocument();

    const table = screen.getByRole('table', { name: 'Crew hours' });
    const apex = within(table).getByText('Apex Concrete').closest('tr')!;
    expect(apex).toHaveTextContent('472');
    expect(within(apex).getByText('match')).toBeInTheDocument();
    const bright = within(table).getByText('BrightLine Electric').closest('tr')!;
    expect(within(bright).getByTestId('gap-cell')).toHaveTextContent('+16 h');
    expect(bright).toHaveAttribute('data-status', 'gap');
    const delta = within(table).getByText('Delta Mechanical').closest('tr')!;
    expect(within(delta).getByText('awaiting')).toBeInTheDocument();
    const ridgeway = within(table).getByText('Ridgeway').closest('tr')!;
    expect(within(ridgeway).getByRole('link', { name: 'Confirm' })).toHaveAttribute(
      'href',
      expect.stringMatching(/^\/reports\//),
    );
    expect(screen.getByTestId('hours-total')).toHaveTextContent('1,804');
  });

  it('reads the week and site from the URL and steps weeks', async () => {
    renderWithProviders(<HoursPage />, { route: '/hours?week=2026-W40' });
    expect(await screen.findByTestId('week-label')).toHaveTextContent('SEP 28 – OCT 2, 2026');
    await userEvent.click(screen.getByRole('button', { name: 'Next week' }));
    await waitFor(() =>
      expect(screen.getByTestId('week-label')).toHaveTextContent('OCT 5 – OCT 9, 2026'),
    );
  });

  it('opens the invoice check for a gap row, builds the query email and marks it resolved', async () => {
    const store = new DemoStore();
    renderWithProviders(<HoursPage />, { route: '/hours', store });
    const table = await screen.findByRole('table', { name: 'Crew hours' });
    expect(screen.getByText('Select a row with a gap to compare it with the invoice.')).toBeVisible();
    await userEvent.click(
      within(table).getByRole('button', { name: 'Compare BrightLine Electric with its invoice' }),
    );
    const aside = await screen.findByTestId('invoice-check');
    expect(aside).toHaveTextContent('BL-3381 · Oct 5 – Oct 9');
    expect(within(aside).getByTestId('invoice-total-gap')).toHaveTextContent('+16');
    expect(within(aside).getByTestId('invoice-status')).toHaveTextContent('Open');
    expect(within(aside).getByTestId('invoice-evidence')).toHaveTextContent('five electricians');

    const query = within(aside).getByTestId('send-query');
    const href = query.getAttribute('href') ?? '';
    expect(href.startsWith('mailto:?subject=')).toBe(true);
    const body = decodeURIComponent(href.split('body=')[1] ?? '');
    expect(body).toContain('Total: invoiced 212 h, reported 196 h, gap +16');
    expect(body).toContain('/reports/');
    await userEvent.click(query);
    await waitFor(() =>
      expect(within(aside).getByTestId('invoice-status')).toHaveTextContent('Queried'),
    );
    expect(store.data.invoices.find((i) => i.invoice_no === 'BL-3381')!.status).toBe('queried');

    await userEvent.click(within(aside).getByRole('button', { name: 'Mark resolved' }));
    await waitFor(() =>
      expect(within(aside).getByTestId('invoice-status')).toHaveTextContent('Resolved'),
    );
    expect(store.data.invoices.find((i) => i.invoice_no === 'BL-3381')!.status).toBe('resolved');
    expect(store.data.audit.at(-1)!.action).toBe('invoice.resolved');
  });

  it('downloads the payroll CSV', async () => {
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => undefined);
    renderWithProviders(<HoursPage />, { route: '/hours' });
    await userEvent.click(await screen.findByRole('button', { name: 'Payroll CSV' }));
    await waitFor(() => expect(click).toHaveBeenCalledTimes(1));
    const anchor = click.mock.instances[0] as HTMLAnchorElement;
    expect(anchor.download).toBe('payroll-2026-W41.csv');
  });

  it('adds an invoice for Delta Mechanical with the week prefilled', async () => {
    const store = new DemoStore();
    renderWithProviders(<HoursPage />, { route: '/hours', store });
    await userEvent.click(await screen.findByRole('button', { name: 'Add invoice' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('combobox', { name: 'Company' }));
    await userEvent.click(await screen.findByRole('option', { name: 'Delta Mechanical' }));
    await waitFor(() => expect(within(dialog).getByLabelText('Mon')).toHaveValue('72'));
    expect(within(dialog).getByTestId('invoice-total')).toHaveTextContent('384 h');
    await userEvent.type(within(dialog).getByLabelText('Invoice number'), 'DM-1001');
    await userEvent.clear(within(dialog).getByLabelText('Fri'));
    await userEvent.type(within(dialog).getByLabelText('Fri'), '88');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add invoice' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    const inv = store.data.invoices.find((i) => i.invoice_no === 'DM-1001')!;
    expect(inv.total_hours).toBe(392);
    const table = screen.getByRole('table', { name: 'Crew hours' });
    await waitFor(() =>
      expect(within(table).getByText('Delta Mechanical').closest('tr')).toHaveTextContent('+8 h'),
    );
  });
});
