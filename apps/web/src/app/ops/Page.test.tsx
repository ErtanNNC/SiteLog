import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { DemoSource } from '@/data/demo/DemoSource';
import { demoOpsFor } from '@/data/demo/ops';
import { DemoStore, demoUserFor } from '@/data/demo/store';
import { renderWithProviders } from '@/test/render';
import OpsPage from './Page';

describe('OpsPage (demo data)', () => {
  it('shows queue health, dead jobs without phone numbers or bodies, and the cost outlier', async () => {
    renderWithProviders(<OpsPage />, { route: '/ops' });
    expect(await screen.findByRole('heading', { name: 'Ops', level: 1 })).toBeInTheDocument();
    expect(screen.getByText('SiteLog internal')).toBeInTheDocument();

    const kpis = screen.getByTestId('ops-kpis');
    expect(kpis).toHaveTextContent('Queued6');
    expect(kpis).toHaveTextContent('Running2');
    expect(kpis).toHaveTextContent('Dead2');
    expect(kpis).toHaveTextContent('Oldest waiting14 s');

    const queue = screen.getByRole('table', { name: 'Queue by job type' });
    expect(within(queue).getAllByRole('row')).toHaveLength(6); // header + 5 types
    const pdfRow = within(queue).getByText('render_pdf').closest('tr')!;
    expect(pdfRow.querySelectorAll('td')[3]).toHaveTextContent('1');

    const dead = screen.getByRole('table', { name: 'Dead jobs' });
    expect(within(dead).getAllByRole('row')).toHaveLength(3);
    const pdf = within(dead).getByText('#48213').closest('tr')!;
    expect(pdf).toHaveTextContent('render_pdf');
    expect(pdf).toHaveTextContent('StorageError: upload to pdfs timed out after 30000 ms');
    expect(within(pdf).getByTitle(/^reportId: /)).toBeInTheDocument();
    expect(pdf).toHaveTextContent('Oct 9 · 23:43 UTC');
    expect(dead.textContent).not.toMatch(/\+1 555|\+1555|Marco/);

    const costs = screen.getByRole('table', { name: 'Cost outliers' });
    // Same org as the operator's current org: the report number links to the report.
    const link = within(costs).getByRole('link', { name: /^RL-2041-\d{4}$/ });
    expect(link.getAttribute('href')).toMatch(/^\/reports\/.+/);
    const outlier = link.closest('tr')!;
    expect(outlier).toHaveTextContent('Kestrel Build Group');
    expect(outlier).toHaveTextContent('$0.41');
    expect(outlier).toHaveTextContent('AI $0.39 · 3 templates');
    expect(outlier).toHaveTextContent('$0.06');
    expect(outlier).toHaveTextContent('412 reports in baseline');
    expect(outlier).toHaveTextContent('6.8×');
  });

  it('shows the M8 measure per org and week, below the target in words (W3-17)', async () => {
    const store = new DemoStore();
    const site = store.data.siteDays[0]!;
    const template = store.data.calls[0]!;
    const outbound = (id: string, day: string, outcome: string) =>
      store.data.calls.push({
        ...template,
        id,
        direction: 'outbound',
        purpose: 'reminder',
        attempt: 1,
        site_day_id: day,
        outcome: outcome as never,
      });
    const days = store.data.siteDays.filter((d) => d.date === site.date).slice(0, 2);
    outbound('00000000-0000-4000-8000-0000000ca201', days[0]!.id, 'filed');
    outbound('00000000-0000-4000-8000-0000000ca202', days[1]!.id, 'not_reached');
    renderWithProviders(<OpsPage />, { route: '/ops', store });
    const table = await screen.findByRole('table', { name: 'Reminder calls (M8)' });
    const row = within(table).getAllByRole('row').at(-1)!;
    expect(row).toHaveTextContent('Kestrel Build Group');
    expect(row).toHaveTextContent('Demo');
    expect(screen.getByText('Below the 85% target')).toBeInTheDocument();
  });

  it('retries a dead job after confirming, refreshes the lists and records the operator', async () => {
    const store = new DemoStore();
    renderWithProviders(<OpsPage />, { route: '/ops', store });
    await userEvent.click(await screen.findByRole('button', { name: 'Retry job 48213' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('Retry job 48213 (render_pdf)?');
    expect(dialog).toHaveTextContent('5 fresh attempts');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Retry job' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await waitFor(() => expect(screen.queryByText('#48213')).not.toBeInTheDocument());
    expect(screen.getByTestId('ops-kpis')).toHaveTextContent('Dead1');
    expect(screen.getByTestId('ops-kpis')).toHaveTextContent('Queued7');
    expect(demoOpsFor(store).audit).toEqual([
      expect.objectContaining({
        action: 'ops.job_retried',
        jobId: 48213,
        type: 'render_pdf',
        actorId: demoUserFor('admin').id,
      }),
    ]);
  });

  it('discards a dead job through the destructive confirm; cancel leaves it alone', async () => {
    const store = new DemoStore();
    renderWithProviders(<OpsPage />, { route: '/ops', store });
    await userEvent.click(await screen.findByRole('button', { name: 'Discard job 48190' }));
    let dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.getByText('#48190')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Discard job 48190' }));
    dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('Discard job 48190 (send_template)?');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Discard job' }));
    await waitFor(() => expect(screen.queryByText('#48190')).not.toBeInTheDocument());
    expect(screen.getByTestId('ops-kpis')).toHaveTextContent('Dead1');
    expect(demoOpsFor(store).audit.map((a) => a.action)).toEqual(['ops.job_discarded']);
  });

  it('shows the not-found page to anyone who is not a platform admin', async () => {
    const du = demoUserFor('admin');
    const source = new DemoSource(
      new DemoStore(),
      { id: du.id, email: du.email, name: du.name, role: du.role },
      { platformAdmin: false },
    );
    renderWithProviders(<OpsPage />, { route: '/ops', source });
    expect(await screen.findByRole('heading', { name: 'Page not found' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Ops' })).not.toBeInTheDocument();
    expect(screen.queryByText('Dead jobs')).not.toBeInTheDocument();
    await expect(source.getOps()).rejects.toThrow('Not found.');
    await expect(source.retryDeadJob(48213)).rejects.toThrow('Not found.');
  });
});

describe('OpsPage: unknown contacts with no organisation (spec §19 Q44, W1-16)', () => {
  it('lists them for SiteLog staff and ignores one, audited', async () => {
    const store = new DemoStore();
    const luis = store.data.unknownContacts[0]!;
    store.data.unknownContacts.push({
      ...luis,
      id: 'unknown:orgless',
      org_id: null,
      phone_e164: '+15550100999',
      channel: 'sms',
      call_id: null,
      snippet: 'Hi, this is Sam from the Elm St. crew',
      status: 'pending',
    });
    renderWithProviders(<OpsPage />, { route: '/ops', store });
    const card = await screen.findByTestId('orgless-contacts');
    const table = await within(card).findByRole('table', {
      name: 'Unknown contacts with no organisation',
    });
    // Only the org-less one: the caller of Kestrel's §18.1 story belongs to Kestrel.
    expect(within(table).getAllByRole('row')).toHaveLength(2);
    expect(table).toHaveTextContent('Hi, this is Sam from the Elm St. crew');
    // A demo org cannot take a real contact: nothing to assign to here.
    expect(within(table).getByRole('button', { name: 'Assign' })).toBeDisabled();
    await userEvent.click(within(table).getByRole('button', { name: 'Ignore' }));
    await waitFor(() =>
      expect(within(card).getByText('No unknown contacts without an organisation.')).toBeVisible(),
    );
    expect(store.data.unknownContacts.at(-1)!.status).toBe('ignored');
    expect(store.data.audit.at(-1)).toMatchObject({
      action: 'ops.unknown_contact_ignored',
      entity_id: 'unknown:orgless',
    });
  });
});
