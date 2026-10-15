import { Bell, Menu, Search, X } from 'lucide-react';
import {
  createContext,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router';
import { useAuth } from '@/auth/AuthProvider';
import { useMarkNotificationsRead, useNotifications, useSearch } from '@/data/hooks';
import type { NotificationItem, SearchResult } from '@/data/types';
import { formatWhen } from '@/lib/format';
import { formatDateInTz } from '@sitelog/shared/format.ts';
import { PinnedLanguage } from '@/i18n/context';
import { useCopy } from '@/i18n/useCopy';
import { cn } from '@/lib/utils';
import { Button } from '../ui/Button';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/Popover';
import { Logo } from './Sidebar';

// ── Page-specific controls slot (week picker, filters…) rendered through a portal ──
const SlotCtx = createContext<HTMLElement | null>(null);
export const TopBarSlotProvider = SlotCtx.Provider;

/**
 * A page's controls in the top bar. They belong to the page, so an English-only page
 * (`<EnglishOnly>`) keeps `lang="en"` on them across the portal.
 */
export function TopBarControls({ children }: { children: ReactNode }) {
  const el = useContext(SlotCtx);
  const pinned = useContext(PinnedLanguage);
  if (!el) return null;
  return createPortal(
    pinned && children != null && children !== false ? (
      <div lang={pinned} className="contents">
        {children}
      </div>
    ) : (
      children
    ),
    el,
  );
}

// ── Global search ──
function GlobalSearch({ className }: { className?: string }) {
  const { t } = useCopy();
  // The bar renders two of these (desktop and phone rows): ids must be unique, or the phone
  // field's <label for> points at the hidden desktop one and it is named by its placeholder.
  const inputId = useId();
  const resultsId = useId();
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const wrap = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(q), 150);
    return () => clearTimeout(t);
  }, [q]);
  const results = useSearch(debounced);
  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);
  const go = (r: SearchResult) => {
    setOpen(false);
    setQ('');
    void navigate(r.href);
  };
  const list = results.data ?? [];
  const grouped = new Map<SearchResult['kind'], SearchResult[]>();
  for (const r of list) grouped.set(r.kind, [...(grouped.get(r.kind) ?? []), r]);
  return (
    <div ref={wrap} className={cn('relative w-full max-w-xl', className)}>
      <label className="sr-only" htmlFor={inputId}>
        {t('shell.search.label')}
      </label>
      <Search
        className="pointer-events-none absolute left-3 top-1/2 size-5 -translate-y-1/2 text-dust"
        aria-hidden="true"
      />
      <input
        id={inputId}
        type="search"
        role="combobox"
        aria-expanded={open && debounced.length >= 2}
        aria-controls={resultsId}
        aria-autocomplete="list"
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') setOpen(false);
          if (e.key === 'Enter' && list[0]) go(list[0]);
        }}
        placeholder={t('shell.search.placeholder')}
        className="h-target w-full rounded-chip border border-rebar bg-concrete/60 pl-10 pr-10 text-[15px] placeholder:text-dust focus:border-asphalt focus:bg-chalk"
      />
      {q ? (
        <button
          type="button"
          className="absolute right-2 top-1/2 flex size-8 -translate-y-1/2 items-center justify-center rounded-chip text-dust hover:bg-concrete"
          onClick={() => setQ('')}
          aria-label={t('shell.search.clear')}
        >
          <X className="size-4" aria-hidden="true" />
        </button>
      ) : null}
      {open && debounced.length >= 2 ? (
        <div
          id={resultsId}
          role="listbox"
          aria-label={t('a11y.searchResults')}
          className="absolute left-0 right-0 top-full z-40 mt-1 max-h-96 overflow-y-auto rounded-card border border-rebar bg-chalk p-1"
        >
          {list.length === 0 ? (
            <div className="px-3 py-3 text-caption text-dust">
              {results.isFetching
                ? t('common.loading')
                : t('shell.search.noResults', { query: debounced })}
            </div>
          ) : (
            [...grouped].map(([kind, items]) => (
              <div key={kind}>
                <div className="eyebrow px-3 pb-1 pt-2 text-dust">
                  {t(`shell.search.groups.${kind}`)}
                </div>
                {items.map((r) => (
                  <button
                    key={`${r.kind}-${r.id}`}
                    type="button"
                    role="option"
                    aria-selected={false}
                    onClick={() => go(r)}
                    className="flex min-h-target-dense w-full flex-col items-start rounded-chip px-3 py-1.5 text-left hover:bg-concrete"
                  >
                    <span className="text-[15px] font-medium">{r.title}</span>
                    {r.subtitle ? (
                      <span className="text-caption text-dust">{r.subtitle}</span>
                    ) : null}
                  </button>
                ))}
              </div>
            ))
          )}
        </div>
      ) : null}
    </div>
  );
}

