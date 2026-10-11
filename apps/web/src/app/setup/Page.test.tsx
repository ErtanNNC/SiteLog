import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { Route, Routes } from 'react-router';
import { DemoStore, demoUserFor } from '@/data/demo/store';
import { storage } from '@/lib/utils';
import { renderWithProviders } from '@/test/render';
import SetupPage from './Page';
import { progressKey } from './state';

function Harness() {
  return (
    <Routes>
      <Route path="/setup" element={<SetupPage />} />
      <Route path="/setup/:step" element={<SetupPage />} />
      <Route path="/" element={<h1>Overview landing</h1>} />
      <Route path="/sites" element={<h1>Sites landing</h1>} />
    </Routes>
  );
}

describe('SetupPage (demo org)', () => {
  it('runs the happy path: company → site & manager (with live preview) → reports → finish', { timeout: 30_000 }, async () => {
    const store = new DemoStore();
    storage.set(progressKey(demoUserFor('admin').id), { done: {}, createdSites: [] });
    renderWithProviders(<Harness />, { route: '/setup/company', store });
    expect(await screen.findByRole('heading', { name: 'Set up your company' })).toBeInTheDocument();
    expect(screen.getByTestId('setup-header')).toHaveTextContent('Kestrel Build Group · setup');
    expect(screen.getByLabelText('Company name')).toHaveValue('Kestrel Build Group');
    await userEvent.click(screen.getByRole('button', { name: 'Continue to first site' }));

    expect(await screen.findByRole('heading', { name: 'Site' })).toBeInTheDocument();
    const stepper = screen.getByRole('list', { name: 'Set up your company' });
    expect(within(stepper).getAllByRole('listitem')[0]).toHaveAttribute('data-state', 'done');
    expect(within(stepper).getAllByRole('listitem')[1]).toHaveAttribute('aria-current', 'step');

    await userEvent.type(screen.getByLabelText('Site name'), 'Harbor View Apartments');
    await userEvent.type(screen.getByLabelText('Project number'), 'hv-5120');
    expect(screen.getByLabelText('Project number')).toHaveValue('HV-5120');
    await userEvent.type(screen.getByLabelText('Site address'), '400 Harbor Dr, Chicago, IL 60611');
    expect(screen.getByTestId('geo-warning')).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('Latitude'), '41.8927');
    await userEvent.type(screen.getByLabelText('Longitude'), '-87.6136');
    await userEvent.type(screen.getByLabelText('Name'), 'Elena Vasquez');
    await userEvent.type(screen.getByTestId('manager-phone'), '555 014 8001');

    const preview = screen.getByTestId('welcome-preview');
    expect(preview).toHaveTextContent(
      "Hi Elena — I'm SiteLog, the reporting assistant for Kestrel Build Group. You're set up as site manager for Harbor View Apartments. Each workday before 17:30",
    );
    expect(preview).toHaveTextContent('Got it');
    expect(preview).toHaveTextContent('Wrong site');
    expect(screen.getByText('$399')).toBeInTheDocument();
    expect(screen.getByText('$0 setup · billed per active site')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Send WhatsApp welcome' }));
    expect(await screen.findByRole('heading', { name: 'Reports & reminders' })).toBeInTheDocument();
    const site = store.data.sites.find((s) => s.project_code === 'HV-5120')!;
    expect(site).toMatchObject({ name: 'Harbor View Apartments', lat: 41.8927, lng: -87.6136, deadline: '17:30:00' });
    const elena = store.data.reporters.find((r) => r.name === 'Elena Vasquez')!;
    expect(elena.phone_e164).toBe('+15550148001');
    expect(store.data.siteReporters.find((sr) => sr.reporter_id === elena.id)).toMatchObject({
      site_id: site.id,
      is_primary: true,
    });

    await userEvent.type(screen.getByRole('textbox', { name: 'Add email' }), 'pm@kestrelbuild.example{enter}');
    await userEvent.click(screen.getByRole('switch', { name: 'Weather heads-up' }));
    await userEvent.click(screen.getByRole('button', { name: 'Finish' }));
    expect(await screen.findByRole('heading', { name: 'Overview landing' })).toBeInTheDocument();
    expect(store.data.settings.heads_up_enabled).toBe(false);
    expect(store.data.recipients.filter((r) => r.site_id === site.id).map((r) => r.email)).toEqual([
      'pm@kestrelbuild.example',
    ]);
    expect(storage.get(progressKey(demoUserFor('admin').id), null)).toBeNull();
  });

  it('validates the site step and resumes at the last incomplete step', { timeout: 30_000 }, async () => {
    const store = new DemoStore();
    storage.set(progressKey(demoUserFor('admin').id), {
      done: { company: true },
      flow: 'wizard',
      createdSites: [],
      site: { name: 'Pending site', projectCode: 'RL-2041' },
    });
    renderWithProviders(<Harness />, { route: '/setup', store });
    expect(await screen.findByRole('heading', { name: 'Site' })).toBeInTheDocument();
    expect(screen.getByLabelText('Site name')).toHaveValue('Pending site');
    await userEvent.click(screen.getByRole('button', { name: 'Send WhatsApp welcome' }));
    expect(screen.getByText('That project number is already in use.')).toBeInTheDocument();
    expect(screen.getByText('Enter the site manager’s name.')).toBeInTheDocument();
    expect(screen.getByText('Enter a valid WhatsApp number for the chosen country.')).toBeInTheDocument();
    expect(store.data.sites).toHaveLength(6);
  });

  it('"Add site" mode lands on /sites after sending the welcome', { timeout: 30_000 }, async () => {
    const store = new DemoStore();
    renderWithProviders(<Harness />, { route: '/setup/site', store });
    expect(await screen.findByRole('heading', { name: 'Add a site' })).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('Site name'), 'Westgate Clinic');
    await userEvent.type(screen.getByLabelText('Project number'), 'WG-0100');
    await userEvent.type(screen.getByLabelText('Site address'), '12 West St, Chicago, IL');
    await userEvent.type(screen.getByLabelText('Name'), 'Omar Haddad');
    await userEvent.type(screen.getByTestId('manager-phone'), '5550149001');
    await userEvent.click(screen.getByRole('button', { name: 'Send WhatsApp welcome' }));
    expect(await screen.findByRole('heading', { name: 'Sites landing' })).toBeInTheDocument();
    await waitFor(() => expect(store.data.sites.some((s) => s.project_code === 'WG-0100')).toBe(true));
  });
});
