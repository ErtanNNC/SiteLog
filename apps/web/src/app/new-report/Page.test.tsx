import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { toast } from 'sonner';
import { describe, expect, it, vi } from 'vitest';
import { emptyReportDataV1, type DailyReportDataV1 } from '@sitelog/shared/schemas/report.ts';
import { DemoStore } from '@/data/demo/store';
import type { ReportDetail } from '@/data/types';
import type * as PhotosModule from '@/lib/photos';
import { makeSource, renderWithProviders } from '@/test/render';
import { toFormValues } from '../report/reportForm';
import { newReportDraftKey } from './draft';
import NewReportPage from './Page';

const pdf = vi.hoisted(() => ({ rendered: [] as unknown[] }));

// The browser PDF renderer (react-pdf, fonts) is exercised by the e2e smoke test.
vi.mock('@/lib/reportPdf', () => ({
  renderReportDetailPdf: async (detail: unknown) => {
    pdf.rendered.push(detail);
    return new Blob(['%PDF-1.3'], { type: 'application/pdf' });
  },
}));

// jsdom has no canvas: the image encoder is stubbed (lib/photos.test.ts covers the real steps).
vi.mock('@/lib/photos', async (importOriginal) => ({
  ...(await importOriginal<typeof PhotosModule>()),
  preparePhoto: async () => ({
    blob: new Blob(['jpeg'], { type: 'image/jpeg' }),
    mime: 'image/jpeg' as const,
    width: 2000,
    height: 1500,
    takenAt: '2026-10-09T21:30:00.000Z',
  }),
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

  it('files a company added with "Add new…" as a confirmed company linked by id', async () => {
    const user = userEvent.setup();
    const store = renderNew();
    const elm = store.data.sites.find((s) => s.name === 'Elm St. Townhomes')!;
    await user.click(await screen.findByTestId('new-report-site'));
    await user.click(await screen.findByRole('option', { name: /Elm St\. Townhomes/ }));
    const editor = screen.getByTestId('report-editor');
    await user.click(within(editor).getByRole('button', { name: 'Add company' }));
    await user.click(within(editor).getByRole('combobox', { name: 'Company' }));
    await user.click(await screen.findByRole('option', { name: 'Add new…' }));
    await user.type(within(editor).getByLabelText('New company name'), 'Harbor Masonry');
    await user.type(within(editor).getByLabelText('Workers'), '4');
    await user.type(within(editor).getByLabelText('Hours / worker'), '8');
    await user.click(screen.getByTestId('file-report'));

    await waitFor(() =>
      expect(store.data.reports.some((r) => r.site_id === elm.id && !r.reporter_id)).toBe(true),
    );
    const report = store.data.reports.find((r) => r.site_id === elm.id && !r.reporter_id)!;
    const company = store.data.companies.find((c) => c.name === 'Harbor Masonry')!;
    expect(company).toMatchObject({ status: 'confirmed', is_self_perform: false });
    const v1 = store.data.versions.find((v) => v.report_id === report.id && v.version === 1)!;
    const data = v1.data as unknown as {
      manpower: Array<{ companyId: string | null; companyName: string; totalHours: number }>;
    };
    expect(data.manpower).toEqual([
      expect.objectContaining({
        companyId: company.id,
        companyName: 'Harbor Masonry',
        totalHours: 32,
      }),
    ]);
    expect(store.data.audit).toContainEqual(
      expect.objectContaining({ action: 'company.created', entity_id: company.id }),
    );
  });

  it('files a photo with the report: uploaded, listed by version 1 and in the PDF', async () => {
    const user = userEvent.setup();
    const loading = vi.spyOn(toast, 'loading');
    pdf.rendered = [];
    const store = renderNew();
    const elm = store.data.sites.find((s) => s.name === 'Elm St. Townhomes')!;
    await user.click(await screen.findByTestId('new-report-site'));
    await user.click(await screen.findByRole('option', { name: /Elm St\. Townhomes/ }));
    const editor = screen.getByTestId('report-editor');
    await user.type(within(editor).getAllByRole('textbox')[0]!, 'Trusses set on unit 2.');

    const picker = within(editor).getByTestId('photo-picker');
    await user.upload(
      within(picker).getByTestId('photo-input'),
      new File(['png'], 'trusses.png', { type: 'image/png' }),
    );
    expect(await within(picker).findByRole('img', { name: 'Photo 1' })).toBeInTheDocument();
    // Taken on the report's day: the time alone.
    expect(within(picker).getByText('Taken 16:30')).toBeInTheDocument();
    await user.type(within(picker).getByLabelText('Caption for photo 1'), 'Unit 2 trusses');
    await user.click(screen.getByTestId('file-report'));

    await waitFor(() =>
      expect(store.data.reports.some((r) => r.site_id === elm.id && !r.reporter_id)).toBe(true),
    );
    const report = store.data.reports.find((r) => r.site_id === elm.id && !r.reporter_id)!;
    expect(loading).toHaveBeenCalledWith('Uploading photos 1 of 1');
    const message = store.data.messages.find((m) => m.org_id === store.data.org.id)!;
    expect(message).toMatchObject({
      conversation_id: null,
      type: 'image',
      body: 'Unit 2 trusses',
      media_mime: 'image/jpeg',
      storage_path: expect.stringMatching(
        new RegExp(`^${store.data.org.id}/${elm.id}/office/[0-9a-f-]{36}\\.jpg$`),
      ),
    });
    expect(store.data.sources).toContainEqual(
      expect.objectContaining({ report_id: report.id, message_id: message.id, kind: 'photo' }),
    );
    const v1 = store.data.versions.find((v) => v.report_id === report.id && v.version === 1)!;
    expect((v1.data as unknown as DailyReportDataV1).photos).toEqual([
      { messageId: message.id, caption: 'Unit 2 trusses', takenAt: '2026-10-09T21:30:00.000Z' },
    ]);
    // The PDF was rendered from the filed version with the uploaded photo.
    await waitFor(() => expect(pdf.rendered).toHaveLength(1));
    expect((pdf.rendered[0] as ReportDetail).photos).toEqual([
      expect.objectContaining({
        messageId: message.id,
        caption: 'Unit 2 trusses',
        url: expect.stringMatching(/^blob:/),
        storagePath: message.storage_path,
      }),
    ]);
    loading.mockRestore();
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

  it('stays on the page when the day already has a report: offers it and uploads nothing', async () => {
    const user = userEvent.setup();
    const store = new DemoStore();
    const source = makeSource('admin', store);
    const upload = vi.spyOn(source, 'uploadReportPhoto');
    renderWithProviders(<NewReportPage />, { source, route: '/reports/new', path: '/reports/new' });
    const riverside = store.data.sites.find((s) => s.project_code === 'RL-2041')!;
    const existing = store.data.reports.find(
      (r) => r.site_id === riverside.id && r.status !== 'void' && r.report_no === 'RL-2041-0187',
    )!;
    const count = store.data.reports.length;
    await user.click(await screen.findByTestId('new-report-site'));
    await user.click(await screen.findByRole('option', { name: new RegExp(riverside.name) }));
    const summary = within(screen.getByTestId('report-editor')).getAllByRole('textbox')[0]!;
    await user.type(summary, 'Duplicate attempt.');
    const picker = screen.getByTestId('photo-picker');
    await user.upload(
      within(picker).getByTestId('photo-input'),
      new File(['png'], 'deck.png', { type: 'image/png' }),
    );
    await within(picker).findByRole('img', { name: 'Photo 1' });
    await user.click(screen.getByTestId('file-report'));

    const notice = await screen.findByTestId('day-has-report');
    expect(notice).toHaveTextContent(
      'RL-2041-0187 already covers this site and date, so this report was not filed. What you typed is still here',
    );
    expect(within(notice).getByRole('link', { name: 'Open RL-2041-0187' })).toHaveAttribute(
      'href',
      `/reports/${existing.id}`,
    );
    // Nothing filed or uploaded; what was typed and picked is still here.
    expect(upload).not.toHaveBeenCalled();
    expect(store.data.reports).toHaveLength(count);
    expect(screen.getByTestId('file-report')).toBeEnabled();
    expect(summary).toHaveValue('Duplicate attempt.');
    expect(within(picker).getAllByTestId('photo-item')).toHaveLength(1);
    // Another date: the notice goes, and the report can be filed.
    const date = screen.getByTestId('new-report-date');
    await user.clear(date);
    await user.type(date, '2026-10-01');
    expect(screen.queryByTestId('day-has-report')).not.toBeInTheDocument();
  });

  it('locks the form and Cancel while saving; leaving mid-upload files nothing', async () => {
    const user = userEvent.setup();
    const store = new DemoStore();
    const source = makeSource('admin', store);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const upload = source.uploadReportPhoto.bind(source);
    vi.spyOn(source, 'uploadReportPhoto').mockImplementation(async (...args) => {
      await gate;
      return upload(...args);
    });
    const view = renderWithProviders(<NewReportPage />, {
      source,
      route: '/reports/new',
      path: '/reports/new',
    });
    const elm = store.data.sites.find((s) => s.name === 'Elm St. Townhomes')!;
    await user.click(await screen.findByTestId('new-report-site'));
    await user.click(await screen.findByRole('option', { name: /Elm St\. Townhomes/ }));
    const summary = within(screen.getByTestId('report-editor')).getAllByRole('textbox')[0]!;
    await user.type(summary, 'Slab poured.');
    const picker = screen.getByTestId('photo-picker');
    await user.upload(
      within(picker).getByTestId('photo-input'),
      new File(['png'], 'slab.png', { type: 'image/png' }),
    );
    await within(picker).findByRole('img', { name: 'Photo 1' });
    await user.click(screen.getByTestId('file-report'));

    await waitFor(() => expect(screen.getByTestId('new-report-form')).toBeDisabled());
    expect(screen.getByTestId('new-report-form')).toHaveAttribute('inert');
    expect(summary).toBeDisabled();
    expect(screen.getByTestId('new-report-date')).toBeDisabled();
    expect(screen.getByTestId('new-report-site')).toBeDisabled();
    // Both Cancel controls are disabled buttons, not links that would leave the save running.
    expect(screen.queryByRole('link', { name: 'Cancel' })).not.toBeInTheDocument();
    const cancels = screen.getAllByRole('button', { name: 'Cancel' });
    expect(cancels).toHaveLength(2);
    for (const b of cancels) expect(b).toBeDisabled();

    // The page goes away (another page of the panel) while the photo uploads.
    view.unmount();
    release();
    await new Promise((r) => setTimeout(r, 50));
    expect(store.data.reports.some((r) => r.site_id === elm.id && !r.reporter_id)).toBe(false);
  });

  it('keeps what was typed across a reload of the tab, until it is filed', async () => {
    const user = userEvent.setup();
    const store = new DemoStore();
    const source = makeSource('admin', store);
    const key = newReportDraftKey(source.orgId, source.user.id);
    const first = renderWithProviders(<NewReportPage />, {
      source,
      route: '/reports/new',
      path: '/reports/new',
    });
    const elm = store.data.sites.find((s) => s.name === 'Elm St. Townhomes')!;
    await user.click(await screen.findByTestId('new-report-site'));
    await user.click(await screen.findByRole('option', { name: /Elm St\. Townhomes/ }));
    await user.type(
      within(screen.getByTestId('report-editor')).getAllByRole('textbox')[0]!,
      'Framing on unit 5.',
    );
    // The camera opens: the tab is hidden, and the draft is saved at once.
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    expect(JSON.parse(window.sessionStorage.getItem(key)!)).toMatchObject({
      v: 1,
      siteId: elm.id,
      date: '2026-10-09',
      values: { summary: 'Framing on unit 5.' },
    });
    first.unmount();

    // The browser reloads the tab.
    renderWithProviders(<NewReportPage />, { source, route: '/reports/new', path: '/reports/new' });
    expect(await screen.findByTestId('draft-restored')).toHaveTextContent(
      'Restored the report you were typing in this tab. Photos are not kept: add them again.',
    );
    expect(screen.getByTestId('new-report-site')).toHaveTextContent('Elm St. Townhomes');
    expect(screen.getByTestId('new-report-date')).toHaveValue('2026-10-09');
    expect(within(screen.getByTestId('report-editor')).getAllByRole('textbox')[0]!).toHaveValue(
      'Framing on unit 5.',
    );

    await user.click(screen.getByTestId('file-report'));
    await waitFor(() =>
      expect(store.data.reports.some((r) => r.site_id === elm.id && !r.reporter_id)).toBe(true),
    );
    expect(window.sessionStorage.getItem(key)).toBeNull();
  });

  it('starts over from a restored draft, and a link to another day ignores it', async () => {
    const user = userEvent.setup();
    const store = new DemoStore();
    const source = makeSource('admin', store);
    const key = newReportDraftKey(source.orgId, source.user.id);
    const elm = store.data.sites.find((s) => s.name === 'Elm St. Townhomes')!;
    const draft = (summary: string) =>
      window.sessionStorage.setItem(
        key,
        JSON.stringify({
          v: 1,
          siteId: elm.id,
          date: '2026-10-08',
          values: { ...toFormValues(emptyReportDataV1('2026-10-09')), summary },
        }),
      );

    draft('Old draft.');
    const view = renderWithProviders(<NewReportPage />, {
      source,
      route: `/reports/new?site=${elm.id}&date=2026-10-07`,
      path: '/reports/new',
    });
    await screen.findByTestId('report-editor');
    expect(screen.queryByTestId('draft-restored')).not.toBeInTheDocument();
    expect(screen.getByTestId('new-report-date')).toHaveValue('2026-10-07');
    view.unmount();
    // Left for when the tab comes back to it.
    expect(JSON.parse(window.sessionStorage.getItem(key)!).values.summary).toBe('Old draft.');

    renderWithProviders(<NewReportPage />, { source, route: '/reports/new', path: '/reports/new' });
    const editor = await screen.findByTestId('report-editor');
    expect(within(editor).getAllByRole('textbox')[0]!).toHaveValue('Old draft.');
    expect(screen.getByTestId('new-report-date')).toHaveValue('2026-10-08');
    await user.click(screen.getByRole('button', { name: 'Start over' }));
    expect(screen.queryByTestId('draft-restored')).not.toBeInTheDocument();
    expect(within(editor).getAllByRole('textbox')[0]!).toHaveValue('');
    expect(screen.getByTestId('new-report-date')).toHaveValue('2026-10-09');
    expect(window.sessionStorage.getItem(key)).toBeNull();
  });
});
