import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { DemoStore } from '@/data/demo/store';
import { renderWithProviders } from '@/test/render';
import BillingPage from './Page';

describe('BillingPage (demo data)', () => {
  it('shows the plan card, sites and invoices from §18', async () => {
    renderWithProviders(<BillingPage />, { route: '/billing' });
    expect(await screen.findByRole('heading', { name: 'Billing' })).toBeInTheDocument();
    expect(screen.getByText('$399 per active site, per month. No setup fee.')).toBeInTheDocument();
    const plan = screen.getByTestId('plan-card');
    expect(within(plan).getByTestId('plan-total')).toHaveTextContent('$2,394');
    expect(plan).toHaveTextContent('6 active sites × $399');
    expect(plan).toHaveTextContent('Sun, Nov 1, 2026');
    expect(plan).toHaveTextContent('Visa ending 4242');

    const sites = screen.getByRole('table', { name: 'Sites on this plan' });
    expect(within(sites).getAllByRole('row')).toHaveLength(7);
    const riverside = within(sites).getByText('Riverside Lofts — Block B').closest('tr')!;
    expect(riverside).toHaveTextContent('March 2026');
    expect(within(riverside).getByText('Active')).toBeInTheDocument();
    expect(riverside).toHaveTextContent('$399');

    const invoices = screen.getByRole('table', { name: 'Invoices' });
    const rows = within(invoices).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(4);
    expect(rows[0]).toHaveTextContent('Thu, Oct 1, 2026');
    expect(rows[0]).toHaveTextContent('$2,394');
    expect(rows[3]).toHaveTextContent('$1,596');
    expect(within(rows[0]!).getByText('Paid')).toBeInTheDocument();
  });

  it('pauses and resumes a site through the confirm dialog (F19)', async () => {
    const store = new DemoStore();
    renderWithProviders(<BillingPage />, { route: '/billing', store });
    const sites = await screen.findByRole('table', { name: 'Sites on this plan' });
    await userEvent.click(within(sites).getByRole('button', { name: 'Pause Riverside Lofts — Block B' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('Pause Riverside Lofts — Block B?');
    expect(dialog).toHaveTextContent('Reminders stop and it won’t be billed from next cycle.');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Pause site' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    const riverside = store.data.sites.find((s) => s.project_code === 'RL-2041')!;
    expect(riverside.status).toBe('paused');
    await waitFor(() => expect(screen.getByTestId('plan-total')).toHaveTextContent('$1,995'));
    expect(screen.getByTestId('plan-card')).toHaveTextContent('5 active sites × $399');
    const row = within(sites).getByText('Riverside Lofts — Block B').closest('tr')!;
    expect(within(row).getByText('Paused')).toBeInTheDocument();

    await userEvent.click(within(row).getByRole('button', { name: 'Resume Riverside Lofts — Block B' }));
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Resume site' }));
    await waitFor(() => expect(riverside.status).toBe('active'));
    await waitFor(() => expect(screen.getByTestId('plan-total')).toHaveTextContent('$2,394'));
    expect(store.data.audit.at(-1)!.action).toBe('site.resumed');
  });
});
