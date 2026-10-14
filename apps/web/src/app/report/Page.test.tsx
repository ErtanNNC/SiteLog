import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { toast } from 'sonner';
import { describe, expect, it, vi } from 'vitest';
import { emptyReportDataV1, type DailyReportData } from '@sitelog/shared/schemas/report.ts';
import { DemoStore, demoUserFor, type DemoLoginKey } from '@/data/demo/store';
import type * as PhotosModule from '@/lib/photos';
import { makeSource, renderWithProviders } from '@/test/render';
import { storeHeroAs } from '@/test/heroData';
import ReportDetailPage from './Page';

// The browser PDF renderer (react-pdf, fonts) is exercised by the e2e smoke test.
vi.mock('@/lib/reportPdf', () => ({
  renderReportDetailPdf: async () => new Blob(['%PDF-1.3'], { type: 'application/pdf' }),
}));

// jsdom has no canvas: the image encoder is stubbed (lib/photos.test.ts covers the real steps).
vi.mock('@/lib/photos', async (importOriginal) => ({
  ...(await importOriginal<typeof PhotosModule>()),
  preparePhoto: async () => ({
    blob: new Blob(['jpeg'], { type: 'image/jpeg' }),
    mime: 'image/jpeg' as const,
    width: 2000,
    height: 1500,
    takenAt: '2026-10-09T23:00:00.000Z',
  }),
}));

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

  it('cites the spoken correction for Apex in v2 without seeking the 17:38 note (F10)', async () => {
    renderReport('RL-2041-0187');
    const manpower = await screen.findByRole('table', { name: 'Manpower' });
    const row = (name: string) => within(manpower).getByText(name).closest('tr')!;
    const apex = row('Apex Concrete').querySelector('[data-source="voice_note"]')!;
    expect(apex.tagName).toBe('SPAN'); // the 20:09 note: not the one in the player
    expect(apex).toHaveTextContent('audio 0:00');
    const delta = row('Delta Mechanical').querySelector('[data-source="voice_note"]')!;
    expect(delta.tagName).toBe('BUTTON');
    // The 17:38 note's excerpts quote no line for Apex ("Apex had six guys" is v1's source).
    expect(screen.queryByText(/Apex Concrete · 7 workers/)).not.toBeInTheDocument();
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
    const data = v3.data as unknown as DailyReportData;
    expect(data.manpower[1]!.workers).toBe(6);
    expect(data.manpower[1]!.source).toHaveLength(2); // voice note + office_edit
    // The new version keeps the edited version's stored shape: the seeded hero is v1.2 data
    // (W1-06), so v2 sources and photos keyed by upload id.
    expect(data.schemaVersion).toBe(2);
    expect(data.manpower[1]!.source[0]).toMatchObject({ type: 'voice_note' });
    expect(data.photos.every((p) => typeof p.uploadId === 'string')).toBe(true);
    expect(data.units).toBe('imperial');
    await waitFor(() =>
      expect(screen.getByTestId('version-switcher')).toHaveTextContent('v3 · current'),
    );
    // The v3 detail query may still be settling right after the switcher updates (slow CI runners).
    await waitFor(() => expect(screen.getByTestId('manpower-total-crew')).toHaveTextContent('25'));
    expect(screen.getByTestId('manpower-total-hours')).toHaveTextContent('200');
    expect(screen.getByTestId('provenance')).toHaveTextContent('edited by Lena Ortiz');
  }, 30_000);
});

describe('ReportDetailPage: report data stored as v2 (§10.3)', () => {
  /** The hero report as seeded (v1.2 data, W1-06), its versions changed in place. */
  function heroAsV2(change?: (data: DailyReportData) => void): DemoStore {
    const store = new DemoStore();
    const hero = store.data.reports.find((r) => r.report_no === 'RL-2041-0187')!;
    for (const v of store.data.versions)
      if (v.report_id === hero.id) change?.(v.data as unknown as DailyReportData);
    return store;
  }

  /** The same facts stored as v1 and as v2 (test/heroData.ts). */
  function heroStoredAs(schemaVersion: 1 | 2): DemoStore {
    const store = new DemoStore();
    storeHeroAs(store, schemaVersion);
    return store;
  }

  async function articleText(store: DemoStore): Promise<string> {
    const hero = store.data.reports.find((r) => r.report_no === 'RL-2041-0187')!;
    const view = renderWithProviders(<ReportDetailPage />, {
      store,
      route: `/reports/${hero.id}`,
      path: '/reports/:reportId',
    });
    const article = await screen.findByRole('article', { name: 'RL-2041-0187' });
    await waitFor(() => expect(screen.getByTestId('manpower-total-crew')).toHaveTextContent('24'));
    const text = article.textContent ?? '';
    view.unmount();
    return text;
  }

  it('shows a version stored as v2 exactly like the v1 version it upgrades from', async () => {
    const v1 = await articleText(heroStoredAs(1));
    const v2 = await articleText(heroStoredAs(2));
    expect(v1).toContain('audio 0:41');
    expect(v2).toBe(v1);
  });

  it('prints observed weather in the report’s units', async () => {
    const store = heroAsV2((d) => {
      d.units = 'metric';
      d.weather.observed = {
        precip: 10.2,
        tempMin: 14.4,
        tempMax: 17.8,
        wind: 15,
        gust: 29,
        provider: 'Open-Meteo',
      };
    });
    const text = await articleText(store);
    expect(text).toContain('10.2 mm');
    expect(text).toContain('14–18 °C');
    expect(text).toContain('15 km/h');
    expect(text).toContain('29 km/h');
    expect(text).not.toMatch(/\d in\b|°F|mph/);
  });
});

