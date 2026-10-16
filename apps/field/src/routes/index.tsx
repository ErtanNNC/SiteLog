import { Navigate, Route, Routes } from 'react-router';
import { Expired } from '@/screens/expired/Expired';
import { History } from '@/screens/history/History';
import { HistoryReport } from '@/screens/history/HistoryReport';
import { LinkScreen } from '@/screens/link/LinkScreen';
import { ReportScreen } from '@/screens/report/ReportScreen';
import { Record } from '@/screens/record/Record';
import { Settings } from '@/screens/settings/Settings';
import { Today } from '@/screens/today/Today';
import { NotFound } from './NotFound';
import { HOME_PATH } from './paths';

/** The §9.3 route map. `/` (the manifest's start_url) opens Today. */
export function FieldRoutes() {
  return (
    <Routes>
      <Route path="/" element={<Navigate to={HOME_PATH} replace />} />
      <Route path="/r/:code" element={<LinkScreen />} />
      <Route path="/r/:code/report/:id" element={<LinkScreen />} />
      <Route path="/today" element={<Today />} />
      <Route path="/record" element={<Record />} />
      <Route path="/report/:id" element={<ReportScreen />} />
      <Route path="/history" element={<History />} />
      <Route path="/history/:id" element={<HistoryReport />} />
      <Route path="/settings" element={<Settings />} />
      <Route path="/expired" element={<Expired />} />
      <Route path="*" element={<NotFound />} />
    </Routes>
  );
}
