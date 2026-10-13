import { BrowserRouter } from 'react-router';
import { ErrorBoundary } from './components/ErrorBoundary';
import { FieldRoutes } from './routes';

/** The field web recorder (spec §9.3): the routes inside an error boundary; language from `src/i18n`. */
export function App() {
  return (
    <ErrorBoundary>
      <BrowserRouter>
        <FieldRoutes />
      </BrowserRouter>
    </ErrorBoundary>
  );
}
