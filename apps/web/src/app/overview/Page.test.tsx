import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { toast } from 'sonner';
import { describe, expect, it, vi } from 'vitest';
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
