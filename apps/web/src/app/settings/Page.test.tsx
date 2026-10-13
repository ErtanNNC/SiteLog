import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { kestrelDemo } from '@sitelog/shared/demo/kestrel.ts';
import { demoPayrollCsv } from '@/data/demo/DemoSource';
import { DemoStore } from '@/data/demo/store';
import { makeSource, renderWithProviders } from '@/test/render';
import SettingsPage from './Page';

const opts = (store: DemoStore, section = 'reports') => ({
  route: `/settings/${section}`,
  path: '/settings/:section',
  store,
});

describe('SettingsPage (demo data)', () => {
  it('renders the reports section from org_settings with Save disabled until dirty, then persists', async () => {
    const store = new DemoStore();
    renderWithProviders(<SettingsPage />, opts(store));
    await screen.findByRole('heading', { name: /^Settings$/ });
    expect(
      screen.getAllByRole('tab', { name: 'Reports & reminders', selected: true }).length,
    ).toBeGreaterThan(0);
    expect(screen.getByLabelText('Report deadline')).toHaveValue('17:30');
    const save = screen.getByTestId('save-settings');
    expect(save).toBeDisabled();
    const ladder = screen.getByTestId('ladder');
    expect(within(ladder).getByTestId('stage-headsUp')).toHaveTextContent('at 16:55');
    expect(within(ladder).getByTestId('stage-missing')).toHaveTextContent('at 19:00');

    await userEvent.click(within(ladder).getByRole('switch', { name: 'Reminder 2' }));
    await userEvent.click(
      within(screen.getByTestId('working-days')).getByRole('button', { name: 'Sat' }),
    );
    await userEvent.click(
      screen.getByRole('radio', { name: 'File automatically after 15 minutes' }),
    );
    expect(save).toBeEnabled();
    await userEvent.click(save);
    await waitFor(() => expect(save).toBeDisabled());
    expect(store.data.settings.reminder2_enabled).toBe(false);
    expect(store.data.settings.working_days).toEqual([1, 2, 3, 4, 5, 6]);
    expect(store.data.settings.filing_mode).toBe('auto_15min');
    expect(store.data.settings.default_deadline).toBe('17:30:00');
    expect(store.data.audit.at(-1)!.action).toBe('settings.updated');
  });

  it('guards navigation while dirty and lets the user leave', async () => {
    const store = new DemoStore();
    renderWithProviders(
      <>
        <a href="/hours">Elsewhere</a>
        <SettingsPage />
      </>,
      opts(store),
    );
    await screen.findByRole('heading', { name: /^Settings$/ });
    await userEvent.click(screen.getByRole('switch', { name: 'Sign-off required' }));
    await userEvent.click(screen.getByRole('link', { name: 'Elsewhere' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('Unsaved changes');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Stay' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.getByRole('heading', { name: /^Settings$/ })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('link', { name: 'Elsewhere' }));
    await userEvent.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Leave' }),
    );
    await waitFor(() =>
      expect(screen.queryByRole('heading', { name: /^Settings$/ })).not.toBeInTheDocument(),
    );
    expect(store.data.settings.signoff_required).toBe(true);
  });

  it('keeps asking about unsaved changes on the Field channels tab', async () => {
    const store = new DemoStore();
    renderWithProviders(
      <>
        <a href="/sites">Sites</a>
        <SettingsPage />
      </>,
      opts(store),
    );
    await screen.findByRole('heading', { name: /^Settings$/ });
    await userEvent.click(
      within(screen.getByTestId('working-days')).getByRole('button', { name: 'Sat' }),
    );
    expect(screen.getByTestId('save-settings')).toBeEnabled();
    // Tabs inside /settings never prompt; the draft survives the switch.
    await userEvent.click(screen.getAllByRole('tab', { name: 'Field channels' })[0]!);
    expect(await screen.findByText('Coming next')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('link', { name: 'Sites' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('Unsaved changes');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Leave' }));
    await waitFor(() =>
      expect(screen.queryByRole('heading', { name: /^Settings$/ })).not.toBeInTheDocument(),
    );
  });

  it('edits recipients per site and applies one list to all sites', async () => {
    const store = new DemoStore();
    renderWithProviders(<SettingsPage />, opts(store, 'recipients'));
    await screen.findByRole('heading', { name: /^Settings$/ });
    expect(
      screen.getAllByRole('tab', { name: 'Recipients', selected: true }).length,
    ).toBeGreaterThan(0);
    const cards = screen.getAllByTestId('site-recipients');
    expect(cards).toHaveLength(6);
    const riverside = cards.find((c) => c.dataset.site === 'Riverside Lofts — Block B')!;
    await userEvent.type(within(riverside).getByRole('textbox'), 'owner@riverside.example');
    await userEvent.click(
      within(riverside).getByRole('button', { name: /^Add email · Riverside/ }),
    );
    expect(within(riverside).getByText('owner@riverside.example')).toBeInTheDocument();
    await userEvent.click(
      within(riverside).getByRole('button', { name: /^Apply to all sites · Riverside/ }),
    );
    const elm = cards.find((c) => c.dataset.site === 'Elm St. Townhomes')!;
    expect(within(elm).getByText('owner@riverside.example')).toBeInTheDocument();
    await userEvent.click(screen.getByTestId('save-settings'));
    await waitFor(() => expect(screen.getByTestId('save-settings')).toBeDisabled());
    const elmSite = store.data.sites.find((s) => s.project_code === 'ES-0377')!;
    expect(
      store.data.recipients.filter((r) => r.site_id === elmSite.id).map((r) => r.email),
    ).toContain('owner@riverside.example');
  });

  it('shows the PDF preview with the paper size and letterhead lines', async () => {
    const store = new DemoStore();
    renderWithProviders(<SettingsPage />, opts(store, 'pdf'));
    await screen.findByRole('heading', { name: /^Settings$/ });
    expect(
      screen.getAllByRole('tab', { name: 'PDF template', selected: true }).length,
    ).toBeGreaterThan(0);
    const preview = screen.getByTestId('pdf-preview');
    expect(preview).toHaveAttribute('data-paper', 'letter');
    expect(preview).toHaveTextContent('2101 W Fulton St, Chicago, IL 60612');
    await userEvent.click(screen.getByRole('radio', { name: 'A4' }));
    expect(preview).toHaveAttribute('data-paper', 'a4');
    await userEvent.click(screen.getByTestId('save-settings'));
    await waitFor(() => expect(store.data.settings.pdf_paper).toBe('a4'));
  });

  it('reorders payroll columns and saves them to org_settings (not localStorage)', async () => {
    const store = new DemoStore();
    renderWithProviders(<SettingsPage />, opts(store, 'payroll'));
    await screen.findByRole('heading', { name: /^Settings$/ });
    const list = screen.getByTestId('payroll-columns');
    const order = () =>
      within(list)
        .getAllByRole('listitem')
        .map((li) => li.textContent);
    expect(order()[0]).toContain('date');
    const save = screen.getByTestId('save-settings');
    expect(save).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Reset to default order' })).toBeDisabled();

    await userEvent.click(screen.getByRole('button', { name: 'Move company up' }));
    await userEvent.click(screen.getByRole('button', { name: 'Move company up' }));
    await userEvent.click(screen.getByRole('button', { name: 'Move company up' }));
    expect(order()[0]).toContain('company');
    expect(save).toBeEnabled();
    await userEvent.click(save);
    await waitFor(() => expect(save).toBeDisabled());
    expect(store.data.settings.payroll_columns).toEqual([
      'company',
      'date',
      'site',
      'project_code',
      'trade',
      'workers',
      'hours',
      'report_no',
      'version',
    ]);
    expect(store.data.audit.at(-1)!.action).toBe('settings.updated');
    expect(window.localStorage.length).toBe(0);
    // The demo CSV follows the saved order, like api-export-payroll.
    expect(demoPayrollCsv(store, '2026-W41').split('\n')[0]).toBe(
      'company,date,site,project_code,trade,workers,hours,report_no,version',
    );

    await userEvent.click(screen.getByRole('button', { name: 'Reset to default order' }));
    expect(order()[0]).toContain('date');
    expect(save).toBeEnabled();
  });

  it('uploads a PNG logo into the live preview, rejects other files and removes it', async () => {
    const created = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:logo-preview');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    const store = new DemoStore();
    renderWithProviders(<SettingsPage />, opts(store, 'pdf'));
    await screen.findByRole('heading', { name: /^Settings$/ });
    const input = screen.getByTestId('logo-input');

    await userEvent.upload(input, new File(['GIF89a'], 'logo.gif', { type: 'image/gif' }), {
      applyAccept: false,
    });
    expect(await screen.findByText('Use a PNG or SVG file.')).toBeInTheDocument();
    const big = new File([new Uint8Array(2 * 1024 * 1024 + 1)], 'big.png', { type: 'image/png' });
    await userEvent.upload(input, big);
    expect(await screen.findByText('The logo must be 2 MB or smaller.')).toBeInTheDocument();
    expect(store.data.org.logo_path).toBeNull();

    await userEvent.upload(input, new File(['png'], 'kestrel.png', { type: 'image/png' }));
    await waitFor(() => expect(store.data.org.logo_path).toBe(`${store.data.org.id}/logo.png`));
    expect(created).toHaveBeenCalled();
    expect(store.logoUrl).toBe('blob:logo-preview');
    const preview = screen.getByTestId('pdf-preview');
    await waitFor(() =>
      expect(preview.querySelector('img')).toHaveAttribute('src', 'blob:logo-preview'),
    );
    expect(screen.queryByText('Use a PNG or SVG file.')).not.toBeInTheDocument();
    expect(store.data.audit.at(-1)!.action).toBe('org.logo_updated');

    await userEvent.click(await screen.findByRole('button', { name: 'Remove logo' }));
    await waitFor(() => expect(store.data.org.logo_path).toBeNull());
    await waitFor(() => expect(preview.querySelector('img')).toBeNull());
    expect(store.data.audit.at(-1)!.action).toBe('org.logo_removed');
  });

  it('shows the error with Retry when settings fail to load, not an endless skeleton', async () => {
    const source = makeSource('admin', new DemoStore());
    const real = source.getSettings.bind(source);
    vi.spyOn(source, 'getSettings')
      .mockRejectedValueOnce(new Error('JWT expired'))
      .mockImplementation(real);
    renderWithProviders(<SettingsPage />, {
      route: '/settings/reports',
      path: '/settings/:section',
      source,
    });
    expect(await screen.findByText('Couldn’t load settings.')).toBeInTheDocument();
    expect(screen.getByText('JWT expired')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByLabelText('Report deadline')).toHaveValue('17:30');
  });

  it('Recipients in an org with no sites explains they are per site and links to adding one', async () => {
    const d = kestrelDemo();
    const store = new DemoStore({ ...d, sites: [], siteReporters: [], recipients: [] });
    renderWithProviders(<SettingsPage />, opts(store, 'recipients'));
    expect(await screen.findByRole('heading', { name: 'No sites yet' })).toBeInTheDocument();
    expect(screen.getByText('Recipients are set per site. Add a site first.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Connect your first site' })).toHaveAttribute(
      'href',
      '/setup/site',
    );
  });
});
