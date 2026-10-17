import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildDemirDemo, DEMIR_ORG_NAME } from '@sitelog/shared/demo/demir.ts';
import { kestrelDemo } from '@sitelog/shared/demo/kestrel.ts';
import { i18n } from '@/i18n/i18n';
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
    expect(await screen.findByTestId('pack-card')).toBeInTheDocument();
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

/** Demir Yapı (§18.2) as the demo store's org: the TR pack, one-way SMS. */
function demirStore(): DemoStore {
  const kestrel = kestrelDemo();
  return new DemoStore({ ...buildDemirDemo(), now: kestrel.now, billing: kestrel.billing });
}

const demirAuth = (store: DemoStore) => ({
  currentOrg: {
    id: store.data.org.id,
    name: DEMIR_ORG_NAME,
    timezone: 'Europe/Istanbul',
    activeSites: 2,
    role: 'admin' as const,
    locale: 'tr-TR' as const,
    country: 'TR',
  },
});

const row = (label: string) =>
  within(screen.getByTestId('pack-details')).getByText(label).closest('div')!;

describe('Settings → Field channels (W4-05, P12, §19 Q231, Q232)', () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    await act(() => i18n.changeLanguage('en'));
  });

  it('shows Kestrel’s US pack read-only and saves the daily link, calls and new-reporter default', async () => {
    const store = new DemoStore();
    renderWithProviders(<SettingsPage />, opts(store, 'channels'));
    const pack = await screen.findByTestId('pack-card');
    expect(pack).toHaveTextContent('Set by SiteLog per country');
    expect(row('Country')).toHaveTextContent(/United States\s*US/);
    expect(row('Text sender')).toHaveTextContent(
      'Toll-free number · Not set up in this environment',
    );
    expect(row('Number to call SiteLog')).toHaveTextContent('Talk now only');
    expect(screen.getByTestId('channel-order')).toHaveTextContent('Notifications → SMS → WhatsApp');
    expect(row('Replies to texts')).toHaveTextContent('Two-way');
    expect(row('Links in texts')).toHaveTextContent('Allowed');
    // Nothing in the pack card can be edited.
    expect(within(pack).queryAllByRole('textbox')).toHaveLength(0);
    expect(within(pack).queryAllByRole('switch')).toHaveLength(0);

    // The recording notice per field language with its version (voice.recording_notice.v1).
    const notice = screen.getByTestId('recording-notice');
    expect(
      within(notice)
        .getAllByRole('listitem')
        .map((li) => li.dataset.language),
    ).toEqual(['en', 'es']);
    expect(notice).toHaveTextContent('This call is recorded to write your daily report.');
    expect(within(notice).getAllByText('Version voice.recording_notice.v1')).toHaveLength(2);

    // A demo org places calls (console): both switches show.
    const save = screen.getByTestId('save-settings');
    expect(save).toBeDisabled();
    await userEvent.click(screen.getByRole('switch', { name: 'Second call at reminder 2' }));
    const time = screen.getByLabelText('Daily link time');
    expect(time).toHaveValue('17:00');
    fireEvent.change(time, { target: { value: '16:30' } });
    fireEvent.change(screen.getByLabelText('To'), { target: { value: '19:00' } });
    await userEvent.type(screen.getByLabelText('Daily link expiry (hours)'), '24');
    await userEvent.click(screen.getByRole('radio', { name: 'Call' }));
    await userEvent.click(save);
    await waitFor(() => expect(save).toBeDisabled());
    expect(store.data.settings).toMatchObject({
      second_call_enabled: false,
      daily_link_time: '16:30:00',
      call_window_end: '19:00:00',
      daily_link_ttl_hours: 24,
      default_contact_pref: 'call',
    });
    expect(store.data.audit.at(-1)!.action).toBe('settings.updated');
  });

  it('holds Save while the expiry is not whole hours from 1 to 168; empty is SiteLog’s default', async () => {
    const store = new DemoStore();
    renderWithProviders(<SettingsPage />, opts(store, 'channels'));
    const ttl = await screen.findByLabelText('Daily link expiry (hours)');
    const save = screen.getByTestId('save-settings');
    await userEvent.type(ttl, '200');
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Enter whole hours from 1 to 168, or leave it empty.',
    );
    expect(ttl).toHaveAttribute('aria-invalid', 'true');
    expect(save).toBeDisabled();
    await userEvent.clear(ttl);
    await userEvent.type(ttl, '48');
    expect(save).toBeEnabled();
    await userEvent.click(save);
    await waitFor(() => expect(store.data.settings.daily_link_ttl_hours).toBe(48));
    await userEvent.clear(ttl);
    await userEvent.click(save);
    await waitFor(() => expect(store.data.settings.daily_link_ttl_hours).toBeNull());
  });

  it('Demir Yapı in Turkish: the TR pack, one-way texts, Talk now only', async () => {
    await act(() => i18n.changeLanguage('tr'));
    const store = demirStore();
    renderWithProviders(<SettingsPage />, {
      ...opts(store, 'channels'),
      auth: demirAuth(store),
    });
    expect(await screen.findByRole('heading', { name: 'Ayarlar' })).toBeInTheDocument();
    expect(
      screen.getAllByRole('tab', { name: 'Saha kanalları', selected: true }).length,
    ).toBeGreaterThan(0);
    expect(screen.getByTestId('pack-card')).toHaveTextContent(
      'SiteLog tarafından ülkeye göre ayarlanır',
    );
    expect(row('Ülke')).toHaveTextContent('TR');
    expect(row('Mesaj göndericisi')).toHaveTextContent('Gönderici adı · Bu ortamda ayarlanmadı');
    expect(row('SiteLog’u arama numarası')).toHaveTextContent('Yalnızca Şimdi konuş');
    expect(row('Mesajlara yanıt')).toHaveTextContent('Tek yönlü');
    const notice = screen.getByTestId('recording-notice');
    expect(
      within(notice)
        .getAllByRole('listitem')
        .map((li) => li.dataset.language),
    ).toEqual(['tr', 'en']);
    expect(screen.getByLabelText('Günlük bağlantı saati')).toHaveValue('17:00');
  });

  it('sends a test message (a demo org: console, audited with the number masked), five an hour', async () => {
    const store = new DemoStore();
    renderWithProviders(<SettingsPage />, opts(store, 'channels'));
    await userEvent.click(await screen.findByRole('button', { name: 'Send me a test message' }));
    const dialog = await screen.findByRole('dialog', { name: 'Send me a test message' });
    const send = within(dialog).getByRole('button', { name: 'Send test message' });
    await userEvent.type(within(dialog).getByTestId('test-phone'), '(555) 014-2290');
    await userEvent.click(send);
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'Tick the box to confirm it is your own number.',
    );
    await userEvent.click(within(dialog).getByRole('checkbox', { name: 'This is my own number.' }));
    await userEvent.click(send);
    expect(await within(dialog).findByTestId('test-result')).toHaveTextContent(
      'Demo company: nothing was sent.',
    );
    expect(store.data.audit.at(-1)).toMatchObject({
      action: 'settings.test_message',
      diff: { to: '+1555***290', driver: 'console', language: 'en' },
    });
    for (let i = 0; i < 4; i++) {
      await userEvent.click(send);
      await waitFor(() =>
        expect(store.data.audit.filter((a) => a.action === 'settings.test_message')).toHaveLength(
          i + 2,
        ),
      );
    }
    await userEvent.click(send);
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'Five test messages an hour. Try again later.',
    );
  });

  it('Call me now (§19 Q232, Q350): a demo org’s test call is the console’s, audited masked, five an hour', async () => {
    const store = new DemoStore();
    renderWithProviders(<SettingsPage />, opts(store, 'channels'));
    await userEvent.click(await screen.findByRole('button', { name: 'Call me now' }));
    const dialog = await screen.findByRole('dialog', { name: 'Call me now' });
    expect(dialog).toHaveTextContent('Nothing is recorded and the number is not saved.');
    // The US pack's field languages.
    expect(within(dialog).getByLabelText('Language of the call')).toBeInTheDocument();
    const call = within(dialog).getByRole('button', { name: 'Call me now' });
    await userEvent.click(call);
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'Enter a valid mobile number.',
    );
    await userEvent.type(within(dialog).getByTestId('call-phone'), '(555) 014-3378');
    await userEvent.click(call);
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'Tick the box to confirm it is your own number.',
    );
    await userEvent.click(within(dialog).getByRole('checkbox', { name: 'This is my own number.' }));
    await userEvent.click(call);
    expect(await within(dialog).findByTestId('call-result')).toHaveTextContent(
      'Demo company: the call was placed on SiteLog’s console, so no real phone rings.',
    );
    expect(store.data.audit.at(-1)).toMatchObject({
      action: 'settings.test_call',
      diff: { to: '+1555***378', telephony: 'console', language: 'en' },
    });
    expect(JSON.stringify(store.data.audit)).not.toContain('5550143378');
    for (let i = 0; i < 4; i++) {
      await userEvent.click(call);
      await waitFor(() =>
        expect(store.data.audit.filter((a) => a.action === 'settings.test_call')).toHaveLength(
          i + 2,
        ),
      );
    }
    await userEvent.click(call);
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'Five test calls an hour. Try again later.',
    );
  });

  it('has no Call me now where the org places no calls (the Calls card says why)', async () => {
    const store = new DemoStore();
    store.data.org.is_demo = false;
    renderWithProviders(<SettingsPage />, opts(store, 'channels'));
    expect(await screen.findByTestId('no-calls')).toHaveTextContent(
      'SiteLog does not place calls in United States yet.',
    );
    expect(screen.getByRole('button', { name: 'Send me a test message' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Call me now' })).toBeNull();
  });

  it('Call me now in Turkish for Demir Yapı', async () => {
    await act(() => i18n.changeLanguage('tr'));
    const store = demirStore();
    renderWithProviders(<SettingsPage />, {
      ...opts(store, 'channels'),
      auth: demirAuth(store),
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Beni şimdi ara' }));
    const dialog = await screen.findByRole('dialog', { name: 'Beni şimdi ara' });
    expect(dialog).toHaveTextContent('Hiçbir şey kaydedilmez, numara saklanmaz.');
    expect(within(dialog).getByLabelText('Aramanın dili')).toBeInTheDocument();
  });
});

describe('Settings → Reports & reminders on v1.2 and the report language (W4-05, §19 Q233)', () => {
  afterEach(async () => {
    await act(() => i18n.changeLanguage('en'));
  });

  it('shows the daily link in the ladder, R1 per person, and no WhatsApp word', async () => {
    renderWithProviders(<SettingsPage />, opts(new DemoStore()));
    const ladder = await screen.findByTestId('ladder');
    const daily = within(ladder).getByTestId('stage-dailyLink');
    expect(daily).toHaveTextContent('Daily link');
    expect(daily).toHaveTextContent('at 17:00');
    expect(within(daily).getByRole('link', { name: 'Change on Field channels' })).toHaveAttribute(
      'href',
      '/settings/channels',
    );
    expect(within(ladder).getByTestId('stage-reminder1')).toHaveTextContent(
      'Text or call — per person',
    );
    expect(screen.getByText(/one question on the recorder or the call/)).toBeInTheDocument();
    expect(
      screen.getByRole('radio', {
        name: 'Reporter confirms — on the recorder or by voice on the call',
      }),
    ).toBeInTheDocument();
    expect(document.body).not.toHaveTextContent(/WhatsApp/);
  });

  it('reads in Turkish', async () => {
    await act(() => i18n.changeLanguage('tr'));
    renderWithProviders(<SettingsPage />, opts(new DemoStore()));
    expect(await screen.findByRole('heading', { name: 'Ayarlar' })).toBeInTheDocument();
    expect(screen.getByLabelText('Rapor son saati')).toHaveValue('17:30');
    expect(
      within(screen.getByTestId('working-days')).getByRole('button', { name: 'Cmt' }),
    ).toBeInTheDocument();
    expect(screen.getByTestId('stage-reminder1')).toHaveTextContent(
      'Mesaj veya arama — kişiye göre',
    );
  });

  it('changes the report language and units after a confirm, audited, without Save', async () => {
    const store = new DemoStore();
    renderWithProviders(<SettingsPage />, opts(store, 'pdf'));
    const card = await screen.findByTestId('report-locale');
    const apply = within(card).getByRole('button', { name: 'Change language and units' });
    expect(apply).toBeDisabled();
    await userEvent.click(within(card).getByRole('combobox', { name: 'Report language' }));
    await userEvent.click(await screen.findByRole('option', { name: 'Turkish' }));
    await userEvent.click(within(card).getByRole('combobox', { name: 'Units' }));
    await userEvent.click(await screen.findByRole('option', { name: 'Metric (°C, mm, km/h)' }));
    await userEvent.click(apply);
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent(
      'New report versions will be in Turkish, Metric (°C, mm, km/h). Filed versions keep their language and units.',
    );
    await userEvent.click(within(dialog).getByRole('button', { name: 'Change' }));
    await waitFor(() => expect(store.data.org.locale).toBe('tr-TR'));
    expect(store.data.org.units).toBe('metric');
    expect(store.data.audit.at(-1)).toMatchObject({
      action: 'org.updated',
      diff: { locale: { from: 'en-US', to: 'tr-TR' }, units: { from: 'imperial', to: 'metric' } },
    });
    // The company details are untouched.
    expect(store.data.org.name).toBe(kestrelDemo().org.name);
    expect(screen.getByTestId('save-settings')).toBeDisabled();
  });
});
