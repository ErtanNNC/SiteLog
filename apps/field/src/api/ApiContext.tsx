import type { ReactNode } from 'react';
import type { FieldRoutes } from './field';
import { ApiContext } from './context';

/** The field-api routes the screens call; tests hand in a fake. */
export function ApiProvider({ routes, children }: { routes: FieldRoutes; children: ReactNode }) {
  return <ApiContext.Provider value={routes}>{children}</ApiContext.Provider>;
}
