import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { toast } from 'sonner';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Route, Routes } from 'react-router';
import { buildDemirDemo, DEMIR_ORG_NAME } from '@sitelog/shared/demo/demir.ts';
import { kestrelDemo } from '@sitelog/shared/demo/kestrel.ts';
import { DemoStore, demoUserFor } from '@/data/demo/store';
import { i18n } from '@/i18n/i18n';
import { storage } from '@/lib/utils';
import { makeSource, renderWithProviders } from '@/test/render';
import SetupPage from './Page';
import { progressKey, type SetupProgress } from './state';

const ADMIN = demoUserFor('admin').id;
/** Wizard progress is kept per user and org. */
const keyFor = (store: DemoStore) => progressKey(ADMIN, store.data.org.id);

/** The demo store's org as a TR org (Demir Yapı's country and locale, spec §18.2). */
function trOrg(source: ReturnType<typeof makeSource>) {
  return {
    id: source.orgId,
    name: 'Demir Yapı A.Ş.',
    timezone: 'Europe/Istanbul',
    activeSites: 0,
    role: 'admin' as const,
    locale: 'tr-TR' as const,
    country: 'TR',
  };
}

/** Fills the site step with a manager and submits it; `phone` in the picker's country. */
async function submitSite(code: string, manager: string, phone: string) {
  await userEvent.type(await screen.findByLabelText('Site name'), `Site ${code}`);
  await userEvent.type(screen.getByLabelText('Project number'), code);
  await userEvent.type(screen.getByLabelText('Site address'), '1 Test St');
  await userEvent.type(screen.getByLabelText('Name'), manager);
  await userEvent.type(screen.getByTestId('manager-phone'), phone);
  await userEvent.click(screen.getByTestId('mgr-sms-attest'));
  await userEvent.click(screen.getByRole('button', { name: 'Send welcome text' }));
  expect(await screen.findByRole('heading', { name: 'Reports & reminders' })).toBeInTheDocument();
}

function Harness() {
  return (
    <Routes>
      <Route path="/setup" element={<SetupPage />} />
      <Route path="/setup/:step" element={<SetupPage />} />
      <Route path="/" element={<h1>Overview landing</h1>} />
      <Route path="/sites" element={<h1>Sites landing</h1>} />
      <Route path="/login" element={<h1>Login landing</h1>} />
    </Routes>
  );
}

