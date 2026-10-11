import { Check, ChevronsUpDown, LogOut, Radio, User } from 'lucide-react';
import { NavLink, useNavigate } from 'react-router';
import { formatPhone } from '@sitelog/shared/format.ts';
import { useAuth } from '@/auth/AuthProvider';
import { copy } from '@/copy/en';
import { useNavBadges, useSimulateIncomingReport } from '@/data/hooks';
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

export function Logo({ className }: { className?: string }) {
  return (
    <span className={cn('inline-flex items-center gap-2.5', className)}>
      <img src="/brand/logo-mark.svg" alt="" width={32} height={32} className="size-8 shrink-0" />
      <span className="font-display text-[22px] leading-none text-chalk">{copy.app.name}</span>
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
  const badges = useNavBadges();
  const simulate = useSimulateIncomingReport();
  const navigate = useNavigate();
  const items = navItemsFor(role);
  const main = items.filter((i) => i.group === 'main');
  const setup = items.filter((i) => i.group === 'setup');

  const renderItem = (item: (typeof items)[number]) => {
    const count = item.badge ? (badges.data?.[item.badge] ?? 0) : 0;
    return (
      <li key={item.key}>
        <NavLink
          to={item.to}
          end={item.end}
          onClick={onNavigate}
          className={({ isActive }) =>
            cn(
              'group flex h-11 items-center gap-3 rounded-btn px-3 text-[15px] font-medium text-dust-light transition-colors hover:bg-steel/70 hover:text-chalk',
              isActive && 'bg-steel text-white',
            )
          }
        >
          {({ isActive }) => (
            <>
              <item.icon
                className={cn(
                  'size-6 shrink-0 stroke-2',
                  isActive ? 'text-signal' : 'text-dust-light group-hover:text-chalk',
                )}
                aria-hidden="true"
              />
              <span className="flex-1 truncate">{item.label}</span>
              {item.badge && count > 0 ? (
                <CountBadge
                  count={count}
                  tone={item.badgeTone ?? 'signal'}
                  label={copy.nav.badges[item.badge](count)}
                />
              ) : null}
            </>
          )}
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
              aria-label={copy.shell.orgSwitcher.label}
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[15px] font-semibold text-chalk">
                  {currentOrg?.name ?? '—'}
                </span>
                <span className="block truncate font-mono text-[12px] text-dust-light">
                  {copy.shell.orgSwitcher.activeSites(currentOrg?.activeSites ?? 0)}
                </span>
              </span>
              <ChevronsUpDown className="size-5 shrink-0 text-dust-light" aria-hidden="true" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-[216px]">
            <DropdownMenuLabel>{copy.shell.orgSwitcher.otherOrgs}</DropdownMenuLabel>
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
        aria-label={copy.nav.mainNavigation}
        className="mt-4 flex-1 overflow-y-auto px-3 scrollbar-thin"
      >
        <ul className="space-y-0.5">{main.map(renderItem)}</ul>
        {setup.length ? (
          <>
            <div className="eyebrow mb-1 mt-6 px-3 text-dust-light">{copy.nav.setupLabel}</div>
            <ul className="space-y-0.5">{setup.map(renderItem)}</ul>
          </>
        ) : null}
      </nav>

      <div className="border-t border-iron px-3 py-3">
        <div className="flex items-center gap-2 px-2 py-1 text-caption text-dust-light">
          <span className="relative flex size-2.5 shrink-0">
            <span className="absolute inline-flex size-full rounded-full bg-filed opacity-60" />
            <span className="relative inline-flex size-2.5 rounded-full bg-filed" />
          </span>
          <span className="truncate">{copy.shell.footer.listening}</span>
        </div>
        <div className="px-2 pb-2 font-mono text-[12px] tracking-[0.02em] text-chalk">
          {formatPhone(env.waDisplayNumber)}
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="flex h-14 w-full items-center gap-3 rounded-btn px-2 text-left hover:bg-steel"
              aria-label={copy.shell.footer.userMenu}
            >
              <Avatar name={user?.name ?? '?'} dark />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[15px] font-semibold text-chalk">
                  {user?.name}
                </span>
                <span className="block truncate text-caption text-dust-light">
                  {user?.title ?? copy.team.officeRoles[role ?? 'ops']}
                </span>
              </span>
              {isDemo ? (
                <span
                  className="inline-flex h-6 items-center rounded-chip border border-signal px-1.5 font-mono text-[11px] font-semibold uppercase tracking-[0.08em] text-signal"
                  title={copy.shell.demo.chipTitle}
                  data-testid="demo-chip"
                >
                  {copy.shell.demo.chip}
                </span>
              ) : null}
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" side="top" className="w-[216px]">
            <DropdownMenuItem
              onSelect={() => void navigate('/settings/reports')}
              disabled={role !== 'admin'}
            >
              <User aria-hidden="true" />
              {copy.shell.footer.profile}
            </DropdownMenuItem>
            {isDemo ? (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuLabel>{copy.shell.demo.menuTitle}</DropdownMenuLabel>
                <DropdownMenuItem
                  onSelect={() => simulate.mutate(undefined)}
                  data-testid="demo-simulate"
                >
                  <Radio aria-hidden="true" />
                  <span className="flex-1">
                    {copy.shell.demo.simulate}
                    <span className="block text-caption text-dust">
                      {copy.shell.demo.simulateHint}
                    </span>
                  </span>
                </DropdownMenuItem>
                <DropdownMenuLabel>{copy.shell.demo.switchUser}</DropdownMenuLabel>
                {(['admin', 'pm', 'ops', 'accounts'] as const).map((k) => (
                  <DropdownMenuItem key={k} onSelect={() => void navigate(`/login?as=${k}`)}>
                    {k === demoKey ? (
                      <Check aria-hidden="true" />
                    ) : (
                      <span className="size-5" aria-hidden="true" />
                    )}
                    {copy.shell.demo.users[k]}
                  </DropdownMenuItem>
                ))}
              </>
            ) : null}
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => void signOut().then(() => navigate('/login'))}>
              <LogOut aria-hidden="true" />
              {copy.shell.footer.signOut}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}
