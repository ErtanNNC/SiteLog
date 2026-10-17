import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { toast } from 'sonner';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildDemirDemo, DEMIR_ORG_NAME } from '@sitelog/shared/demo/demir.ts';
import { kestrelDemo } from '@sitelog/shared/demo/kestrel.ts';
import { DemoSource } from '@/data/demo/DemoSource';
import { DemoStore, demoUserFor } from '@/data/demo/store';
import type { InviteReporterInput } from '@/data/source';
import { i18n } from '@/i18n/i18n';
import { renderWithProviders } from '@/test/render';
import TeamPage from './Page';

afterEach(async () => {
  vi.restoreAllMocks();
  await act(() => i18n.changeLanguage('en'));
});

const rowOf = (name: string) =>
  within(screen.getByRole('table', { name: /Field reporters|Saha raporcuları/ }))
    .getByText(name)
    .closest('tr')!;

async function openMenu(name: string, item: string | RegExp) {
  const table = await screen.findByRole('table', { name: /Field reporters|Saha raporcuları/ });
  await userEvent.click(within(table).getByRole('button', { name: new RegExp(name) }));
  await userEvent.click(await screen.findByRole('menuitem', { name: item }));
}

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

describe('TeamPage (demo data)', () => {
  it('lists the reporters with the P10 columns and statuses, and the office users', async () => {
    renderWithProviders(<TeamPage />, { route: '/team' });
    expect(await screen.findByRole('heading', { name: 'Team & numbers' })).toBeInTheDocument();
    expect(
      screen.getByText(
        'SiteLog matches every call and text to a site by the phone number. Personal links are tied to one person.',
      ),
    ).toBeInTheDocument();
    const table = screen.getByRole('table', { name: 'Field reporters' });
    const headers = within(table)
      .getAllByRole('columnheader')
      .map((h) => h.textContent);
    expect(headers.slice(0, 7)).toEqual([
      'Name',
      'Mobile',
      'Prefers',
      'Sites',
      'Language',
      'On time · 30 d',
      'Status',
    ]);
    expect(within(table).queryByText('WhatsApp')).not.toBeInTheDocument();
    expect(within(table).getAllByRole('row')).toHaveLength(8);
    const marco = rowOf('Marco Ruiz');
    expect(within(marco).getByText('+1 555 014 3378')).toBeInTheDocument();
    const chip = within(marco).getByText('Active');
    expect(chip.closest('[data-status]')).toHaveAttribute('aria-label', 'Status: Active');
    expect(within(marco).getByTestId('reporter-locale')).toHaveTextContent('English');
    expect(within(marco).getByText('Speaks Spanish · English')).toBeInTheDocument();
    expect(within(marco).getByTestId('contact-pref')).toHaveTextContent('Text link');
    expect(within(marco).getByText('1 phone signed in')).toBeInTheDocument();
    expect(within(rowOf("Kevin O'Brien")).getByTestId('contact-pref')).toHaveTextContent('Call');
    const jorge = rowOf('Jorge Medina');
    expect(within(jorge).getByText('Invite sent')).toBeInTheDocument();
    expect(within(jorge).getByTestId('reporter-locale')).toHaveTextContent('Spanish');
    const office = screen.getByTestId('office-users');
    expect(within(office).getAllByRole('listitem')).toHaveLength(4);
    expect(office).toHaveTextContent('Lena Ortiz');
    expect(within(office).getByText('Admin')).toBeInTheDocument();
  });

  it('reads "Can’t text this number" from the welcome’s attempts, not last_invite_error', async () => {
    const store = new DemoStore();
    const jorge = store.data.reporters.find((r) => r.name === 'Jorge Medina')!;
    // A v1.0 refusal alone no longer makes the status.
    jorge.last_invite_error = 'not on whatsapp';
    const welcome = store.data.messages.findLast(
      (m) => m.reporter_id === jorge.id && m.copy_key === 'welcome',
    );
    const base = welcome ?? store.data.messages.find((m) => m.copy_key === 'welcome')!;
    store.data.messages.push(
      {
        ...base,
        id: 'welcome-1',
        reporter_id: jorge.id,
        status: 'undeliverable',
        channel: 'sms',
        provider_message_id: null,
        payload: { dedupe_key: 'welcome:jorge', attempt: 1 },
        created_at: '2026-10-09T23:00:00Z',
      },
      {
        ...base,
        id: 'welcome-2',
        reporter_id: jorge.id,
        status: 'failed',
        channel: 'whatsapp',
        provider_message_id: 'MM1',
        payload: { dedupe_key: 'welcome:jorge', attempt: 2 },
        created_at: '2026-10-09T23:01:00Z',
      },
    );
    renderWithProviders(<TeamPage />, { route: '/team', store });
    const row = await findRow('Jorge Medina');
    const chip = within(row).getByText('Can’t text this number');
    expect(chip.closest('[data-status]')).toHaveAttribute('data-status', 'undeliverable');
  });

  it('shows a reporter who sent STOP as "Opted out of texts", stopped by them', async () => {
    const store = new DemoStore();
    const jorge = store.data.reporters.find((r) => r.name === 'Jorge Medina')!;
    Object.assign(jorge, { status: 'opted_out', opted_out_at: store.nowIso() });
    store.smsOptOuts.set(jorge.phone_e164, 'sms_keyword');
    renderWithProviders(<TeamPage />, { route: '/team', store });
    const row = await findRow('Jorge Medina');
    const chip = within(row).getByText('Opted out of texts');
    expect(chip.closest('[data-status]')).toHaveAttribute('data-status', 'opted_out');
    expect(row).toHaveTextContent('Stopped by them (STOP)');
    expect(row).toHaveTextContent(
      'Only Jorge can turn texts back on, by replying START to one of our texts.',
    );
    // Never on a two-way pack (§19 Q242): no menu item to clear it.
    await userEvent.click(within(row).getByRole('button', { name: 'Menu for Jorge Medina' }));
    expect(screen.queryByRole('menuitem', { name: 'Turn texts back on' })).toBeNull();
  });

  it('an ops user moves Marco to WhatsApp with the attestation, audited via office', async () => {
    const store = new DemoStore();
    renderWithProviders(<TeamPage />, { route: '/team', store, as: 'ops' });
    await openMenu('Marco Ruiz', 'Edit');
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByTestId('edit-channel'));
    await userEvent.click(await screen.findByRole('option', { name: 'WhatsApp' }));
    // Marco has not agreed to WhatsApp: saved, unreachable until he turns it on (§19 Q243).
    expect(within(dialog).getByTestId('channel-not-agreed')).toHaveTextContent(
      'Marco has not agreed to WhatsApp yet.',
    );
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }));
    expect(within(dialog).getByRole('alert')).toHaveTextContent(
      'Tick the box: change how SiteLog reaches Marco only when they asked.',
    );
    await userEvent.click(
      within(dialog).getByRole('checkbox', { name: 'Marco asked for this change' }),
    );
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    const marco = store.data.reporters.find((r) => r.name === 'Marco Ruiz')!;
    expect(marco.message_channel).toBe('whatsapp');
    expect(store.data.audit.at(-1)).toMatchObject({
      action: 'reporter.preferences_changed',
      actor_id: demoUserFor('ops').id,
      diff: {
        from: { message_channel: null },
        to: { message_channel: 'whatsapp' },
        via: 'office',
        attested: true,
      },
    });
    const row = await findRow('Marco Ruiz');
    await waitFor(() =>
      expect(within(row).getByTestId('contact-pref')).toHaveTextContent('Text link · WhatsApp'),
    );
    expect(row).toHaveTextContent('WhatsApp not agreed yet');
  });

  it('a language change alone needs no attestation', async () => {
    const store = new DemoStore();
    renderWithProviders(<TeamPage />, { route: '/team', store });
    await openMenu('Jorge Medina', 'Edit');
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('combobox', { name: 'Language SiteLog uses' }));
    await userEvent.click(await screen.findByRole('option', { name: 'English' }));
    expect(within(dialog).queryByRole('checkbox', { name: /asked for this change/ })).toBeNull();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(store.data.reporters.find((r) => r.name === 'Jorge Medina')!.locale).toBe('en-US');
    expect(store.data.audit.at(-1)!.diff).toMatchObject({
      to: { locale: 'en-US' },
      attested: false,
    });
  });

  it('revokes Marco’s devices: consents kept, audited device.revoked via office', async () => {
    const store = new DemoStore();
    const marco = store.data.reporters.find((r) => r.name === 'Marco Ruiz')!;
    const consents = store.data.consents.filter((c) => c.reporter_id === marco.id).length;
    renderWithProviders(<TeamPage />, { route: '/team', store });
    await openMenu('Marco Ruiz', 'Revoke devices');
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('Revoke devices for Marco Ruiz?');
    expect(dialog).toHaveTextContent('Their next open asks for a code sent to +1 555 014 3378.');
    expect(within(dialog).getByTestId('revoke-count')).toHaveTextContent('Signed in now: 1 phone.');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Revoke devices' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(store.data.audit.at(-1)).toMatchObject({
      action: 'device.revoked',
      entity_id: marco.id,
      diff: { via: 'office', devices: 1 },
    });
    expect(store.data.consents.filter((c) => c.reporter_id === marco.id)).toHaveLength(consents);
    await waitFor(() =>
      expect(within(rowOf('Marco Ruiz')).queryByText('1 phone signed in')).toBeNull(),
    );
  });

  it('texts Priya today’s link from her row: the Demo phone gets it', async () => {
    const store = new DemoStore();
    const success = vi.spyOn(toast, 'success');
    renderWithProviders(<TeamPage />, { route: '/team', store });
    const priya = store.data.reporters.find((r) => r.name === 'Priya Raman')!;
    const before = store.data.messages.filter(
      (m) => m.reporter_id === priya.id && m.copy_key === 'daily_link',
    ).length;
    await openMenu('Priya Raman', /^Text today’s link/);
    await waitFor(() => expect(success).toHaveBeenCalledWith('Today’s link texted to Priya.'));
    expect(
      store.data.messages.filter((m) => m.reporter_id === priya.id && m.copy_key === 'daily_link'),
    ).toHaveLength(before + 1);
    expect(store.data.audit.at(-1)).toMatchObject({
      action: 'daily_link.texted',
      entity_id: priya.id,
    });
    // An invited reporter cannot be texted the link yet.
    const table = screen.getByRole('table', { name: 'Field reporters' });
    await userEvent.click(within(table).getByRole('button', { name: 'Menu for Jorge Medina' }));
    for (const item of await screen.findAllByRole('menuitem', { name: /^Text today’s link/ }))
      expect(item).toHaveAttribute('aria-disabled', 'true');
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
  });

  it('ignores the unknown number', async () => {
    const store = new DemoStore();
    renderWithProviders(<TeamPage />, { route: '/team', store });
    const alert = await screen.findByTestId('unknown-sender');
    await userEvent.click(within(alert).getByRole('button', { name: 'Ignore' }));
    await waitFor(() => expect(screen.queryByTestId('unknown-sender')).not.toBeInTheDocument());
    expect(store.data.unknownContacts[0]!.status).toBe('ignored');
  });

  it('starts Invite with the org’s default preference (W4-05, §19 Q231)', async () => {
    const store = new DemoStore();
    store.data.settings.default_contact_pref = 'call';
    renderWithProviders(<TeamPage />, { route: '/team', store });
    await userEvent.click(await screen.findByRole('button', { name: 'Invite reporter' }));
    const dialog = await screen.findByRole('dialog');
    await waitFor(() => expect(within(dialog).getByRole('radio', { name: 'Call' })).toBeChecked());
  });

  it('invites a reporter with the language SiteLog uses and the preferred channel', async () => {
    const store = new DemoStore();
    renderWithProviders(<TeamPage />, { route: '/team', store });
    await userEvent.click(await screen.findByRole('button', { name: 'Invite reporter' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.type(within(dialog).getByLabelText('Name'), 'Nora Haddad');
    await userEvent.type(within(dialog).getByTestId('invite-phone'), '(555) 014-8800');
    expect(dialog).toHaveTextContent('+1 555 014 8800');
    await userEvent.click(within(dialog).getByRole('checkbox', { name: 'Elm St. Townhomes' }));
    await userEvent.click(within(dialog).getByRole('checkbox', { name: 'Spanish' }));
    await userEvent.click(within(dialog).getByTestId('invite-locale'));
    await userEvent.click(await screen.findByRole('option', { name: 'Spanish' }));
    expect(dialog).toHaveTextContent('They can always use the other one.');
    await userEvent.click(within(dialog).getByRole('radio', { name: 'Call' }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Send welcome text' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    const nora = store.data.reporters.find((r) => r.name === 'Nora Haddad')!;
    expect(nora).toMatchObject({
      phone_e164: '+15550148800',
      languages: ['en', 'es'],
      status: 'invited',
      locale: 'es-US',
      contact_pref: 'call',
    });
  });

  it('adds an office user with a panel language and refuses to remove the last admin', async () => {
    const store = new DemoStore();
    renderWithProviders(<TeamPage />, { route: '/team', store });
    await userEvent.click(await screen.findByRole('button', { name: 'Add office user' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.type(within(dialog).getByLabelText('Email'), 'dana@kestrelbuild.example');
    await userEvent.click(within(dialog).getByRole('radio', { name: 'Accounts' }));
    expect(
      within(dialog).getByRole('radio', { name: 'The company’s language (English)' }),
    ).toBeChecked();
    await userEvent.click(within(dialog).getByRole('radio', { name: 'Turkish' }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Send invite' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    const dana = store.data.members.find((m) => m.display_name === 'dana@kestrelbuild.example')!;
    expect(dana).toMatchObject({ role: 'accounts', ui_locale: 'tr-TR' });
    const office = screen.getByTestId('office-users');
    await waitFor(() => expect(within(office).getAllByRole('listitem')).toHaveLength(5));
    expect(office).toHaveTextContent('Panel in Turkish');
    await userEvent.click(within(office).getByRole('button', { name: 'Menu for Lena Ortiz' }));
    expect(await screen.findByRole('menuitem', { name: 'Remove' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
  });

  it('edits a reporter: name, sites and languages, with the phone read-only (P10)', async () => {
    const store = new DemoStore();
    renderWithProviders(<TeamPage />, { route: '/team', store });
    await openMenu('Jorge Medina', 'Edit');
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
    await waitFor(() =>
      expect(
        within(screen.getByRole('table', { name: 'Field reporters' })).getByText('Jorge A. Medina'),
      ).toBeInTheDocument(),
    );
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

describe('TeamPage in Turkish (Demir Yapı, the TR pack)', () => {
  it('reads in Turkish: columns, statuses, the invite’s TR picker and language', async () => {
    await act(() => i18n.changeLanguage('tr'));
    const store = demirStore();
    renderWithProviders(<TeamPage />, { route: '/team', store, auth: demirAuth(store) });
    expect(await screen.findByRole('heading', { name: 'Ekip ve numaralar' })).toBeInTheDocument();
    const table = screen.getByRole('table', { name: 'Saha raporcuları' });
    expect(
      within(table)
        .getAllByRole('columnheader')
        .slice(0, 7)
        .map((h) => h.textContent),
    ).toEqual(['Ad', 'Cep telefonu', 'Tercih', 'Şantiyeler', 'Dil', 'Zamanında · 30 g', 'Durum']);
    const emre = rowOf('Emre Yıldız');
    expect(within(emre).getByText('Aktif')).toBeInTheDocument();
    expect(within(emre).getByTestId('contact-pref')).toHaveTextContent('Arama');
    expect(within(emre).getByTestId('reporter-locale')).toHaveTextContent('Türkçe');

    await userEvent.click(screen.getByRole('button', { name: 'Raporcu davet et' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('button', { name: /^Ülke kodu: .+ \+90$/ })).toHaveTextContent(
      'TR +90',
    );
    expect(within(dialog).getByTestId('invite-locale')).toHaveTextContent('Türkçe');
    expect(dialog).toHaveTextContent('Raporlar her zaman Türkçe çıkar.');
    // The TR pack has no voice number: a call preference uses Talk now (§19 Q33).
    await userEvent.click(within(dialog).getByRole('radio', { name: 'Arama' }));
    expect(dialog).toHaveTextContent('Kayıt ekranındaki Şimdi konuş ile arar.');
  });

  it('an admin turns texts back on after a provider opt-out, with the attestation (Q242)', async () => {
    await act(() => i18n.changeLanguage('tr'));
    const store = demirStore();
    const selin = store.data.reporters.find((r) => r.name === 'Selin Kaya')!;
    Object.assign(selin, { status: 'opted_out', opted_out_at: store.nowIso() });
    store.smsOptOuts.set(selin.phone_e164, 'provider_opt_out');
    for (const c of store.data.consents)
      if (c.reporter_id === selin.id && c.type === 'sms') c.revoked_at = store.nowIso();
    renderWithProviders(<TeamPage />, { route: '/team', store, auth: demirAuth(store) });
    const row = await findRow('Selin Kaya');
    expect(within(row).getByText('Mesajları durdurdu')).toBeInTheDocument();
    expect(row).toHaveTextContent('Operatör durdurdu');
    await userEvent.click(within(row).getByRole('button', { name: 'Selin Kaya için menü' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Mesajları yeniden aç' }));
    const dialog = await screen.findByRole('dialog');
    const confirm = within(dialog).getByRole('button', { name: 'Mesajları yeniden aç' });
    expect(confirm).toBeDisabled();
    await userEvent.click(
      within(dialog).getByRole('checkbox', { name: 'Selin yeniden mesaj almak istedi' }),
    );
    await userEvent.click(confirm);
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(selin).toMatchObject({ status: 'active', opted_out_at: null });
    expect(
      store.data.consents.find(
        (c) => c.reporter_id === selin.id && c.type === 'sms' && c.revoked_at === null,
      ),
    ).toMatchObject({ method: 'office_attested' });
    expect(store.data.audit.map((a) => a.action)).toEqual(
      expect.arrayContaining(['reporter.opt_out_cleared', 'consent.given']),
    );
  });

  it('an ops user cannot turn texts back on (an admin only)', async () => {
    const store = demirStore();
    const selin = store.data.reporters.find((r) => r.name === 'Selin Kaya')!;
    Object.assign(selin, { status: 'opted_out', opted_out_at: store.nowIso() });
    store.smsOptOuts.set(selin.phone_e164, 'provider_opt_out');
    renderWithProviders(<TeamPage />, {
      route: '/team',
      store,
      as: 'ops',
      auth: { currentOrg: { ...demirAuth(store).currentOrg, role: 'ops' } },
    });
    const row = await findRow('Selin Kaya');
    await userEvent.click(within(row).getByRole('button', { name: 'Menu for Selin Kaya' }));
    expect(await screen.findByRole('menuitem', { name: 'Edit' })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Turn texts back on' })).toBeNull();
  });
});

describe('Call now (W4-04, F3, §19 Q230)', () => {
  it('Lena attests and calls Priya: the consent is office_attested, the row shows the call', async () => {
    const success = vi.spyOn(toast, 'success');
    const store = new DemoStore();
    const priya = store.data.reporters.find((r) => r.name === 'Priya Raman')!;
    renderWithProviders(<TeamPage />, { route: '/team', store });
    await openMenu('Priya Raman', 'Call now');
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('Call Priya Raman now?');
    expect(dialog).toHaveTextContent(
      'SiteLog’s assistant calls Priya now about today’s report at Elm St. Townhomes.',
    );
    expect(dialog).toHaveTextContent('If Priya doesn’t answer, SiteLog sends no text.');
    const confirm = within(dialog).getByRole('button', { name: 'Call now' });
    expect(confirm).toBeDisabled();
    await userEvent.click(
      within(dialog).getByRole('checkbox', {
        name: 'Priya agreed to get calls from SiteLog for the daily report',
      }),
    );
    await userEvent.click(confirm);
    await waitFor(() =>
      expect(success).toHaveBeenCalledWith(
        'Calling Priya Raman now. The progress shows in their row.',
      ),
    );
    const consent = store.data.consents.find(
      (c) => c.reporter_id === priya.id && c.type === 'auto_call',
    );
    expect(consent).toMatchObject({
      method: 'office_attested',
      text_version: 'team.call_now.v1',
      evidence: { user_id: demoUserFor('admin').id, via: 'office' },
    });
    const call = store.data.calls.find((c) => c.reporter_id === priya.id);
    expect(call).toMatchObject({ purpose: 'daily_report', status: 'ringing', attempt: null });
    expect(store.data.audit.map((a) => a.action)).toEqual(
      expect.arrayContaining(['consent.given', 'call.requested']),
    );
    const line = await within(await findRow('Priya Raman')).findByTestId('call-today');
    expect(line).toHaveTextContent('Office call · Ringing · 19:05');
    // A live call: Call now waits until it ends.
    const table = screen.getByRole('table', { name: 'Field reporters' });
    await userEvent.click(within(table).getByRole('button', { name: /Priya Raman/ }));
    expect(await screen.findByRole('menuitem', { name: 'Call now' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    store.dispose();
  });

  it('words a refusal: today’s report is already filed (Aisha, Hillcrest weather day)', async () => {
    const error = vi.spyOn(toast, 'error');
    const store = new DemoStore();
    renderWithProviders(<TeamPage />, { route: '/team', store, as: 'ops' });
    await openMenu('Aisha Bello', 'Call now');
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('checkbox'));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Call now' }));
    await waitFor(() =>
      expect(error).toHaveBeenCalledWith('Today’s report for this site is already filed.'),
    );
    expect(store.data.consents.some((c) => c.method === 'office_attested')).toBe(false);
  });

  it('is not offered to a project manager, nor where the org places no calls', async () => {
    const pm = new DemoStore();
    const { unmount } = renderWithProviders(<TeamPage />, {
      route: '/team',
      store: pm,
      as: 'pm',
    });
    await userEvent.click(
      within(await screen.findByRole('table', { name: 'Field reporters' })).getByRole('button', {
        name: /Priya Raman/,
      }),
    );
    expect(await screen.findByRole('menuitem', { name: 'Edit' })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Call now' })).toBeNull();
    unmount();

    const real = new DemoStore();
    real.data.org.is_demo = false;
    renderWithProviders(<TeamPage />, { route: '/team', store: real });
    await userEvent.click(
      within(await screen.findByRole('table', { name: 'Field reporters' })).getByRole('button', {
        name: /Priya Raman/,
      }),
    );
    expect(await screen.findByRole('menuitem', { name: 'Edit' })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Call now' })).toBeNull();
  });

  it('reads in Turkish, and outside the call window says so (Demir Yapı at 03:05)', async () => {
    await act(() => i18n.changeLanguage('tr'));
    const error = vi.spyOn(toast, 'error');
    const store = demirStore();
    renderWithProviders(<TeamPage />, { route: '/team', store, auth: demirAuth(store) });
    const row = await findRow('Emre Yıldız');
    await userEvent.click(within(row).getByRole('button', { name: 'Emre Yıldız için menü' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: /^Şimdi ara/ }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('Emre Yıldız şimdi aransın mı?');
    await userEvent.click(
      within(dialog).getByRole('checkbox', {
        name: 'Emre, günlük rapor için SiteLog’un aramasını kabul etti',
      }),
    );
    await userEvent.click(within(dialog).getByRole('button', { name: 'Şimdi ara' }));
    await waitFor(() =>
      expect(error).toHaveBeenCalledWith(
        'SiteLog’un bu şantiyede arama yaptığı saatlerin dışındayız.',
      ),
    );
  });
});

async function findRow(name: string) {
  const table = await screen.findByRole('table', { name: /Field reporters|Saha raporcuları/ });
  return within(table).getByText(name).closest('tr')!;
}
