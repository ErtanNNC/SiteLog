/**
 * The field app's PWA (spec §9.3, §14.5; W1-04 step 6): manifest, icons and a service worker that
 * precaches the app shell only.
 *
 * - Manifest: name "TalkOlog", `display: standalone`, theme Asphalt (`#16181B`), background Chalk (the
 *   field screens' background, §14.6), icons rendered from `docs/brand/logo-app-icon.svg` by
 *   `scripts/build-brand.mjs` (192 and 512 px, and a 512 px maskable icon with the mark inside the
 *   safe zone). `start_url` is `/`: the router decides where that lands, so a home-screen icon that
 *   is already installed follows later changes without a reinstall.
 *   No `description`: the manifest has one language and the app speaks three (the plugin would
 *   otherwise copy package.json's).
 * - Service worker (Workbox `injectManifest` since W2-14, `src/sw.ts`): the built JS, CSS and HTML, the brand files and the fonts
 *   (Archivo and IBM Plex Mono, latin and latin-ext, bundled by `src/fonts.css`), so the installed
 *   shell paints with its own fonts and no third-party request. No runtime caching, so `/api`
 *   (field-api) always goes to the network, and the navigation fallback to `index.html` never
 *   answers `/api`. W2-14 moved it from `generateSW` to `injectManifest` with the same rules (in
 *   `src/sw.ts`, the globs and the denylist in `config/pwa-rules.ts`) and added the web push
 *   handlers (`src/sw/handlers.ts`: show the notification, open its link in the app), web push
 *   being an optional message channel for the installed app, never a person's only channel (spec
 *   §4.5, §9.3). Built as a classic script (`iife`), so every browser registers it the same way.
 *   Registered by the plain `registerSW.js` script. The first install takes control of the open
 *   page (`clientsClaim`). A new version does not take over an open page: no `skipWaiting`, so it
 *   waits until every window of the app is closed. On activation Workbox deletes the precached files
 *   the new build no longer lists, and the host answers an old build's missing hashed files with
 *   `index.html` (the app fallback), so a page left on the old build would fail to load its next lazy
 *   chunk. An open page therefore keeps one consistent build, and a recording is never cut off by a
 *   reload. An immediate update (skip waiting, then reload on `controllerchange`), held back while a
 *   recording or upload is in progress, was left for W1-09 but is not in its Build list and is not
 *   built yet (GAP step 18, "Open").
 */
import type { VitePWAOptions } from 'vite-plugin-pwa';
import { colors } from '@sitelog/shared/tokens.ts';
import { NAVIGATE_FALLBACK_DENYLIST, PRECACHE_GLOBS } from './pwa-rules.ts';

export { NAVIGATE_FALLBACK_DENYLIST, PRECACHE_GLOBS };

/** Icons in `public/brand/`, written by `pnpm --filter @sitelog/field brand`. */
export const PWA_ICONS = [
  { src: '/brand/pwa-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
  { src: '/brand/pwa-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
  { src: '/brand/pwa-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
] as const;

export const pwaOptions: Partial<VitePWAOptions> = {
  strategies: 'injectManifest',
  srcDir: 'src',
  filename: 'sw.ts',
  injectRegister: 'script',
  includeAssets: ['brand/*.svg', 'brand/*.png'],
  manifest: {
    id: '/',
    name: 'TalkOlog',
    short_name: 'TalkOlog',
    description: undefined,
    start_url: '/',
    scope: '/',
    display: 'standalone',
    theme_color: colors.asphalt.toUpperCase(),
    background_color: colors.chalk.toUpperCase(),
    icons: PWA_ICONS.map((icon) => ({ ...icon })),
  },
  // The worker (`src/sw.ts`) precaches these, answers navigations with the shell except
  // NAVIGATE_FALLBACK_DENYLIST, cleans outdated caches, claims the first page, never skips waiting
  // and caches nothing at run time (no field-api responses).
  injectManifest: {
    globPatterns: PRECACHE_GLOBS,
    rollupFormat: 'iife',
  },
  devOptions: { enabled: false },
};