describe('ReportDetailPage: photos in Edit', () => {
  it('removes a recorder photo and adds an office photo as a new version', async () => {
    const user = userEvent.setup();
    const { store, report } = renderReport('RL-2041-0187');
    await screen.findByRole('heading', { name: 'Friday, Oct 9 — Riverside B' });
    const before = within(screen.getByTestId('section-photos')).getAllByTestId('report-photo');
    expect(before).toHaveLength(2);
    const v2 = store.data.versions.find((v) => v.report_id === report.id && v.version === 2)!;
    const [first, second] = (v2.data as unknown as DailyReportData).photos;

    await user.click(screen.getByRole('button', { name: 'Edit' }));
    const picker = within(await screen.findByTestId('report-editor')).getByTestId('photo-picker');
    expect(within(picker).getAllByTestId('photo-item')).toHaveLength(2);
    expect(within(picker).getByLabelText('Caption for photo 1')).toHaveValue(first!.caption);
    await user.click(within(picker).getByRole('button', { name: 'Remove photo 1' }));
    await user.upload(
      within(picker).getByTestId('photo-input'),
      new File(['png'], 'pump.png', { type: 'image/png' }),
    );
    expect(await within(picker).findByTestId('photo-thumb')).toBeInTheDocument();
    await user.type(within(picker).getByLabelText('Caption for photo 2'), 'Pump truck at 13:00');
    expect(within(picker).getByTestId('photo-count')).toHaveTextContent('2 photos of 20');

    await user.click(screen.getByTestId('save-version'));
    const dialog = await screen.findByRole('dialog');
    await user.type(
      within(dialog).getByLabelText('Change note'),
      'Wrong morning photo; pump added',
    );
    await user.click(within(dialog).getByTestId('confirm-save'));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    const row = store.data.reports.find((r) => r.id === report.id)!;
    expect(row.current_version).toBe(3);
    const v3 = store.data.versions.find((v) => v.report_id === report.id && v.version === 3)!;
    const added = store.data.uploads.find((u) => u.report_id === report.id && u.uploaded_by)!;
    expect(added).toMatchObject({
      caption: 'Pump truck at 13:00',
      kind: 'photo',
      reporter_id: null,
    });
    expect((v3.data as unknown as DailyReportData).photos).toEqual([
      second,
      { uploadId: added.id, caption: 'Pump truck at 13:00', takenAt: '2026-10-09T23:00:00.000Z' },
    ]);
    expect(store.data.audit).toContainEqual(
      expect.objectContaining({
        action: 'report.version_created',
        diff: expect.objectContaining({
          version: 3,
          photos: 2,
          photos_added: 1,
          photos_removed: 1,
        }),
      }),
    );
    await waitFor(() =>
      expect(screen.getByTestId('version-switcher')).toHaveTextContent('v3 · current'),
    );
    const section = await screen.findByTestId('section-photos');
    await waitFor(() =>
      expect(within(section).getByText('Pump truck at 13:00')).toBeInTheDocument(),
    );
    expect(within(section).getAllByTestId('report-photo')).toHaveLength(2);
    expect(within(section).getByRole('img', { name: 'Pump truck at 13:00' })).toHaveAttribute(
      'src',
      expect.stringMatching(/^blob:/),
    );
  }, 30_000);

  it('counts a changed caption alone as an edit; an untouched form is "Nothing changed"', async () => {
    const user = userEvent.setup();
    const message = vi.spyOn(toast, 'message');
    const { store, report } = renderReport('RL-2041-0187');
    await screen.findByRole('heading', { name: 'Friday, Oct 9 — Riverside B' });
    await user.click(screen.getByRole('button', { name: 'Edit' }));
    await user.click(screen.getByTestId('save-version'));
    await waitFor(() => expect(message).toHaveBeenCalledWith('Nothing changed.'));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    message.mockRestore();

    const caption = screen.getByLabelText('Caption for photo 2');
    await user.clear(caption);
    await user.type(caption, 'Slab edge, end of day');
    await user.click(screen.getByTestId('save-version'));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText('Change note'), 'Clearer caption');
    await user.click(within(dialog).getByTestId('confirm-save'));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    const v3 = store.data.versions.find((v) => v.report_id === report.id && v.version === 3)!;
    expect((v3.data as unknown as DailyReportData).photos.map((p) => p.caption)).toEqual([
      'Conditions this morning',
      'Slab edge, end of day',
    ]);
  }, 30_000);

  it('places a new photo first, and locks Cancel while the photo uploads', async () => {
    const user = userEvent.setup();
    const store = new DemoStore();
    const source = makeSource('admin', store);
    const report = store.data.reports.find((r) => r.report_no === 'RL-2041-0187')!;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const upload = source.uploadReportPhoto.bind(source);
    vi.spyOn(source, 'uploadReportPhoto').mockImplementation(async (...args) => {
      await gate;
      return upload(...args);
    });
    renderWithProviders(<ReportDetailPage />, {
      source,
      route: `/reports/${report.id}`,
      path: '/reports/:reportId',
    });
    await screen.findByRole('heading', { name: 'Friday, Oct 9 — Riverside B' });
    const v2 = store.data.versions.find((v) => v.report_id === report.id && v.version === 2)!;
    const [first, second] = (v2.data as unknown as DailyReportData).photos;

    await user.click(screen.getByRole('button', { name: 'Edit' }));
    const picker = within(await screen.findByTestId('report-editor')).getByTestId('photo-picker');
    await user.upload(
      within(picker).getByTestId('photo-input'),
      new File(['png'], 'crane.png', { type: 'image/png' }),
    );
    await within(picker).findByTestId('photo-thumb');
    await user.click(within(picker).getByRole('button', { name: 'Move photo 3 earlier' }));
    await user.click(within(picker).getByRole('button', { name: 'Move photo 2 earlier' }));
    await user.type(within(picker).getByLabelText('Caption for photo 1'), 'Crane lift');

    await user.click(screen.getByTestId('save-version'));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText('Change note'), 'Crane photo first');
    await user.click(within(dialog).getByTestId('confirm-save'));
    // Uploading: neither Cancel can leave a save that still creates the version.
    await waitFor(() =>
      expect(within(dialog).getByRole('button', { name: 'Cancel' })).toBeDisabled(),
    );
    await user.keyboard('{Escape}');
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    release();
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    const v3 = store.data.versions.find((v) => v.report_id === report.id && v.version === 3)!;
    const added = store.data.uploads.find((u) => u.report_id === report.id && u.uploaded_by)!;
    expect((v3.data as unknown as DailyReportData).photos).toEqual([
      { uploadId: added.id, caption: 'Crane lift', takenAt: '2026-10-09T23:00:00.000Z' },
      first,
      second,
    ]);
  }, 30_000);

  it('dates a photo taken another day than the report’s', async () => {
    const store = new DemoStore();
    const report = store.data.reports.find((r) => r.report_no === 'RL-2041-0187')!;
    const current = store.data.versions.find(
      (v) => v.report_id === report.id && v.version === report.current_version,
    )!;
    const data = current.data as unknown as DailyReportData;
    data.photos[0] = { ...data.photos[0]!, takenAt: '2026-10-08T19:05:00.000Z' };
    data.photos[1] = { ...data.photos[1]!, takenAt: '2026-10-09T21:40:00.000Z' };
    renderWithProviders(<ReportDetailPage />, {
      store,
      route: `/reports/${report.id}`,
      path: '/reports/:reportId',
    });
    const section = await screen.findByTestId('section-photos');
    expect(within(section).getByText('Taken Oct 8 · 14:05')).toBeInTheDocument();
    expect(within(section).getByText('Taken 16:40')).toBeInTheDocument();
  });

  it('asks before discarding photo changes', async () => {
    const user = userEvent.setup();
    renderReport('RL-2041-0187');
    await screen.findByRole('heading', { name: 'Friday, Oct 9 — Riverside B' });
    await user.click(screen.getByRole('button', { name: 'Edit' }));
    await user.click(screen.getByRole('button', { name: 'Remove photo 2' }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('Discard changes?');
    await user.click(within(dialog).getByRole('button', { name: 'Discard' }));
    expect(screen.queryByTestId('report-editor')).not.toBeInTheDocument();
    expect(
      within(screen.getByTestId('section-photos')).getAllByTestId('report-photo'),
    ).toHaveLength(2);
  });
});

describe('ReportDetailPage (report typed in the panel)', () => {
  it('credits Open-Meteo only when there is observed weather', async () => {
    const store = new DemoStore();
    const site = store.data.sites.find((x) => x.project_code === 'P9-0932')!;
    const typed = store.createOfficeReport({
      siteId: site.id,
      date: '2026-09-14',
      data: {
        ...emptyReportDataV1('2026-09-14'),
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
        ...emptyReportDataV1('2026-10-09'),
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
        ...emptyReportDataV1('2026-10-09'),
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
