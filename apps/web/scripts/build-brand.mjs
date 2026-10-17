#!/usr/bin/env node
/**
 * The panel's brand files (spec §14.5, D10), made from the v1.2 kit in docs/brand/:
 *
 *  - copies the kit SVGs into public/brand/ unchanged (logo-mark, logo-mark-inverted, logo-mono,
 *    logo-app-icon, favicon-16, favicon-32);
 *  - renders the PNG favicons with Chromium: 16 px from favicon-16.svg (the simplified mark below
 *    32 px), 32 px from favicon-32.svg, 48 px from logo-mark.svg, and the 180 px apple-touch icon from
 *    logo-app-icon.svg, full bleed because iOS rounds the corners itself;
 *  - builds logo-lockup.svg: the kit mark + "SiteLog" in Archivo ExtraBold Expanded (800, stretch
 *    125%), the glyphs outlined so the file renders the same without the web font.
 *
 *   pnpm brand                                   (= pnpm --filter @sitelog/web brand)
 *
 * Chromium: PLAYWRIGHT_CHROMIUM_PATH, else /opt/pw-browsers/chromium when present, else the browser
 * Playwright installed. logo-avatar-circle.svg (the WhatsApp profile picture) is not touched.
 */
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { chromium } from '@playwright/test';

const WEB = resolve(import.meta.dirname, '..');
const ROOT = resolve(WEB, '..', '..');
const KIT = join(ROOT, 'docs', 'brand');
const OUT = join(WEB, 'public', 'brand');
const FONT = join(ROOT, 'packages', 'pdf', 'src', 'fonts', 'ArchivoExpanded-ExtraBold.ttf');

const KIT_FILES = [
  'logo-mark.svg',
  'logo-mark-inverted.svg',
  'logo-mono.svg',
  'logo-app-icon.svg',
  'favicon-16.svg',
  'favicon-32.svg',
];

/** [kit file, size in px, output, page background (null = transparent)] */
const PNGS = [
  ['favicon-16.svg', 16, 'favicon-16.png', null],
  ['favicon-32.svg', 32, 'favicon-32.png', null],
  ['logo-mark.svg', 48, 'favicon-48.png', null],
  ['logo-app-icon.svg', 180, 'apple-touch-icon.png', '#FF6A13'],
];

const ASPHALT = '#16181B';

/** fontkit ships with @react-pdf (a dependency of this package), not on its own. */
function loadFontkit() {
  const fromWeb = createRequire(import.meta.url);
  const fromRenderer = createRequire(fromWeb.resolve('@react-pdf/renderer'));
  return createRequire(fromRenderer.resolve('@react-pdf/font'))('fontkit');
}

/** The lockup: a 64 px mark, then the word mark at the artboards' proportions (Web-Login, Web-Overview). */
function lockupSvg() {
  const MARK = 64;
  const GAP = 22; // ≈ 1/3 of the mark, as in the artboards
  const SIZE = 43; // ≈ 2/3 of the mark
  const TRACKING = -0.03; // em, as in the artboards
  const round = (n) => Math.round(n * 100) / 100;

  const mark = readFileSync(join(KIT, 'logo-mark.svg'), 'utf8');
  const inner = /<svg[^>]*>([\s\S]*)<\/svg>/.exec(mark)?.[1];
  if (!inner) throw new Error('docs/brand/logo-mark.svg: no <svg> body');

  const font = loadFontkit().openSync(FONT);
  const scale = SIZE / font.unitsPerEm;
  const baseline = MARK / 2 + (font.capHeight * scale) / 2; // capitals centred on the mark
  const run = font.layout('SiteLog');
  let x = MARK + GAP;
  const d = run.glyphs.map((glyph, i) => {
    const pos = run.positions[i];
    const ox = x + pos.xOffset * scale;
    const oy = pos.yOffset * scale;
    x += pos.xAdvance * scale + TRACKING * SIZE;
    return glyph.path
      .mapPoints((px, py) => [round(ox + px * scale), round(baseline - oy - py * scale)])
      .toSVG();
  });
  const width = Math.ceil(x - TRACKING * SIZE);
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${MARK}" width="${width}" height="${MARK}" role="img" aria-label="SiteLog">` +
    `<title>SiteLog</title>${inner.trim()}<path fill="${ASPHALT}" d="${d.join('')}"/></svg>\n`
  );
}

async function renderPngs() {
  const executablePath =
    process.env.PLAYWRIGHT_CHROMIUM_PATH ??
    (existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined);
  const browser = await chromium.launch({ executablePath });
  try {
    const page = await browser.newPage({ deviceScaleFactor: 1 });
    for (const [file, size, out, background] of PNGS) {
      const svg = readFileSync(join(KIT, file)).toString('base64');
      await page.setViewportSize({ width: size, height: size });
      await page.setContent(
        `<!doctype html><html><body style="margin:0;background:${background ?? 'transparent'}">` +
          `<img src="data:image/svg+xml;base64,${svg}" width="${size}" height="${size}" style="display:block" alt=""></body></html>`,
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

for (const file of KIT_FILES) {
  copyFileSync(join(KIT, file), join(OUT, file));
  console.log(`public/brand/${file} ← docs/brand/${file}`);
}
writeFileSync(join(OUT, 'logo-lockup.svg'), lockupSvg());
console.log('public/brand/logo-lockup.svg ← kit mark + "SiteLog" (Archivo 800, stretch 125%)');
await renderPngs();
