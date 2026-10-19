import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { toast } from 'sonner';
import { describe, expect, it, vi } from 'vitest';
import { kestrelDemo } from '@sitelog/shared/demo/kestrel.ts';
import type { DemoDataset } from '@sitelog/shared/demo/types.ts';
import { emptyReportDataV1 } from '@sitelog/shared/schemas/report.ts';
import { DemoSource } from '@/data/demo/DemoSource';
import { DemoStore, demoUserFor } from '@/data/demo/store';
import type { PdfLinkBatch, PdfSelection } from '@/data/source';
import { i18n } from '@/i18n/i18n';
import { rememberLanguage } from '@/i18n/language';
import { renderWithProviders } from '@/test/render';
import ReportsPage from './Page';

// The browser renderer (react-pdf) is replaced by a fixed PDF.
const rendered = vi.hoisted(() => ({ count: 0 }));
vi.mock('@/lib/reportPdf', () => ({
  renderReportDetailPdf: async () => {
    rendered.count += 1;
    return new Blob(['%PDF-1.3'], { type: 'application/pdf' });
  },
}));

/**
 * Demo data, but the first report without a PDF has one behind a signed URL (what SupabaseSource
 * returns for a stored PDF). PDFs rendered in this session come back as files too.
 */
class PdfSource extends DemoSource {
  calls: PdfSelection[] = [];
  constructor(store = new DemoStore()) {
    const u = demoUserFor('admin');
    super(store, { id: u.id, email: u.email, name: u.name, role: u.role });
  }
  override async getPdfUrls(selection: PdfSelection): Promise<PdfLinkBatch> {
    this.calls.push(selection);
    const demo = await super.getPdfUrls(selection);
    const [first, ...rest] = demo.missing;
    return {
      files: [
        ...demo.files,
        ...(first ? [{ ...first, url: `https://storage.test/${first.reportNo}.pdf` }] : []),
      ],
      missing: rest,
      total: demo.total,
      capped: demo.capped,
    };
  }
}

function renderLive(route = '/reports', store?: DemoStore) {
  const source = new PdfSource(store);
  renderWithProviders(<ReportsPage />, {
    route,
    path: '/reports',
    source,
    auth: { isDemo: false },
  });
  return source;
}

function renderReports(route = '/reports', store?: DemoStore) {
  renderWithProviders(<ReportsPage />, { route, path: '/reports', store });
}

