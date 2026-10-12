import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { toast } from 'sonner';
import { describe, expect, it, vi } from 'vitest';
import { DemoSource } from '@/data/demo/DemoSource';
import { DemoStore, demoUserFor } from '@/data/demo/store';
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
    await userEvent.click(
      within(sites).getByRole('button', { name: 'Pause Riverside Lofts — Block B' }),
    );
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

    await userEvent.click(
      within(row).getByRole('button', { name: 'Resume Riverside Lofts — Block B' }),
    );
    await userEvent.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Resume site' }),
    );
    await waitFor(() => expect(riverside.status).toBe('active'));
    await waitFor(() => expect(screen.getByTestId('plan-total')).toHaveTextContent('$2,394'));
    expect(store.data.audit.at(-1)!.action).toBe('site.resumed');
  });

  it('demo mode explains the Stripe portal for payment method and invoice downloads', async () => {
    const message = vi.spyOn(toast, 'message');
    renderWithProviders(<BillingPage />, { route: '/billing' });
    await userEvent.click(await screen.findByTestId('update-payment'));
    const invoices = screen.getByRole('table', { name: 'Invoices' });
    await userEvent.click(
      within(invoices).getByRole('button', { name: 'Download invoice Thu, Oct 1, 2026' }),
    );
    expect(message).toHaveBeenCalledTimes(2);
    expect(message).toHaveBeenLastCalledWith(
      'Demo mode: the Stripe customer portal opens here in production.',
    );
  });

  it('opens the Stripe customer portal from api-billing outside demo mode', async () => {
    const u = demoUserFor('admin');
    const source = new DemoSource(new DemoStore(), {
      id: u.id,
      email: u.email,
      name: u.name,
      role: u.role,
    });
    const portal = vi
      .spyOn(source, 'getBillingPortalUrl')
      .mockRejectedValueOnce(new Error('No Stripe customer yet; start a subscription first'))
      .mockResolvedValueOnce('https://billing.stripe.test/p/session');
    const error = vi.spyOn(toast, 'error');
    renderWithProviders(<BillingPage />, { route: '/billing', source, auth: { isDemo: false } });
    const invoices = await screen.findByRole('table', { name: 'Invoices' });
    await userEvent.click(screen.getByTestId('update-payment'));
    await waitFor(() =>
      expect(error).toHaveBeenCalledWith(
        'No Stripe customer yet; start a subscription first',
        expect.anything(),
      ),
    );
    await userEvent.click(
      within(invoices).getByRole('button', { name: 'Download invoice Thu, Oct 1, 2026' }),
    );
    await waitFor(() => expect(portal).toHaveBeenCalledTimes(2));
  });
});
