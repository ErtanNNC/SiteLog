import { CircleAlert, Inbox, Lock, RefreshCw, WifiOff, type LucideIcon } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { copy } from '@/copy/en';
import { captureError } from '@/lib/sentry';
import { cn, errorMessage } from '@/lib/utils';
import { Button } from '../ui/Button';

/** Icon, one sentence, one action (§11.3). */
export function EmptyState({
  icon: Icon = Inbox,
  title,
  body,
  action,
  className,
  hero,
}: {
  icon?: LucideIcon;
  title: string;
  body?: ReactNode;
  action?: ReactNode;
  className?: string;
  hero?: boolean;
}) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center rounded-card border border-dashed border-rebar bg-chalk px-6 py-12 text-center',
        className,
      )}
      role="status"
    >
      {hero ? (
        <div aria-hidden="true" className="hazard-stripe mb-6 h-2 w-24 rounded-chip" />
      ) : null}
      <Icon className="mb-3 size-6 stroke-2 text-dust" aria-hidden="true" />
      <h2 className="font-h2 text-h2">{title}</h2>
      {body ? <p className="mt-1 max-w-md text-[15px] text-dust">{body}</p> : null}
      {action ? <div className="mt-5">{action}</div> : null}
    </div>
  );
}

/** Inline error card "Couldn't load {thing}. Retry." + Sentry event id (§11.5). */
export function ErrorState({
  thing,
  error,
  onRetry,
  className,
}: {
  thing: string;
  error?: unknown;
  onRetry?: () => void;
  className?: string;
}) {
  // Report once per distinct error; adjusting state during render avoids an effect round-trip.
  const [captured, setCaptured] = useState<{ error: unknown; id: string | null }>({
    error: undefined,
    id: null,
  });
  if (captured.error !== error) {
    setCaptured({ error, id: error ? captureError(error, { thing }) : null });
  }
  const eventId = captured.id;
  return (
    <div
      className={cn(
        'flex flex-col items-start gap-3 rounded-card border border-missing/50 bg-chalk p-5 md:flex-row md:items-center md:justify-between',
        className,
      )}
      role="alert"
    >
      <div className="flex items-start gap-3">
        <CircleAlert className="mt-0.5 size-6 shrink-0 stroke-2 text-missing" aria-hidden="true" />
        <div>
          <p className="font-semibold">{copy.states.error(thing)}</p>
          {error ? <p className="text-caption text-dust">{errorMessage(error)}</p> : null}
          {eventId ? (
            <p className="font-mono text-[12px] text-dust">{copy.states.errorId(eventId)}</p>
          ) : null}
        </div>
      </div>
      {onRetry ? (
        <Button variant="ghost" size="dense" onClick={onRetry}>
          <RefreshCw aria-hidden="true" />
          {copy.states.retry}
        </Button>
      ) : null}
    </div>
  );
}

/** "You don't have access to {page}. Ask an admin." */
export function NoAccessState({
  page,
  homeHref = '/',
  homeLabel = copy.states.goHome,
}: {
  page: string;
  homeHref?: string;
  homeLabel?: string;
}) {
  return (
    <div className="mx-auto max-w-lg py-12">
      <EmptyState
        icon={Lock}
        title={copy.states.noAccessTitle}
        body={copy.states.noAccess(page)}
        action={
          <Button variant="secondary" asChild>
            <Link to={homeHref}>{homeLabel}</Link>
          </Button>
        }
      />
    </div>
  );
}

/** Top banner "You're offline — changes will retry." (hidden while online). */
export function OfflineBanner() {
  const [online, setOnline] = useState(() =>
    typeof navigator === 'undefined' ? true : navigator.onLine,
  );
  useEffect(() => {
    const up = () => setOnline(true);
    const down = () => setOnline(false);
    window.addEventListener('online', up);
    window.addEventListener('offline', down);
    return () => {
      window.removeEventListener('online', up);
      window.removeEventListener('offline', down);
    };
  }, []);
  if (online) return null;
  return (
    <div
      role="status"
      className="flex items-center justify-center gap-2 bg-asphalt px-4 py-2 text-caption font-medium text-chalk"
    >
      <WifiOff className="size-4" aria-hidden="true" />
      {copy.shell.offline}
    </div>
  );
}

/** Review reasons banner (needs_review) with resolve actions supplied by the page. */
export function ReviewReasonsBanner({
  reasons,
  actions,
  className,
}: {
  reasons: Array<{ key: string; text: string; action?: ReactNode }>;
  actions?: ReactNode;
  className?: string;
}) {
  if (!reasons.length) return null;
  return (
    <div
      className={cn('rounded-card border border-level/40 bg-chip-review-bg/40 p-4', className)}
      role="region"
      aria-label={copy.states.reviewReasons.title(reasons.length)}
    >
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          <CircleAlert className="mt-0.5 size-5 shrink-0 text-level" aria-hidden="true" />
          <div>
            <p className="font-semibold text-chip-review-fg">
              {copy.states.reviewReasons.title(reasons.length)}
            </p>
            <ul className="mt-1 space-y-1 text-[15px]">
              {reasons.map((r) => (
                <li key={r.key} className="flex flex-wrap items-center gap-2">
                  <span>{r.text}</span>
                  {r.action}
                </li>
              ))}
            </ul>
          </div>
        </div>
        {actions}
      </div>
    </div>
  );
}
