import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { DemoStore } from '@/data/demo/store';
import { renderWithProviders } from '@/test/render';
import NewReportPage from './Page';

// The browser PDF renderer (react-pdf, fonts) is exercised by the e2e smoke test.
vi.mock('@/lib/reportPdf', () => ({
  renderReportDetailPdf: async () => new Blob(['%PDF-1.3'], { type: 'application/pdf' }),
}));

function renderNew(route = '/reports/new') {
  const store = new DemoStore();
  renderWithProviders(<NewReportPage />, { store, route, path: '/reports/new' });
  return store;
}

describe('NewReportPage', () => {
  it('files a typed report for the chosen site and date as version 1 by the office', async () => {
    const user = userEvent.setup();
    const store = renderNew();
    const elm = store.data.sites.find((s) => s.name === 'Elm St. Townhomes')!;
    await user.click(await screen.findByTestId('new-report-site'));
    await user.click(await screen.findByRole('option', { name: /Elm St\. Townhomes/ }));
    expect(screen.getByTestId('new-report-date')).toHaveValue('2026-10-09');

    const editor = screen.getByTestId('report-editor');
    await user.type(within(editor).getAllByRole('textbox')[0]!, 'Framing on units 3 and 4.');
    await user.click(within(editor).getByRole('button', { name: 'Add work item' }));
    await user.type(within(editor).getByLabelText('Activity'), 'Wall framing');
    await user.click(screen.getByTestId('file-report'));

    await waitFor(() =>
      expect(store.data.reports.some((r) => r.site_id === elm.id && !r.reporter_id)).toBe(true),
    );
    const report = store.data.reports.find((r) => r.site_id === elm.id && !r.reporter_id)!;
    expect(report.status).toBe('filed');
    expect(report.confirmed_at).toBeNull();
    const v1 = store.data.versions.find((v) => v.report_id === report.id && v.version === 1)!;
    expect(v1.author).toBe('office_user');
    const data = v1.data as unknown as {
      reportDate: string;
      summary: string;
      workPerformed: Array<{ activity: string; source: unknown[] }>;
    };
    expect(data.reportDate).toBe('2026-10-09');
    expect(data.summary).toBe('Framing on units 3 and 4.');
    // Typed, not edited: no office_edit provenance on version 1.
    expect(data.workPerformed).toEqual([
      expect.objectContaining({ activity: 'Wall framing', source: [] }),
    ]);
    const day = store.data.siteDays.find((d) => d.site_id === elm.id && d.date === '2026-10-09')!;
    expect(day.status).toBe('filed');
    expect(day.report_id).toBe(report.id);
  });

  it('refuses an empty report and a future date', async () => {
    const user = userEvent.setup();
    const store = renderNew();
    const before = store.data.reports.length;
    await user.click(await screen.findByTestId('new-report-site'));
    await user.click(await screen.findByRole('option', { name: /Elm St\. Townhomes/ }));
    const date = screen.getByTestId('new-report-date');
    await user.clear(date);
    await user.type(date, '2026-10-12');
    await user.click(screen.getByTestId('file-report'));
    expect(await screen.findByText('The date can’t be in the future.')).toBeInTheDocument();
    expect(
      screen.getByText('Write a summary or add at least one row before filing.'),
    ).toBeInTheDocument();
    expect(store.data.reports).toHaveLength(before);
  });

  it('opens the existing report when the site-day already has one', async () => {
    const user = userEvent.setup();
    const store = renderNew();
    const riverside = store.data.sites.find((s) => s.project_code === 'RL-2041')!;
    const existing = store.data.reports.find(
      (r) => r.site_id === riverside.id && r.status !== 'void' && r.report_no === 'RL-2041-0187',
    )!;
    const count = store.data.reports.length;
    await user.click(await screen.findByTestId('new-report-site'));
    await user.click(await screen.findByRole('option', { name: new RegExp(riverside.name) }));
    await user.type(
      within(screen.getByTestId('report-editor')).getAllByRole('textbox')[0]!,
      'Duplicate attempt.',
    );
    await user.click(screen.getByTestId('file-report'));
    await waitFor(() => expect(screen.queryByTestId('file-report')).not.toBeInTheDocument());
    expect(store.data.reports).toHaveLength(count);
    expect(existing.status).not.toBe('void');
  });
});
