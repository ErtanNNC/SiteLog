import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router';
import { toast } from 'sonner';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEMO_COUNTRIES } from '@sitelog/shared/demo/countries.ts';
import type { CountryRow } from '@sitelog/shared/db/types.ts';
import { DemoStore, demoUserFor } from '@/data/demo/store';
import type * as EnvModule from '@/lib/env';
import { storage } from '@/lib/utils';
import { makeSource, renderWithProviders } from '@/test/render';
import SetupPage from './Page';
import { progressKey, type SetupProgress } from './state';

/**
 * The no-org wizard in Supabase mode (W1-06a): the country list is the `countries` table, read
 * under RLS by a signed-in user with no org, and create_org gets the chosen pack as `p_country`.
 */
const h = vi.hoisted(() => ({
  countries: { data: [] as unknown[] | null, error: null as { message: string } | null },
  rpc: vi.fn<
    (
      fn: string,
      args: Record<string, unknown>,
    ) => Promise<{ data: unknown; error: { code?: string; message: string } | null }>
  >(),
}));

vi.mock('@/lib/env', async (importOriginal) => {
  const mod = await importOriginal<typeof EnvModule>();
  return { ...mod, isDemo: false, env: { ...mod.env, demo: false } };
});
vi.mock('@/lib/supabase', () => ({
  supabase: {
    from: (table: string) => ({
      select: (cols: string) => ({
        order: async (col: string) => {
          if (table !== 'countries' || cols !== '*' || col !== 'code')
            throw new Error(`unexpected query ${table} ${cols} ${col}`);
          return { data: h.countries.data, error: h.countries.error };
        },
      }),
    }),
    rpc: (fn: string, args: Record<string, unknown>) => h.rpc(fn, args),
  },
}));

const ADMIN = demoUserFor('admin').id;
const ROWS = [...DEMO_COUNTRIES].sort((a, b) => a.code.localeCompare(b.code));

function Harness() {
  return (
    <Routes>
      <Route path="/setup" element={<SetupPage />} />
      <Route path="/setup/:step" element={<SetupPage />} />
      <Route path="/login" element={<h1>Login landing</h1>} />
    </Routes>
  );
}

function renderNoOrg() {
  const refreshOrgs = vi.fn(async () => []);
  renderWithProviders(<Harness />, {
    route: '/setup/company',
    source: null,
    auth: { currentOrg: null, orgs: [], role: null, refreshOrgs },
  });
  return { refreshOrgs };
}

async function chooseCountry(code: string) {
  await userEvent.click(screen.getByRole('combobox', { name: 'Country' }));
  await userEvent.click(await screen.findByRole('option', { name: new RegExp(` ${code}$`) }));
}

