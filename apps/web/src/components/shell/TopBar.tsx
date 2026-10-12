import { Bell, Menu, Search, X } from 'lucide-react';
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router';
import { useAuth } from '@/auth/AuthProvider';
import { copy } from '@/copy/en';
import { useMarkNotificationsRead, useNotifications, useSearch } from '@/data/hooks';
import type { NotificationItem, SearchResult } from '@/data/types';
import { formatWhen } from '@/lib/format';
import { formatDateInTz } from '@sitelog/shared/format.ts';
import { cn } from '@/lib/utils';
import { Button } from '../ui/Button';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/Popover';
import { Logo } from './Sidebar';

// ── Page-specific controls slot (week picker, filters…) rendered through a portal ──
const SlotCtx = createContext<HTMLElement | null>(null);
export const TopBarSlotProvider = SlotCtx.Provider;

export function TopBarControls({ children }: { children: ReactNode }) {
  const el = useContext(SlotCtx);
  return el ? createPortal(children, el) : null;
}

// ── Global search ──
function GlobalSearch({ className }: { className?: string }) {
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
      <label className="sr-only" htmlFor="global-search">
        {copy.shell.search.label}
      </label>
      <Search
        className="pointer-events-none absolute left-3 top-1/2 size-5 -translate-y-1/2 text-dust"
        aria-hidden="true"
      />
      <input
        id="global-search"
        type="search"
        role="combobox"
        aria-expanded={open && debounced.length >= 2}
        aria-controls="global-search-results"
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
        placeholder={copy.shell.search.placeholder}
        className="h-11 w-full rounded-chip border border-rebar bg-concrete/60 pl-10 pr-10 text-[15px] placeholder:text-dust focus:border-asphalt focus:bg-chalk"
      />
      {q ? (
        <button
          type="button"
          className="absolute right-2 top-1/2 flex size-8 -translate-y-1/2 items-center justify-center rounded-chip text-dust hover:bg-concrete"
          onClick={() => setQ('')}
          aria-label={copy.common.dismiss}
        >
          <X className="size-4" aria-hidden="true" />
        </button>
      ) : null}
      {open && debounced.length >= 2 ? (
        <div
          id="global-search-results"
          role="listbox"
          aria-label={copy.a11y.searchResults}
          className="absolute left-0 right-0 top-full z-40 mt-1 max-h-96 overflow-y-auto rounded-card border border-rebar bg-chalk p-1"
        >
          {list.length === 0 ? (
            <div className="px-3 py-3 text-caption text-dust">
              {results.isFetching ? copy.common.loading : copy.shell.search.noResults(debounced)}
            </div>
          ) : (
            [...grouped].map(([kind, items]) => (
              <div key={kind}>
                <div className="eyebrow px-3 pb-1 pt-2 text-dust">
                  {copy.shell.search.groups[kind]}
                </div>
                {items.map((r) => (
                  <button
                    key={`${r.kind}-${r.id}`}
                    type="button"
                    role="option"
                    aria-selected={false}
                    onClick={() => go(r)}
                    className="flex min-h-10 w-full flex-col items-start rounded-chip px-3 py-1.5 text-left hover:bg-concrete"
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
              ? `${copy.shell.notifications.label} · ${copy.shell.notifications.unread(unread)}`
              : copy.shell.notifications.label
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
          <h2 className="font-h2 text-[17px]">{copy.shell.notifications.title}</h2>
          {unread > 0 ? (
            <Button
              variant="link"
              size="sm"
              onClick={() =>
                markRead.mutate({ ids: items.filter((n) => !n.readAt).map((n) => n.id) })
              }
            >
              {copy.shell.notifications.markAllRead}
            </Button>
          ) : null}
        </div>
        <ul
          className="max-h-[420px] overflow-y-auto p-1 scrollbar-thin"
          aria-label={copy.shell.notifications.title}
        >
          {items.length === 0 ? (
            <li className="px-3 py-6 text-center text-caption text-dust">
              {copy.shell.notifications.empty}
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
                      {formatWhen(n.createdAt, tz, today)}
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

/** §11.2 top bar: Chalk, 1 px Rebar bottom border; search · bell · page controls slot. */
export function TopBar({
  onOpenMenu,
  slotRef,
}: {
  onOpenMenu: () => void;
  slotRef: (el: HTMLDivElement | null) => void;
}) {
  return (
    <header className="sticky top-0 z-30 border-b border-rebar bg-chalk">
      <div className="flex h-16 items-center gap-3 px-4 md:px-8">
        <Button
          variant="subtle"
          size="icon"
          className="md:hidden"
          onClick={onOpenMenu}
          aria-label={copy.nav.openMenu}
        >
          <Menu aria-hidden="true" />
        </Button>
        <span className="rounded-btn bg-asphalt px-2 py-1 md:hidden">
          <Logo />
        </span>
        <GlobalSearch className="hidden sm:block" />
        <div className="ml-auto flex items-center gap-2">
          <div
            ref={slotRef}
            className="flex items-center gap-2 empty:hidden"
            data-testid="topbar-controls"
          />
          <NotificationsBell />
        </div>
      </div>
      <div className="px-4 pb-3 sm:hidden">
        <GlobalSearch />
      </div>
    </header>
  );
}
