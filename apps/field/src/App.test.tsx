import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { UI_RESOURCES } from '@sitelog/shared/copy/ui/index.ts';
import { i18n } from './i18n/i18n';
import { FieldRoutes } from './routes';
import { FIELD_ROUTES } from './routes/paths';

// The date line uses the phone's time zone; pin it so the test does not depend on the machine's
// (15:00 UTC is already the next day from UTC+9 on).
vi.mock('@/lib/time', () => ({ deviceTimeZone: () => 'America/Chicago' }));

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <FieldRoutes />
    </MemoryRouter>,
  );
}

describe('field app shell (W1-04)', () => {
  afterEach(() => vi.useRealTimers());

  it.each(['en', 'es', 'tr'] as const)(
    'renders every §9.3 route as a placeholder in %s',
    async (lng) => {
      await act(() => i18n.changeLanguage(lng));
      const copy = UI_RESOURCES[lng].field;
      expect(document.documentElement.lang).toBe(lng);
      for (const route of FIELD_ROUTES) {
        const { unmount } = renderAt(route.example);
        const title = copy.routes[route.screen];
        expect(screen.getByRole('heading', { level: 1, name: title })).toBeInTheDocument();
        expect(screen.getByText(copy.placeholderBody)).toBeInTheDocument();
        expect(screen.getByRole('banner')).toHaveTextContent('SiteLog');
        expect(document.title).toBe(`${title} · SiteLog`);
        // Field-03: the settings gear is on Today only, named as on the artboards ("Ayarlar").
        const gear = screen.queryByRole('link', { name: copy.routes.settings });
        expect(!!gear, route.path).toBe(route.screen === 'today');
        unmount();
      }
    },
  );

  it('shows today in the Today header style of the app’s language (Field-03, Field-10)', async () => {
    vi.useFakeTimers({ now: new Date('2026-10-09T15:00:00Z'), toFake: ['Date'] });
    const expected = { en: 'FRI, OCT 9', es: 'VIE, 9 OCT', tr: 'CUMA, 9 EKİM' } as const;
    for (const lng of ['en', 'es', 'tr'] as const) {
      await act(() => i18n.changeLanguage(lng));
      const { unmount } = renderAt('/today');
      const time = screen.getByText(expected[lng]);
      expect(time.tagName).toBe('TIME');
      expect(time).toHaveAttribute('datetime', '2026-10-09');
      unmount();
    }
  });

  it('opens Today from / (the manifest start_url)', () => {
    renderAt('/');
    expect(screen.getByRole('heading', { level: 1, name: 'Today' })).toBeInTheDocument();
  });

  it('shows a not-found screen for any other path, with a way to Today', async () => {
    renderAt('/nope');
    expect(screen.getByRole('heading', { level: 1, name: 'Page not found' })).toBeInTheDocument();
    await act(() => i18n.changeLanguage('tr'));
    expect(screen.getByRole('heading', { level: 1, name: 'Sayfa bulunamadı' })).toBeInTheDocument();
    // The installed app has no URL bar or back button: the screen's one action opens Today.
    const action = screen.getByRole('link', { name: 'Bugün ekranına git' });
    expect(action).toHaveAttribute('href', '/today');
    await act(() => i18n.changeLanguage('es'));
    fireEvent.click(screen.getByRole('link', { name: 'Ir a Hoy' }));
    expect(screen.getByRole('heading', { level: 1, name: 'Hoy' })).toBeInTheDocument();
    await act(() => i18n.changeLanguage('en'));
  });
});
