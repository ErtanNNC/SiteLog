/**
 * Session + org memberships + current org (persisted) + role.
 * Supabase: magic link (signInWithOtp) and onAuthStateChange. Demo: any email signs in as a
 * §18 user (default Lena Ortiz, admin); `/login?as=pm|ops|accounts` picks another demo user.
 */
import type { Session } from '@supabase/supabase-js';
import type { MemberRole } from '@sitelog/shared/enums.ts';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { DemoSource } from '@/data/demo/DemoSource';
import { demoUserFor, getDemoStore, resetDemoStore, type DemoLoginKey } from '@/data/demo/store';
import { fetchOrgs } from '@/data/supabase/SupabaseSource';
import type { OrgSummary } from '@/data/types';
import { env, isDemo } from '@/lib/env';
import { setSentryUser } from '@/lib/sentry';
import { supabase } from '@/lib/supabase';
import { storage } from '@/lib/utils';

export const CURRENT_ORG_KEY = 'sitelog.currentOrg';
export const DEMO_SESSION_KEY = 'sitelog.demo.session';

export interface AuthUser {
  id: string;
  email: string | null;
  name: string;
  title: string | null;
}

export type AuthStatus = 'loading' | 'signed_out' | 'signed_in';

export interface AuthState {
  status: AuthStatus;
  user: AuthUser | null;
  orgs: OrgSummary[];
  currentOrg: OrgSummary | null;
  role: MemberRole | null;
  isDemo: boolean;
  /** Demo only: which §18 user is signed in. */
  demoKey: DemoLoginKey | null;
  setCurrentOrg: (orgId: string) => void;
  signInWithEmail: (email: string, opts?: { as?: string | null }) => Promise<void>;
  signOut: () => Promise<void>;
  refreshOrgs: () => Promise<OrgSummary[]>;
  accessToken: () => Promise<string | null>;
}

const AuthContext = createContext<AuthState | null>(null);

function pickOrg(orgs: OrgSummary[]): OrgSummary | null {
  if (!orgs.length) return null;
  const saved = storage.get<string | null>(CURRENT_ORG_KEY, null);
  return orgs.find((o) => o.id === saved) ?? orgs[0]!;
}

