import { act, render, renderHook, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/Dialog';
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/Popover';
import { EnglishOnly } from './EnglishOnly';
import { i18n } from './i18n';
import { LANGUAGE_KEY } from './language';
import { PANEL_RESOURCES, stringTree } from './resources';
import {
  applyOrgLanguage,
  translate,
  useCopy,
  useLanguage,
  useOrgLanguageDefault,
} from './useCopy';

function Probe({ id }: { id: string }) {
  const { t, tc, language } = useCopy();
  return (
    <p data-testid={id} data-language={language}>
      {t('nav.sites')} | {t('shell.orgSwitcher.activeSites', { count: 1 })} |{' '}
      {t('shell.orgSwitcher.activeSites', { count: 6 })} | {t('states.noAccess', { page: 'X' })} |{' '}
      {t('settings.title')} | {tc('language')}
    </p>
  );
}

describe('useCopy (D9)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('serves copy/en.ts as English, with counted phrases and variables', () => {
    render(<Probe id="p" />);
    expect(screen.getByTestId('p')).toHaveTextContent(
      'Sites | 1 active site | 6 active sites | You don’t have access to X. Ask an admin. | Settings | Language',
    );
    expect(screen.getByTestId('p')).toHaveAttribute('data-language', 'en');
  });

  it('switches to Turkish everywhere at once, falling back to English per key', async () => {
    render(<Probe id="p" />);
    await act(() => i18n.changeLanguage('tr'));
    // `settings.title` has no Turkish yet: it falls back to English, never to the raw key.
    expect(screen.getByTestId('p')).toHaveTextContent(
      'Şantiyeler | 1 aktif şantiye | 6 aktif şantiye | X sayfasına erişiminiz yok. Bir yöneticiye danışın. | Settings | Dil',
    );
    expect(document.documentElement.lang).toBe('tr');
    expect(translate('nav.reports')).toBe('Raporlar');
  });

  it('keeps an <EnglishOnly> page in English, marked lang="en", inside a Turkish shell', async () => {
    await act(() => i18n.changeLanguage('tr'));
    render(
      <>
        <Probe id="shell" />
        <EnglishOnly>
          <Probe id="page" />
        </EnglishOnly>
      </>,
    );
    expect(screen.getByTestId('shell')).toHaveTextContent(/^Şantiyeler/);
    expect(screen.getByTestId('page')).toHaveTextContent(/^Sites \| 1 active site/);
    expect(screen.getByTestId('page')).toHaveAttribute('data-language', 'en');
    expect(screen.getByTestId('page').closest('[lang]')).toHaveAttribute('lang', 'en');
  });

  it('carries lang="en" into what an <EnglishOnly> page portals to <body> (WCAG 3.1.2)', async () => {
    await act(() => i18n.changeLanguage('tr'));
    const { unmount } = render(
      <EnglishOnly>
        <Popover open>
          <PopoverAnchor />
          <PopoverContent>Page popover</PopoverContent>
        </Popover>
        <Dialog open>
          <DialogContent aria-describedby={undefined}>
            <DialogTitle>Page dialog</DialogTitle>
          </DialogContent>
        </Dialog>
      </EnglishOnly>,
    );
    expect(document.documentElement.lang).toBe('tr');
    expect(screen.getByRole('dialog', { name: 'Page dialog' })).toHaveAttribute('lang', 'en');
    expect(screen.getByText('Page popover').closest('[lang]')).toHaveAttribute('lang', 'en');
    unmount();

    // The shell's own dialogs follow <html lang>.
    render(
      <Dialog open>
        <DialogContent aria-describedby={undefined}>
          <DialogTitle>Shell dialog</DialogTitle>
        </DialogContent>
      </Dialog>,
    );
    expect(screen.getByRole('dialog', { name: 'Shell dialog' })).not.toHaveAttribute('lang');
  });

  it('useLanguage saves the choice and applies it', async () => {
    const { result } = renderHook(() => useLanguage());
    expect(result.current.language).toBe('en');
    await act(async () => result.current.setLanguage('tr'));
    expect(result.current.language).toBe('tr');
    expect(window.localStorage.getItem(LANGUAGE_KEY)).toBe('"tr"');
  });

  it('applies the org locale as a default (§6.3), even over a Turkish browser, never over a choice', async () => {
    vi.stubGlobal('navigator', { ...navigator, languages: ['tr-TR'], language: 'tr-TR' });
    const { rerender, unmount } = renderHook(({ locale }) => useOrgLanguageDefault(locale), {
      initialProps: { locale: undefined as 'en-US' | 'tr-TR' | undefined },
    });
    expect(i18n.language).toBe('en');
    await act(async () => rerender({ locale: 'tr-TR' }));
    expect(i18n.language).toBe('tr');
    expect(window.localStorage.getItem(LANGUAGE_KEY)).toBeNull(); // a default, not a choice
    await act(async () => rerender({ locale: 'en-US' }));
    expect(i18n.language).toBe('en'); // the Turkish browser does not win over the org
    unmount();

    window.localStorage.setItem(LANGUAGE_KEY, '"en"');
    renderHook(() => useOrgLanguageDefault('tr-TR'));
    expect(i18n.language).toBe('en');
  });

  it('applyOrgLanguage switches synchronously, before anything renders', () => {
    applyOrgLanguage('tr-TR');
    expect(i18n.language).toBe('tr');
    expect(translate('nav.sites')).toBe('Şantiyeler');
    applyOrgLanguage(null);
    expect(i18n.language).toBe('tr');
  });

  it('builds the English resource from the strings of copy/en.ts only', () => {
    expect(stringTree({ a: 'x', f: () => 'y', l: ['m', 'n'], o: { b: 'z' } })).toEqual({
      a: 'x',
      l: ['m', 'n'],
      o: { b: 'z' },
    });
    const nav = PANEL_RESOURCES.en.panel.nav as Record<string, unknown>;
    expect(nav.sites).toBe('Sites');
    expect(PANEL_RESOURCES.tr.common.language).toBe('Dil');
  });
});
