import { Check, ChevronsUpDown, LogOut, Radio, User } from 'lucide-react';
import { useId } from 'react';
import { Link, NavLink, useLocation, useNavigate } from 'react-router';
import { formatPhone } from '@sitelog/shared/format.ts';
import { useAuth } from '@/auth/AuthProvider';
import { saveEmailLanguage } from '@/auth/emailLanguage';
import { useOptionalDataSource } from '@/data/DataProvider';
import { useNavBadges, useSimulateIncomingReport } from '@/data/hooks';
import { isPanelLanguage, PANEL_LANGUAGES } from '@/i18n/language';
import { useCopy, useLanguage } from '@/i18n/useCopy';
import { env } from '@/lib/env';
import { cn } from '@/lib/utils';
import { Avatar } from '../ui/Avatar';
import { CountBadge } from '../ui/Badge';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../ui/DropdownMenu';
import { navItemsFor } from './nav';
import { assetUrl } from '@/lib/asset';

export function Logo({ className }: { className?: string }) {
  const { t } = useCopy();
  return (
    <span className={cn('inline-flex items-center gap-2.5', className)}>
      <img
        src={assetUrl('brand/logo-mark.svg')}
        alt=""
        width={32}
        height={32}
        className="size-8 shrink-0"
      />
      <span className="font-display text-[22px] leading-none text-chalk">{t('app.name')}</span>
    </span>
  );
}

