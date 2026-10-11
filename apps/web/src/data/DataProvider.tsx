/**
 * Chooses the DataSource (demo vs Supabase) for the signed-in user and current org, and wires
 * realtime changes into TanStack Query invalidation.
 */
import { useQueryClient } from '@tanstack/react-query';
import { createContext, useContext, useEffect, useMemo, type ReactNode } from 'react';
import { useAuth } from '@/auth/AuthProvider';
import { isDemo } from '@/lib/env';
import { supabase } from '@/lib/supabase';
import { DemoSource } from './demo/DemoSource';
import { demoUserFor, getDemoStore } from './demo/store';
import type { DataSource } from './source';
import { SupabaseSource } from './supabase/SupabaseSource';

const DataContext = createContext<DataSource | null>(null);

export function DataProvider({
  children,
  source: override,
}: {
  children: ReactNode;
  source?: DataSource | null;
}) {
  const { user, currentOrg, role, demoKey, accessToken } = useAuth();
  const queryClient = useQueryClient();

  const source = useMemo<DataSource | null>(() => {
    if (override !== undefined) return override;
    if (!user || !currentOrg || !role) return null;
    if (isDemo) {
      const du = demoUserFor(demoKey);
      return new DemoSource(
        getDemoStore(),
        { id: du.id, email: user.email ?? du.email, name: du.name, role: du.role },
        { latencyMs: 120 },
      );
    }
    if (!supabase) return null;
    return new SupabaseSource(
      supabase,
      currentOrg.id,
      { id: user.id, email: user.email, name: user.name, role },
      accessToken,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [override, user?.id, user?.email, currentOrg?.id, role, demoKey, accessToken]);

  useEffect(() => {
    if (!source) return;
    const orgId = source.orgId;
    return source.subscribe(() => {
      void queryClient.invalidateQueries({ queryKey: [orgId] });
    });
  }, [source, queryClient]);

  return <DataContext.Provider value={source}>{children}</DataContext.Provider>;
}

export function useDataSource(): DataSource {
  const src = useContext(DataContext);
  if (!src) throw new Error('No DataSource: useDataSource() needs a signed-in user with an org');
  return src;
}

export function useOptionalDataSource(): DataSource | null {
  return useContext(DataContext);
}
