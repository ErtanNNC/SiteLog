import { Navigate, Route, Routes } from 'react-router';
import { NotFound } from './NotFound';
import { Placeholder } from './Placeholder';
import { FIELD_ROUTES, HOME_PATH } from './paths';

/** The §9.3 route map. `/` (the manifest's start_url) opens Today. */
export function FieldRoutes() {
  return (
    <Routes>
      <Route path="/" element={<Navigate to={HOME_PATH} replace />} />
      {FIELD_ROUTES.map((route) => (
        <Route key={route.path} path={route.path} element={<Placeholder screen={route.screen} />} />
      ))}
      <Route path="*" element={<NotFound />} />
    </Routes>
  );
}
