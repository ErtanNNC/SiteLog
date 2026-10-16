/**
 * The field app's routes (spec §9.3). W1-09 builds the link check (`/r/:code`: resolve, device
 * check, welcome), Today, Record and the report's Processing state; W1-13 the question and draft
 * states of `/report/:id` (filing until filed); W1-15 the Filed screen and the `filed` text's
 * link `/r/:code/report/:id` (the link check, then that report); W2-02 Settings (F15); W2-03 Past
 * reports (`/history`, and `/history/:id` for one report) and the expired link (F16); W2-12 the
 * SMS EDIT's links `/r/:code/history[/:id]` (the link check, then Past reports or that report,
 * where the texted change waits as a preview with Save change).
 * `screen` is the route's key in the `field.routes` copy.
 *
 * Plain data (no React), so the Playwright smoke test reads the same list.
 */
export const FIELD_ROUTES = [
  { path: '/r/:code', screen: 'link', example: '/r/K7Q2MX' },
  { path: '/r/:code/report/:id', screen: 'link', example: '/r/K7Q2MX/report/7d2f4c1e' },
  { path: '/r/:code/history', screen: 'link', example: '/r/K7Q2MX/history' },
  { path: '/r/:code/history/:id', screen: 'link', example: '/r/K7Q2MX/history/7d2f4c1e' },
  { path: '/today', screen: 'today', example: '/today' },
  { path: '/record', screen: 'record', example: '/record' },
  { path: '/report/:id', screen: 'report', example: '/report/7d2f4c1e' },
  { path: '/history', screen: 'history', example: '/history' },
  { path: '/history/:id', screen: 'history', example: '/history/7d2f4c1e' },
  { path: '/settings', screen: 'settings', example: '/settings' },
  { path: '/expired', screen: 'expired', example: '/expired' },
] as const;

export type FieldScreen = (typeof FIELD_ROUTES)[number]['screen'];

/** Where `/` (the manifest's `start_url`) goes: Today, which asks for a link when none is stored. */
export const HOME_PATH = '/today';
