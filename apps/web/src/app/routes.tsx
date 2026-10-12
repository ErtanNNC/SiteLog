/**
 * §11.1 route map. Pages live in src/app/<name>/Page.tsx and are lazy-loaded, so a page can be
 * swapped by replacing its file. Guards: RequireAuth (session + org) and RequireRole (§2.2).
 */
import { lazy, Suspense, type ComponentType, type ReactNode } from 'react';
import { Navigate, Route, Routes } from 'react-router';
import { useAuth } from '@/auth/AuthProvider';
import { RequireAuth, RequireRole, ROUTE_ROLES } from '@/auth/guards';
import { AppShell } from '@/components/shell/AppShell';
import { PageSkeleton } from '@/components/sitelog/Skeletons';
import { copy } from '@/copy/en';

const page = (loader: () => Promise<{ default: ComponentType }>) => lazy(loader);

const LoginPage = page(() => import('./login/Page'));
const AuthCallbackPage = page(() => import('./auth/CallbackPage'));
const SetupPage = page(() => import('./setup/Page'));
const OverviewPage = page(() => import('./overview/Page'));
const SitesPage = page(() => import('./sites/Page'));
const SiteDetailPage = page(() => import('./site/Page'));
const ReportsPage = page(() => import('./reports/Page'));
const ReportDetailPage = page(() => import('./report/Page'));
const NewReportPage = page(() => import('./new-report/Page'));
const HoursPage = page(() => import('./hours/Page'));
const WeatherPage = page(() => import('./weather/Page'));
const TeamPage = page(() => import('./team/Page'));
const GlossaryPage = page(() => import('./glossary/Page'));
const SettingsPage = page(() => import('./settings/Page'));
const BillingPage = page(() => import('./billing/Page'));
const OpsPage = page(() => import('./ops/Page'));
const TryPage = page(() => import('./try/Page'));
const NotFoundPage = page(() => import('./not-found/Page'));

function guard(key: keyof typeof ROUTE_ROLES, label: string, node: ReactNode) {
  return (
    <RequireRole roles={ROUTE_ROLES[key]!} page={label}>
      {node}
    </RequireRole>
  );
}

/** `/` — accounts users land on /hours (§11.1). */
function Home() {
  const { role } = useAuth();
  if (role === 'accounts') return <Navigate to="/hours" replace />;
  return guard('overview', copy.nav.overview, <OverviewPage />);
}

export function AppRoutes() {
  return (
    <Suspense fallback={<PageSkeleton fullscreen />}>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/auth/callback" element={<AuthCallbackPage />} />
        <Route element={<RequireAuth />}>
          <Route path="/setup" element={<SetupPage />} />
          <Route path="/setup/:step" element={<SetupPage />} />
          <Route element={<AppShell />}>
            <Route index element={<Home />} />
            <Route path="/sites" element={guard('sites', copy.nav.sites, <SitesPage />)} />
            <Route
              path="/sites/:siteId"
              element={guard('sites', copy.nav.sites, <SiteDetailPage />)}
            />
            <Route path="/reports" element={guard('reports', copy.nav.reports, <ReportsPage />)} />
            <Route
              path="/reports/new"
              element={guard('reports', copy.nav.reports, <NewReportPage />)}
            />
            <Route
              path="/reports/:reportId"
              element={guard('reports', copy.nav.reports, <ReportDetailPage />)}
            />
            <Route path="/hours" element={guard('hours', copy.nav.hours, <HoursPage />)} />
            <Route path="/weather" element={guard('weather', copy.nav.weather, <WeatherPage />)} />
            <Route path="/try" element={guard('try', copy.nav.try, <TryPage />)} />
            <Route path="/team" element={guard('team', copy.nav.team, <TeamPage />)} />
            <Route
              path="/glossary"
              element={guard('glossary', copy.nav.glossary, <GlossaryPage />)}
            />
            <Route path="/settings" element={<Navigate to="/settings/reports" replace />} />
            <Route
              path="/settings/:section"
              element={guard('settings', copy.nav.settings, <SettingsPage />)}
            />
            <Route path="/billing" element={guard('billing', copy.nav.billing, <BillingPage />)} />
            {/* SiteLog staff only (platform_admins), not an org role and not in the sidebar. */}
            <Route path="/ops" element={<OpsPage />} />
            <Route path="*" element={<NotFoundPage />} />
          </Route>
        </Route>
      </Routes>
    </Suspense>
  );
}
