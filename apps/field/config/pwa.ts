/**
 * The field app's PWA (spec §9.3, §14.5; W1-04 step 6): manifest, icons and a service worker that
 * precaches the app shell only.
 *
 * - Manifest: name "SiteLog", `display: standalone`, theme Asphalt (`#16181B`), background Chalk (the
 *   field screens' background, §14.6), icons rendered from `docs/brand/logo-app-icon.svg` by
 *   `scripts/build-brand.mjs` (192 and 512 px, and a 512 px maskable icon with the mark inside the
 *   safe zone). `start_url` is `/`: the router decides where that lands, so a home-screen icon that
 *   is already installed follows later changes without a reinstall.
 *   No `description`: the manifest has one language and the app speaks three (the plugin would
 *   otherwise copy package.json's).
 * - Service worker (Workbox `generateSW`): the built JS, CSS and HTML, the brand files and the fonts
 *   (Archivo and IBM Plex Mono, latin and latin-ext, bundled by `src/fonts.css`), so the installed
 *   shell paints with its own fonts and no third-party request. No runtime caching, so `/api`
 *   (field-api) always goes to the network, and the navigation fallback to `index.html` never
 *   answers `/api`. No web push in week 1: push arrives as a message channel with M6 (spec §4.5,
 *   §9.3), never a person's only channel; it will need `injectManifest` for its push handlers.
 *   Registered by the plain `registerSW.js` script. The first install takes control of the open
 *   page (`clientsClaim`). A new version does not take over an open page: no `skipWaiting`, so it
 *   waits until every window of the app is closed. On activation Workbox deletes the precached files
 *   the new build no longer lists, and the host answers an old build's missing hashed files with
 *   `index.html` (the app fallback), so a page left on the old build would fail to load its next lazy
 *   chunk. An open page therefore keeps one consistent build, and a recording is never cut off by a
 *   reload. An immediate update (skip waiting, then reload on `controllerchange`) is for W1-09, held
 *   back while a recording or upload is in progress.
 */
import type { VitePWAOptions } from 'vite-plugin-pwa';
import { colors } from '@sitelog/shared/tokens.ts';

/** Icons in `public/brand/`, written by `pnpm --filter @sitelog/field brand`. */
export const PWA_ICONS = [
  { src: '/brand/pwa-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
  { src: '/brand/pwa-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
  { src: '/brand/pwa-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
] as const;

/**
 * The precached build: the shell (JS, CSS, HTML) and the font files `src/fonts.css` bundles. Only the
 * latin and latin-ext subsets exist in the build (latin-ext carries Turkish and Spanish letters), and
 * both names contain `-latin-`.
 */
export const PRECACHE_GLOBS = ['**/*.{js,css,html}', '**/*-latin-*.woff2'];

/** Navigations the shell must never answer: field-api, proxied or rewritten to Supabase (D39, D43). */
export const NAVIGATE_FALLBACK_DENYLIST = [/^\/api(?:\/|\?|$)/];

export const pwaOptions: Partial<VitePWAOptions> = {
  injectRegister: 'script',
  includeAssets: ['brand/*.svg', 'brand/*.png'],
  manifest: {
    id: '/',
    name: 'SiteLog',
    short_name: 'SiteLog',
    description: undefined,
    start_url: '/',
    scope: '/',
    display: 'standalone',
    theme_color: colors.asphalt.toUpperCase(),
    background_color: colors.chalk.toUpperCase(),
    icons: PWA_ICONS.map((icon) => ({ ...icon })),
  },
  workbox: {
    globPatterns: PRECACHE_GLOBS,
    navigateFallback: '/index.html',
    navigateFallbackDenylist: NAVIGATE_FALLBACK_DENYLIST,
    cleanupOutdatedCaches: true,
    // No skipWaiting: see above.
    clientsClaim: true,
    // The shell only: nothing is cached at run time (no field-api responses).
    runtimeCaching: [],
  },
  devOptions: { enabled: false },
};
