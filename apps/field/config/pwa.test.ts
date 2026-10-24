// @vitest-environment node
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { NAVIGATE_FALLBACK_DENYLIST, PRECACHE_GLOBS, PWA_ICONS, pwaOptions } from './pwa';

const FIELD = join(import.meta.dirname, '..');
const SRC = join(FIELD, 'src');
const PUBLIC = join(FIELD, 'public');
const KIT = join(FIELD, '..', '..', 'docs', 'brand');

/** Width and height from a PNG's IHDR chunk. */
function pngSize(file: string): { width: number; height: number } {
  const buf = readFileSync(file);
  expect(buf.subarray(1, 4).toString('latin1')).toBe('PNG');
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

describe('PWA manifest (§9.3, §14.5)', () => {
  const manifest = pwaOptions.manifest || {};

  it('is TalkOlog, standalone, Asphalt theme and Chalk background, opening at /', () => {
    expect(manifest).toMatchObject({
      name: 'TalkOlog',
      short_name: 'TalkOlog',
      display: 'standalone',
      theme_color: '#16181B',
      background_color: '#FBFAF7',
      start_url: '/',
      scope: '/',
      id: '/',
    });
    // The plugin would copy package.json's developer description into the install sheet.
    expect('description' in manifest && manifest.description).toBeFalsy();
  });

  it('has 192 and 512 px icons and a maskable one, rendered from logo-app-icon.svg', () => {
    expect(manifest.icons).toEqual(PWA_ICONS.map((i) => ({ ...i })));
    const purposes = PWA_ICONS.map((i) => `${i.sizes} ${i.purpose}`);
    expect(purposes).toEqual(['192x192 any', '512x512 any', '512x512 maskable']);
    for (const icon of PWA_ICONS) {
      const [w, h] = icon.sizes.split('x').map(Number);
      expect(pngSize(join(PUBLIC, icon.src)), icon.src).toEqual({ width: w, height: h });
    }
    expect(pngSize(join(PUBLIC, 'brand', 'apple-touch-icon.png'))).toEqual({
      width: 180,
      height: 180,
    });
  });

  it('ships the kit SVGs unchanged in public/brand', () => {
    const kit = readdirSync(KIT).filter((f) => f.endsWith('.svg'));
    expect(kit.length).toBeGreaterThan(0);
    for (const file of kit) {
      expect(readFileSync(join(PUBLIC, 'brand', file), 'utf8'), file).toBe(
        readFileSync(join(KIT, file), 'utf8'),
      );
    }
  });
});

describe('service worker (the shell, and web push since W2-14)', () => {
  const inject = pwaOptions.injectManifest ?? {};
  const sw = readFileSync(join(SRC, 'sw.ts'), 'utf8');
  /** The worker's code without its comments. */
  const code = sw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

  it('precaches the built shell and its fonts, and caches nothing at run time', () => {
    expect(pwaOptions.strategies).toBe('injectManifest');
    expect([pwaOptions.srcDir, pwaOptions.filename]).toEqual(['src', 'sw.ts']);
    expect(inject.globPatterns).toBe(PRECACHE_GLOBS);
    expect(inject.rollupFormat).toBe('iife');
    expect(PRECACHE_GLOBS).toEqual(['**/*.{js,css,html}', '**/*-latin-*.woff2']);
    expect(code).toContain('precacheAndRoute(self.__WB_MANIFEST)');
    expect(code).toContain('cleanupOutdatedCaches()');
    // No runtime caching: the only route is the navigation fallback to the shell.
    expect(code.match(/registerRoute\(/g)).toHaveLength(1);
    expect(code).not.toMatch(/CacheFirst|NetworkFirst|StaleWhileRevalidate|workbox-strategies/);
    expect(pwaOptions.includeAssets).toEqual(['brand/*.svg', 'brand/*.png']);
  });

  it('serves its own fonts (no Google Fonts), latin and latin-ext only, all precached', () => {
    // A stylesheet from fonts.googleapis.com blocks the first paint and the worker cannot cache it.
    const html = readFileSync(join(FIELD, 'index.html'), 'utf8');
    expect(html).not.toMatch(/fonts\.(googleapis|gstatic)\.com/);
    const css = readFileSync(join(SRC, 'fonts.css'), 'utf8');
    expect(readFileSync(join(SRC, 'styles.css'), 'utf8')).toContain("@import './fonts.css';");
    const files = [...css.matchAll(/url\('([^']+)'\)/g)].map((m) => m[1]!);
    expect(files).toHaveLength(8);
    for (const file of files) {
      expect(file).toMatch(
        /^@fontsource(-variable)?\/[\w-]+\/files\/[\w-]+-latin(-ext)?-[\w-]+\.woff2$/,
      );
      // Each one matches the precache glob once it is built (assets/<name>-<hash>.woff2).
      expect(file.split('/').pop()).toMatch(/-latin-.*\.woff2$/);
    }
    // The same faces as §14.2: Archivo with its width axis, IBM Plex Mono 400/500/600, both subsets.
    const faces = css.split('@font-face').slice(1);
    const faceKey = (face: string) =>
      [/font-family: '([^']+)'/, /font-weight: ([\d ]+);/, /files\/[\w-]*?(latin(?:-ext)?)-/]
        .map((re) => re.exec(face)?.[1])
        .join(' ');
    expect(faces.map(faceKey).sort()).toEqual(
      [
        'Archivo 100 900 latin',
        'Archivo 100 900 latin-ext',
        'IBM Plex Mono 400 latin',
        'IBM Plex Mono 400 latin-ext',
        'IBM Plex Mono 500 latin',
        'IBM Plex Mono 500 latin-ext',
        'IBM Plex Mono 600 latin',
        'IBM Plex Mono 600 latin-ext',
      ].sort(),
    );
    for (const face of faces) {
      expect(face).toContain('font-display: swap;');
      expect(face).toMatch(/unicode-range:/);
    }
    expect(css).toContain('font-stretch: 62% 125%;');
    // Family names are the tokens' (packages/shared/src/tokens.css).
    const tokens = readFileSync(
      join(FIELD, '..', '..', 'packages', 'shared', 'src', 'tokens.css'),
      'utf8',
    );
    expect(tokens).toContain("--font-sans: 'Archivo',");
    expect(tokens).toContain("--font-mono: 'IBM Plex Mono',");
  });

  it('never answers /api navigations with the shell', () => {
    expect(code).toContain("createHandlerBoundToURL('/index.html')");
    expect(code).toContain('denylist: NAVIGATE_FALLBACK_DENYLIST');
    const denied = (path: string) => NAVIGATE_FALLBACK_DENYLIST.some((re) => re.test(path));
    expect(denied('/api/resolve')).toBe(true);
    expect(denied('/api')).toBe(true);
    expect(denied('/api?x=1')).toBe(true);
    expect(denied('/today')).toBe(false);
    expect(denied('/r/K7Q2MX')).toBe(false);
  });

  it('registers with a plain script and never swaps the build under an open page', () => {
    expect(pwaOptions.injectRegister).toBe('script');
    // The first install controls the page; a new version waits until the app's windows are closed.
    expect(code).toContain('clientsClaim()');
    expect(code).not.toMatch(/skipWaiting/);
    expect(pwaOptions.registerType ?? 'prompt').toBe('prompt');
    expect(pwaOptions.devOptions?.enabled).toBe(false);
  });

  it('handles push and notificationclick with the tested handlers (W2-14)', () => {
    expect(code).toMatch(
      /addEventListener\('push', \(event\) => event\.waitUntil\(showPush\(self, event\.data\)\)\)/,
    );
    expect(code).toMatch(
      /addEventListener\('notificationclick'[\s\S]*openFromNotification\(self, event\.notification\)/,
    );
  });
});
