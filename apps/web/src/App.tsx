import { QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router';
import { AuthProvider } from './auth/AuthProvider';
import { TooltipProvider } from './components/ui/Tooltip';
import { Toaster } from './components/ui/Toaster';
import { DataProvider } from './data/DataProvider';
import { queryClient } from './lib/query';
import { AppRoutes } from './app/routes';

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <AuthProvider>
          <DataProvider>
            <TooltipProvider delayDuration={200}>
              <AppRoutes />
              <Toaster />
            </TooltipProvider>
          </DataProvider>
        </AuthProvider>
      </BrowserRouter>
    </QueryClientProvider>
  );
}
