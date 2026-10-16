import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { DemoStore } from '@/data/demo/store';
import { i18n } from '@/i18n/i18n';
import { makeSource, renderWithProviders } from '@/test/render';
import { InvoiceCheckAside } from './InvoiceCheckAside';
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
    expect(
      screen.getByText('Select a row with a gap to compare it with the invoice.'),
    ).toBeVisible();
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

describe('HoursPage edge cases', () => {
  it('shows no invoiced total and no "match" when nothing is compared (one site)', async () => {
    const store = new DemoStore();
    const riverside = store.data.sites.find((s) => s.project_code === 'RL-2041')!;
    renderWithProviders(<HoursPage />, { route: `/hours?site=${riverside.id}`, store });
    const total = await screen.findByTestId('hours-total');
    const cells = within(total).getAllByRole('cell');
    expect(cells.at(-2)).toHaveTextContent('—');
    expect(cells.at(-1)).toHaveTextContent('awaiting');
    expect(total).not.toHaveTextContent('match');
  });

  it('falls back to this week for a week that does not exist', async () => {
    for (const week of ['2026-W99', '2026-W00', '2027-W53']) {
      const view = renderWithProviders(<HoursPage />, { route: `/hours?week=${week}` });
      expect(await screen.findByTestId('week-label'), week).toHaveTextContent(
        'OCT 5 – OCT 9, 2026',
      );
      view.unmount();
    }
  });

  it('explains why Add invoice has no company to choose', async () => {
    const store = new DemoStore();
    for (const c of store.data.companies) if (!c.is_self_perform) c.status = 'unconfirmed';
    renderWithProviders(<HoursPage />, { route: '/hours', store });
    await userEvent.click(await screen.findByRole('button', { name: 'Add invoice' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByTestId('no-companies')).toHaveTextContent(
      'No subcontractors yet. A company appears here once a filed report lists its crew.',
    );
    expect(within(dialog).queryByRole('combobox', { name: 'Company' })).not.toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Add invoice' })).toBeDisabled();
  });

  it('adds an invoice for a company with no hours this week and opens its check', async () => {
    const store = new DemoStore();
    store.data.companies.push({
      ...store.data.companies.find((c) => !c.is_self_perform && c.status === 'confirmed')!,
      id: 'company-summit',
      name: 'Summit Glazing',
      trade: 'Glazing',
      aliases: [],
    });
    renderWithProviders(<HoursPage />, { route: '/hours', store });
    await userEvent.click(await screen.findByRole('button', { name: 'Add invoice' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('combobox', { name: 'Company' }));
    await userEvent.click(await screen.findByRole('option', { name: 'Summit Glazing' }));
    await userEvent.type(within(dialog).getByLabelText('Invoice number'), 'SG-0042');
    await userEvent.type(within(dialog).getByLabelText('Mon'), '8');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add invoice' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    const table = screen.getByRole('table', { name: 'Crew hours' });
    const row = (await within(table).findByText('Summit Glazing')).closest('tr')!;
    expect(row).toHaveAttribute('data-status', 'gap');
    expect(within(row).getByTestId('gap-cell')).toHaveTextContent('+8 h');
    const aside = await screen.findByTestId('invoice-check');
    expect(aside).toHaveTextContent('Summit Glazing');
    expect(aside).toHaveTextContent(
      'No site report recorded hours for this company on the gap days.',
    );
  });

  it('shows an accounts user the evidence report number without a link', async () => {
    renderWithProviders(<HoursPage />, { route: '/hours', as: 'accounts' });
    const table = await screen.findByRole('table', { name: 'Crew hours' });
    await userEvent.click(
      within(table).getByRole('button', { name: 'Compare BrightLine Electric with its invoice' }),
    );
    const aside = await screen.findByTestId('invoice-check');
    const chips = within(aside).getAllByTestId('evidence-report');
    expect(chips.length).toBeGreaterThan(0);
    expect(chips[0]).toHaveTextContent(/[A-Z]{2}-\d{4}-\d{4}/);
    expect(within(aside).queryByRole('link', { name: /^Open report/ })).not.toBeInTheDocument();
  });
});

describe('InvoiceCheckAside', () => {
  it('labels evidence from a typed report as the report, not as audio', async () => {
    const hours = await makeSource().getHours('2026-W41');
    const row = hours.rows.find((r) => r.companyName === 'BrightLine Electric')!;
    const invoice = hours.invoices.find((i) => i.invoiceId === row.invoiceId)!;
    const first = invoice.evidence[0]!;
    const typed = {
      ...invoice,
      evidence: [{ ...first, kind: 'report' as const, clipId: null, at: null, quote: null }],
    };
    renderWithProviders(<InvoiceCheckAside invoice={typed} row={row} onClose={() => {}} />);
    const link = await screen.findByRole('link', { name: `Open report ${first.reportNo}` });
    expect(link).toHaveTextContent(first.reportNo);
    expect(link).not.toHaveTextContent(/audio/i);
    const body = decodeURIComponent(
      screen.getByTestId('send-query').getAttribute('href')!.split('body=')[1]!,
    );
    expect(body).toContain('Site report evidence:');
    expect(body).not.toContain('voice notes');
  });
});

// W3-06: Crew hours on v1.2 — Turkish, call evidence, accounts without report links.
describe('HoursPage on v1.2 (W3-06)', () => {
  const week = ['2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09'];
  /** A second Apex invoice for W41 (the newer one is compared): Friday +8 h, Northgate's call day. */
  function withApexGap(store = new DemoStore()) {
    const apex = store.data.companies.find((c) => c.name === 'Apex Concrete')!;
    store.data.invoices.push({
      ...store.data.invoices.find((i) => i.invoice_no === 'AP-1097')!,
      id: 'invoice-ap-1098',
      invoice_no: 'AP-1098',
      lines: week.map((date, i) => ({ date, hours: [88, 96, 96, 88, 112][i]! })),
      total_hours: 480,
      created_at: '2026-10-09T21:00:00.000Z',
    });
    return { store, apex };
  }

  it('reads in Turkish: hours in "sa", numbers, weekdays and the invoice check', async () => {
    await act(() => i18n.changeLanguage('tr'));
    try {
      renderWithProviders(<HoursPage />, { route: '/hours?week=2026-W41' });
      expect(await screen.findByRole('heading', { name: 'Ekip saatleri' })).toBeInTheDocument();
      expect(screen.getByTestId('week-label')).toHaveTextContent('5 EKİ – 9 EKİ, 2026');
      expect(screen.getByTestId('kpi-sub-hours')).toHaveTextContent('1.804');
      expect(screen.getByText('+24 sa · 2 taşeron')).toBeInTheDocument();
      const table = screen.getByRole('table', { name: 'Ekip saatleri' });
      for (const d of ['Pzt', 'Sal', 'Çar', 'Per', 'Cum'])
        expect(within(table).getByRole('columnheader', { name: d })).toBeInTheDocument();
      const bright = within(table).getByText('BrightLine Electric').closest('tr')!;
      expect(within(bright).getByTestId('gap-cell')).toHaveTextContent('+16 sa');
      expect(within(table).getAllByText('eşleşiyor').length).toBeGreaterThan(0);
      await userEvent.click(
        within(table).getByRole('button', {
          name: 'BrightLine Electric firmasını faturasıyla karşılaştır',
        }),
      );
      const aside = await screen.findByTestId('invoice-check');
      expect(aside).toHaveTextContent('Fatura kontrolü');
      expect(aside).toHaveTextContent('BL-3381 · 5 Eki – 9 Eki');
      expect(within(aside).getByTestId('invoice-status')).toHaveTextContent('Açık');
      expect(within(aside).getByRole('link', { name: /^RL-2041-0187 raporunu ses 0:19/ })).toBe(
        within(aside)
          .getAllByTestId('evidence-link')
          .find((l) => l.textContent?.includes('0187')),
      );
      const body = decodeURIComponent(
        within(aside).getByTestId('send-query').getAttribute('href')!.split('body=')[1]!,
      );
      expect(body).toContain('Toplam: faturalanan 212 sa, raporlanan 196 sa, fark +16');
      expect(body).toContain('RL-2041-0187 · ses 0:19');
      expect(screen.getByRole('button', { name: 'Fatura ekle' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Bordro CSV' })).toBeInTheDocument();
    } finally {
      await act(() => i18n.changeLanguage('en'));
    }
  });

  it('links each voice-note second to P7 at that second', async () => {
    renderWithProviders(<HoursPage />, { route: '/hours?week=2026-W41' });
    const table = await screen.findByRole('table', { name: 'Crew hours' });
    await userEvent.click(
      within(table).getByRole('button', { name: 'Compare BrightLine Electric with its invoice' }),
    );
    const aside = await screen.findByTestId('invoice-check');
    const hero = within(aside).getByRole('link', {
      name: 'Open report RL-2041-0187 at audio 0:19',
    });
    expect(hero.getAttribute('href')).toMatch(/^\/reports\/[^?]+\?clip=[^&]+&at=19$/);
    expect(hero).toHaveAttribute('data-kind', 'voice_note');
  });

  it('shows a gap on Northgate’s call day with a call chip that opens P7 at the second', async () => {
    const { store } = withApexGap();
    renderWithProviders(<HoursPage />, { route: '/hours?week=2026-W41', store });
    const table = await screen.findByRole('table', { name: 'Crew hours' });
    const apexRow = within(table).getByText('Apex Concrete').closest('tr')!;
    expect(within(apexRow).getByTestId('gap-cell')).toHaveTextContent('+8 h');
    await userEvent.click(
      within(table).getByRole('button', { name: 'Compare Apex Concrete with its invoice' }),
    );
    const aside = await screen.findByTestId('invoice-check');
    const call = within(aside).getByRole('link', {
      name: /^Open report NG-2210-\d+ at call 0:10$/,
    });
    const ngReport = store.data.reports.find((r) => r.report_no.startsWith('NG-2210-0069'))!;
    const ngCall = store.data.calls.find((c) => c.report_id === ngReport.id)!;
    expect(call).toHaveAttribute('href', `/reports/${ngReport.id}?clip=${ngCall.id}&at=10`);
    expect(call).toHaveTextContent('call 0:10');
    // No transcript of that call in the demo: the crew line stands in for the words.
    expect(call.closest('li')).toHaveTextContent('“Apex Concrete · 3 × 8 h = 24 h”');
    const body = decodeURIComponent(
      within(aside).getByTestId('send-query').getAttribute('href')!.split('body=')[1]!,
    );
    expect(body).toContain(`NG-2210-0069 · call 0:10: “Apex Concrete · 3 × 8 h = 24 h”`);
  });

  it('gives an accounts user the call and voice-note seconds without links', async () => {
    const { store } = withApexGap();
    renderWithProviders(<HoursPage />, { route: '/hours?week=2026-W41', store, as: 'accounts' });
    const table = await screen.findByRole('table', { name: 'Crew hours' });
    // Ridgeway (unconfirmed): accounts cannot open the report or the glossary to confirm it.
    const ridgeway = within(table).getByText('Ridgeway').closest('tr')!;
    expect(within(ridgeway).queryByRole('link')).toBeNull();
    expect(within(ridgeway).getByTestId('unconfirmed-ask')).toHaveAttribute(
      'title',
      'Heard in a report but not yet a known subcontractor. Ask an ops user to confirm it.',
    );
    await userEvent.click(
      within(table).getByRole('button', { name: 'Compare Apex Concrete with its invoice' }),
    );
    const aside = await screen.findByTestId('invoice-check');
    expect(within(aside).queryAllByTestId('evidence-link')).toHaveLength(0);
    const chips = within(aside).getAllByTestId('evidence-report');
    expect(chips.some((c) => c.dataset.kind === 'call' && /call 0:10/.test(c.textContent!))).toBe(
      true,
    );
    const body = decodeURIComponent(
      within(aside).getByTestId('send-query').getAttribute('href')!.split('body=')[1]!,
    );
    expect(body).not.toContain('/reports/');
  });

  it('posts one invoice_gap notice when an invoice is added with a gap', async () => {
    const store = new DemoStore();
    renderWithProviders(<HoursPage />, { route: '/hours?week=2026-W41', store, as: 'accounts' });
    await userEvent.click(await screen.findByRole('button', { name: 'Add invoice' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('combobox', { name: 'Company' }));
    await userEvent.click(await screen.findByRole('option', { name: 'Delta Mechanical' }));
    await waitFor(() => expect(within(dialog).getByLabelText('Mon')).toHaveValue('72'));
    await userEvent.type(within(dialog).getByLabelText('Invoice number'), 'DM-1001');
    await userEvent.clear(within(dialog).getByLabelText('Fri'));
    await userEvent.type(within(dialog).getByLabelText('Fri'), '88');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add invoice' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    const notices = store.data.notifications.filter(
      (n) => n.kind === 'invoice_gap' && n.title.includes('Delta Mechanical'),
    );
    expect(notices.map((n) => n.title)).toEqual(['Invoice gap: Delta Mechanical +8 h']);
  });
});
