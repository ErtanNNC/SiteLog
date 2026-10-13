/**
 * The field app's routes (spec §9.3). W1-04 renders each as a placeholder; the screens arrive with
 * W1-09 (link check, Today, Recording), W1-13 (question, draft, filed) and M6 (history, settings,
 * expired). `screen` is the route's key in the `field.routes` copy.
 *
 * Plain data (no React), so the Playwright smoke test reads the same list.
 */
export const FIELD_ROUTES = [
  { path: '/r/:code', screen: 'link', example: '/r/K7Q2MX' },
  { path: '/today', screen: 'today', example: '/today' },
  { path: '/record', screen: 'record', example: '/record' },
  { path: '/report/:id', screen: 'report', example: '/report/7d2f4c1e' },
  { path: '/history', screen: 'history', example: '/history' },
  { path: '/settings', screen: 'settings', example: '/settings' },
  { path: '/expired', screen: 'expired', example: '/expired' },
] as const;

export type FieldScreen = (typeof FIELD_ROUTES)[number]['screen'];

/** Where `/` (the manifest's `start_url`) goes until the link and device flow decide (W1-09). */
export const HOME_PATH = '/today';
