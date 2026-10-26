import type { MemberRole } from '@sitelog/shared/enums.ts';
import { LogOut } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Navigate, Outlet, useLocation, useNavigate } from 'react-router';
import type { NavLabelKey } from '@/components/shell/nav';
import { ErrorState, NoAccessState } from '@/components/sitelog/States';
import { PageSkeleton } from '@/components/sitelog/Skeletons';
import { Button } from '@/components/ui/Button';
import { useCopy } from '@/i18n/useCopy';
import { useAuth } from './AuthProvider';

/** Where a role lands after sign-in (§11.1: accounts users land on /hours). */
export function homeFor(role: MemberRole | null): string {
  return role === 'accounts' ? '/hours' : '/';
}

/** Signed-in users only; users without an org go to the setup wizard. */
export function RequireAuth({ children }: { children?: ReactNode }) {
  const { status, orgs } = useAuth();
  const location = useLocation();
  if (status === 'loading') return <PageSkeleton fullscreen />;
  if (status === 'error') return <AuthErrorScreen />;
  if (status === 'signed_out') {
    return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  }
  if (orgs.length === 0 && !location.pathname.startsWith('/setup')) {
    return <Navigate to="/setup" replace />;
  }
  return children ? <>{children}</> : <Outlet />;
}

/** Signed in, but the org memberships did not load: Retry, or sign out (§11.5 error state). */
function AuthErrorScreen() {
  const { error, refreshOrgs, signOut } = useAuth();
  const { t } = useCopy();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const retry = async () => {
    setBusy(true);
    // A new failure replaces the shown error; success flips the status to signed_in.
    await refreshOrgs().catch(() => undefined);
    setBusy(false);
  };
  return (
    <div className="flex min-h-screen items-center justify-center bg-concrete p-4">
      <div className="grid w-full max-w-lg gap-3">
        <ErrorState
          thing={t('login.accountThing')}
          error={error}
          onRetry={busy ? undefined : () => void retry()}
        />
        <div className="flex justify-end">
          <Button
            variant="ghost"
            size="dense"
            onClick={() => {
              void signOut()
                .catch(() => undefined)
                .then(() => navigate('/login', { replace: true }));
            }}
          >
            <LogOut aria-hidden="true" />
            {t('login.signOut')}
          </Button>
        </div>
      </div>
    </div>
  );
}

/** §2.2 / §11.1 roles per route. */
export const ROUTE_ROLES = {
  overview: ['admin', 'pm', 'ops'],
  sites: ['admin', 'pm', 'ops'],
  reports: ['admin', 'pm', 'ops'],
  hours: ['admin', 'pm', 'ops', 'accounts'],
  weather: ['admin', 'pm', 'ops'],
  try: ['admin', 'pm', 'ops'],
  team: ['admin', 'ops'],
  glossary: ['admin', 'pm', 'ops'],
  settings: ['admin'],
  billing: ['admin'],
  devPhone: ['admin'],
  setup: ['admin'],
} as const satisfies Record<string, readonly MemberRole[]>;

export type RouteKey = keyof typeof ROUTE_ROLES;

export function canAccess(role: MemberRole | null, roles: readonly MemberRole[]): boolean {
  return !!role && roles.includes(role);
}

/**
 * Renders the "No access" state (§11.5) when the current role is not allowed. It belongs to the
 * shell, so it speaks the panel's language; `page` is the page's nav label key.
 */
export function RequireRole({
  roles,
  page,
  children,
}: {
  roles: readonly MemberRole[];
  page: NavLabelKey | 'setup.pageName';
  children: ReactNode;
}) {
  const { role } = useAuth();
  const { t } = useCopy();
  if (!canAccess(role, roles)) {
    return (
      <NoAccessState
        page={t(page)}
        homeHref={homeFor(role)}
        homeLabel={role === 'accounts' ? t('states.goToHours') : t('states.goHome')}
      />
    );
  }
  return <>{children}</>;
}
