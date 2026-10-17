import { act, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { i18n } from '@/i18n/i18n';
import { rememberLanguage } from '@/i18n/language';
import { renderWithProviders } from '@/test/render';
import { AppRoutes } from './routes';

/** The viewer chose Turkish (a choice wins over the en-US org's default). */
async function chooseTurkish() {
  rememberLanguage('tr');
  await act(() => i18n.changeLanguage('tr'));
}

describe('routes (§11.1)', () => {
  it('/dev/phone is the Demo phone for admins (W1-08)', async () => {
    renderWithProviders(<AppRoutes />, { as: 'admin', route: '/dev/phone' });
    expect(await screen.findByRole('heading', { level: 1, name: 'Demo phone' })).toBeVisible();
    expect(await screen.findByRole('navigation', { name: 'Reporters' })).toBeInTheDocument();
    expect(
      within(screen.getAllByRole('navigation', { name: 'Main navigation' })[0]!).getByRole('link', {
        name: 'Demo phone',
      }),
    ).toHaveAttribute('aria-current', 'page');
  });

  it('/dev/phone is admin only', async () => {
    renderWithProviders(<AppRoutes />, { as: 'pm', route: '/dev/phone' });
    expect(
      await screen.findByText('You don’t have access to Demo phone. Ask an admin.'),
    ).toBeInTheDocument();
  });

  it('/settings/channels is the Field channels tab (W4-05)', async () => {
    renderWithProviders(<AppRoutes />, { as: 'admin', route: '/settings/channels' });
    expect(await screen.findByRole('heading', { level: 1, name: 'Settings' })).toBeVisible();
    expect(await screen.findByTestId('pack-card')).toBeInTheDocument();
    const tabs = screen.getAllByRole('tab', { name: 'Field channels' });
    expect(tabs[0]).toHaveAttribute('aria-selected', 'true');
    expect(tabs[0]).toHaveAttribute('href', '/settings/channels');
    // P12 order: Reports & reminders · Field channels · PDF template · Recipients · Payroll export.
    const tablist = screen.getAllByRole('tablist', { name: 'Settings' })[0]!;
    expect(
      within(tablist)
        .getAllByRole('tab')
        .map((t) => t.textContent),
    ).toEqual([
      'Reports & reminders',
      'Field channels',
      'PDF template',
      'Recipients',
      'Payroll export',
    ]);
  });

  it('in Turkish: the shell and the translated pages speak Turkish, other pages stay English', async () => {
    await chooseTurkish();
    const { unmount } = renderWithProviders(<AppRoutes />, {
      as: 'admin',
      route: '/dev/phone',
    });
    expect(await screen.findByRole('heading', { level: 1, name: 'Demo telefon' })).toBeVisible();
    expect(await screen.findByRole('tab', { name: 'Mesajlar' })).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'Rapor verenler' })).toBeInTheDocument();
    unmount();

    // Settings speaks Turkish since W4-05; New report is still English-only (W4-09).
    const settings = renderWithProviders(<AppRoutes />, {
      as: 'admin',
      route: '/settings/channels',
    });
    expect(await screen.findByRole('heading', { level: 1, name: 'Ayarlar' })).toBeVisible();
    settings.unmount();
    renderWithProviders(<AppRoutes />, { as: 'admin', route: '/reports/new' });
    const heading = await screen.findByRole('heading', { level: 1, name: 'New report' });
    // The page (English, lang="en") inside the Turkish shell.
    expect(heading.closest('[lang]')).toHaveAttribute('lang', 'en');
    expect(screen.getAllByRole('navigation', { name: 'Ana gezinme' }).length).toBeGreaterThan(0);
    expect(screen.getByRole('link', { name: 'İçeriğe geç' })).toHaveAttribute('href', '#main');
  });

  it('without a choice, the en-US org’s shell is English, even for a Turkish browser (§6.3)', async () => {
    vi.stubGlobal('navigator', { ...navigator, languages: ['tr-TR'], language: 'tr-TR' });
    await act(() => i18n.changeLanguage('tr')); // what /login showed: not saved, not a choice
    renderWithProviders(<AppRoutes />, { as: 'admin', route: '/dev/phone' });
    expect(await screen.findByRole('heading', { level: 1, name: 'Demo phone' })).toBeVisible();
    expect(i18n.language).toBe('en');
    vi.unstubAllGlobals();
  });

  it('in Turkish: the sign-in error screen (companies did not load) is Turkish', async () => {
    await chooseTurkish();
    renderWithProviders(<AppRoutes />, {
      as: 'admin',
      route: '/',
      auth: { status: 'error', error: new Error('Network down') },
    });
    expect(await screen.findByText('Şirketleriniz yüklenemedi.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Tekrar dene' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Çıkış yap' })).toBeInTheDocument();
  });

  it('in Turkish: not found and no access are Turkish', async () => {
    await chooseTurkish();
    const { unmount } = renderWithProviders(<AppRoutes />, {
      as: 'admin',
      route: '/no-such-page',
    });
    expect(await screen.findByRole('heading', { name: 'Sayfa bulunamadı' })).toBeVisible();
    expect(screen.getByRole('link', { name: 'Genel bakışa git' })).toHaveAttribute('href', '/');
    unmount();

    renderWithProviders(<AppRoutes />, { as: 'accounts', route: '/sites' });
    expect(
      await screen.findByText('Şantiyeler sayfasına erişiminiz yok. Bir yöneticiye danışın.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Puantaja git' })).toHaveAttribute('href', '/hours');
  });
});
