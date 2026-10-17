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
import { demoUserFor, getDemoStore, type DemoLoginKey } from '@/data/demo/store';
import { fetchOrgs } from '@/data/supabase/SupabaseSource';
import type { OrgSummary } from '@/data/types';
import { applyOrgLanguage, memberDefaultLocale } from '@/i18n/useCopy';
import { env, isDemo } from '@/lib/env';
import { setSentryUser } from '@/lib/sentry';
import { supabase } from '@/lib/supabase';
import { storage } from '@/lib/utils';
import { clearSession, DEMO_SESSION_KEY } from './session';

export const CURRENT_ORG_KEY = 'sitelog.currentOrg';

export interface AuthUser {
  id: string;
  email: string | null;
  name: string;
  title: string | null;
}

/** `error`: signed in, but the org memberships could not be loaded (see `error`, `refreshOrgs`). */
export type AuthStatus = 'loading' | 'signed_out' | 'signed_in' | 'error';

export interface AuthState {
  status: AuthStatus;
  /** Why the org memberships failed to load while `status` is `error`; null otherwise. */
  error: unknown;
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

/**
 * Links minted by the admin API (`inviteUserByEmail`, `generateLink`) cannot carry a PKCE
 * challenge, so GoTrue redirects them to /auth/callback with implicit-grant tokens in the URL
 * hash, which a `flowType: 'pkce'` client refuses ("Not a valid PKCE flow url"). Adopt that
 * session explicitly and strip the tokens from the address bar.
 */
async function adoptImplicitGrantSession(sb: NonNullable<typeof supabase>): Promise<void> {
  if (typeof window === 'undefined' || !window.location.hash) return;
  const hash = new URLSearchParams(window.location.hash.replace(/^#/, ''));
  const accessToken = hash.get('access_token');
  const refreshToken = hash.get('refresh_token');
  if (!accessToken || !refreshToken) return;
  window.history.replaceState(
    window.history.state,
    '',
    `${window.location.pathname}${window.location.search}`,
  );
  const { error } = await sb.auth.setSession({
    access_token: accessToken,
    refresh_token: refreshToken,
  });
  if (error) console.warn('[auth] could not adopt the session from the link', error.message);
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
  const [error, setError] = useState<unknown>(null);
  const [user, setUser] = useState<AuthUser | null>(null);
  const [orgs, setOrgs] = useState<OrgSummary[]>([]);
  const [currentOrg, setCurrentOrgState] = useState<OrgSummary | null>(null);
  const [demoKey, setDemoKey] = useState<DemoLoginKey | null>(null);
  const sessionRef = useRef<Session | null>(null);
  /** The user whose org memberships are loaded and shown (null while none are). */
  const loadedUserRef = useRef<string | null>(null);

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

  /**
   * Never rejects: a failed org load (network, PostgREST) ends in `error` with the user kept, so
   * the guard can offer Retry and Sign out instead of a skeleton that never ends. Treating it as
   * "no orgs" would send an existing customer to the wizard to create a second company.
   *
   * A reload for the user already signed in (auth-js re-emits SIGNED_IN when the tab regains
   * focus) that fails keeps the loaded state: going to `error` would unmount the page and lose
   * an unsaved form over a brief network blip.
   */
  const applySignedIn = useCallback(
    async (u: AuthUser, key: DemoLoginKey | null) => {
      let list: OrgSummary[] | null = null;
      let failure: unknown = null;
      try {
        list = await loadOrgsFor(u, key);
      } catch (err) {
        failure = err ?? new Error('Could not load your companies');
      }
      if (!list && loadedUserRef.current === u.id) {
        console.warn('[auth] could not reload your companies; keeping the loaded ones', failure);
        return;
      }
      loadedUserRef.current = list ? u.id : null;
      const current = list ? pickOrg(list) : null;
      // The org's locale is the default language: apply it before `signed_in` mounts the shell.
      applyOrgLanguage(memberDefaultLocale(current));
      setUser(u);
      setDemoKey(key);
      setOrgs(list ?? []);
      setCurrentOrgState(current);
      setError(failure);
      setStatus(list ? 'signed_in' : 'error');
      setSentryUser({ id: u.id, email: u.email });
    },
    [loadOrgsFor],
  );

  const applySignedOut = useCallback(() => {
    sessionRef.current = null;
    loadedUserRef.current = null;
    setError(null);
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
    void adoptImplicitGrantSession(sb)
      .then(() => sb.auth.getSession())
      .then(({ data }) => {
        if (cancelled) return;
        if (data.session) {
          sessionRef.current = data.session;
          void applySignedIn(userFromSession(data.session), null);
        } else {
          applySignedOut();
        }
      })
      // A failed session restore (network) must not leave the app on its loading skeleton.
      .catch(() => {
        if (!cancelled) applySignedOut();
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
      // The AuthError itself: the sign-in page reads its `status` (429: too many emails).
      if (error) throw error;
    },
    [applySignedIn],
  );

  const signOut = useCallback(async () => {
    await clearSession();
    applySignedOut();
  }, [applySignedOut]);

  /** Rejects on failure; after a failed sign-in load (`error`) a success completes the sign-in. */
  const refreshOrgs = useCallback(async () => {
    if (!user) return [];
    let list: OrgSummary[];
    try {
      list = await loadOrgsFor(user, demoKey);
    } catch (err) {
      setError((prev: unknown) => (prev ? err : prev));
      throw err;
    }
    // Completing a failed sign-in load (no org was current): the shell mounts next, so its
    // language is set first. Once loaded, `AppShell` follows the current org's locale.
    if (loadedUserRef.current !== user.id) applyOrgLanguage(memberDefaultLocale(pickOrg(list)));
    loadedUserRef.current = user.id;
    setOrgs(list);
    setCurrentOrgState((cur) => list.find((o) => o.id === cur?.id) ?? pickOrg(list));
    setError(null);
    setStatus((s) => (s === 'error' ? 'signed_in' : s));
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
      error,
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
      error,
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
