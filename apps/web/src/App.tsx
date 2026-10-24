import { QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { BrowserRouter, MemoryRouter } from 'react-router';
import { AppErrorBoundary } from './app/AppErrorBoundary';
import { AuthProvider } from './auth/AuthProvider';
import { TooltipProvider } from './components/ui/Tooltip';
import { Toaster } from './components/ui/Toaster';
import { DataProvider } from './data/DataProvider';
import { queryClient } from './lib/query';
import { AppRoutes } from './app/routes';

/**
 * The hosted demo (`VITE_ROUTER=memory`, scripts/build-artifact.mjs) runs inside a frame that has no
 * server-side fallback for deep links, so routes live in memory there; everywhere else they are URLs.
 */
function Router({ children }: { children: ReactNode }) {
  if (import.meta.env.VITE_ROUTER === 'memory') return <MemoryRouter>{children}</MemoryRouter>;
  return <BrowserRouter>{children}</BrowserRouter>;
}

/** The panel: providers inside the error boundary (§11.5), the language from `src/i18n`. */
export function App() {
  return (
    <AppErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <Router>
          <AuthProvider>
            <DataProvider>
              <TooltipProvider delayDuration={200}>
                <AppRoutes />
                <Toaster />
              </TooltipProvider>
            </DataProvider>
          </AuthProvider>
        </Router>
      </QueryClientProvider>
    </AppErrorBoundary>
  );
}