// ── Notifications bell ──
function NotificationsBell() {
  const { currentOrg } = useAuth();
  const { t, language } = useCopy();
  const [open, setOpen] = useState(false);
  const notifications = useNotifications({ refetchInterval: 60_000 });
  const markRead = useMarkNotificationsRead();
  const navigate = useNavigate();
  const items = notifications.data ?? [];
  const unread = items.filter((n) => !n.readAt).length;
  const tz = currentOrg?.timezone ?? 'UTC';
  const today = formatDateInTz(new Date(), tz);
  const openItem = (n: NotificationItem) => {
    if (!n.readAt) markRead.mutate({ ids: [n.id] });
    setOpen(false);
    if (n.targetPath) void navigate(n.targetPath);
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="subtle"
          size="icon"
          aria-label={
            unread
              ? `${t('shell.notifications.label')}, ${t('shell.notifications.unread', { count: unread })}`
              : t('shell.notifications.label')
          }
          className="relative"
          data-testid="notifications-bell"
        >
          <Bell aria-hidden="true" />
          {unread > 0 ? (
            <span
              aria-hidden="true"
              className="absolute right-2.5 top-2.5 size-2.5 rounded-full border-2 border-chalk bg-signal"
            />
          ) : null}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[360px] max-w-[calc(100vw-32px)] p-0">
        <div className="flex items-center justify-between border-b border-rebar px-4 py-3">
          <h2 className="font-h2 text-[17px]">{t('shell.notifications.title')}</h2>
          {unread > 0 ? (
            <Button
              variant="link"
              size="sm"
              onClick={() =>
                markRead.mutate({ ids: items.filter((n) => !n.readAt).map((n) => n.id) })
              }
            >
              {t('shell.notifications.markAllRead')}
            </Button>
          ) : null}
        </div>
        <ul
          className="max-h-[420px] overflow-y-auto p-1 scrollbar-thin"
          aria-label={t('shell.notifications.title')}
        >
          {items.length === 0 ? (
            <li className="px-3 py-6 text-center text-caption text-dust">
              {t('shell.notifications.empty')}
            </li>
          ) : (
            items.map((n) => (
              <li key={n.id}>
                <button
                  type="button"
                  onClick={() => openItem(n)}
                  className={cn(
                    'flex w-full gap-3 rounded-chip px-3 py-2.5 text-left hover:bg-concrete',
                    !n.readAt && 'bg-signal-tint/40',
                  )}
                >
                  <span
                    aria-hidden="true"
                    className={cn(
                      'mt-2 size-2 shrink-0 rounded-full',
                      n.readAt ? 'bg-transparent' : 'bg-signal',
                    )}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block text-[15px] font-medium leading-5">{n.title}</span>
                    {n.body ? (
                      <span className="block truncate text-caption text-dust">{n.body}</span>
                    ) : null}
                    <span className="block font-mono text-[11px] uppercase tracking-[0.08em] text-dust">
                      {formatWhen(n.createdAt, tz, today, language)}
                    </span>
                  </span>
                </button>
              </li>
            ))
          )}
        </ul>
      </PopoverContent>
    </Popover>
  );
}

/**
 * §11.2 top bar: Chalk, 1 px Rebar bottom border; search · bell · page controls slot. A page's
 * controls render into one of two slots, so the DOM order is the visual (and Tab) order at every
 * width (WCAG 2.4.3): from 768 px the desktop slot before the bell; below it the mobile slot, a row
 * of its own after the search, so a page with several controls (week picker, filters, Save) never
 * pushes the bar wider than the phone. `AppShell` hands the matching one to `TopBarControls`.
 */
export function TopBar({
  onOpenMenu,
  desktopSlotRef,
  mobileSlotRef,
}: {
  onOpenMenu: () => void;
  desktopSlotRef: (el: HTMLDivElement | null) => void;
  mobileSlotRef: (el: HTMLDivElement | null) => void;
}) {
  const { t } = useCopy();
  return (
    <header className="sticky top-0 z-30 border-b border-rebar bg-chalk">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2.5 md:h-16 md:flex-nowrap md:px-8 md:py-0">
        <Button
          variant="subtle"
          size="icon"
          className="md:hidden"
          onClick={onOpenMenu}
          aria-label={t('nav.openMenu')}
        >
          <Menu aria-hidden="true" />
        </Button>
        <span className="rounded-btn bg-asphalt px-2 py-1 md:hidden">
          <Logo />
        </span>
        <GlobalSearch className="hidden min-w-0 flex-1 sm:block" />
        <div className="ml-auto flex items-center gap-2">
          <div
            ref={desktopSlotRef}
            className="hidden items-center gap-2 empty:hidden md:flex"
            data-testid="topbar-controls"
          />
          <NotificationsBell />
        </div>
        <GlobalSearch className="sm:hidden" />
        <div
          ref={mobileSlotRef}
          className="flex w-full flex-wrap items-center justify-end gap-2 empty:hidden md:hidden"
          data-testid="topbar-controls-mobile"
        />
      </div>
    </header>
  );
}
