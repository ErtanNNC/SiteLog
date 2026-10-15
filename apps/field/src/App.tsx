import { BrowserRouter } from 'react-router';
import { ApiProvider } from './api/ApiContext';
import { fieldRoutes } from './api/field';
import { ErrorBoundary } from './components/ErrorBoundary';
import { QueueProvider } from './queue/QueueContext';
import { FieldRoutes } from './routes';
import { SessionProvider } from './session/SessionContext';

/**
 * The field web recorder (spec §9.3): the routes inside an error boundary, with the resolved link
 * (session), field-api and the upload queue for every screen; language from `src/i18n`.
 */
export function App() {
  return (
    <ErrorBoundary>
      <SessionProvider>
        <ApiProvider routes={fieldRoutes}>
          <QueueProvider routes={fieldRoutes}>
            <BrowserRouter>
              <FieldRoutes />
            </BrowserRouter>
          </QueueProvider>
        </ApiProvider>
      </SessionProvider>
    </ErrorBoundary>
  );
}
