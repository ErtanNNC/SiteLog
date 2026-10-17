import { lazy, Suspense } from 'react';
import { Navigate, Route, Routes } from 'react-router';
import { Expired } from '@/screens/expired/Expired';
import { History } from '@/screens/history/History';
import { HistoryReport } from '@/screens/history/HistoryReport';
import { Legal } from '@/screens/legal/Legal';
import { LinkScreen } from '@/screens/link/LinkScreen';
import { Photos } from '@/screens/photos/Photos';
import { ReportScreen } from '@/screens/report/ReportScreen';
import { Record } from '@/screens/record/Record';
import { Settings } from '@/screens/settings/Settings';
import { Today } from '@/screens/today/Today';
import { NotFound } from './NotFound';
import { RouteLoading } from './RouteLoading';
import { HOME_PATH } from './paths';

/**
 * Talk now's call screen (W3-13) is its own chunk, and the voice client it loads (`livekit-client`)
 * another: neither is in the main bundle (§16.2 M12).
 */
const Talk = lazy(() => import('@/screens/talk/Talk').then((m) => ({ default: m.Talk })));

/** The §9.3 route map. `/` (the manifest's start_url) opens Today. */
export function FieldRoutes() {
  return (
    <Routes>
      <Route path="/" element={<Navigate to={HOME_PATH} replace />} />
      <Route path="/r/:code" element={<LinkScreen />} />
      <Route path="/r/:code/report/:id" element={<LinkScreen />} />
      <Route path="/r/:code/history" element={<LinkScreen to="history" />} />
      <Route path="/r/:code/history/:id" element={<LinkScreen to="history" />} />
      <Route path="/today" element={<Today />} />
      <Route path="/record" element={<Record />} />
      <Route
        path="/talk"
        element={
          <Suspense fallback={<RouteLoading />}>
            <Talk />
          </Suspense>
        }
      />
      <Route path="/photos" element={<Photos />} />
      <Route path="/report/:id" element={<ReportScreen />} />
      <Route path="/history" element={<History />} />
      <Route path="/history/:id" element={<HistoryReport />} />
      <Route path="/settings" element={<Settings />} />
      <Route path="/expired" element={<Expired />} />
      <Route path="/legal/:key" element={<Legal />} />
      <Route path="*" element={<NotFound />} />
    </Routes>
  );
}
