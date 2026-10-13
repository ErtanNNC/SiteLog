import { PANEL_LANGUAGES } from '@/i18n/language';
import { useCopy, useLanguage } from '@/i18n/useCopy';
import { cn } from '@/lib/utils';

/**
 * EN/TR switch for `/login` (P1, F1): each language named in itself, the current one pressed. The
 * choice is saved on this device and applies at once, without leaving the page.
 */
export function LanguageSwitch({
  tone = 'light',
  className,
}: {
  /** `dark` on Asphalt (the sign-in brand panel). */
  tone?: 'light' | 'dark';
  className?: string;
}) {
  const { tc } = useCopy();
  const { language, setLanguage } = useLanguage();
  const dark = tone === 'dark';
  return (
    <div
      role="group"
      aria-label={tc('language')}
      className={cn(
        'inline-flex gap-1 rounded-btn border p-1',
        dark ? 'border-iron' : 'border-rebar bg-chalk',
        className,
      )}
      data-testid="language-switch"
    >
      {PANEL_LANGUAGES.map((lang) => {
        const pressed = language === lang;
        return (
          <button
            key={lang}
            type="button"
            lang={lang}
            aria-pressed={pressed}
            onClick={() => setLanguage(lang)}
            className={cn(
              'inline-flex h-11 items-center rounded-chip px-3 text-[14px] font-semibold transition-colors',
              dark
                ? pressed
                  ? 'bg-chalk text-asphalt'
                  : 'text-dust-light hover:bg-steel hover:text-chalk'
                : pressed
                  ? 'bg-asphalt text-chalk'
                  : 'text-dust hover:bg-concrete hover:text-asphalt',
            )}
          >
            {tc(`languageNames.${lang}`)}
          </button>
        );
      })}
    </div>
  );
}
