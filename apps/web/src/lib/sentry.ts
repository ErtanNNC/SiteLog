import * as Sentry from '@sentry/react';
import { env } from './env';

let enabled = false;

/** Error reporting (§15 observability). No-op without `VITE_SENTRY_DSN`. */
export function initSentry(): void {
  if (!env.sentryDsn || enabled) return;
  Sentry.init({
    dsn: env.sentryDsn,
    environment: env.dev ? 'development' : 'production',
    sendDefaultPii: false,
    tracesSampleRate: 0,
  });
  enabled = true;
}

/** Report an error and return the Sentry event id (shown in the inline error card). */
export function captureError(err: unknown, context?: Record<string, unknown>): string | null {
  if (!enabled) {
    if (env.dev) console.error(err);
    return null;
  }
  return Sentry.captureException(err, context ? { extra: context } : undefined);
}

export function setSentryUser(user: { id: string; email?: string | null } | null): void {
  if (!enabled) return;
  Sentry.setUser(user ? { id: user.id, email: user.email ?? undefined } : null);
}
