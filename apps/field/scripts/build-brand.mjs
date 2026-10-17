#!/usr/bin/env node
/**
 * The field app's brand files (spec §9.3, §14.5; W1-04 step 6), made from the v1.2 kit in
 * docs/brand/, the same way as the panel's (`apps/web/scripts/build-brand.mjs`):
 *
 *  - copies the kit SVGs into public/brand/ unchanged;
 *  - renders the PNGs with Chromium, offline:
 *      favicon-16/32/48.png      16 px from favicon-16.svg (the simplified mark), 32 px from
 *                                favicon-32.svg, 48 px from logo-mark.svg;
 *      apple-touch-icon.png      180 px from logo-app-icon.svg, full bleed (iOS rounds the corners);
 *      pwa-192.png, pwa-512.png  the manifest's `any` icons: logo-app-icon.svg as drawn;
 *      pwa-maskable-512.png      the manifest's `maskable` icon: full-bleed Signal, the app icon at 80 %
 *                                so the whole mark sits inside the 80 % safe-zone circle.
 *
 *   pnpm --filter @sitelog/field brand        (or `pnpm brand` for the panel and the field app)
 *
 * The background colour is read from packages/shared/src/tokens.css (`--color-signal`).
 * Chromium: PLAYWRIGHT_CHROMIUM_PATH, else /opt/pw-browsers/chromium when present, else the browser
 * Playwright installed.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium } from '@playwright/test';

const FIELD = resolve(import.meta.dirname, '..');
const ROOT = resolve(FIELD, '..', '..');
const KIT = join(ROOT, 'docs', 'brand');
const OUT = join(FIELD, 'public', 'brand');

const KIT_FILES = [
  'logo-mark.svg',
  'logo-mark-inverted.svg',
  'logo-mono.svg',
  'logo-app-icon.svg',
  'favicon-16.svg',
  'favicon-32.svg',
];

function token(name) {
  const css = readFileSync(join(ROOT, 'packages', 'shared', 'src', 'tokens.css'), 'utf8');
  const m = new RegExp(`--color-${name}:\\s*(#[0-9a-fA-F]{6})\\s*;`).exec(css);
  if (!m) throw new Error(`tokens.css has no --color-${name}`);
  return m[1];
}
const SIGNAL = token('signal');

/** [kit file, size in px, output, page background (null = transparent), artwork scale] */
const PNGS = [
  ['favicon-16.svg', 16, 'favicon-16.png', null, 1],
  ['favicon-32.svg', 32, 'favicon-32.png', null, 1],
  ['logo-mark.svg', 48, 'favicon-48.png', null, 1],
  ['logo-app-icon.svg', 180, 'apple-touch-icon.png', SIGNAL, 1],
  ['logo-app-icon.svg', 192, 'pwa-192.png', null, 1],
  ['logo-app-icon.svg', 512, 'pwa-512.png', null, 1],
  ['logo-app-icon.svg', 512, 'pwa-maskable-512.png', SIGNAL, 0.8],
];

async function renderPngs() {
  const executablePath =
    process.env.PLAYWRIGHT_CHROMIUM_PATH ??
    (existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined);
  const browser = await chromium.launch({ executablePath });
  try {
    const page = await browser.newPage({ deviceScaleFactor: 1 });
    for (const [file, size, out, background, scale] of PNGS) {
      const svg = readFileSync(join(KIT, file)).toString('base64');
      const art = Math.round(size * scale);
      await page.setViewportSize({ width: size, height: size });
      await page.setContent(
        `<!doctype html><html><body style="margin:0;background:${background ?? 'transparent'}">` +
          `<div style="width:${size}px;height:${size}px;display:flex;align-items:center;justify-content:center">` +
          `<img src="data:image/svg+xml;base64,${svg}" width="${art}" height="${art}" style="display:block" alt="">` +
          `</div></body></html>`,
      );
      await page.locator('img').evaluate((img) => img.decode());
      await page.screenshot({
        path: join(OUT, out),
        clip: { x: 0, y: 0, width: size, height: size },
        omitBackground: !background,
      });
      console.log(`public/brand/${out} ← docs/brand/${file} (${size} px)`);
    }
  } finally {
    await browser.close();
  }
}

mkdirSync(OUT, { recursive: true });
for (const file of KIT_FILES) {
  copyFileSync(join(KIT, file), join(OUT, file));
  console.log(`public/brand/${file} ← docs/brand/${file}`);
}
await renderPngs();
