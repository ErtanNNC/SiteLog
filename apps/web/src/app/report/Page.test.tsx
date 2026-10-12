import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { emptyReportData } from '@sitelog/shared/schemas/report.ts';
import { DemoStore, demoUserFor, type DemoLoginKey } from '@/data/demo/store';
import { renderWithProviders } from '@/test/render';
import ReportDetailPage from './Page';

function renderReport(reportNo: string, opts: { v?: number; as?: DemoLoginKey } = {}) {
  const store = new DemoStore();
  const report = store.data.reports.find((r) => r.report_no === reportNo)!;
  renderWithProviders(<ReportDetailPage />, {
    store,
    as: opts.as,
    route: `/reports/${report.id}${opts.v ? `?v=${opts.v}` : ''}`,
    path: '/reports/:reportId',
  });
  return { store, report };
}

describe('ReportDetailPage (hero report RL-2041-0187)', () => {
  it('shows v2 as current with the EDITED badge, totals and provenance', async () => {
    renderReport('RL-2041-0187');
    expect(
      await screen.findByRole('heading', { name: 'Friday, Oct 9 — Riverside B' }),
    ).toBeInTheDocument();
    expect(screen.getByTestId('version-switcher')).toHaveTextContent('v2 · current');
    expect(screen.getByTestId('provenance')).toHaveTextContent(
      'Reported by Marco Ruiz by WhatsApp voice at 17:38 · confirmed 17:43 · edited by reply 20:10',
    );
    const manpower = screen.getByRole('table', { name: 'Manpower' });
    const apex = within(manpower).getByText('Apex Concrete').closest('tr')!;
    expect(within(apex).getByText('Edited v2')).toBeInTheDocument();
    expect(within(apex).getByText('7')).toBeInTheDocument();
    expect(within(apex).getByText('6')).toBeInTheDocument(); // struck-through previous value
    const delta = within(manpower).getByText('Delta Mechanical').closest('tr')!;
    expect(within(delta).getByText('Confirmed by reply')).toBeInTheDocument();
    expect(screen.getByTestId('manpower-total-crew')).toHaveTextContent('24');
    expect(screen.getByTestId('manpower-total-hours')).toHaveTextContent('192');
    expect(screen.getByTestId('delay-log-chip')).toHaveTextContent('In delay log · 3.5 h');
    expect(screen.getByText('Weather data: Open-Meteo')).toBeInTheDocument();
    expect(screen.getByText('heard “sixty-eight yards”')).toBeInTheDocument();
    expect(screen.getByTestId('voice-player')).toBeInTheDocument();
    expect(screen.getAllByText('ES + EN → EN').length).toBeGreaterThan(0);
    expect(screen.getAllByRole('button', { name: /Play voice note from/ }).length).toBeGreaterThan(
      4,
    );
    expect(screen.getByText('Question answered')).toBeInTheDocument();
  });

  it('switches to v1 and shows the original 23 crew / 184 h', async () => {
    renderReport('RL-2041-0187', { v: 1 });
    await screen.findByRole('heading', { name: 'Friday, Oct 9 — Riverside B' });
    expect(screen.getByTestId('version-switcher')).toHaveTextContent('v1');
    expect(screen.getByText('You’re viewing version 1. Version 2 is current.')).toBeInTheDocument();
    expect(screen.getByTestId('manpower-total-crew')).toHaveTextContent('23');
    expect(screen.getByTestId('manpower-total-hours')).toHaveTextContent('184');
    expect(screen.queryByText('Edited v2')).not.toBeInTheDocument();
  });

  it('signs off through the confirm dialog, then offers Undo', async () => {
    const { store, report } = renderReport('RL-2041-0187');
    await screen.findByRole('heading', { name: 'Friday, Oct 9 — Riverside B' });
    expect(screen.getByLabelText('Status: Filed')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Sign off' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('Sign off RL-2041-0187 v2?');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Sign off' }));
    await waitFor(() => expect(screen.getByLabelText('Status: Signed off')).toBeInTheDocument());
    expect(screen.getByTestId('signed-off-state')).toHaveTextContent('Signed off by Lena Ortiz');
    expect(store.data.reports.find((r) => r.id === report.id)!.status).toBe('signed_off');
    await userEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(screen.getByLabelText('Status: Filed')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Sign off' })).toBeInTheDocument();
  });

  it('hides sign-off for ops users', async () => {
    renderReport('RL-2041-0187', { as: 'ops' });
    await screen.findByRole('heading', { name: 'Friday, Oct 9 — Riverside B' });
    expect(screen.queryByRole('button', { name: 'Sign off' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Edit' })).toBeInTheDocument();
  });

  it('resolves the unknown Ridgeway company on the Oakmont report and clears the banner', async () => {
    const { store, report } = renderReport('OM-1187-0133');
    await screen.findByRole('heading', { name: /Friday, Oct 9 — Oakmont/ });
    const banner = screen.getByRole('region', { name: '1 reason to review' });
    expect(banner).toHaveTextContent('Unknown subcontractor “Ridgeway”');
    const ridgeway = within(screen.getByRole('table', { name: 'Manpower' }))
      .getByText('Ridgeway')
      .closest('tr')!;
    expect(within(ridgeway).getByText('Unconfirmed')).toBeInTheDocument();
    await userEvent.click(within(banner).getByRole('button', { name: 'Add as subcontractor' }));
    await waitFor(() =>
      expect(screen.queryByRole('region', { name: /reason to review/ })).not.toBeInTheDocument(),
    );
    const row = store.data.reports.find((r) => r.id === report.id)!;
    expect(row.needs_review).toBe(false);
    expect(row.current_version).toBe(2);
    await waitFor(() => expect(screen.getByLabelText('Status: Filed')).toBeInTheDocument());
  });

  it('edit mode saves a new version with a change note', async () => {
    const { store, report } = renderReport('RL-2041-0187');
    await screen.findByRole('heading', { name: 'Friday, Oct 9 — Riverside B' });
    await userEvent.click(screen.getByRole('button', { name: 'Edit' }));
    const editor = await screen.findByTestId('report-editor');
    expect(within(editor).getAllByTestId('manpower-edit-row')).toHaveLength(5);
    const workers = within(editor).getAllByLabelText('Workers')[1]!; // BrightLine row
    await userEvent.clear(workers);
    await userEvent.type(workers, '6');
    await userEvent.click(within(editor).getByRole('button', { name: 'Add company' }));
    expect(within(editor).getAllByTestId('manpower-edit-row')).toHaveLength(6);
    await userEvent.click(
      within(within(editor).getAllByTestId('manpower-edit-row')[5]!).getByRole('button', {
        name: 'Remove row',
      }),
    );
    await userEvent.click(screen.getByTestId('save-version'));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('Save RL-2041-0187 as a new version?');
    await userEvent.click(within(dialog).getByTestId('confirm-save'));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'A change note is required.',
    );
    await userEvent.type(within(dialog).getByLabelText('Change note'), 'BrightLine had 6, not 5');
    await userEvent.click(within(dialog).getByTestId('confirm-save'));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    const row = store.data.reports.find((r) => r.id === report.id)!;
    expect(row.current_version).toBe(3);
    const v3 = store.data.versions.find((v) => v.report_id === report.id && v.version === 3)!;
    expect(v3.change_note).toBe('BrightLine had 6, not 5');
    expect(v3.author).toBe('office_user');
    const data = v3.data as unknown as { manpower: Array<{ workers: number; source: unknown[] }> };
    expect(data.manpower[1]!.workers).toBe(6);
    expect(data.manpower[1]!.source).toHaveLength(2); // audio + office_edit
    await waitFor(() =>
      expect(screen.getByTestId('version-switcher')).toHaveTextContent('v3 · current'),
    );
    // The v3 detail query may still be settling right after the switcher updates (slow CI runners).
    await waitFor(() => expect(screen.getByTestId('manpower-total-crew')).toHaveTextContent('25'));
    expect(screen.getByTestId('manpower-total-hours')).toHaveTextContent('200');
    expect(screen.getByTestId('provenance')).toHaveTextContent('edited by Lena Ortiz');
  }, 30_000);
});

describe('ReportDetailPage (report typed in the panel)', () => {
  it('credits Open-Meteo only when there is observed weather', async () => {
    const store = new DemoStore();
    const site = store.data.sites.find((x) => x.project_code === 'P9-0932')!;
    const typed = store.createOfficeReport({
      siteId: site.id,
      date: '2026-09-14',
      data: {
        ...emptyReportData('2026-09-14'),
        summary: 'Typed in the office.',
        weather: { conditionsText: 'Clear, 68°F', periods: [] },
      },
      userId: demoUserFor('admin').id,
    });
    renderWithProviders(<ReportDetailPage />, {
      store,
      route: `/reports/${typed.reportId}`,
      path: '/reports/:reportId',
    });
    expect(await screen.findByText('Clear, 68°F')).toBeInTheDocument();
    expect(screen.queryByText('Weather data: Open-Meteo')).not.toBeInTheDocument();
  });
});

describe('ReportDetailPage (typed company filed before companies were linked on save)', () => {
  it('offers Add as subcontractor for the unlinked company, so Crew hours "Confirm" leads somewhere', async () => {
    const store = new DemoStore();
    const elm = store.data.sites.find((x) => x.name === 'Elm St. Townhomes')!;
    const typed = store.createOfficeReport({
      siteId: elm.id,
      date: '2026-10-09',
      data: {
        ...emptyReportData('2026-10-09'),
        summary: 'Typed in the office.',
        manpower: [
          {
            companyId: null,
            companyNameHeard: 'Harbor Masonry',
            companyName: 'Harbor Masonry',
            workers: 4,
            hoursPerWorker: 8,
            totalHours: 32,
            hoursBasis: 'office_edit',
            confidence: 1,
            source: [],
          },
        ],
      },
      userId: demoUserFor('admin').id,
    });
    // As filed before the fix: no company row and the crew row not linked.
    store.data.companies.splice(
      store.data.companies.findIndex((c) => c.name === 'Harbor Masonry'),
      1,
    );
    const v1 = store.data.versions.find((v) => v.report_id === typed.reportId)!;
    (
      v1.data as unknown as { manpower: Array<{ companyId: string | null }> }
    ).manpower[0]!.companyId = null;
    for (const m of store.data.manpower) if (m.report_id === typed.reportId) m.company_id = null;

    renderWithProviders(<ReportDetailPage />, {
      store,
      route: `/reports/${typed.reportId}`,
      path: '/reports/:reportId',
    });
    const banner = await screen.findByRole('region', { name: '1 reason to review' });
    expect(banner).toHaveTextContent('Unknown subcontractor “Harbor Masonry”');
    const table = screen.getByRole('table', { name: 'Manpower' });
    expect(within(table).getByText('Unconfirmed')).toBeInTheDocument();

    await userEvent.click(within(banner).getByRole('button', { name: 'Add as subcontractor' }));
    await waitFor(() =>
      expect(screen.queryByRole('region', { name: /reason to review/ })).not.toBeInTheDocument(),
    );
    const company = store.data.companies.find((c) => c.name === 'Harbor Masonry')!;
    expect(company.status).toBe('confirmed');
    const report = store.data.reports.find((r) => r.id === typed.reportId)!;
    expect(report.current_version).toBe(2);
    const v2 = store.data.versions.find((v) => v.report_id === report.id && v.version === 2)!;
    expect(
      (v2.data as unknown as { manpower: Array<{ companyId: string | null }> }).manpower[0]!
        .companyId,
    ).toBe(company.id);
    await waitFor(() =>
      expect(
        within(screen.getByRole('table', { name: 'Manpower' })).queryByText('Unconfirmed'),
      ).not.toBeInTheDocument(),
    );
  }, 30_000);
});

describe('ReportDetailPage (WhatsApp report still being collected)', () => {
  it('offers no Add / Map controls for an unlinked company before the report is filed', async () => {
    const store = new DemoStore();
    const elm = store.data.sites.find((x) => x.name === 'Elm St. Townhomes')!;
    const typed = store.createOfficeReport({
      siteId: elm.id,
      date: '2026-10-09',
      data: {
        ...emptyReportData('2026-10-09'),
        summary: 'Still talking to the site manager.',
        manpower: [
          {
            companyId: null,
            companyNameHeard: 'Harbor Masonry',
            companyName: 'Harbor Masonry',
            workers: 4,
            hoursPerWorker: 8,
            totalHours: 32,
            hoursBasis: 'stated',
            confidence: 0.6,
            source: [],
          },
        ],
      },
      userId: demoUserFor('admin').id,
    });
    // As extraction leaves it while the worker asks about the company: not linked, not filed.
    store.data.companies.splice(
      store.data.companies.findIndex((c) => c.name === 'Harbor Masonry'),
      1,
    );
    const v1 = store.data.versions.find((v) => v.report_id === typed.reportId)!;
    (
      v1.data as unknown as { manpower: Array<{ companyId: string | null }> }
    ).manpower[0]!.companyId = null;
    for (const m of store.data.manpower) if (m.report_id === typed.reportId) m.company_id = null;
    const report = store.data.reports.find((r) => r.id === typed.reportId)!;
    report.status = 'awaiting_answer';
    report.filed_at = null;

    renderWithProviders(<ReportDetailPage />, {
      store,
      route: `/reports/${typed.reportId}`,
      path: '/reports/:reportId',
    });
    expect(await screen.findByRole('table', { name: 'Manpower' })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: /reason to review/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add as subcontractor' })).not.toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: 'Map to existing' })).not.toBeInTheDocument();
  }, 30_000);
});
