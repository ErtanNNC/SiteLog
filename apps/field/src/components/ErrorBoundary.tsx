import { Component, type ErrorInfo, type ReactNode } from 'react';
import { CrashScreen } from './CrashScreen';

/**
 * Catches a render error anywhere in the app so the phone shows a way back instead of a blank
 * page. Reporting to Sentry joins with the screens that can fail (W1-09).
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[field] render error', error, info.componentStack);
  }

  override render() {
    return this.state.failed ? <CrashScreen /> : this.props.children;
  }
}