afterEach(() => {
  h.countries = { data: [], error: null };
  h.rpc.mockReset();
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('SetupPage (no org yet, Supabase mode)', () => {
  it('creates a TR org: create_org gets p_country, the site step starts in Turkish with +90', async () => {
    h.countries.data = ROWS;
    h.rpc.mockResolvedValue({ data: { id: 'org-new' }, error: null });
    const success = vi.spyOn(toast, 'success');
    const { refreshOrgs } = renderNoOrg();
    await userEvent.type(await screen.findByLabelText('Company name'), 'Demir Yapı A.Ş.');
    await chooseCountry('TR');
    await userEvent.click(screen.getByRole('button', { name: 'Continue to first site' }));

    await waitFor(() => expect(h.rpc).toHaveBeenCalledTimes(1));
    expect(h.rpc).toHaveBeenCalledWith('create_org', {
      p_name: 'Demir Yapı A.Ş.',
      p_timezone: 'Europe/Istanbul',
      p_address: null,
      p_license_no: null,
      p_country: 'TR',
    });
    await waitFor(() => expect(success).toHaveBeenCalledWith('Demir Yapı A.Ş. created.'));
    expect(refreshOrgs).toHaveBeenCalled();
    // The wizard continues in the new org: its first site manager defaults from the TR pack.
    const saved = storage.get<SetupProgress | null>(progressKey(ADMIN, 'org-new'), null)!;
    expect(saved.company).toMatchObject({ country: 'TR', timezone: 'Europe/Istanbul' });
    expect(saved.site).toMatchObject({
      timezone: 'Europe/Istanbul',
      managerCountry: 'TR',
      backupCountry: 'TR',
      languages: ['tr'],
    });
  });

  it('sends US (create_org’s default) when the user keeps the preselected country', async () => {
    h.countries.data = ROWS;
    h.rpc.mockResolvedValue({ data: { id: 'org-us' }, error: null });
    renderNoOrg();
    await userEvent.type(await screen.findByLabelText('Company name'), 'Fresh Build Co');
    await userEvent.click(screen.getByRole('button', { name: 'Continue to first site' }));
    await waitFor(() =>
      expect(h.rpc).toHaveBeenCalledWith(
        'create_org',
        expect.objectContaining({ p_country: 'US', p_timezone: 'America/Chicago' }),
      ),
    );
  });

  it('preselects the pack of a tr-TR browser’s region (spec §19 Q32, W4-01)', async () => {
    vi.spyOn(navigator, 'languages', 'get').mockReturnValue(['tr-TR', 'en-US']);
    h.countries.data = ROWS;
    h.rpc.mockResolvedValue({ data: { id: 'org-tr' }, error: null });
    renderNoOrg();
    await userEvent.type(await screen.findByLabelText('Company name'), 'Yıldız İnşaat');
    expect(screen.getByRole('combobox', { name: 'Country' })).toHaveTextContent(/\bTR$/);
    await userEvent.click(screen.getByRole('button', { name: 'Continue to first site' }));
    await waitFor(() =>
      expect(h.rpc).toHaveBeenCalledWith(
        'create_org',
        expect.objectContaining({ p_country: 'TR', p_timezone: 'Europe/Istanbul' }),
      ),
    );
  });

  it('keeps US when the browser’s region has no pack', async () => {
    vi.spyOn(navigator, 'languages', 'get').mockReturnValue(['de-DE', 'de']);
    h.countries.data = ROWS;
    renderNoOrg();
    await screen.findByLabelText('Company name');
    expect(screen.getByRole('combobox', { name: 'Country' })).toHaveTextContent(/\bUS$/);
  });

  it('lists a pack no code knows about: a new country is a new row (spec §4.6)', async () => {
    const zz: CountryRow = {
      ...ROWS[1]!,
      code: 'ZZ',
      default_locale: 'en-US',
      field_locales: ['es-US'],
      units: 'metric',
      paper: 'a4',
      currency: 'EUR',
      default_timezone: 'UTC',
      message_channels: ['whatsapp', 'sms'],
      sms_sender_type: 'alphanumeric',
      two_way_sms: false,
      sms_links_allowed: false,
    };
    h.countries.data = [...ROWS, zz];
    h.rpc.mockResolvedValue({ data: { id: 'org-zz' }, error: null });
    renderNoOrg();
    await userEvent.type(await screen.findByLabelText('Company name'), 'Zed Build');
    await chooseCountry('ZZ');
    const presets = screen.getByTestId('country-presets');
    expect(presets).toHaveTextContent('EUR');
    expect(presets).toHaveTextContent('Metric');
    expect(presets).toHaveTextContent('A4');
    await userEvent.click(screen.getByRole('button', { name: 'Continue to first site' }));
    await waitFor(() =>
      expect(h.rpc).toHaveBeenCalledWith(
        'create_org',
        expect.objectContaining({ p_country: 'ZZ', p_timezone: 'UTC' }),
      ),
    );
    // Its manager starts in Spanish; libphonenumber has no region ZZ, so a US number.
    expect(
      storage.get<SetupProgress | null>(progressKey(ADMIN, 'org-zz'), null)!.site,
    ).toMatchObject({ managerCountry: 'US', languages: ['es'] });
  });

  it('maps create_org’s unknown country (22023) to the copy error', async () => {
    h.countries.data = ROWS;
    h.rpc.mockResolvedValue({ data: null, error: { code: '22023', message: 'unknown country' } });
    const error = vi.spyOn(toast, 'error');
    renderNoOrg();
    await userEvent.type(await screen.findByLabelText('Company name'), 'Fresh Build Co');
    await userEvent.click(screen.getByRole('button', { name: 'Continue to first site' }));
    await waitFor(() =>
      expect(error).toHaveBeenCalledWith('That country isn’t available. Choose one from the list.'),
    );
    expect(storage.get(progressKey(ADMIN, null), null)).toMatchObject({
      company: { name: 'Fresh Build Co', country: 'US' },
    });
  });

  it('shows an error with Retry when the country packs fail to load', async () => {
    h.countries = { data: null, error: { message: 'PostgREST unavailable' } };
    renderNoOrg();
    expect(await screen.findByText('Couldn’t load the country list.')).toBeInTheDocument();
    expect(screen.getByText('PostgREST unavailable')).toBeInTheDocument();
    expect(screen.queryByLabelText('Company name')).not.toBeInTheDocument();
    // Inside the wizard's frame: its heading, and the way out.
    expect(screen.getByRole('heading', { level: 1, name: 'Set up your company' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Save and finish later' })).toBeInTheDocument();
    h.countries = { data: ROWS, error: null };
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByLabelText('Company name')).toBeInTheDocument();
  });

  it('lets a user stuck on a failing country list sign out with "Save and finish later"', async () => {
    h.countries = {
      data: null,
      error: { message: 'No country is set up in this TalkOlog database yet.' },
    };
    const signOut = vi.fn(async () => {});
    renderWithProviders(<Harness />, {
      route: '/setup/company',
      source: null,
      auth: { currentOrg: null, orgs: [], role: null, signOut },
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Save and finish later' }));
    expect(await screen.findByRole('heading', { name: 'Login landing' })).toBeInTheDocument();
    expect(signOut).toHaveBeenCalledTimes(1);
  });
});

describe('SetupPage (an org, Supabase mode, country packs unavailable)', () => {
  /** A TR org whose wizard runs while the `countries` read fails. */
  function renderTrOrg(route: string) {
    const store = new DemoStore();
    const source = makeSource('admin', store);
    storage.set(progressKey(ADMIN, source.orgId), {
      done: { company: true },
      flow: 'wizard',
      createdSites: [],
    });
    renderWithProviders(<Harness />, {
      route,
      source,
      auth: {
        currentOrg: {
          id: source.orgId,
          name: 'Demir Yapı A.Ş.',
          timezone: 'Europe/Istanbul',
          activeSites: 6,
          role: 'admin',
          locale: 'tr-TR',
          country: 'TR',
        },
      },
    });
  }

  it('still runs the site step (the manager defaults fall back) with the org’s report language', async () => {
    h.countries = { data: null, error: { message: 'PostgREST unavailable' } };
    renderTrOrg('/setup/site');
    expect(await screen.findByRole('heading', { name: 'Site' })).toBeInTheDocument();
    expect(screen.queryByText('Couldn’t load the country list.')).not.toBeInTheDocument();
    expect(screen.getByText('Reports always come out in Turkish.')).toBeInTheDocument();
  });

  it('still shows the org’s country, locked, on the company step', async () => {
    h.countries = { data: null, error: { message: 'PostgREST unavailable' } };
    renderTrOrg('/setup/company');
    expect(await screen.findByLabelText('Company name')).toBeInTheDocument();
    const country = screen.getByRole('combobox', { name: 'Country' });
    expect(country).toBeDisabled();
    expect(country).toHaveTextContent(/\bTR$/);
  });
});
