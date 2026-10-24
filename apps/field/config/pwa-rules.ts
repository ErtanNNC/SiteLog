/**
 * The service worker's shell rules (W1-04 step 6; W2-14), shared by the plugin config
 * (`config/pwa.ts`) and the worker itself (`src/sw.ts`). Plain data: the worker bundle imports it.
 */

/**
 * The precached build: the shell (JS, CSS, HTML) and the font files `src/fonts.css` bundles. Only the
 * latin and latin-ext subsets exist in the build (latin-ext carries Turkish and Spanish letters), and
 * both names contain `-latin-`.
 */
export const PRECACHE_GLOBS = ['**/*.{js,css,html}', '**/*-latin-*.woff2'];

/** Navigations the shell must never answer: field-api, proxied or rewritten to Supabase (D39, D43). */
export const NAVIGATE_FALLBACK_DENYLIST = [/^\/api(?:\/|\?|$)/];