describe('SetupPage (demo org)', () => {
  it(
    'runs the happy path: company → site & manager (with live preview) → reports → finish',
    { timeout: 30_000 },
    async () => {
      const store = new DemoStore();
      const success = vi.spyOn(toast, 'success');
      storage.set(keyFor(store), { done: {}, createdSites: [] });
      renderWithProviders(<Harness />, { route: '/setup/company', store });
      expect(
        await screen.findByRole('heading', { name: 'Set up your company' }),
      ).toBeInTheDocument();
      expect(screen.getByTestId('setup-header')).toHaveTextContent('Kestrel Build Group · setup');
      expect(await screen.findByLabelText('Company name')).toHaveValue('Kestrel Build Group');
      // The org exists: the stored details are shown, and unchanged ones are not saved again.
      expect(screen.getByLabelText(/^Address/)).toHaveValue('2101 W Fulton St, Chicago, IL 60612');
      await userEvent.click(screen.getByRole('button', { name: 'Continue to first site' }));

      expect(await screen.findByRole('heading', { name: 'Site' })).toBeInTheDocument();
      const stepper = screen.getByRole('list', { name: 'Set up your company' });
      expect(within(stepper).getAllByRole('listitem')[0]).toHaveAttribute('data-state', 'done');
      expect(within(stepper).getAllByRole('listitem')[1]).toHaveAttribute('aria-current', 'step');

      await userEvent.type(screen.getByLabelText('Site name'), 'Harbor View Apartments');
      await userEvent.type(screen.getByLabelText('Project number'), 'hv-5120');
      expect(screen.getByLabelText('Project number')).toHaveValue('HV-5120');
      await userEvent.type(
        screen.getByLabelText('Site address'),
        '400 Harbor Dr, Chicago, IL 60611',
      );
      expect(screen.getByTestId('geo-warning')).toBeInTheDocument();
      await userEvent.type(screen.getByLabelText('Latitude'), '41.8927');
      await userEvent.type(screen.getByLabelText('Longitude'), '-87.6136');
      await userEvent.type(screen.getByLabelText('Name'), 'Elena Vasquez');
      await userEvent.type(screen.getByTestId('manager-phone'), '555 014 8001');
      await userEvent.click(screen.getByTestId('mgr-sms-attest'));

      // W4-02: the §9.2 welcome as sent, by SMS, with the US pack's reply clause (two-way) and no
      // "or call" (no voice number in the demo pack); the v1.0 template and its buttons are gone.
      const preview = screen.getByTestId('welcome-preview');
      expect(screen.getByTestId('welcome-text')).toHaveTextContent(
        "Hi Elena, I'm TalkOlog, the daily report assistant for Kestrel Build Group at Harbor View Apartments. Each workday before 17:30, tap your link and talk for ~3 min: https://go.talkolog.com/r/MRZ4K7 - Reply STOP to opt out, HELP for help",
      );
      expect(screen.getByTestId('welcome-text')).toHaveAttribute('lang', 'en');
      expect(preview).toHaveTextContent('TalkOlog · text message');
      expect(preview).not.toHaveTextContent('Got it');
      expect(screen.queryByTestId('welcome-call-note')).not.toBeInTheDocument();
      // The org's own price (W4-10, §19 Q234).
      const pricing = screen.getByTestId('pricing-card');
      expect(within(pricing).getByText('$399')).toBeInTheDocument();
      expect(within(pricing).getByText('/ site / month')).toBeInTheDocument();
      expect(within(pricing).getByText('$0 setup · billed per active site')).toBeInTheDocument();
      // The preference and language default to Text link and the pack's first field locale.
      expect(screen.getByRole('radio', { name: 'Text link' })).toBeChecked();
      expect(screen.getByTestId('mgr-locale')).toHaveTextContent('English');

      await userEvent.click(screen.getByRole('button', { name: 'Send welcome text' }));
      expect(
        await screen.findByRole('heading', { name: 'Reports & reminders' }),
      ).toBeInTheDocument();
      // The invite only queues the welcome; it goes out once a worker sends it.
      expect(success).toHaveBeenCalledWith(
        'Site added. The welcome text to Elena Vasquez is queued.',
      );
      const site = store.data.sites.find((s) => s.project_code === 'HV-5120')!;
      expect(site).toMatchObject({
        name: 'Harbor View Apartments',
        lat: 41.8927,
        lng: -87.6136,
        deadline: '17:30:00',
      });
      const elena = store.data.reporters.find((r) => r.name === 'Elena Vasquez')!;
      expect(elena.phone_e164).toBe('+15550148001');
      expect(elena).toMatchObject({ locale: 'en-US', contact_pref: 'link', status: 'invited' });
      expect(
        store.data.audit.find((a) => a.action === 'reporter.invited' && a.entity_id === elena.id)
          ?.diff,
      ).toMatchObject({ sms_attestation: 'team.invite_sms.v1' });
      expect(store.data.siteReporters.find((sr) => sr.reporter_id === elena.id)).toMatchObject({
        site_id: site.id,
        is_primary: true,
      });

      await userEvent.type(
        screen.getByRole('textbox', { name: 'Add email' }),
        'pm@kestrelbuild.example{enter}',
      );
      await userEvent.click(screen.getByRole('switch', { name: 'Weather heads-up' }));
      await userEvent.click(screen.getByRole('button', { name: 'Finish' }));
      expect(await screen.findByRole('heading', { name: 'Overview landing' })).toBeInTheDocument();
      expect(store.data.settings.heads_up_enabled).toBe(false);
      expect(
        store.data.recipients.filter((r) => r.site_id === site.id).map((r) => r.email),
      ).toEqual(['pm@kestrelbuild.example']);
      expect(storage.get(keyFor(store), null)).toBeNull();
      expect(store.data.audit.some((a) => a.action === 'org.updated')).toBe(false);
    },
  );

  it(
    'validates the site step and resumes at the last incomplete step',
    { timeout: 30_000 },
    async () => {
      const store = new DemoStore();
      storage.set(keyFor(store), {
        done: { company: true },
        flow: 'wizard',
        createdSites: [],
        site: { name: 'Pending site', projectCode: 'RL-2041' },
      });
      renderWithProviders(<Harness />, { route: '/setup', store });
      expect(await screen.findByRole('heading', { name: 'Site' })).toBeInTheDocument();
      expect(await screen.findByDisplayValue('Pending site')).toBe(
        screen.getByLabelText('Site name'),
      );
      await userEvent.click(screen.getByRole('button', { name: 'Send welcome text' }));
      expect(screen.getByText('That project number is already in use.')).toBeInTheDocument();
      expect(screen.getByText('Enter the site manager’s name.')).toBeInTheDocument();
      expect(
        screen.getByText('Enter a valid mobile number for the chosen country.'),
      ).toBeInTheDocument();
      // Owner decision 2026-10-20: the office attests the manager agreed to get texts.
      expect(
        screen.getByText(
          'Tick the box first: the person must have agreed to get daily report texts.',
        ),
      ).toBeInTheDocument();
      expect(
        screen.getByRole('checkbox', {
          name: 'This person agreed to get daily report texts from TalkOlog',
        }),
      ).toHaveAttribute('aria-invalid', 'true');
      expect(store.data.sites).toHaveLength(6);
    },
  );

  it('"Add site" mode lands on /sites after sending the welcome', { timeout: 30_000 }, async () => {
    const store = new DemoStore();
    renderWithProviders(<Harness />, { route: '/setup/site', store });
    expect(await screen.findByRole('heading', { name: 'Add a site' })).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('Site name'), 'Westgate Clinic');
    await userEvent.type(screen.getByLabelText('Project number'), 'WG-0100');
    await userEvent.type(screen.getByLabelText('Site address'), '12 West St, Chicago, IL');
    await userEvent.type(screen.getByLabelText('Name'), 'Omar Haddad');
    await userEvent.type(screen.getByTestId('manager-phone'), '5550149001');
    await userEvent.click(screen.getByTestId('mgr-sms-attest'));
    await userEvent.click(screen.getByRole('button', { name: 'Send welcome text' }));
    expect(await screen.findByRole('heading', { name: 'Sites landing' })).toBeInTheDocument();
    await waitFor(() =>
      expect(store.data.sites.some((s) => s.project_code === 'WG-0100')).toBe(true),
    );
  });

  it('validates the company logo and uploads it once the company is created', async () => {
    const store = new DemoStore();
    storage.set(keyFor(store), { done: {}, createdSites: [] });
    renderWithProviders(<Harness />, { route: '/setup/company', store });
    await screen.findByLabelText('Company name');
    const input = document.getElementById('co-logo') as HTMLInputElement;
    await userEvent.upload(input, new File(['x'], 'logo.jpg', { type: 'image/jpeg' }), {
      applyAccept: false,
    });
    expect(await screen.findByText('Use a PNG or SVG file.')).toBeInTheDocument();
    await userEvent.upload(input, new File(['<svg/>'], 'logo.svg', { type: 'image/svg+xml' }));
    await waitFor(() =>
      expect(screen.queryByText('Use a PNG or SVG file.')).not.toBeInTheDocument(),
    );
    expect(store.data.org.logo_path).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Continue to first site' }));
    expect(await screen.findByRole('heading', { name: 'Site' })).toBeInTheDocument();
    expect(store.data.org.logo_path).toBe(`${store.data.org.id}/logo.svg`);
    expect(store.logoUrl).toMatch(/^blob:/);
    expect(store.data.audit.at(-1)!.action).toBe('org.logo_updated');
  });

  it('Back to the company step edits the existing org instead of creating a second one', async () => {
    const store = new DemoStore();
    const source = makeSource('admin', store);
    const refreshOrgs = vi.fn(async () => []);
    storage.set(keyFor(store), { done: { company: true }, flow: 'wizard', createdSites: [] });
    renderWithProviders(<Harness />, {
      route: '/setup/site',
      source,
      auth: { refreshOrgs },
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Back' }));
    const name = await screen.findByLabelText('Company name');
    expect(name).toHaveValue('Kestrel Build Group');
    await userEvent.clear(name);
    await userEvent.type(name, 'Kestrel Build Group LLC');
    await userEvent.click(screen.getByRole('button', { name: 'Continue to first site' }));
    expect(await screen.findByRole('heading', { name: 'Site' })).toBeInTheDocument();
    expect(store.data.org).toMatchObject({
      id: source.orgId,
      name: 'Kestrel Build Group LLC',
      address: '2101 W Fulton St, Chicago, IL 60612',
    });
    expect(store.data.audit.at(-1)).toMatchObject({
      action: 'org.updated',
      entity_id: source.orgId,
      diff: { name: { from: 'Kestrel Build Group', to: 'Kestrel Build Group LLC' } },
    });
    expect(refreshOrgs).toHaveBeenCalled();
  });

  it('shows the org’s country locked on the company step (W1-06a, spec §19 Q31)', async () => {
    const store = new DemoStore();
    storage.set(keyFor(store), { done: {}, createdSites: [] });
    renderWithProviders(<Harness />, { route: '/setup/company', store });
    expect(await screen.findByLabelText('Company name')).toHaveValue('Kestrel Build Group');
    const country = screen.getByRole('combobox', { name: 'Country' });
    expect(country).toBeDisabled();
    expect(country).toHaveTextContent(/\bUS$/);
    expect(country).toHaveAccessibleDescription('The country can’t be changed after setup.');
    expect(screen.queryByTestId('country-presets')).not.toBeInTheDocument();
  });

  it('shows the org’s country over one an older run saved, and saves it', async () => {
    const store = new DemoStore();
    // Progress saved before the org existed (or by an older build) names another country.
    storage.set(keyFor(store), { done: {}, company: { country: 'TR' }, createdSites: [] });
    renderWithProviders(<Harness />, { route: '/setup/company', store });
    expect(await screen.findByLabelText('Company name')).toHaveValue('Kestrel Build Group');
    const country = screen.getByRole('combobox', { name: 'Country' });
    expect(country).toBeDisabled();
    expect(country).toHaveTextContent(/\bUS$/);
    await waitFor(() =>
      expect(storage.get<SetupProgress | null>(keyFor(store), null)?.company.country).toBe('US'),
    );
  });

  it('starts a TR org’s site manager with a +90 number and Turkish (its country pack)', async () => {
    const store = new DemoStore();
    const source = makeSource('admin', store);
    storage.set(keyFor(store), { done: { company: true }, flow: 'wizard', createdSites: [] });
    renderWithProviders(<Harness />, {
      route: '/setup/site',
      source,
      auth: { currentOrg: trOrg(source) },
    });
    expect(await screen.findByRole('heading', { name: 'Site' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Country code: .+ \+90$/ })).toHaveTextContent(
      'TR +90',
    );
    expect(screen.getByRole('checkbox', { name: 'Turkish' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    expect(screen.getByRole('checkbox', { name: 'English' })).toHaveAttribute(
      'aria-checked',
      'false',
    );
    expect(screen.getByRole('combobox', { name: 'Site time zone' })).toHaveTextContent(
      'Europe/Istanbul',
    );
    // A TR org's reports come out in Turkish (§9.6), whatever the manager speaks.
    expect(screen.getByText('Reports always come out in Turkish.')).toBeInTheDocument();
  });

  it(
    'creates a TR org’s manager speaking Turkish when no language is ticked',
    { timeout: 30_000 },
    async () => {
      const store = new DemoStore();
      const source = makeSource('admin', store);
      storage.set(keyFor(store), { done: { company: true }, flow: 'wizard', createdSites: [] });
      renderWithProviders(<Harness />, {
        route: '/setup/site',
        source,
        auth: { currentOrg: trOrg(source) },
      });
      await userEvent.click(await screen.findByRole('checkbox', { name: 'Turkish' }));
      expect(screen.getByRole('checkbox', { name: 'Turkish' })).toHaveAttribute(
        'aria-checked',
        'false',
      );
      await submitSite('KK-1300', 'Emre Yıldız', '532 000 0599');
      const emre = store.data.reporters.find((r) => r.name === 'Emre Yıldız')!;
      expect(emre).toMatchObject({ phone_e164: '+905320000599', languages: ['tr'] });
    },
  );

  it(
    'creates a US org’s manager speaking English when no language is ticked',
    { timeout: 30_000 },
    async () => {
      const store = new DemoStore();
      storage.set(keyFor(store), { done: { company: true }, flow: 'wizard', createdSites: [] });
      renderWithProviders(<Harness />, { route: '/setup/site', store });
      expect(await screen.findByText('Reports always come out in English.')).toBeInTheDocument();
      await userEvent.click(screen.getByRole('checkbox', { name: 'English' }));
      await submitSite('HV-5121', 'Elena Vasquez', '555 014 8001');
      const elena = store.data.reporters.find((r) => r.name === 'Elena Vasquez')!;
      expect(elena).toMatchObject({ phone_e164: '+15550148001', languages: ['en'] });
    },
  );

  it('is admin-only inside an org', async () => {
    const store = new DemoStore();
    renderWithProviders(<Harness />, { route: '/setup/site', store, as: 'pm' });
    expect(await screen.findByRole('heading', { name: 'No access' })).toBeInTheDocument();
    expect(
      screen.getByText('You don’t have access to company setup. Ask an admin.'),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText('Site name')).not.toBeInTheDocument();
  });

  it(
    'keeps a created site when its manager invite fails, so a retry cannot duplicate it',
    { timeout: 30_000 },
    async () => {
      const store = new DemoStore();
      const source = makeSource('admin', store);
      const real = source.createSite.bind(source);
      vi.spyOn(source, 'createSite').mockImplementation(async (input) => ({
        ...(await real({ ...input, reporter: null })),
        inviteError: 'api-invite-reporter failed (502)',
      }));
      const error = vi.spyOn(toast, 'error');
      const success = vi.spyOn(toast, 'success');
      storage.set(keyFor(store), { done: { company: true }, flow: 'wizard', createdSites: [] });
      renderWithProviders(<Harness />, { route: '/setup/site', source });
      await userEvent.type(await screen.findByLabelText('Site name'), 'Harbor View Apartments');
      await userEvent.type(screen.getByLabelText('Project number'), 'HV-5120');
      await userEvent.type(screen.getByLabelText('Site address'), '400 Harbor Dr, Chicago, IL');
      await userEvent.type(screen.getByLabelText('Name'), 'Elena Vasquez');
      await userEvent.type(screen.getByTestId('manager-phone'), '555 014 8001');
      await userEvent.click(screen.getByTestId('mgr-sms-attest'));
      await userEvent.click(screen.getByRole('button', { name: 'Send welcome text' }));

      expect(
        await screen.findByRole('heading', { name: 'Reports & reminders' }),
      ).toBeInTheDocument();
      const site = store.data.sites.find((s) => s.project_code === 'HV-5120')!;
      expect(storage.get<{ createdSites: unknown[] } | null>(keyFor(store), null)).toMatchObject({
        done: { site: true },
        createdSites: [{ id: site.id, name: 'Harbor View Apartments', code: 'HV-5120' }],
      });
      expect(error).toHaveBeenCalledWith(
        'The site was created, but the welcome text to Elena Vasquez couldn’t be queued (api-invite-reporter failed (502)). Invite them from Team & numbers.',
      );
      expect(success).not.toHaveBeenCalledWith(
        'Site added. The welcome text to Elena Vasquez is queued.',
      );

      // Back on the site step, the same project number is already taken (no second insert).
      await userEvent.click(screen.getByRole('button', { name: 'Back' }));
      await userEvent.type(await screen.findByLabelText('Project number'), 'HV-5120');
      await userEvent.click(screen.getByRole('button', { name: 'Send welcome text' }));
      expect(screen.getByText('That project number is already in use.')).toBeInTheDocument();
      expect(store.data.sites.filter((s) => s.project_code === 'HV-5120')).toHaveLength(1);
    },
  );

  it('finishing later adds the wizard recipients without dropping a list saved meanwhile', async () => {
    const store = new DemoStore();
    const riverside = store.data.sites.find((s) => s.project_code === 'RL-2041')!;
    storage.set(keyFor(store), {
      done: { company: true, site: true },
      flow: 'wizard',
      createdSites: [
        { id: riverside.id, name: riverside.name, code: riverside.project_code },
        // Stale progress: a site that is not in this org is left alone.
        { id: 'site-of-another-org', name: 'Elsewhere', code: 'EW-0001' },
      ],
      reports: { recipients: ['pm@kestrelbuild.example', 'sam@kestrelbuild.example'] },
    });
    renderWithProviders(<Harness />, { route: '/setup/reports', store });
    await userEvent.click(await screen.findByRole('button', { name: 'Finish' }));
    expect(await screen.findByRole('heading', { name: 'Overview landing' })).toBeInTheDocument();
    expect(
      store.data.recipients.filter((r) => r.site_id === riverside.id).map((r) => r.email),
    ).toEqual([
      'reports@kestrelbuild.example',
      'sam@kestrelbuild.example',
      'pm@kestrelbuild.example',
    ]);
    expect(store.data.recipients.some((r) => r.site_id === 'site-of-another-org')).toBe(false);
  });

  it('shows an error with Retry instead of an endless skeleton when settings fail to load', async () => {
    const store = new DemoStore();
    const source = makeSource('admin', store);
    const real = source.getSettings.bind(source);
    vi.spyOn(source, 'getSettings')
      .mockRejectedValueOnce(new Error('PostgREST unavailable'))
      .mockImplementation(real);
    storage.set(keyFor(store), {
      done: { company: true, site: true },
      flow: 'wizard',
      createdSites: [],
    });
    renderWithProviders(<Harness />, { route: '/setup/reports', source });
    expect(await screen.findByText('Couldn’t load settings.')).toBeInTheDocument();
    expect(screen.getByText('PostgREST unavailable')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('button', { name: 'Finish' })).toBeInTheDocument();
  });
});

describe('SetupPage (no org yet)', () => {
  it('"Save and finish later" signs out instead of bouncing back to the wizard', async () => {
    const signOut = vi.fn(async () => {});
    renderWithProviders(<Harness />, {
      route: '/setup/company',
      source: null,
      auth: { currentOrg: null, orgs: [], role: null, signOut },
    });
    await userEvent.type(await screen.findByLabelText('Company name'), 'Fresh Build Co');
    await userEvent.click(screen.getByRole('button', { name: 'Save and finish later' }));
    expect(await screen.findByRole('heading', { name: 'Login landing' })).toBeInTheDocument();
    expect(signOut).toHaveBeenCalledTimes(1);
    // The draft stays saved for this user (no org yet) and resumes after the next sign-in.
    expect(
      storage.get<{ company: { name: string } } | null>(progressKey(ADMIN), null)?.company.name,
    ).toBe('Fresh Build Co');
  });
});

/** Demir Yapı (§18.2), the TR pack's demo org: one-way SMS, no voice number, no price yet. */
function demirStore(): DemoStore {
  const kestrel = kestrelDemo();
  return new DemoStore({ ...buildDemirDemo(), now: kestrel.now, billing: kestrel.billing });
}

function demirOrg(store: DemoStore) {
  return {
    id: store.data.org.id,
    name: DEMIR_ORG_NAME,
    timezone: 'Europe/Istanbul',
    activeSites: 2,
    role: 'admin' as const,
    locale: 'tr-TR' as const,
    country: 'TR',
    price: null,
  };
}

async function fillSite(code: string, labels: { name: string; code: string; address: string }) {
  await userEvent.type(await screen.findByLabelText(labels.name), `Site ${code}`);
  await userEvent.type(screen.getByLabelText(labels.code), code);
  await userEvent.type(screen.getByLabelText(labels.address), '1 Test St');
}

const EN_LABELS = { name: 'Site name', code: 'Project number', address: 'Site address' };

describe('SetupPage site step on v1.2 (W4-02)', () => {
  afterEach(async () => {
    await act(() => i18n.changeLanguage('en'));
  });

  it(
    'sends the language and the preference; a call without a voice number uses Talk now (Q33)',
    { timeout: 30_000 },
    async () => {
      const store = new DemoStore();
      storage.set(keyFor(store), { done: { company: true }, flow: 'wizard', createdSites: [] });
      renderWithProviders(<Harness />, { route: '/setup/site', store });
      await fillSite('HV-5122', EN_LABELS);
      await userEvent.type(screen.getByLabelText('Name'), 'Luis Ortega');
      await userEvent.type(screen.getByTestId('manager-phone'), '555 014 8002');
      await userEvent.click(screen.getByTestId('mgr-sms-attest'));
      expect(screen.getByText('They can always use the other one.')).toBeInTheDocument();
      await userEvent.click(screen.getByRole('radio', { name: 'Call' }));
      // The US demo pack has no voice number: Talk now in the recorder (§19 Q33).
      expect(screen.getByText('They will use Talk now in the recorder.')).toBeInTheDocument();
      await userEvent.click(screen.getByTestId('mgr-locale'));
      await userEvent.click(await screen.findByRole('option', { name: 'Spanish' }));
      // The preview follows the chosen language (es-US), with the Spanish reply clause.
      const text = screen.getByTestId('welcome-text');
      expect(text).toHaveTextContent(/^Hola Luis, soy TalkOlog, el asistente de reportes diarios/);
      expect(text).toHaveAttribute('lang', 'es');
      // The backup reporter gets their own language and preference.
      await userEvent.click(screen.getByRole('button', { name: 'Add a backup reporter' }));
      await userEvent.type(screen.getByLabelText('Backup name'), 'Ana Ruiz');
      await userEvent.type(screen.getByTestId('backup-phone'), '555 014 8003');
      await userEvent.click(
        within(screen.getByRole('radiogroup', { name: 'Backup’s preferred channel' })).getByRole(
          'radio',
          { name: 'Call' },
        ),
      );
      // The backup needs the office's SMS attestation too (owner decision 2026-10-20).
      await userEvent.click(screen.getByRole('button', { name: 'Send welcome text' }));
      expect(
        await screen.findByText(
          'Tick the box first: the person must have agreed to get daily report texts.',
        ),
      ).toBeInTheDocument();
      expect(screen.getByTestId('bk-sms-attest')).toHaveAccessibleName(
        'Ana agreed to get daily report texts from TalkOlog',
      );
      expect(store.data.sites.some((s) => s.project_code === 'HV-5122')).toBe(false);
      await userEvent.click(screen.getByTestId('bk-sms-attest'));
      await userEvent.click(screen.getByRole('button', { name: 'Send welcome text' }));
      expect(
        await screen.findByRole('heading', { name: 'Reports & reminders' }),
      ).toBeInTheDocument();
      await waitFor(() =>
        expect(store.data.reporters.find((r) => r.name === 'Ana Ruiz')).toBeDefined(),
      );
      expect(store.data.reporters.find((r) => r.name === 'Luis Ortega')).toMatchObject({
        locale: 'es-US',
        contact_pref: 'call',
        role: 'site_manager',
      });
      expect(store.data.reporters.find((r) => r.name === 'Ana Ruiz')).toMatchObject({
        locale: 'en-US',
        contact_pref: 'call',
        role: 'backup',
      });
    },
  );

  it(
    'refuses a landline for a text link and allows a call where TalkOlog reaches it (Q229)',
    { timeout: 30_000 },
    async () => {
      const store = new DemoStore();
      const source = makeSource('admin', store);
      storage.set(keyFor(store), { done: { company: true }, flow: 'wizard', createdSites: [] });
      // A demo org places its calls (console telephony): TalkOlog can reach a landline by phone.
      renderWithProviders(<Harness />, {
        route: '/setup/site',
        source,
        auth: { currentOrg: trOrg(source) },
      });
      await fillSite('KK-1301', EN_LABELS);
      await userEvent.type(screen.getByLabelText('Name'), 'Emre Yıldız');
      await userEvent.type(screen.getByTestId('manager-phone'), '0212 222 33 44');
      await userEvent.click(screen.getByTestId('mgr-sms-attest'));
      await userEvent.click(screen.getByRole('button', { name: 'Send welcome text' }));
      expect(
        await screen.findByText(
          'This is a landline number, which can’t get texts. Choose Call, or enter a mobile number.',
        ),
      ).toBeInTheDocument();
      expect(store.data.sites.some((s) => s.project_code === 'KK-1301')).toBe(false);
      await userEvent.click(screen.getByRole('radio', { name: 'Call' }));
      await userEvent.click(screen.getByRole('button', { name: 'Send welcome text' }));
      expect(
        await screen.findByRole('heading', { name: 'Reports & reminders' }),
      ).toBeInTheDocument();
      expect(store.data.reporters.find((r) => r.name === 'Emre Yıldız')).toMatchObject({
        phone_e164: '+902122223344',
        contact_pref: 'call',
      });
    },
  );

  it('blocks a landline TalkOlog can neither text nor call (Q229, F2)', async () => {
    const store = new DemoStore();
    const source = makeSource('admin', store);
    storage.set(keyFor(store), { done: { company: true }, flow: 'wizard', createdSites: [] });
    // A real TR org: no voice number, no outbound trunk.
    renderWithProviders(<Harness />, {
      route: '/setup/site',
      source,
      auth: { currentOrg: { ...trOrg(source), demoOrg: false }, isDemo: false },
    });
    await fillSite('KK-1302', EN_LABELS);
    await userEvent.type(screen.getByLabelText('Name'), 'Emre Yıldız');
    await userEvent.type(screen.getByTestId('manager-phone'), '0212 222 33 44');
    await userEvent.click(screen.getByTestId('mgr-sms-attest'));
    await userEvent.click(screen.getByRole('radio', { name: 'Call' }));
    await userEvent.click(screen.getByRole('button', { name: 'Send welcome text' }));
    expect(
      await screen.findByText(/^This is a landline number\. TalkOlog can’t text it/),
    ).toBeInTheDocument();
    expect(store.data.sites.some((s) => s.project_code === 'KK-1302')).toBe(false);
    // A mobile number goes through.
    await userEvent.clear(screen.getByTestId('manager-phone'));
    await userEvent.type(screen.getByTestId('manager-phone'), '532 000 0598');
    await userEvent.click(screen.getByRole('button', { name: 'Send welcome text' }));
    expect(await screen.findByRole('heading', { name: 'Reports & reminders' })).toBeInTheDocument();
  });

  it(
    'runs in Turkish for a TR org: Emre, Türkçe and Call, the TR welcome, every step in Turkish',
    { timeout: 30_000 },
    async () => {
      await act(() => i18n.changeLanguage('tr'));
      const store = demirStore();
      const source = makeSource('admin', store);
      storage.set(progressKey(ADMIN, store.data.org.id), { done: {}, createdSites: [] });
      renderWithProviders(<Harness />, {
        route: '/setup/company',
        source,
        auth: { currentOrg: demirOrg(store) },
      });
      expect(await screen.findByRole('heading', { name: 'Şirketinizi kurun' })).toBeInTheDocument();
      expect(screen.getByRole('list', { name: 'Şirketinizi kurun' })).toHaveTextContent(
        'Adım 1 / 3',
      );
      expect(await screen.findByLabelText('Şirket adı')).toHaveValue(DEMIR_ORG_NAME);
      expect(screen.getByRole('combobox', { name: 'Ülke' })).toHaveAccessibleDescription(
        'Ülke kurulumdan sonra değiştirilemez.',
      );
      await userEvent.click(screen.getByRole('button', { name: 'İlk şantiyeye geç' }));

      expect(await screen.findByRole('heading', { name: 'Şantiye' })).toBeInTheDocument();
      await userEvent.type(screen.getByLabelText('Şantiye adı'), 'Kartal');
      await userEvent.type(screen.getByLabelText('Proje numarası'), 'KK-1300');
      await userEvent.type(screen.getByLabelText('Şantiye adresi'), 'Kartal, İstanbul');
      await userEvent.type(screen.getByLabelText('Ad'), 'Emre Yıldız');
      await userEvent.type(screen.getByTestId('manager-phone'), '532 000 0599');
      await userEvent.click(screen.getByTestId('mgr-sms-attest'));
      expect(screen.getByTestId('mgr-locale')).toHaveTextContent('Türkçe');
      await userEvent.click(screen.getByRole('radio', { name: 'Arama' }));
      expect(screen.getByText('Kayıt ekranındaki Şimdi konuş ile arar.')).toBeInTheDocument();
      // The TR welcome: one-way (no reply clause), no voice number (no "or call").
      const text = screen.getByTestId('welcome-text');
      expect(text).toHaveTextContent(
        `Merhaba Emre, ben TalkOlog, ${DEMIR_ORG_NAME} için Kartal günlük rapor asistanıyım. Her iş günü 17:30 öncesi linke dokunup ~3 dk anlatın: https://go.talkolog.com/r/MRZ4K7`,
      );
      expect(text).not.toHaveTextContent(/STOP|arayın/);
      expect(text).toHaveAttribute('lang', 'tr');
      expect(screen.getByText('Önizleme · Emre ne alacak')).toBeInTheDocument();
      expect(screen.getByTestId('mgr-sms-attest')).toHaveAccessibleName(
        'Emre, TalkOlog’dan günlük rapor mesajları almayı kabul etti',
      );
      // No TRY price yet (§19 Q9): Billing's line instead of a number.
      expect(screen.getByTestId('pricing-card')).toHaveTextContent(
        'Şantiye başına fiyatınızı TalkOlog belirler.',
      );
      await userEvent.click(screen.getByRole('button', { name: 'Karşılama mesajını gönder' }));

      expect(
        await screen.findByRole('heading', { name: 'Raporlar ve hatırlatmalar' }),
      ).toBeInTheDocument();
      // §18.2 seeds an Emre Yıldız already: the new one is found by his number.
      expect(store.data.reporters.find((r) => r.phone_e164 === '+905320000599')).toMatchObject({
        name: 'Emre Yıldız',
        locale: 'tr-TR',
        contact_pref: 'call',
        status: 'invited',
      });
      expect(screen.getByRole('button', { name: 'Bitir' })).toBeInTheDocument();
      expect(screen.getAllByRole('button', { name: 'E-posta ekle' }).length).toBeGreaterThan(0);
      // Settings' section speaks Turkish since W4-05: no English island is left in the step.
      expect(screen.getByRole('switch', { name: 'Hatırlatma 1' })).toBeInTheDocument();
      expect(document.querySelector('main [lang="en"]')).toBeNull();
    },
  );
});
