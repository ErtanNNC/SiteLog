/* eslint-disable react-refresh/only-export-components */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, type RenderOptions } from '@testing-library/react';
import { useState, type ReactElement, type ReactNode } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { AuthContextForTests, type AuthState } from '@/auth/AuthProvider';
import { TopBarSlotProvider } from '@/components/shell/TopBar';
import { TooltipProvider } from '@/components/ui/Tooltip';
import { DataProvider } from '@/data/DataProvider';
import { DemoSource } from '@/data/demo/DemoSource';
import { DemoStore, demoUserFor, type DemoLoginKey } from '@/data/demo/store';
import type { DataSource } from '@/data/source';
import type { OrgSummary } from '@/data/types';
import { DEMO_SITELOG_NUMBER } from '@sitelog/shared/demo/kestrel.ts';

export interface ProviderOptions {
  as?: DemoLoginKey;
  route?: string;
  /** Path pattern for the rendered element (e.g. "/reports/:reportId"). */
  path?: string;
  store?: DemoStore;
  source?: DataSource | null;
  auth?: Partial<AuthState>;
}

export function makeAuthState(
  as: DemoLoginKey = 'admin',
  overrides: Partial<AuthState> = {},
): AuthState {
  const du = demoUserFor(as);
  const org: OrgSummary = {
    id: 'org',
    name: 'Kestrel Build Group',
    timezone: 'America/Chicago',
    activeSites: 6,
    role: du.role,
    locale: 'en-US',
    country: 'US',
    sitelogNumbers: [DEMO_SITELOG_NUMBER],
  };
  return {
    status: 'signed_in',
    error: null,
    user: { id: du.id, email: du.email, name: du.name, title: du.title },
    orgs: [org],
    currentOrg: org,
    role: du.role,
    isDemo: true,
    demoKey: as,
    setCurrentOrg: () => {},
    signInWithEmail: async () => {},
    signOut: async () => {},
    refreshOrgs: async () => [org],
    accessToken: async () => 'demo-token',
    ...overrides,
  };
}

export function makeSource(as: DemoLoginKey = 'admin', store = new DemoStore()): DemoSource {
  const du = demoUserFor(as);
  return new DemoSource(store, { id: du.id, email: du.email, name: du.name, role: du.role });
}

export function Providers({
  children,
  as = 'admin',
  route = '/',
  path,
  source,
  store,
  auth,
}: ProviderOptions & { children: ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
      }),
  );
  // Pages render week/month/site pickers through the TopBarControls portal; give them a slot.
  const [slot, setSlot] = useState<HTMLDivElement | null>(null);
  const [src] = useState(() => (source === undefined ? makeSource(as, store) : source));
  const authState = makeAuthState(as, {
    ...auth,
    // An explicit `currentOrg: null` is a user without an org (the no-org setup wizard).
    currentOrg:
      auth && 'currentOrg' in auth
        ? (auth.currentOrg ?? null)
        : {
            id: src?.orgId ?? 'org',
            name: 'Kestrel Build Group',
            timezone: 'America/Chicago',
            activeSites: 6,
            role: demoUserFor(as).role,
            locale: 'en-US',
            country: 'US',
            sitelogNumbers: [DEMO_SITELOG_NUMBER],
          },
  });
  return (
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[route]}>
        <AuthContextForTests.Provider value={authState}>
          <DataProvider source={src}>
            <TooltipProvider>
              <TopBarSlotProvider value={slot}>
                <div ref={setSlot} data-testid="topbar-controls" />
                {path ? (
                  <Routes>
                    <Route path={path} element={children} />
                  </Routes>
                ) : (
                  children
                )}
              </TopBarSlotProvider>
            </TooltipProvider>
          </DataProvider>
        </AuthContextForTests.Provider>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

export function renderWithProviders(
  ui: ReactElement,
  opts: ProviderOptions & Omit<RenderOptions, 'wrapper'> = {},
) {
  const { as, route, path, source, store, auth, ...renderOpts } = opts;
  return render(ui, {
    wrapper: ({ children }) => (
      <Providers as={as} route={route} path={path} source={source} store={store} auth={auth}>
        {children}
      </Providers>
    ),
    ...renderOpts,
  });
}
