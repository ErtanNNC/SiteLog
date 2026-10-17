import { Link } from 'react-router';
import { useFieldCopy } from '@/i18n/useFieldCopy';

/** The settings glyph of Field-03 (24 px grid, 2 px stroke, round caps; §14.3). */
function SettingsIcon() {
  return (
    <svg
      width="22"
      height="22"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M4 6h10 M18 6h2 M4 12h4 M12 12h8 M4 18h12 M20 18h0" />
      <circle cx="16" cy="6" r="2" />
      <circle cx="10" cy="12" r="2" />
      <circle cx="18" cy="18" r="2" />
    </svg>
  );
}

function ChevronIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className="flex-none"
    >
      <path d="M7 10l5 5 5-5" />
    </svg>
  );
}

/**
 * The field app's top bar (Field-03-Today, Field-10-Today-TR): the mark, the site's name and, on
 * Today, the settings gear. Before a link tells us the site it shows "SiteLog" as on
 * Field-02-Welcome. With `onChangeSite` the name is the site switcher (named "{site}, Change
 * site", §9.3: more than one site). The gear is 56 px, the field target size (§14.6).
 */
export function Header({
  siteName,
  onChangeSite,
  settings = false,
}: {
  siteName?: string;
  onChangeSite?: () => void;
  settings?: boolean;
}) {
  const { t, tc } = useFieldCopy();
  return (
    <header
      data-on-dark
      className={`flex h-header flex-none items-center gap-2 bg-asphalt pl-4 text-chalk ${settings ? '' : 'pr-4'}`}
    >
      <img src="/brand/logo-mark.svg" alt="" width={28} height={28} className="size-7 flex-none" />
      {siteName && onChangeSite ? (
        <button
          type="button"
          onClick={onChangeSite}
          // The name shown starts the accessible name (WCAG 2.5.3 label in name): a voice-control
          // user says the site's name.
          aria-label={`${siteName}, ${t('today.changeSite')}`}
          className="flex h-target min-w-0 flex-1 items-center gap-1.5 border-0 bg-transparent p-0 text-left text-[16px] leading-6 font-bold text-chalk"
        >
          <span className="truncate">{siteName}</span>
          <ChevronIcon />
        </button>
      ) : siteName ? (
        <span className="min-w-0 flex-1 truncate text-[16px] leading-6 font-bold">{siteName}</span>
      ) : (
        <span className="min-w-0 flex-1 truncate text-[19px] leading-6 font-extrabold tracking-[-0.03em] [font-stretch:125%]">
          {tc('appName')}
        </span>
      )}
      {settings ? (
        <Link
          to="/settings"
          aria-label={t('routes.settings')}
          className="flex size-target flex-none items-center justify-center rounded-btn"
        >
          <SettingsIcon />
        </Link>
      ) : null}
    </header>
  );
}
