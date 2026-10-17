import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes, useLocation } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { LANGUAGE_KEY } from '@/i18n/language';
import { makeAuthState, makeSource, renderWithProviders } from '@/test/render';
import { Sidebar } from './Sidebar';

function Where() {
  const { pathname, search } = useLocation();
  return <output data-testid="where">{pathname + search}</output>;
}

describe('Sidebar', () => {
  it('shows every nav item for an admin with the review / unknown-number / glossary badges', async () => {
    renderWithProviders(<Sidebar />, { as: 'admin' });
    for (const label of [
      'Overview',
      'Sites',
      'Reports',
      'Crew hours',
      'Weather & delays',
      'Team & numbers',
      'Site glossary',
      'Settings',
      'Billing',
      'Try it on WhatsApp',
    ]) {
      expect(screen.getByRole('link', { name: new RegExp(label) })).toBeInTheDocument();
    }
    expect(screen.getByRole('link', { name: 'Demo phone' })).toHaveAttribute('href', '/dev/phone');
    await waitFor(() => expect(screen.getByLabelText('1 report to review')).toHaveTextContent('1'));
    expect(screen.getByLabelText('1 unknown number')).toHaveTextContent('1');
    expect(screen.getByLabelText('3 terms to review')).toHaveTextContent('3');
    expect(screen.getByLabelText('1 report to review')).toHaveClass('bg-level');
    expect(screen.getByLabelText('1 unknown number')).toHaveClass('bg-signal');
    expect(screen.getByTestId('demo-chip')).toHaveTextContent('Demo');
    expect(screen.getByText('6 active sites')).toBeInTheDocument();
  });

  it('shows the v1.2 footer: agent ready for texts and calls, with the org’s SiteLog number (§11.2)', () => {
    renderWithProviders(<Sidebar />, { as: 'admin' });
    expect(screen.getByText('Agent ready · texts & calls')).toBeInTheDocument();
    const numbers = screen.getByRole('list', { name: 'SiteLog numbers' });
    expect(within(numbers).getByText('+1 555 014 2290')).toBeInTheDocument();
    expect(screen.getByTestId('sidebar-footer')).not.toHaveTextContent(/WhatsApp/);
  });

  it('leaves the number line out when the org has no SiteLog number yet', () => {
    const org = { ...makeAuthState('admin').currentOrg!, sitelogNumbers: [] };
    renderWithProviders(<Sidebar />, { as: 'admin', auth: { currentOrg: org, orgs: [org] } });
    expect(screen.getByText('Agent ready · texts & calls')).toBeInTheDocument();
    expect(screen.queryByTestId('sitelog-numbers')).not.toBeInTheDocument();
  });

  it('hides Settings, Billing and Demo phone for a project manager and Team for ops-only pages', () => {
    renderWithProviders(<Sidebar />, { as: 'pm' });
    expect(screen.getByRole('link', { name: /Try it on WhatsApp/ })).toHaveAttribute(
      'href',
      '/try',
    );
    expect(screen.queryByRole('link', { name: /Settings/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Billing/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Demo phone/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Team & numbers/ })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Site glossary/ })).toBeInTheDocument();
  });

  it('shows only Crew hours for accounts users', () => {
    renderWithProviders(<Sidebar />, { as: 'accounts' });
    const links = screen.getAllByRole('link');
    expect(links.map((l) => l.textContent?.trim())).toEqual(['Crew hours']);
  });

  it('names the org switcher and the account menu by their visible text first (WCAG 2.5.3)', () => {
    renderWithProviders(<Sidebar />, { as: 'admin' });
    const org = screen.getByRole('button', { name: /^Kestrel Build Group/ });
    expect(org).not.toHaveAttribute('aria-label');
    expect(org).toHaveAccessibleName('Kestrel Build Group 6 active sites, Switch company');
    const account = screen.getByRole('button', { name: /^Lena Ortiz/ });
    expect(account).not.toHaveAttribute('aria-label');
    expect(account).toHaveAccessibleName('Lena Ortiz Operations Demo, Account menu');
  });

  it('keeps Settings current on every Settings tab, Field channels included (§11.2)', () => {
    for (const route of ['/settings/reports', '/settings/channels', '/settings/payroll']) {
      const { unmount } = renderWithProviders(<Sidebar />, { as: 'admin', route });
      const settings = screen.getByRole('link', { name: 'Settings' });
      expect(settings, route).toHaveAttribute('aria-current', 'page');
      expect(settings, route).toHaveClass('bg-steel');
      expect(settings, route).toHaveAttribute('href', '/settings/reports');
      expect(screen.getByRole('link', { name: 'Billing' })).not.toHaveAttribute('aria-current');
      unmount();
    }
    renderWithProviders(<Sidebar />, { as: 'admin', route: '/sites' });
    expect(screen.getByRole('link', { name: 'Settings' })).not.toHaveAttribute('aria-current');
    expect(screen.getByRole('link', { name: 'Sites' })).toHaveAttribute('aria-current', 'page');
  });

  it('switches the shell to Turkish from the account menu and keeps the route (§11.2, §11.5)', async () => {
    const route = '/reports/abc?v=2';
    renderWithProviders(
      <Routes>
        <Route
          path="*"
          element={
            <>
              <Sidebar />
              <Where />
            </>
          }
        />
      </Routes>,
      { as: 'admin', route },
    );
    await userEvent.click(
      screen.getByRole('button', { name: 'Lena Ortiz Operations Demo, Account menu' }),
    );
    const languages = await screen.findByRole('group', { name: 'Language' });
    expect(within(languages).getByRole('menuitemradio', { name: 'English' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    await userEvent.click(within(languages).getByRole('menuitemradio', { name: 'Türkçe' }));

    const nav = await screen.findByRole('navigation', { name: 'Ana gezinme' });
    for (const label of [
      'Genel bakış',
      'Şantiyeler',
      'Raporlar',
      'Puantaj',
      'Hava ve gecikmeler',
      'Ekip ve numaralar',
      'Şantiye sözlüğü',
      'Ayarlar',
      'Faturalandırma',
      'Demo telefon',
    ]) {
      expect(within(nav).getByRole('link', { name: new RegExp(label) })).toBeInTheDocument();
    }
    expect(screen.getByText('Kurulum')).toBeInTheDocument();
    expect(screen.getByText('Asistan hazır · mesaj ve arama')).toBeInTheDocument();
    expect(screen.getByText('6 aktif şantiye')).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByLabelText('1 rapor inceleme bekliyor')).toHaveTextContent('1'),
    );
    expect(
      screen.getByRole('button', { name: 'Lena Ortiz Operations Demo, Hesap menüsü' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Kestrel Build Group 6 aktif şantiye, Şirket değiştir' }),
    ).toBeInTheDocument();
    expect(screen.getByTestId('where')).toHaveTextContent(route);
    expect(document.documentElement.lang).toBe('tr');
    expect(window.localStorage.getItem(LANGUAGE_KEY)).toBe('"tr"');

    // The menu itself is Turkish now, and English comes back the same way.
    await userEvent.click(screen.getByRole('button', { name: /Hesap menüsü$/ }));
    const diller = await screen.findByRole('group', { name: 'Dil' });
    expect(screen.getByRole('menuitem', { name: 'Çıkış yap' })).toBeInTheDocument();
    await userEvent.click(within(diller).getByRole('menuitemradio', { name: 'English' }));
    expect(await screen.findByRole('navigation', { name: 'Main navigation' })).toBeInTheDocument();
    expect(screen.getByTestId('where')).toHaveTextContent(route);
  });

  it('writes the chosen language to the Auth metadata for the next sign-in email (§19 Q340)', async () => {
    const source = makeSource('admin');
    // A Supabase-backed panel: the demo itself writes nothing.
    Object.defineProperty(source, 'mode', { value: 'supabase' });
    const save = vi
      .spyOn(source, 'saveEmailLanguage')
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValue({ updated: true });
    renderWithProviders(<Sidebar />, { as: 'admin', source });

    await userEvent.click(screen.getByRole('button', { name: /Account menu$/ }));
    const languages = await screen.findByRole('group', { name: 'Language' });
    await userEvent.click(within(languages).getByRole('menuitemradio', { name: 'Türkçe' }));
    // A failed write leaves the switch applied.
    expect(await screen.findByRole('navigation', { name: 'Ana gezinme' })).toBeInTheDocument();
    expect(save).toHaveBeenLastCalledWith('tr');

    await userEvent.click(screen.getByRole('button', { name: /Hesap menüsü$/ }));
    const diller = await screen.findByRole('group', { name: 'Dil' });
    await userEvent.click(within(diller).getByRole('menuitemradio', { name: 'English' }));
    expect(await screen.findByRole('navigation', { name: 'Main navigation' })).toBeInTheDocument();
    expect(save).toHaveBeenLastCalledWith('en');
    expect(save).toHaveBeenCalledTimes(2);
  });

  it('writes no Auth metadata in the demo', async () => {
    const source = makeSource('admin');
    const save = vi.spyOn(source, 'saveEmailLanguage');
    renderWithProviders(<Sidebar />, { as: 'admin', source });
    await userEvent.click(screen.getByRole('button', { name: /Account menu$/ }));
    const languages = await screen.findByRole('group', { name: 'Language' });
    await userEvent.click(within(languages).getByRole('menuitemradio', { name: 'Türkçe' }));
    expect(await screen.findByRole('navigation', { name: 'Ana gezinme' })).toBeInTheDocument();
    expect(save).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole('button', { name: /Hesap menüsü$/ }));
    const diller = await screen.findByRole('group', { name: 'Dil' });
    await userEvent.click(within(diller).getByRole('menuitemradio', { name: 'English' }));
    expect(await screen.findByRole('navigation', { name: 'Main navigation' })).toBeInTheDocument();
  });
});
