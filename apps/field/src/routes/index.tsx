import { Navigate, Route, Routes } from 'react-router';
import { LinkScreen } from '@/screens/link/LinkScreen';
import { ReportScreen } from '@/screens/report/ReportScreen';
import { Record } from '@/screens/record/Record';
import { Today } from '@/screens/today/Today';
import { NotFound } from './NotFound';
import { Placeholder } from './Placeholder';
import { HOME_PATH, PLACEHOLDER_ROUTES } from './paths';

/** The §9.3 route map. `/` (the manifest's start_url) opens Today. */
export function FieldRoutes() {
  return (
    <Routes>
      <Route path="/" element={<Navigate to={HOME_PATH} replace />} />
      <Route path="/r/:code" element={<LinkScreen />} />
      <Route path="/today" element={<Today />} />
      <Route path="/record" element={<Record />} />
      <Route path="/report/:id" element={<ReportScreen />} />
      {PLACEHOLDER_ROUTES.map((route) => (
        <Route key={route.path} path={route.path} element={<Placeholder screen={route.screen} />} />
      ))}
      <Route path="*" element={<NotFound />} />
    </Routes>
  );
}