function userFromSession(session: Session): AuthUser {
  const meta = (session.user.user_metadata ?? {}) as Record<string, unknown>;
  const email = session.user.email ?? null;
  const name =
    (typeof meta.full_name === 'string' && meta.full_name) ||
    (typeof meta.name === 'string' && meta.name) ||
    (email ? email.split('@')[0]! : 'User');
  return {
    id: session.user.id,
    email,
    name,
    title: typeof meta.title === 'string' ? meta.title : null,
  };
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>('loading');
  const [user, setUser] = useState<AuthUser | null>(null);
  const [orgs, setOrgs] = useState<OrgSummary[]>([]);
  const [currentOrg, setCurrentOrgState] = useState<OrgSummary | null>(null);
  const [demoKey, setDemoKey] = useState<DemoLoginKey | null>(null);
  const sessionRef = useRef<Session | null>(null);

  const loadOrgsFor = useCallback(
    async (u: AuthUser, key: DemoLoginKey | null): Promise<OrgSummary[]> => {
      if (isDemo) {
        const demoUser = demoUserFor(key);
        const source = new DemoSource(getDemoStore(), {
          id: demoUser.id,
          email: demoUser.email,
          name: demoUser.name,
          role: demoUser.role,
        });
        return source.getOrgs();
      }
      if (!supabase) return [];
      return fetchOrgs(supabase, u.id);
    },
    [],
  );

  const applySignedIn = useCallback(
    async (u: AuthUser, key: DemoLoginKey | null) => {
      const list = await loadOrgsFor(u, key);
      setUser(u);
      setDemoKey(key);
      setOrgs(list);
      setCurrentOrgState(pickOrg(list));
      setStatus('signed_in');
      setSentryUser({ id: u.id, email: u.email });
    },
    [loadOrgsFor],
  );

  const applySignedOut = useCallback(() => {
    sessionRef.current = null;
    setUser(null);
    setOrgs([]);
    setCurrentOrgState(null);
    setDemoKey(null);
    setStatus('signed_out');
    setSentryUser(null);
  }, []);

  // Boot: restore the session.
  useEffect(() => {
    let cancelled = false;
    if (isDemo) {
      const saved = storage.get<{ key: DemoLoginKey } | null>(DEMO_SESSION_KEY, null);
      // Deferred so the provider never sets state synchronously inside the effect body.
      queueMicrotask(() => {
        if (cancelled) return;
        if (saved?.key) {
          const du = demoUserFor(saved.key);
          void applySignedIn(
            { id: du.id, email: du.email, name: du.name, title: du.title },
            saved.key,
          );
        } else {
          applySignedOut();
        }
      });
      return () => {
        cancelled = true;
      };
    }
    if (!supabase) {
      queueMicrotask(() => {
        if (!cancelled) applySignedOut();
      });
      return () => {
        cancelled = true;
      };
    }
    const sb = supabase;
    void sb.auth.getSession().then(({ data }) => {
      if (cancelled) return;
      if (data.session) {
        sessionRef.current = data.session;
        void applySignedIn(userFromSession(data.session), null);
      } else {
        applySignedOut();
      }
    });
    const { data: sub } = sb.auth.onAuthStateChange((event, session) => {
      if (cancelled) return;
      if (event === 'SIGNED_OUT' || !session) {
        applySignedOut();
        return;
      }
      const changed = sessionRef.current?.user.id !== session.user.id;
      sessionRef.current = session;
      if (changed || event === 'SIGNED_IN') void applySignedIn(userFromSession(session), null);
    });
    return () => {
      cancelled = true;
      sub.subscription.unsubscribe();
    };
  }, [applySignedIn, applySignedOut]);

  const setCurrentOrg = useCallback(
    (orgId: string) => {
      const org = orgs.find((o) => o.id === orgId);
      if (!org) return;
      storage.set(CURRENT_ORG_KEY, orgId);
      setCurrentOrgState(org);
    },
    [orgs],
  );

  const signInWithEmail = useCallback(
    async (email: string, opts?: { as?: string | null }) => {
      if (isDemo) {
        const key = (
          ['admin', 'pm', 'ops', 'accounts'].includes(opts?.as ?? '') ? opts!.as : 'admin'
        ) as DemoLoginKey;
        storage.set(DEMO_SESSION_KEY, { key });
        const du = demoUserFor(key);
        await applySignedIn(
          { id: du.id, email: email || du.email, name: du.name, title: du.title },
          key,
        );
        return;
      }
      if (!supabase) throw new Error('Supabase is not configured');
      const { error } = await supabase.auth.signInWithOtp({
        email,
        options: { emailRedirectTo: `${env.appUrl}/auth/callback` },
      });
      if (error) throw new Error(error.message);
    },
    [applySignedIn],
  );

  const signOut = useCallback(async () => {
    if (isDemo) {
      storage.remove(DEMO_SESSION_KEY);
      resetDemoStore();
      applySignedOut();
      return;
    }
    await supabase?.auth.signOut();
    applySignedOut();
  }, [applySignedOut]);

  const refreshOrgs = useCallback(async () => {
    if (!user) return [];
    const list = await loadOrgsFor(user, demoKey);
    setOrgs(list);
    setCurrentOrgState((cur) => list.find((o) => o.id === cur?.id) ?? pickOrg(list));
    return list;
  }, [user, demoKey, loadOrgsFor]);

  const accessToken = useCallback(async () => {
    if (isDemo) return 'demo-token';
    if (!supabase) return null;
    const { data } = await supabase.auth.getSession();
    return data.session?.access_token ?? null;
  }, []);

  const value = useMemo<AuthState>(
    () => ({
      status,
      user,
      orgs,
      currentOrg,
      role: currentOrg?.role ?? null,
      isDemo,
      demoKey,
      setCurrentOrg,
      signInWithEmail,
      signOut,
      refreshOrgs,
      accessToken,
    }),
    [
      status,
      user,
      orgs,
      currentOrg,
      demoKey,
      setCurrentOrg,
      signInWithEmail,
      signOut,
      refreshOrgs,
      accessToken,
    ],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}

/** For tests and storybook-like harnesses: provide a ready-made auth state. */
export const AuthContextForTests = AuthContext;
