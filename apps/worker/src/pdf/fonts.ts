import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Font } from '@react-pdf/renderer';

/**
 * Archivo (headings/body) + IBM Plex Mono (numbers/labels), embedded (§12). The TTFs live in
 * src/pdf/fonts and are copied to dist/fonts by the build; both locations are tried.
 */

export const FONT_SANS = 'Archivo';
export const FONT_SANS_EXPANDED = 'ArchivoExpanded';
export const FONT_MONO = 'IBM Plex Mono';

let registered = false;

export function fontsDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, 'fonts'),
    join(here, '..', 'fonts'),
    join(here, '..', 'src', 'pdf', 'fonts'),
    join(process.cwd(), 'src', 'pdf', 'fonts'),
    join(process.cwd(), 'apps', 'worker', 'src', 'pdf', 'fonts'),
  ];
  for (const c of candidates) if (existsSync(join(c, 'Archivo-Regular.ttf'))) return c;
  throw new Error(`PDF fonts not found; looked in ${candidates.join(', ')}`);
}

export function registerFonts(): void {
  if (registered) return;
  const dir = fontsDir();
  const f = (name: string) => join(dir, name);
  Font.register({
    family: FONT_SANS,
    fonts: [
      { src: f('Archivo-Regular.ttf'), fontWeight: 400 },
      { src: f('Archivo-Medium.ttf'), fontWeight: 500 },
      { src: f('Archivo-SemiBold.ttf'), fontWeight: 600 },
      { src: f('Archivo-Bold.ttf'), fontWeight: 700 },
      { src: f('Archivo-ExtraBold.ttf'), fontWeight: 800 },
    ],
  });
  Font.register({
    family: FONT_SANS_EXPANDED,
    fonts: [
      { src: f('ArchivoExpanded-Bold.ttf'), fontWeight: 700 },
      { src: f('ArchivoExpanded-ExtraBold.ttf'), fontWeight: 800 },
    ],
  });
  Font.register({
    family: FONT_MONO,
    fonts: [
      { src: f('IBMPlexMono-Regular.ttf'), fontWeight: 400 },
      { src: f('IBMPlexMono-Medium.ttf'), fontWeight: 500 },
      { src: f('IBMPlexMono-SemiBold.ttf'), fontWeight: 600 },
    ],
  });
  // Construction terms hyphenate badly; keep words whole.
  Font.registerHyphenationCallback((word) => [word]);
  registered = true;
}
