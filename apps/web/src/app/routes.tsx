/**
 * §11.1 route map. Pages live in src/app/<name>/Page.tsx and are lazy-loaded, so a page can be
 * swapped by replacing its file. Guards: RequireAuth (session + org) and RequireRole (§2.2).
 *
 * D9: the shell, sign-in, `/auth/callback`, the Overview (W1-16), Sites and Site detail (W1-18),
 * the Reports archive and Report review (W1-17), Crew hours (W3-06), Weather & delays (W3-07), the
 * Site glossary (W3-08), Team & numbers (W4-03), Billing (W4-10), the not-found page and the
 * placeholders speak the panel's language (EN/TR).
 * A page wrapped in `<EnglishOnly>` still reads `copy/en.ts` directly and renders in English inside
 * the translated shell; it loses the wrapper when it gets its Turkish.
 */
import { lazy, Suspense, type ComponentType, type ReactNode } from 'react';
import { Navigate, Route, Routes } from 'react-router';
import { useAuth } from '@/auth/AuthProvider';
import { RequireAuth, RequireRole, ROUTE_ROLES, type RouteKey } from '@/auth/guards';
import { AppShell } from '@/components/shell/AppShell';
import { PageSkeleton } from '@/components/sitelog/Skeletons';
import { EnglishOnly } from '@/i18n/EnglishOnly';

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
const DevPhonePage = page(() => import('./dev-phone/Page'));
const OpsPage = page(() => import('./ops/Page'));
const TryPage = page(() => import('./try/Page'));
const NotFoundPage = page(() => import('./not-found/Page'));

/** The role guard of a shell page; its "No access" state names the page by its nav label. */
function guard(key: Exclude<RouteKey, 'setup'>, node: ReactNode) {
  return (
    <RequireRole roles={ROUTE_ROLES[key]} page={`nav.${key}`}>
      {node}
    </RequireRole>
  );
}

/** `/` — accounts users land on /hours (§11.1). The Overview speaks EN and TR (W1-16). */
function Home() {
  const { role } = useAuth();
  if (role === 'accounts') return <Navigate to="/hours" replace />;
  return guard('overview', <OverviewPage />);
}

export function AppRoutes() {
  return (
    <Suspense fallback={<PageSkeleton fullscreen />}>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/auth/callback" element={<AuthCallbackPage />} />
        <Route element={<RequireAuth />}>
          <Route
            path="/setup"
            element={
              <EnglishOnly>
                <SetupPage />
              </EnglishOnly>
            }
          />
          <Route
            path="/setup/:step"
            element={
              <EnglishOnly>
                <SetupPage />
              </EnglishOnly>
            }
          />
          <Route element={<AppShell />}>
            <Route index element={<Home />} />
            <Route path="/sites" element={guard('sites', <SitesPage />)} />
            <Route path="/sites/:siteId" element={guard('sites', <SiteDetailPage />)} />
            <Route path="/reports" element={guard('reports', <ReportsPage />)} />
            <Route
              path="/reports/new"
              element={guard(
                'reports',
                <EnglishOnly>
                  <NewReportPage />
                </EnglishOnly>,
              )}
            />
            <Route path="/reports/:reportId" element={guard('reports', <ReportDetailPage />)} />
            <Route path="/hours" element={guard('hours', <HoursPage />)} />
            <Route path="/weather" element={guard('weather', <WeatherPage />)} />
            <Route
              path="/try"
              element={guard(
                'try',
                <EnglishOnly>
                  <TryPage />
                </EnglishOnly>,
              )}
            />
            <Route path="/team" element={guard('team', <TeamPage />)} />
            <Route path="/glossary" element={guard('glossary', <GlossaryPage />)} />
            <Route path="/settings" element={<Navigate to="/settings/reports" replace />} />
            {/* `/settings/channels` (§11.1) is the Field channels tab, a placeholder until W1-08. */}
            <Route
              path="/settings/:section"
              element={guard(
                'settings',
                <EnglishOnly>
                  <SettingsPage />
                </EnglishOnly>,
              )}
            />
            <Route path="/billing" element={guard('billing', <BillingPage />)} />
            <Route path="/dev/phone" element={guard('devPhone', <DevPhonePage />)} />
            {/* SiteLog staff only (platform_admins), not an org role and not in the sidebar. */}
            <Route
              path="/ops"
              element={
                <EnglishOnly>
                  <OpsPage />
                </EnglishOnly>
              }
            />
            <Route path="*" element={<NotFoundPage />} />
          </Route>
        </Route>
      </Routes>
    </Suspense>
  );
}
