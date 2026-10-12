import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { toast } from 'sonner';
import { describe, expect, it, vi } from 'vitest';
import { DemoSource } from '@/data/demo/DemoSource';
import { DemoStore, demoUserFor } from '@/data/demo/store';
import type { PdfLinkBatch, PdfSelection } from '@/data/source';
import { renderWithProviders } from '@/test/render';
import ReportsPage from './Page';

/** Demo data, but with rendered PDFs behind signed URLs (what SupabaseSource returns). */
class PdfSource extends DemoSource {
  calls: PdfSelection[] = [];
  constructor() {
    const u = demoUserFor('admin');
    super(new DemoStore(), { id: u.id, email: u.email, name: u.name, role: u.role });
  }
  override async getPdfUrls(selection: PdfSelection): Promise<PdfLinkBatch> {
    this.calls.push(selection);
    const demo = await super.getPdfUrls(selection);
    const [first, ...rest] = demo.missing;
    return {
      files: first
        ? [{ reportId: 'r', reportNo: first, url: `https://storage.test/${first}.pdf` }]
        : [],
      missing: rest,
      total: demo.total,
      capped: demo.capped,
    };
  }
}

function renderLive(route = '/reports') {
  const source = new PdfSource();
  renderWithProviders(<ReportsPage />, {
    route,
    path: '/reports',
    source,
    auth: { isDemo: false },
  });
  return source;
}

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

  it('demo mode explains the zip export instead of downloading', async () => {
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click');
    const message = vi.spyOn(toast, 'message');
    renderReports();
    await screen.findByRole('table', { name: 'Reports' });
    await userEvent.click(screen.getByTestId('export-zip'));
    expect(message).toHaveBeenCalledWith(
      expect.stringMatching(/^Demo mode: a zip with \d+ PDFs would download here/),
    );
    expect(click).not.toHaveBeenCalled();
  });
});

describe('ReportsPage PDF export (signed URLs)', () => {
  it('zips the selected rows into one download named after the org date', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => new Response(new TextEncoder().encode('%PDF-1.7')));
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => undefined);
    const success = vi.spyOn(toast, 'success');
    const source = renderLive('/reports?status=needs_review');
    await waitFor(() => expect(screen.getByTestId('result-count')).toHaveTextContent('1 report'));
    const row = rowsOf(screen.getByRole('table', { name: 'Reports' }))[0]!;
    await userEvent.click(within(row).getByRole('checkbox', { name: /Select OM-1187-/ }));
    await userEvent.click(screen.getByTestId('export-zip'));
    await waitFor(() => expect(click).toHaveBeenCalledTimes(1));
    const anchor = click.mock.instances[0] as unknown as HTMLAnchorElement;
    expect(anchor.download).toBe('SiteLog_reports_2026-10-09.zip');
    expect(source.calls).toHaveLength(1);
    expect(source.calls[0]).toEqual({ reportIds: [expect.any(String)] });
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringMatching(/^https:\/\/storage\.test\/OM-1187-\d+\.pdf$/),
      expect.anything(),
    );
    expect(success).toHaveBeenCalledWith('1 PDF zipped.', expect.anything());
  });

  it('exports every report matching the filters when nothing is selected', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      async () => new Response(new TextEncoder().encode('%PDF-1.7')),
    );
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => undefined);
    const warning = vi.spyOn(toast, 'warning');
    const source = renderLive('/reports?wx=1');
    await waitFor(() => expect(screen.getByTestId('result-count')).toHaveTextContent('10 reports'));
    await userEvent.click(screen.getByTestId('export-zip'));
    await waitFor(() => expect(click).toHaveBeenCalledTimes(1));
    expect(source.calls[0]).toMatchObject({ filters: { hasWeatherDelay: true, page: 1 } });
    // One file came back with a URL; the other nine have no PDF yet.
    await waitFor(() =>
      expect(warning).toHaveBeenCalledWith(
        '1 PDF zipped · 9 not ready or failed to download.',
        expect.anything(),
      ),
    );
  });

  it('opens a row PDF in a new tab once its signed URL arrives', async () => {
    const tab = { opener: {}, closed: false, location: { href: '' }, close: vi.fn() };
    const open = vi.spyOn(window, 'open').mockReturnValue(tab as unknown as Window);
    renderLive();
    await screen.findByRole('table', { name: 'Reports' });
    await userEvent.click(screen.getByRole('button', { name: 'Download PDF RL-2041-0187' }));
    expect(open).toHaveBeenCalledWith('', '_blank');
    await waitFor(() => expect(tab.location.href).toBe('https://storage.test/RL-2041-0187.pdf'));
    expect(tab.opener).toBeNull();
    expect(tab.close).not.toHaveBeenCalled();
  });
});
