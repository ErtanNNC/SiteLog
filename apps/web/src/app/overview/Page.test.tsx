import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { toast } from 'sonner';
import { describe, expect, it, vi } from 'vitest';
import { kestrelDemo } from '@sitelog/shared/demo/kestrel.ts';
import type { DemoDataset } from '@sitelog/shared/demo/types.ts';
import { DemoSource } from '@/data/demo/DemoSource';
import { DemoStore, demoUserFor } from '@/data/demo/store';
import type { PdfLinkBatch, PdfSelection } from '@/data/source';
import { renderWithProviders } from '@/test/render';
import OverviewPage from './Page';

describe('OverviewPage (demo data, Fri Oct 9 2026)', () => {
  it('renders the eyebrow, title and KPIs from the §18 dataset', async () => {
    renderWithProviders(<OverviewPage />);
    expect(
      await screen.findByRole('heading', { name: 'Today across 6 sites' }),
    ).toBeInTheDocument();
    expect(screen.getByText('FRI, OCT 9, 2026 · 19:05')).toBeInTheDocument();
    expect(screen.getByTestId('kpi-reports-in')).toHaveTextContent('4 / 6');
    expect(
      screen.getByRole('img', { name: 'Breakdown: Filed 4, Weather day 1, Missing 1, Awaiting 0' }),
    ).toBeInTheDocument();
    expect(screen.getByText('Crew on site').parentElement).toHaveTextContent('68');
    expect(screen.getByText('Labor hours logged').parentElement).toHaveTextContent('544');
    expect(screen.getByText('Weather-affected sites').parentElement).toHaveTextContent('3');
  });

  it('tints the Elm St. missing row and links filed rows to their report', async () => {
    renderWithProviders(<OverviewPage />);
    const table = await screen.findByRole('table', { name: 'Sites today' });
    const elm = within(table).getByRole('link', { name: 'Elm St. Townhomes' }).closest('tr')!;
    expect(elm).toHaveClass('bg-chip-miss-bg/40');
    expect(within(elm).getByText('Missing')).toBeInTheDocument();
    const riverside = within(table)
      .getByRole('link', { name: 'Riverside Lofts — Block B' })
      .closest('tr')!;
    expect(within(riverside).getByText('Filed')).toBeInTheDocument();
    expect(within(riverside).getByText('17:38')).toBeInTheDocument();
    expect(within(riverside).getByText('3.5 h lost')).toBeInTheDocument();
    const oakmont = within(table)
      .getByRole('link', { name: 'Oakmont Medical Center' })
      .closest('tr')!;
    expect(within(oakmont).getByText('Needs review')).toBeInTheDocument();
    const hillcrest = within(table)
      .getByRole('link', { name: 'Hillcrest School Extension' })
      .closest('tr')!;
    expect(within(hillcrest).getByText('Weather day')).toBeInTheDocument();
  });

  it('lists needs-attention items in priority order with their actions', async () => {
    renderWithProviders(<OverviewPage />);
    const list = await screen.findByTestId('needs-attention');
    const kinds = [...list.querySelectorAll('[data-kind]')].map((el) =>
      el.getAttribute('data-kind'),
    );
    expect(kinds).toEqual([
      'missing',
      'needs_review',
      'invoice_gap',
      'invoice_gap',
      'unknown_sender',
      'glossary_review',
    ]);
    expect(within(list).getByText('Elm St. Townhomes — no report')).toBeInTheDocument();
    expect(within(list).getByText('Priya didn’t answer 2 reminders.')).toBeInTheDocument();
    expect(within(list).getByRole('link', { name: 'Call Priya' })).toHaveAttribute(
      'href',
      'tel:+15550147719',
    );
    expect(within(list).getByText('Invoice gap: BrightLine Electric +16 h')).toBeInTheDocument();
    expect(within(list).getByText('Invoice gap: ClearView Glazing +8 h')).toBeInTheDocument();
    expect(
      within(list).getByText('Unknown subcontractor “Ridgeway” · 6 workers'),
    ).toBeInTheDocument();
    expect(within(list).getByText('3 glossary terms to review')).toBeInTheDocument();
  });

  it('marks a missing site-day as no work through the confirm dialog', async () => {
    const store = new DemoStore();
    renderWithProviders(<OverviewPage />, { store });
    const list = await screen.findByTestId('needs-attention');
    await userEvent.click(within(list).getByRole('button', { name: 'Mark no work' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('Mark no work at Elm St. Townhomes?');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Mark no work' }));
    await waitFor(() =>
      expect(screen.queryByText('Elm St. Townhomes — no report')).not.toBeInTheDocument(),
    );
    const elm = store.data.sites.find((s) => s.project_code === 'ES-0377')!;
    expect(
      store.data.siteDays.find((d) => d.site_id === elm.id && d.date === '2026-10-09')!.status,
    ).toBe('no_work');
    expect(store.data.audit.at(-1)!.action).toBe('site_day.marked_no_work');
  });

  it("Today's PDFs explains demo mode instead of downloading", async () => {
    const message = vi.spyOn(toast, 'message');
    renderWithProviders(<OverviewPage />);
    await userEvent.click(await screen.findByTestId('todays-pdfs'));
    expect(message).toHaveBeenCalledWith(
      'Demo mode: PDFs are rendered by the worker from each filed report.',
    );
  });

  it("Today's PDFs downloads one zip of today's filed reports (signed URLs)", async () => {
    const u = demoUserFor('admin');
    const calls: PdfSelection[] = [];
    const source = new (class extends DemoSource {
      override async getPdfUrls(selection: PdfSelection): Promise<PdfLinkBatch> {
        calls.push(selection);
        const ids = 'reportIds' in selection ? selection.reportIds : [];
        return {
          files: ids.map((id, i) => ({
            reportId: id,
            reportNo: `NO-${i}`,
            url: `https://storage.test/${i}.pdf`,
          })),
          missing: [],
          total: ids.length,
          capped: false,
        };
      }
    })(new DemoStore(), { id: u.id, email: u.email, name: u.name, role: u.role });
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => new Response(new TextEncoder().encode('%PDF-1.7')));
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => undefined);
    const success = vi.spyOn(toast, 'success');
    renderWithProviders(<OverviewPage />, { source, auth: { isDemo: false } });
    await userEvent.click(await screen.findByTestId('todays-pdfs'));
    await waitFor(() => expect(click).toHaveBeenCalledTimes(1));
    expect((click.mock.instances[0] as unknown as HTMLAnchorElement).download).toBe(
      'SiteLog_daily-reports_2026-10-09.zip',
    );
    // The four reports filed today (Riverside, Oakmont, Pier 9, Northgate).
    expect(calls).toEqual([{ reportIds: expect.any(Array) }]);
    expect((calls[0] as { reportIds: string[] }).reportIds).toHaveLength(4);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(success).toHaveBeenCalledWith('4 PDFs zipped.', expect.anything());
  });
});

/**
 * A new org (§18 org and members, nothing else), optionally with the first §18 site. The demo
 * clock is Fri Oct 9 2026 19:05 Chicago, after the 17:30 deadline, and no site-day exists yet
 * (no scheduler has run), as in a deployment where reports are typed in the panel.
 */
function newOrg(
  opts: {
    site?: 'active' | 'paused';
    reporter?: boolean;
    reminder1?: boolean;
  } = {},
): DemoDataset {
  const d = kestrelDemo();
  const site = d.sites[0]!;
  const link = d.siteReporters.find((sr) => sr.site_id === site.id && sr.is_primary)!;
  const reporter = d.reporters.find((r) => r.id === link.reporter_id)!;
  return {
    ...d,
    settings: { ...d.settings, reminder1_enabled: opts.reminder1 ?? true },
    sites: opts.site
      ? [
          {
            ...site,
            report_seq: 0,
            status: opts.site,
            paused_at: opts.site === 'paused' ? '2026-10-01T15:00:00Z' : null,
          },
        ]
      : [],
    reporters: opts.reporter ? [reporter] : [],
    siteReporters: opts.reporter ? [link] : [],
    recipients: [],
    companies: [],
    glossary: [],
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
  };
}

describe('OverviewPage empty states', () => {
  it('no sites: connect the first one', async () => {
    renderWithProviders(<OverviewPage />, { store: new DemoStore(newOrg()) });
    expect(await screen.findByRole('heading', { name: 'No sites yet' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Connect your first site' })).toHaveAttribute(
      'href',
      '/setup/site',
    );
  });

  it('no sites, as a project manager: ask an admin, no link into the admin-only wizard', async () => {
    renderWithProviders(<OverviewPage />, { store: new DemoStore(newOrg()), as: 'pm' });
    expect(await screen.findByRole('heading', { name: 'No sites yet' })).toBeInTheDocument();
    expect(
      screen.getByText('An admin connects sites. Ask an admin to connect the first one.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Connect your first site' })).toBeNull();
  });

  it('every site paused: says so and points to Sites, not to connecting a first site', async () => {
    renderWithProviders(<OverviewPage />, { store: new DemoStore(newOrg({ site: 'paused' })) });
    expect(
      await screen.findByRole('heading', { name: 'All sites are paused' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open sites' })).toHaveAttribute('href', '/sites');
    expect(
      screen.getByText('Resume a site from its settings and daily reports start again.'),
    ).toBeInTheDocument();
    expect(screen.queryByText('No sites yet')).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Connect your first site' })).toBeNull();
  });

  it('every site paused, as a project manager: ask an admin (only admins can resume a site)', async () => {
    renderWithProviders(<OverviewPage />, {
      store: new DemoStore(newOrg({ site: 'paused' })),
      as: 'pm',
    });
    expect(
      await screen.findByRole('heading', { name: 'All sites are paused' }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        'An admin resumes sites. Ask an admin to resume one and daily reports start again.',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Resume a site from its settings/)).not.toBeInTheDocument();
  });

  it('one site, nothing reported, no site manager: not "all clear", and offers a typed report', async () => {
    renderWithProviders(<OverviewPage />, { store: new DemoStore(newOrg({ site: 'active' })) });
    expect(await screen.findByTestId('kpi-reports-in')).toHaveTextContent('0 / 1');
    const aside = screen.getByRole('complementary', { name: 'Needs attention' });
    expect(within(aside).getByRole('heading', { name: 'Nothing needs you yet' })).toBeVisible();
    expect(within(aside).getByText('1 site still to report today.')).toBeInTheDocument();
    expect(screen.queryByText('All clear')).not.toBeInTheDocument();
    expect(screen.queryByText(/Every site has reported/)).not.toBeInTheDocument();

    expect(
      screen.getByRole('heading', { name: 'No site manager reports by WhatsApp yet' }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Reminders go out/)).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'New report' })).toHaveAttribute(
      'href',
      '/reports/new',
    );
  });

  it('a verified site manager and reminders on: the deadline and the first reminder', async () => {
    renderWithProviders(<OverviewPage />, {
      store: new DemoStore(newOrg({ site: 'active', reporter: true })),
    });
    expect(
      await screen.findByRole('heading', {
        name: 'Reports usually arrive after 17:30. Reminders go out at 17:45.',
      }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'New report' })).toBeNull();
  });

  it('reminders turned off: the deadline only', async () => {
    renderWithProviders(<OverviewPage />, {
      store: new DemoStore(newOrg({ site: 'active', reporter: true, reminder1: false })),
    });
    expect(
      await screen.findByRole('heading', { name: 'Reports usually arrive after 17:30.' }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Reminders go out/)).not.toBeInTheDocument();
  });

  it('every site in and nothing waiting: all clear', async () => {
    const d = newOrg({ site: 'active', reporter: true });
    const site = d.sites[0]!;
    d.siteDays = [
      {
        id: 'sd-1',
        site_id: site.id,
        date: '2026-10-09',
        status: 'no_work',
        deadline_at: '2026-10-09T22:30:00Z',
        reminder_stage: 0,
        reminders_paused: false,
        is_late: false,
        weather: null,
        report_id: null,
        created_at: '2026-10-09T05:00:00Z',
        updated_at: '2026-10-09T18:00:00Z',
      },
    ];
    renderWithProviders(<OverviewPage />, { store: new DemoStore(d) });
    const aside = await screen.findByRole('complementary', { name: 'Needs attention' });
    expect(within(aside).getByRole('heading', { name: 'All clear' })).toBeInTheDocument();
    expect(
      within(aside).getByText('Every site has reported and nothing is waiting on you.'),
    ).toBeInTheDocument();
    // A no-work day is an outcome: no "reports usually arrive" hint for it.
    expect(screen.queryByText(/Reports usually arrive/)).not.toBeInTheDocument();
  });
});
