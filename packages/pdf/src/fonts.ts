import { Font } from '@react-pdf/renderer';

/**
 * Archivo (headings/body) + IBM Plex Mono (numbers/labels), embedded (§12). The TTFs live in
 * src/fonts. The host says where to load them from before the first render: file paths in the
 * worker, asset URLs in the browser (`setFontSource`).
 */

export const FONT_SANS = 'Archivo';
export const FONT_SANS_EXPANDED = 'ArchivoExpanded';
export const FONT_MONO = 'IBM Plex Mono';

export const FONT_FILES = [
  'Archivo-Regular.ttf',
  'Archivo-Medium.ttf',
  'Archivo-SemiBold.ttf',
  'Archivo-Bold.ttf',
  'Archivo-ExtraBold.ttf',
  'ArchivoExpanded-Bold.ttf',
  'ArchivoExpanded-ExtraBold.ttf',
  'IBMPlexMono-Regular.ttf',
  'IBMPlexMono-Medium.ttf',
  'IBMPlexMono-SemiBold.ttf',
] as const;
export type FontFile = (typeof FONT_FILES)[number];

let source: ((file: FontFile) => string) | null = null;
let registered = false;

/** Maps each font file to a path or URL react-pdf can load. Call once, before rendering. */
export function setFontSource(resolve: (file: FontFile) => string): void {
  source = resolve;
  registered = false;
}

export function registerFonts(): void {
  if (registered) return;
  if (!source) throw new Error('PDF fonts: call setFontSource() before rendering');
  const f = source;
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
