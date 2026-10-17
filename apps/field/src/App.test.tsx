import { act, fireEvent, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { UI_RESOURCES } from '@sitelog/shared/copy/ui/index.ts';
import { i18n } from './i18n/i18n';
import { renderApp } from './test/render';

// The date line uses the phone's time zone; pin it so the test does not depend on the machine's
// (15:00 UTC is already the next day from UTC+9 on).
vi.mock('@/lib/time', () => ({ deviceTimeZone: () => 'America/Chicago' }));

describe('field app shell (W1-04)', () => {
  afterEach(() => vi.useRealTimers());

  it.each(['en', 'es', 'tr'] as const)(
    'renders the expired screen with no link to send in %s (W2-03)',
    async (lng) => {
      await act(() => i18n.changeLanguage(lng));
      const copy = UI_RESOURCES[lng].field;
      expect(document.documentElement.lang).toBe(lng);
      const { unmount } = renderApp('/expired', { session: null });
      expect(
        screen.getByRole('heading', { level: 1, name: copy.expired.title }),
      ).toBeInTheDocument();
      expect(screen.getByText(copy.expired.noCode)).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: copy.expired.send })).toBeNull();
      expect(screen.getByRole('banner')).toHaveTextContent('SiteLog');
      expect(document.title).toBe(`${copy.expired.title} · SiteLog`);
      unmount();
    },
  );

  it('shows today in the date line style of the app’s language before a link (Field-03, Field-10)', async () => {
    vi.useFakeTimers({ now: new Date('2026-10-09T15:00:00Z'), toFake: ['Date'] });
    const expected = { en: 'FRI, OCT 9', es: 'VIE, 9 OCT', tr: 'CUMA, 9 EKİM' } as const;
    for (const lng of ['en', 'es', 'tr'] as const) {
      await act(() => i18n.changeLanguage(lng));
      const { unmount } = renderApp('/expired', { session: null });
      const time = screen.getByText(expected[lng]);
      expect(time.tagName).toBe('TIME');
      expect(time).toHaveAttribute('datetime', '2026-10-09');
      unmount();
    }
  });

  it('opens Today from / (the manifest start_url), which asks for the link when none is stored', () => {
    renderApp('/', { session: null });
    expect(screen.getByRole('heading', { level: 1, name: 'Open your link' })).toBeInTheDocument();
    expect(
      screen.getByText('Open SiteLog from the link in your text message.'),
    ).toBeInTheDocument();
  });

  it('shows a not-found screen for any other path, with a way to Today', async () => {
    renderApp('/nope', { session: null });
    expect(screen.getByRole('heading', { level: 1, name: 'Page not found' })).toBeInTheDocument();
    await act(() => i18n.changeLanguage('tr'));
    expect(screen.getByRole('heading', { level: 1, name: 'Sayfa bulunamadı' })).toBeInTheDocument();
    // The installed app has no URL bar or back button: the screen's one action opens Today.
    const action = screen.getByRole('link', { name: 'Bugün ekranına git' });
    expect(action).toHaveAttribute('href', '/today');
    await act(() => i18n.changeLanguage('es'));
    fireEvent.click(screen.getByRole('link', { name: 'Ir a Hoy' }));
    expect(screen.getByRole('heading', { level: 1, name: 'Abra su enlace' })).toBeInTheDocument();
    await act(() => i18n.changeLanguage('en'));
  });
});