/** A new org: nothing filed yet, with or without its sites. */
function newOrg(withSites: boolean): DemoStore {
  const d = kestrelDemo();
  const empty: DemoDataset = {
    ...d,
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
  return new DemoStore(
    withSites ? empty : { ...empty, sites: [], reporters: [], siteReporters: [], recipients: [] },
  );
}

/** A report typed in the panel today (no stored PDF yet). */
function withTypedReport() {
  const store = new DemoStore();
  const site = store.data.sites.find((s) => s.project_code === 'P9-0932')!;
  // Before the demo history starts, so the day has no report yet.
  const typed = store.createOfficeReport({
    siteId: site.id,
    date: '2026-09-14',
    data: { ...emptyReportDataV1('2026-09-14'), summary: 'Typed in the office.' },
    userId: demoUserFor('admin').id,
  });
  return { store, typed };
}

const rowsOf = (table: HTMLElement) => [...table.querySelectorAll<HTMLElement>('tbody tr')];

// The archive renders the whole demo org (50-row pages, transcript search over every report): slow
// on a shared CI runner under full parallel load, so these tests get a longer limit than the 5 s
// default.
describe('ReportsPage (demo archive)', { timeout: 20_000 }, () => {
  it('lists the first page of 50 reports, newest first', async () => {
    renderReports();
    expect(await screen.findByRole('heading', { name: 'Reports' })).toBeInTheDocument();
    const table = await screen.findByRole('table', { name: 'Reports' });
    const rows = rowsOf(table);
    expect(rows).toHaveLength(50);
    expect(rows[0]).toHaveTextContent('Oct 9');
    expect(screen.getByTestId('result-count')).toHaveTextContent(/^\d+ reports$/);
    expect(screen.getByText(/Page 1 of \d+/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Download PDF RL-2041-0187' })).toBeInTheDocument();
  });

  it('weather toggle narrows to the 10 delay reports and offers the EOT pack action', async () => {
    renderReports();
    await screen.findByRole('table', { name: 'Reports' });
    await userEvent.click(screen.getByRole('button', { name: 'Has weather delay' }));
    await waitFor(
      () => expect(screen.getByTestId('result-count')).toHaveTextContent('10 reports'),
      // The 50-row page re-renders (chips, channel icons) on slow runners.
      { timeout: 5000 },
    );
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
    // A 250 ms debounce, then the 50-row page re-renders (chips, channel icons) on slow runners.
    await waitFor(() => expect(screen.getByTestId('result-count')).toHaveTextContent('1 report'), {
      timeout: 5000,
    });
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

  it('filters by channel (P6: Any · Link · Call) and shows the channel icon with the flags', async () => {
    renderReports('/reports?channel=call');
    const table = await screen.findByRole('table', { name: 'Reports' });
    await waitFor(() => expect(screen.getByTestId('result-count')).toHaveTextContent('2 reports'), {
      timeout: 5000,
    });
    expect(screen.getByTestId('channel-filter')).toHaveTextContent('Call');
    for (const row of rowsOf(table)) {
      expect(row.querySelector('[data-channel="call"]')).toHaveTextContent('Reported by call');
      // No photos on a call (§10.5): flagged, except on a weather day (Hillcrest, rained out).
      const weatherDay = row.querySelector('[data-flag="weather_day"]') !== null;
      expect(row.querySelector('[data-flag="no_photo"]') !== null).toBe(!weatherDay);
    }
  });

  it('speaks Turkish when the panel does', async () => {
    rememberLanguage('tr');
    await act(() => i18n.changeLanguage('tr'));
    renderReports('/reports?edited=1');
    const table = await screen.findByRole('table', { name: 'Raporlar' });
    await waitFor(() => expect(screen.getByTestId('result-count')).toHaveTextContent('1 rapor'), {
      timeout: 5000,
    });
    const row = rowsOf(table)[0]!;
    expect(within(row).getByText('Yağmur 3,5 sa')).toBeInTheDocument();
    expect(within(row).getByText('Geç 17:38')).toBeInTheDocument();
    expect(within(row).getByText('Dosyalandı')).toBeInTheDocument();
    expect(within(row).getByText('9 Eki')).toBeInTheDocument();
    expect(screen.getByLabelText('Kanal')).toBeInTheDocument();
  });

  it('reads filters from the URL and selects rows for export', async () => {
    renderReports('/reports?status=needs_review&edited=0');
    await screen.findByRole('table', { name: 'Reports' });
    await waitFor(() => expect(screen.getByTestId('result-count')).toHaveTextContent('1 report'), {
      timeout: 5000,
    });
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

  it('renders a row PDF in the browser in demo mode (no stored files)', async () => {
    rendered.count = 0;
    const tab = { opener: {}, closed: false, location: { href: '' }, close: vi.fn() };
    vi.spyOn(window, 'open').mockReturnValue(tab as unknown as Window);
    renderReports();
    await screen.findByRole('table', { name: 'Reports' });
    await userEvent.click(screen.getByRole('button', { name: 'Download PDF RL-2041-0187' }));
    await waitFor(() => expect(tab.location.href).toMatch(/^blob:/));
    expect(rendered.count).toBe(1);
  });

  it('goes back to page 1 from a page past the end', async () => {
    renderReports('/reports?page=99');
    const table = await screen.findByRole('table', { name: 'Reports' });
    expect(rowsOf(table)).toHaveLength(50);
    expect(screen.getByText(/Page 1 of \d+/)).toBeInTheDocument();
  });

  it('tells a new org how to file its first report, not to clear filters', async () => {
    renderReports('/reports', newOrg(true));
    expect(await screen.findByText('No reports yet')).toBeInTheDocument();
    expect(screen.queryByText('No reports match these filters.')).not.toBeInTheDocument();
    const status = screen.getByText('No reports yet').closest('[role="status"]') as HTMLElement;
    expect(within(status).getByRole('link', { name: 'New report' })).toHaveAttribute(
      'href',
      '/reports/new',
    );
  });

  it('points a new org without sites to its first site', async () => {
    renderReports('/reports', newOrg(false));
    expect(await screen.findByText('No reports yet')).toBeInTheDocument();
    expect(
      screen.getByText('Add your first site, then file its daily reports here.'),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole('link', { name: 'Connect your first site' })).toHaveAttribute(
        'href',
        '/setup/site',
      ),
    );
  });

  it('tells a project manager without sites to ask an admin (no link into the admin-only wizard)', async () => {
    renderWithProviders(<ReportsPage />, {
      route: '/reports',
      path: '/reports',
      store: newOrg(false),
      as: 'pm',
    });
    expect(await screen.findByText('No reports yet')).toBeInTheDocument();
    expect(
      await screen.findByText(
        'An admin adds sites. Ask an admin to add the first one, then file its daily reports here.',
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByText('Add your first site, then file its daily reports here.'),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Connect your first site' })).toBeNull();
  });

  it('keeps the filter hint when filters match nothing', async () => {
    renderReports('/reports?q=nothing-matches-this');
    expect(await screen.findByText('No reports match these filters.')).toBeInTheDocument();
    expect(screen.getByText('Try widening the dates or clearing a toggle.')).toBeInTheDocument();
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
    // A 250 ms debounce, then the 50-row page re-renders (chips, channel icons) on slow runners.
    await waitFor(() => expect(screen.getByTestId('result-count')).toHaveTextContent('1 report'), {
      timeout: 5000,
    });
    const row = rowsOf(screen.getByRole('table', { name: 'Reports' }))[0]!;
    await userEvent.click(within(row).getByRole('checkbox', { name: /Select OM-1187-/ }));
    await userEvent.click(screen.getByTestId('export-zip'));
    await waitFor(() => expect(click).toHaveBeenCalledTimes(1));
    const anchor = click.mock.instances[0] as unknown as HTMLAnchorElement;
    expect(anchor.download).toBe('TalkOlog_reports_2026-10-09.zip');
    expect(source.calls).toHaveLength(1);
    expect(source.calls[0]).toEqual({ reportIds: [expect.any(String)] });
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringMatching(/^https:\/\/storage\.test\/OM-1187-\d+\.pdf$/),
      expect.anything(),
    );
    expect(success).toHaveBeenCalledWith('1 PDF zipped.', expect.anything());
  });

  it('exports every report matching the filters, rendering and storing the missing PDFs', async () => {
    rendered.count = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      async () => new Response(new TextEncoder().encode('%PDF-1.7')),
    );
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => undefined);
    const loading = vi.spyOn(toast, 'loading');
    const success = vi.spyOn(toast, 'success');
    const source = renderLive('/reports?wx=1');
    await waitFor(
      () => expect(screen.getByTestId('result-count')).toHaveTextContent('10 reports'),
      // The 50-row page re-renders (chips, channel icons) on slow runners.
      { timeout: 5000 },
    );
    await userEvent.click(screen.getByTestId('export-zip'));
    await waitFor(() => expect(click).toHaveBeenCalledTimes(1));
    expect(source.calls[0]).toMatchObject({ filters: { hasWeatherDelay: true, page: 1 } });
    // One file came back with a URL; the other nine are rendered here and zipped too.
    expect(loading).toHaveBeenCalledWith('Making PDFs · 9 of 9', expect.anything());
    expect(rendered.count).toBe(9);
    await waitFor(() => expect(success).toHaveBeenCalledWith('10 PDFs zipped.', expect.anything()));
    // …and stored, so the next export has them.
    const again = await source.getPdfUrls({ filters: { hasWeatherDelay: true } });
    expect(again.files).toHaveLength(10);
    expect(again.missing).toEqual([]);
  });

  it('renders and stores the PDF of a typed report that has none yet', async () => {
    rendered.count = 0;
    const tab = { opener: {}, closed: false, location: { href: '' }, close: vi.fn() };
    const open = vi.spyOn(window, 'open').mockReturnValue(tab as unknown as Window);
    const { store, typed } = withTypedReport();
    const source = renderLive('/reports?q=Typed%20in%20the%20office', store);
    // A 250 ms debounce, then the 50-row page re-renders (chips, channel icons) on slow runners.
    await waitFor(() => expect(screen.getByTestId('result-count')).toHaveTextContent('1 report'), {
      timeout: 5000,
    });
    const button = screen.getByRole('button', { name: `Download PDF ${typed.reportNo}` });
    expect(button).toHaveAttribute('title', 'No PDF stored yet. It is made when you open it.');
    await userEvent.click(button);
    expect(open).toHaveBeenCalledWith('', '_blank');
    await waitFor(() => expect(tab.location.href).toMatch(/^blob:/));
    expect(rendered.count).toBe(1);
    expect(tab.close).not.toHaveBeenCalled();
    const stored = await source.getPdfUrls({ reportIds: [typed.reportId] });
    expect(stored.files.map((f) => f.reportNo)).toEqual([typed.reportNo]);
    // The archive row now has a PDF to open.
    await waitFor(() => expect(button).not.toHaveAttribute('title'));
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
