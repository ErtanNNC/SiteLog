import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { toast } from 'sonner';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { kestrelDemo } from '@sitelog/shared/demo/kestrel.ts';
import { DemoSource } from '@/data/demo/DemoSource';
import { DemoStore, demoUserFor } from '@/data/demo/store';
import type { InviteReporterInput } from '@/data/source';
import { renderWithProviders } from '@/test/render';
import TeamPage from './Page';

afterEach(() => vi.restoreAllMocks());

describe('TeamPage (demo data)', () => {
  it('lists the field reporters with status chips and the office users', async () => {
    renderWithProviders(<TeamPage />, { route: '/team' });
    expect(await screen.findByRole('heading', { name: 'Team & numbers' })).toBeInTheDocument();
    const table = screen.getByRole('table', { name: 'Field reporters' });
    expect(within(table).getAllByRole('row')).toHaveLength(8);
    const marco = within(table).getByText('Marco Ruiz').closest('tr')!;
    expect(within(marco).getByText('+1 555 014 3378')).toBeInTheDocument();
    expect(within(marco).getByText('Verified')).toBeInTheDocument();
    expect(within(marco).getByText('ES · EN')).toBeInTheDocument();
    expect(within(marco).getByTestId('contact-pref')).toHaveTextContent('Prefers text link');
    const kevin = within(table).getByText("Kevin O'Brien").closest('tr')!;
    expect(within(kevin).getByTestId('contact-pref')).toHaveTextContent('Prefers call');
    const jorge = within(table).getByText('Jorge Medina').closest('tr')!;
    expect(within(jorge).getByText('Invite sent')).toBeInTheDocument();
    const office = screen.getByTestId('office-users');
    expect(within(office).getAllByRole('listitem')).toHaveLength(4);
    expect(office).toHaveTextContent('Lena Ortiz');
    expect(within(office).getByText('Admin')).toBeInTheDocument();
  });

  it('shows a reporter who sent STOP as "Opted out of texts" (§11)', async () => {
    const store = new DemoStore();
    const jorge = store.data.reporters.find((r) => r.name === 'Jorge Medina')!;
    Object.assign(jorge, { status: 'opted_out', opted_out_at: store.nowIso() });
    // Even with an earlier refusal recorded: the opt-out says why nothing is texted.
    jorge.last_invite_error = 'twilio 400 21610: unsubscribed';
    renderWithProviders(<TeamPage />, { route: '/team', store });
    const table = await screen.findByRole('table', { name: 'Field reporters' });
    const row = within(table).getByText('Jorge Medina').closest('tr')!;
    const chip = within(row).getByText('Opted out of texts');
    expect(chip.closest('[data-status]')).toHaveAttribute('data-status', 'opted_out');
    expect(within(row).queryByText('Invite sent')).not.toBeInTheDocument();
    expect(within(row).queryByText('Can’t reach this number')).not.toBeInTheDocument();
  });

  it('an invite the API answers opted_out says no welcome text was sent', async () => {
    const store = new DemoStore();
    const u = demoUserFor('admin');
    // api-invite-reporter re-enables a number that sent STOP as `opted_out` (W1-08).
    const source = new (class extends DemoSource {
      override async inviteReporter(input: InviteReporterInput) {
        await super.inviteReporter(input);
        return { status: 'opted_out' as const };
      }
    })(store, { id: u.id, email: u.email, name: u.name, role: u.role });
    const success = vi.spyOn(toast, 'success');
    renderWithProviders(<TeamPage />, { route: '/team', source });
    await userEvent.click(await screen.findByRole('button', { name: 'Invite reporter' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.type(within(dialog).getByLabelText('Name'), 'Nora Haddad');
    await userEvent.type(within(dialog).getByTestId('invite-phone'), '(555) 014-8800');
    await userEvent.click(within(dialog).getByRole('checkbox', { name: 'Elm St. Townhomes' }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Send welcome text' }));
    await waitFor(() =>
      expect(success).toHaveBeenCalledWith(
        'Nora Haddad opted out of texts (STOP); no welcome text was sent.',
      ),
    );
    expect(success).not.toHaveBeenCalledWith('Welcome text queued for Nora Haddad.');
  });

  it('links the unknown caller to the guessed site, invited until they consent (W1-16)', async () => {
    const store = new DemoStore();
    renderWithProviders(<TeamPage />, { route: '/team', store });
    const alert = await screen.findByTestId('unknown-sender');
    expect(alert).toHaveAttribute('role', 'alert');
    expect(alert).toHaveTextContent('Unknown number tried to report');
    expect(alert).toHaveTextContent('+1 555 019 4410 · 17:52');
    expect(alert).toHaveTextContent('this is Luis');
    expect(within(alert).getByRole('button', { name: 'Ignore' })).toBeInTheDocument();
    await userEvent.click(within(alert).getByRole('button', { name: 'Link to Elm St. Townhomes' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('They can report once they agree to texts and recording.');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Link number' }));
    await waitFor(() => expect(screen.queryByTestId('unknown-sender')).not.toBeInTheDocument());
    const luis = store.data.reporters.find((r) => r.phone_e164 === '+15550194410')!;
    expect(luis).toMatchObject({ name: 'Luis', status: 'invited' });
    expect(store.data.unknownContacts[0]!.status).toBe('linked');
  });

  it('links a WhatsApp sender to the guessed site through the dialog', async () => {
    const store = new DemoStore();
    // A WhatsApp-era sender (no channel), as api-link-unknown-sender links them.
    Object.assign(store.data.unknownContacts[0]!, { channel: null, call_id: null });
    renderWithProviders(<TeamPage />, { route: '/team', store });
    const alert = await screen.findByTestId('unknown-sender');
    await userEvent.click(within(alert).getByRole('button', { name: 'Link to Elm St. Townhomes' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByLabelText('Name')).toHaveValue('Luis');
    expect(within(dialog).getByRole('combobox', { name: 'Site' })).toHaveTextContent(
      'Elm St. Townhomes',
    );
    await userEvent.click(within(dialog).getByRole('button', { name: 'Link number' }));
    await waitFor(() => expect(screen.queryByTestId('unknown-sender')).not.toBeInTheDocument());
    const luis = store.data.reporters.find((r) => r.phone_e164 === '+15550194410')!;
    expect(luis.name).toBe('Luis');
    expect(luis.status).toBe('active');
    expect(store.data.unknownContacts[0]!.status).toBe('linked');
    const table = screen.getByRole('table', { name: 'Field reporters' });
    await waitFor(() => expect(within(table).getByText('Luis')).toBeInTheDocument());
  });

  it('ignores the unknown number', async () => {
    const store = new DemoStore();
    renderWithProviders(<TeamPage />, { route: '/team', store });
    const alert = await screen.findByTestId('unknown-sender');
    await userEvent.click(within(alert).getByRole('button', { name: 'Ignore' }));
    await waitFor(() => expect(screen.queryByTestId('unknown-sender')).not.toBeInTheDocument());
    expect(store.data.unknownContacts[0]!.status).toBe('ignored');
  });

  it('invites a reporter with an E.164 phone number', async () => {
    const store = new DemoStore();
    renderWithProviders(<TeamPage />, { route: '/team', store });
    await userEvent.click(await screen.findByRole('button', { name: 'Invite reporter' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.type(within(dialog).getByLabelText('Name'), 'Nora Haddad');
    await userEvent.type(within(dialog).getByTestId('invite-phone'), '(555) 014-8800');
    expect(dialog).toHaveTextContent('+1 555 014 8800');
    await userEvent.click(within(dialog).getByRole('checkbox', { name: 'Elm St. Townhomes' }));
    await userEvent.click(within(dialog).getByRole('checkbox', { name: 'Spanish' }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Send welcome text' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    const nora = store.data.reporters.find((r) => r.name === 'Nora Haddad')!;
    expect(nora.phone_e164).toBe('+15550148800');
    expect(nora.languages).toEqual(['en', 'es']);
    expect(nora.status).toBe('invited');
  });

  it('starts the invite’s number in the org’s country and offers Turkish (W1-06a)', async () => {
    const store = new DemoStore();
    renderWithProviders(<TeamPage />, {
      route: '/team',
      store,
      auth: {
        currentOrg: {
          id: store.data.org.id,
          name: 'Demir Yapı A.Ş.',
          timezone: 'Europe/Istanbul',
          activeSites: 6,
          role: 'admin',
          locale: 'tr-TR',
          country: 'TR',
        },
      },
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Invite reporter' }));
    const dialog = await screen.findByRole('dialog');
    expect(
      within(dialog).getByRole('button', { name: /^Country code: .+ \+90$/ }),
    ).toHaveTextContent('TR +90');
    await userEvent.type(within(dialog).getByTestId('invite-phone'), '0532 000 0599');
    expect(dialog).toHaveTextContent('+90 532 000 05 99');
    expect(within(dialog).getByRole('checkbox', { name: 'Turkish' })).toBeInTheDocument();
    // A TR org's reports come out in Turkish (§9.6, its locale).
    expect(dialog).toHaveTextContent('Reports always come out in Turkish.');
    await userEvent.keyboard('{Escape}');

    // The Edit dialog says the same.
    const table = await screen.findByRole('table', { name: 'Field reporters' });
    await userEvent.click(within(table).getByRole('button', { name: 'Menu for Jorge Medina' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Edit' }));
    expect(await screen.findByRole('dialog')).toHaveTextContent(
      'Reports always come out in Turkish.',
    );
  });

  it('adds an office user and refuses to remove the last admin', async () => {
    const store = new DemoStore();
    renderWithProviders(<TeamPage />, { route: '/team', store });
    await userEvent.click(await screen.findByRole('button', { name: 'Add office user' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.type(within(dialog).getByLabelText('Email'), 'dana@kestrelbuild.example');
    await userEvent.click(within(dialog).getByRole('radio', { name: 'Accounts' }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Send invite' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(store.data.members.some((m) => m.display_name === 'dana@kestrelbuild.example')).toBe(
      true,
    );
    const office = screen.getByTestId('office-users');
    await waitFor(() => expect(within(office).getAllByRole('listitem')).toHaveLength(5));
    await userEvent.click(within(office).getByRole('button', { name: 'Menu for Lena Ortiz' }));
    expect(await screen.findByRole('menuitem', { name: 'Remove' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
  });

  it('edits a reporter: name, sites and languages, with the phone read-only (P10)', async () => {
    const store = new DemoStore();
    renderWithProviders(<TeamPage />, { route: '/team', store });
    const table = await screen.findByRole('table', { name: 'Field reporters' });
    await userEvent.click(within(table).getByRole('button', { name: 'Menu for Jorge Medina' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Edit' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('Edit Jorge Medina');
    expect(dialog).toHaveTextContent('Reports always come out in English.');
    const phone = within(dialog).getByTestId('edit-phone');
    expect(phone).toHaveValue('+1 555 014 3390');
    expect(phone).toHaveAttribute('readonly');
    expect(dialog).toHaveTextContent('disable this reporter and invite the new number');
    const save = within(dialog).getByRole('button', { name: 'Save changes' });
    expect(save).toBeDisabled();

    // At least one site is required.
    await userEvent.click(
      within(dialog).getByRole('checkbox', { name: 'Riverside Lofts — Block B' }),
    );
    await userEvent.click(
      within(dialog).getByRole('checkbox', { name: 'Pier 9 Warehouse Retrofit' }),
    );
    await userEvent.click(save);
    expect(within(dialog).getByRole('alert')).toHaveTextContent('Pick at least one site.');

    const name = within(dialog).getByLabelText('Name');
    await userEvent.clear(name);
    await userEvent.type(name, 'Jorge A. Medina');
    await userEvent.click(
      within(dialog).getByRole('checkbox', { name: 'Pier 9 Warehouse Retrofit' }),
    );
    await userEvent.click(within(dialog).getByRole('checkbox', { name: 'Elm St. Townhomes' }));
    await userEvent.click(within(dialog).getByRole('checkbox', { name: 'English' }));
    await userEvent.click(save);
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    const jorge = store.data.reporters.find((r) => r.phone_e164 === '+15550143390')!;
    expect(jorge.name).toBe('Jorge A. Medina');
    expect(jorge.languages).toEqual(['es', 'en']);
    const links = store.data.siteReporters.filter((sr) => sr.reporter_id === jorge.id);
    const codeOf = (siteId: string) => store.data.sites.find((s) => s.id === siteId)!.project_code;
    expect(links.map((l) => codeOf(l.site_id)).sort()).toEqual(['ES-0377', 'P9-0932'].sort());
    // Elm St. already has a primary site manager, so Jorge joins as secondary.
    expect(links.every((l) => !l.is_primary)).toBe(true);
    const audit = store.data.audit.at(-1)!;
    expect(audit.action).toBe('reporter.updated');
    expect(audit.diff).toMatchObject({ name: { from: 'Jorge Medina', to: 'Jorge A. Medina' } });
    await waitFor(() => expect(within(table).getByText('Jorge A. Medina')).toBeInTheDocument());
  });

  it('Invite reporter in an org with no sites says to add one first instead of a dead end', async () => {
    const d = kestrelDemo();
    const store = new DemoStore({ ...d, sites: [], siteReporters: [], recipients: [] });
    renderWithProviders(<TeamPage />, { route: '/team', store });
    await screen.findByRole('heading', { name: 'Team & numbers' });
    await userEvent.click(screen.getAllByRole('button', { name: 'Invite reporter' })[0]!);
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByTestId('invite-no-sites')).toHaveTextContent(
      'Add a site first. Each reporter reports for a site.',
    );
    expect(within(dialog).getByRole('link', { name: 'Add a site' })).toHaveAttribute(
      'href',
      '/setup/site',
    );
    expect(within(dialog).getByRole('button', { name: 'Send welcome text' })).toBeDisabled();
  });

  it('an ops user with no sites is told to ask an admin (adding a site is admin-only)', async () => {
    const d = kestrelDemo();
    const store = new DemoStore({ ...d, sites: [], siteReporters: [], recipients: [] });
    renderWithProviders(<TeamPage />, { route: '/team', store, as: 'ops' });
    await screen.findByRole('heading', { name: 'Team & numbers' });
    await userEvent.click(screen.getAllByRole('button', { name: 'Invite reporter' })[0]!);
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByTestId('invite-no-sites')).toHaveTextContent(
      'Ask an admin to add a site first.',
    );
    expect(within(dialog).queryByRole('link', { name: 'Add a site' })).toBeNull();
  });
});