/** §11.2 sidebar, 240 px Asphalt. Rendered in the desktop aside and inside the mobile drawer. */
export function Sidebar({
  onNavigate,
  className,
}: {
  onNavigate?: () => void;
  className?: string;
}) {
  const { user, orgs, currentOrg, role, setCurrentOrg, signOut, isDemo, demoKey } = useAuth();
  const { t, tc } = useCopy();
  const { language, setLanguage } = useLanguage();
  const source = useOptionalDataSource();
  const languageLabelId = useId();
  const badges = useNavBadges();
  const simulate = useSimulateIncomingReport();
  const navigate = useNavigate();
  const items = navItemsFor(role, isDemo, {
    demoPhone: isDemo || env.demoPhoneAllOrgs || currentOrg?.demoOrg === true,
  });
  const main = items.filter((i) => i.group === 'main');
  const setup = items.filter((i) => i.group === 'setup');
  const numbers = currentOrg?.sitelogNumbers ?? [];

  const { pathname } = useLocation();

  const renderItem = (item: (typeof items)[number]) => {
    const count = item.badge ? (badges.data?.[item.badge] ?? 0) : 0;
    const itemClass = (active: boolean) =>
      cn(
        'group flex h-target items-center gap-3 rounded-btn px-3 text-[15px] font-medium text-dust-light transition-colors hover:bg-steel/70 hover:text-chalk',
        active && 'bg-steel text-white',
      );
    const body = (active: boolean) => (
      <>
        <item.icon
          className={cn(
            'size-6 shrink-0 stroke-2',
            active ? 'text-signal' : 'text-dust-light group-hover:text-chalk',
          )}
          aria-hidden="true"
        />
        <span className="flex-1 truncate">{t(item.label)}</span>
        {item.badge && count > 0 ? (
          <CountBadge
            count={count}
            tone={item.badgeTone ?? 'signal'}
            label={t(`nav.badges.${item.badge}`, { count })}
          />
        ) : null}
      </>
    );
    // An item that opens one page of a section (Settings → /settings/reports) is active on all of it.
    if (item.activePrefix) {
      const active = pathname.startsWith(item.activePrefix);
      return (
        <li key={item.key}>
          <Link
            to={item.to}
            onClick={onNavigate}
            className={itemClass(active)}
            aria-current={active ? 'page' : undefined}
          >
            {body(active)}
          </Link>
        </li>
      );
    }
    return (
      <li key={item.key}>
        <NavLink
          to={item.to}
          end={item.end}
          onClick={onNavigate}
          className={({ isActive }) => itemClass(isActive)}
        >
          {({ isActive }) => body(isActive)}
        </NavLink>
      </li>
    );
  };

  return (
    <div
      className={cn('on-dark flex h-full w-full flex-col bg-asphalt text-chalk', className)}
      data-testid="sidebar"
    >
      <div className="px-5 pb-4 pt-5">
        <Logo />
      </div>
      <div className="px-3">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="flex h-12 w-full items-center gap-2 rounded-btn border border-iron px-3 text-left hover:bg-steel"
            >
              {/* WCAG 2.5.3 (label in name): the name is the visible text, then the purpose. */}
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[15px] font-semibold text-chalk">
                  {currentOrg?.name ?? '—'}
                </span>{' '}
                <span className="block truncate font-mono text-[12px] text-dust-light">
                  {t('shell.orgSwitcher.activeSites', { count: currentOrg?.activeSites ?? 0 })}
                </span>
                <span className="sr-only">, {t('shell.orgSwitcher.label')}</span>
              </span>
              <ChevronsUpDown className="size-5 shrink-0 text-dust-light" aria-hidden="true" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-[216px]">
            <DropdownMenuLabel>{t('shell.orgSwitcher.otherOrgs')}</DropdownMenuLabel>
            <DropdownMenuRadioGroup value={currentOrg?.id} onValueChange={(v) => setCurrentOrg(v)}>
              {orgs.map((o) => (
                <DropdownMenuRadioItem key={o.id} value={o.id}>
                  <span className="flex-1 truncate">{o.name}</span>
                  <span className="ml-2 font-mono text-[11px] text-dust">{o.activeSites}</span>
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <nav
        aria-label={t('nav.mainNavigation')}
        className="mt-4 flex-1 overflow-y-auto px-3 scrollbar-thin"
      >
        <ul className="space-y-0.5">{main.map(renderItem)}</ul>
        {setup.length ? (
          <>
            <div className="eyebrow mb-1 mt-6 px-3 text-dust-light">{t('nav.setupLabel')}</div>
            <ul className="space-y-0.5">{setup.map(renderItem)}</ul>
          </>
        ) : null}
      </nav>

      <div className="border-t border-iron px-3 py-3" data-testid="sidebar-footer">
        {/* §11.2 footer: the agent's status, then the org's TalkOlog number(s) when it has one. */}
        <div className="flex items-start gap-2 px-2 py-1 text-caption text-dust-light">
          <span className="relative mt-1 flex size-2.5 shrink-0" aria-hidden="true">
            <span className="absolute inline-flex size-full rounded-full bg-filed opacity-60" />
            <span className="relative inline-flex size-2.5 rounded-full bg-filed" />
          </span>
          <span className="min-w-0">{t('shell.footer.agentReady')}</span>
        </div>
        {numbers.length ? (
          <ul
            aria-label={t('shell.footer.sitelogNumbers')}
            className="px-2 pb-2 font-mono text-[12px] tracking-[0.02em] text-chalk"
            data-testid="sitelog-numbers"
          >
            {numbers.map((n) => (
              <li key={n}>{formatPhone(n)}</li>
            ))}
          </ul>
        ) : null}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="flex h-14 w-full items-center gap-3 rounded-btn px-2 text-left hover:bg-steel"
            >
              {/* The initials repeat the name that follows; the name is the visible text first. */}
              <Avatar name={user?.name ?? '?'} dark aria-hidden="true" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[15px] font-semibold text-chalk">
                  {user?.name}
                </span>{' '}
                <span className="block truncate text-caption text-dust-light">
                  {user?.title ?? t(`team.officeRoles.${role ?? 'ops'}`)}
                </span>
              </span>{' '}
              {isDemo ? (
                <span
                  className="inline-flex h-6 items-center rounded-chip border border-signal px-1.5 font-mono text-[11px] font-semibold uppercase tracking-[0.08em] text-signal"
                  title={t('shell.demo.chipTitle')}
                  data-testid="demo-chip"
                >
                  {t('shell.demo.chip')}
                </span>
              ) : null}
              <span className="sr-only">, {t('shell.footer.userMenu')}</span>
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" side="top" className="w-[216px]">
            {/* §11.2 menu: Language EN/TR, Profile, Sign out. Switching keeps the route (§11.5).
                §19 Q378: no Language group while the build offers English only. */}
            {PANEL_LANGUAGES.length > 1 ? (
              <>
                <DropdownMenuLabel id={languageLabelId}>{tc('language')}</DropdownMenuLabel>
                <DropdownMenuRadioGroup
                  value={language}
                  onValueChange={(v) => {
                    if (!isPanelLanguage(v)) return;
                    setLanguage(v);
                    // §19 Q340: the next sign-in email follows the language chosen here.
                    saveEmailLanguage(source, v);
                  }}
                  aria-labelledby={languageLabelId}
                >
                  {PANEL_LANGUAGES.map((lang) => (
                    <DropdownMenuRadioItem key={lang} value={lang} lang={lang}>
                      {tc(`languageNames.${lang}`)}
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
                <DropdownMenuSeparator />
              </>
            ) : null}
            <DropdownMenuItem
              onSelect={() => void navigate('/settings/reports')}
              disabled={role !== 'admin'}
            >
              <User aria-hidden="true" />
              {t('shell.footer.profile')}
            </DropdownMenuItem>
            {isDemo ? (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuLabel>{t('shell.demo.menuTitle')}</DropdownMenuLabel>
                <DropdownMenuItem
                  onSelect={() => simulate.mutate(undefined)}
                  data-testid="demo-simulate"
                >
                  <Radio aria-hidden="true" />
                  <span className="flex-1">
                    {t('shell.demo.simulate')}
                    <span className="block text-caption text-dust">
                      {t('shell.demo.simulateHint')}
                    </span>
                  </span>
                </DropdownMenuItem>
                <DropdownMenuLabel>{t('shell.demo.switchUser')}</DropdownMenuLabel>
                {(['admin', 'pm', 'ops', 'accounts'] as const).map((k) => (
                  <DropdownMenuItem key={k} onSelect={() => void navigate(`/login?as=${k}`)}>
                    {k === demoKey ? (
                      <Check aria-hidden="true" />
                    ) : (
                      <span className="size-5" aria-hidden="true" />
                    )}
                    {t(`shell.demo.users.${k}`)}
                  </DropdownMenuItem>
                ))}
              </>
            ) : null}
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => void signOut().then(() => navigate('/login'))}>
              <LogOut aria-hidden="true" />
              {t('shell.footer.signOut')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}
