import type { MemberRole } from '@sitelog/shared/enums.ts';
import type { ReactNode } from 'react';
import { Navigate, Outlet, useLocation } from 'react-router';
import { copy } from '@/copy/en';
import { NoAccessState } from '@/components/sitelog/States';
import { PageSkeleton } from '@/components/sitelog/Skeletons';
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
  if (status === 'signed_out') {
    return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  }
  if (orgs.length === 0 && !location.pathname.startsWith('/setup')) {
    return <Navigate to="/setup" replace />;
  }
  return children ? <>{children}</> : <Outlet />;
}

export const ROUTE_ROLES: Record<string, MemberRole[]> = {
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
  setup: ['admin'],
};

export function canAccess(role: MemberRole | null, roles: readonly MemberRole[]): boolean {
  return !!role && roles.includes(role);
}

/** Renders the "No access" state (§11.5) when the current role is not allowed. */
export function RequireRole({
  roles,
  page,
  children,
}: {
  roles: readonly MemberRole[];
  page: string;
  children: ReactNode;
}) {
  const { role } = useAuth();
  if (!canAccess(role, roles)) {
    return (
      <NoAccessState
        page={page}
        homeHref={homeFor(role)}
        homeLabel={role === 'accounts' ? copy.states.goToHours : copy.states.goHome}
      />
    );
  }
  return <>{children}</>;
}
