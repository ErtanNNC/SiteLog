/**
 * The field app's routes (spec §9.3). W1-09 builds the link check (`/r/:code`: resolve, device
 * check, welcome), Today, Record and the report's Processing state; W1-13 the question and draft
 * states of `/report/:id` (filing until filed); the Filed screen is W1-15; history, settings and
 * expired are M6 and stay placeholders.
 * `screen` is the route's key in the `field.routes` copy.
 *
 * Plain data (no React), so the Playwright smoke test reads the same list.
 */
export const FIELD_ROUTES = [
  { path: '/r/:code', screen: 'link', example: '/r/K7Q2MX', placeholder: false },
  { path: '/today', screen: 'today', example: '/today', placeholder: false },
  { path: '/record', screen: 'record', example: '/record', placeholder: false },
  { path: '/report/:id', screen: 'report', example: '/report/7d2f4c1e', placeholder: false },
  { path: '/history', screen: 'history', example: '/history', placeholder: true },
  { path: '/settings', screen: 'settings', example: '/settings', placeholder: true },
  { path: '/expired', screen: 'expired', example: '/expired', placeholder: true },
] as const;

export type FieldScreen = (typeof FIELD_ROUTES)[number]['screen'];

/** The routes still rendered as W1-04 placeholders. */
export const PLACEHOLDER_ROUTES = FIELD_ROUTES.filter((r) => r.placeholder);

/** Where `/` (the manifest's `start_url`) goes: Today, which asks for a link when none is stored. */
export const HOME_PATH = '/today';
