import { Component, type ErrorInfo, type ReactNode } from 'react';
import { clearSession } from '@/auth/session';
import { captureError } from '@/lib/sentry';
import { AppErrorFallback } from './AppErrorFallback';

interface Props {
  children: ReactNode;
  /** Defaults to ending the session and loading `/login` afresh (the providers are gone). */
  onSignOut?: () => Promise<void> | void;
  /** Defaults to reloading the page; Retry uses it when a page's code failed to load. */
  onReload?: () => void;
}

interface State {
  failed: boolean;
  eventId: string | null;
  /** The error was a page chunk that failed to load: only a reload can fetch it again. */
  chunkLoad: boolean;
}

/**
 * A lazy page whose chunk failed to load (a stale hashed chunk after a deploy, a network blip).
 * `React.lazy` keeps the rejected import, so re-rendering throws the same error again.
 * Messages: Chromium, Safari, Firefox; Vite's preload helper.
 */
const CHUNK_LOAD_ERROR =
  /dynamically imported module|Importing a module script failed|error loading dynamically imported module|Unable to preload CSS/i;

function isChunkLoadError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  return CHUNK_LOAD_ERROR.test(message);
}

/** The provider tree is unmounted, so sign-out goes around it and reloads the app on `/login`. */
async function signOutToLogin(): Promise<void> {
  await clearSession().catch(() => undefined);
  if (import.meta.env.VITE_ROUTER === 'memory') window.location.reload();
  else window.location.assign(`${import.meta.env.BASE_URL}login`);
}

/**
 * The boundary around the whole provider tree (`App.tsx`, §11.5): a render error anywhere shows a
 * full-page fallback instead of a blank screen, reports it to Sentry when `VITE_SENTRY_DSN` is set
 * (`captureError` is a no-op otherwise) and offers Retry and Sign out. Retry re-mounts the app, or
 * reloads the page when a page's code failed to load (`isChunkLoadError`).
 */
export class AppErrorBoundary extends Component<Props, State> {
  override state: State = { failed: false, eventId: null, chunkLoad: false };

  static getDerivedStateFromError(error: unknown): Partial<State> {
    return { failed: true, chunkLoad: isChunkLoadError(error) };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    const eventId = captureError(error, {
      boundary: 'app',
      componentStack: info.componentStack ?? null,
    });
    this.setState({ eventId });
  }

  private readonly retry = () => {
    if (this.state.chunkLoad) {
      (this.props.onReload ?? (() => window.location.reload()))();
      return;
    }
    this.setState({ failed: false, eventId: null, chunkLoad: false });
  };

  override render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <AppErrorFallback
        eventId={this.state.eventId}
        onRetry={this.retry}
        onSignOut={this.props.onSignOut ?? signOutToLogin}
      />
    );
  }
}
