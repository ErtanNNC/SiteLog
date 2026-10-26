import { CircleAlert, LogOut, RefreshCw } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { useCopy } from '@/i18n/useCopy';

/**
 * The error boundary's page (`AppErrorBoundary`): token-styled, in the panel's language, with the
 * Sentry event id when the error was reported.
 */
export function AppErrorFallback({
  eventId,
  onRetry,
  onSignOut,
}: {
  eventId: string | null;
  onRetry: () => void;
  onSignOut: () => Promise<void> | void;
}) {
  const { t } = useCopy();
  const [signingOut, setSigningOut] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  // The page was replaced under the reader: move focus to the explanation.
  useEffect(() => heading.current?.focus(), []);
  const signOut = () => {
    setSigningOut(true);
    void Promise.resolve()
      .then(onSignOut)
      .finally(() => setSigningOut(false));
  };
  return (
    <main
      className="flex min-h-screen items-center justify-center bg-concrete px-4 py-12"
      data-testid="app-error"
    >
      <div className="w-full max-w-lg rounded-card border border-rebar bg-chalk p-6 sm:p-8">
        <CircleAlert className="size-6 stroke-2 text-missing" aria-hidden="true" />
        <h1
          ref={heading}
          tabIndex={-1}
          className="mt-3 font-display text-[26px] leading-8 outline-none"
        >
          {t('errorBoundary.title')}
        </h1>
        <p className="mt-2 text-[15px] text-dust">{t('errorBoundary.body')}</p>
        {eventId ? (
          <p className="mt-3 text-caption text-dust">
            {t('errorBoundary.reported')}{' '}
            <span className="font-mono text-[12px]">
              {t('errorBoundary.errorId', { id: eventId })}
            </span>
          </p>
        ) : null}
        <div className="mt-6 flex flex-wrap gap-3">
          <Button variant="primary" onClick={onRetry}>
            <RefreshCw aria-hidden="true" />
            {t('errorBoundary.retry')}
          </Button>
          <Button variant="ghost" onClick={signOut} loading={signingOut}>
            <LogOut aria-hidden="true" />
            {t('errorBoundary.signOut')}
          </Button>
        </div>
      </div>
    </main>
  );
}
