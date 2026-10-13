/**
 * SiteLog design tokens (spec §14.1–§14.4) for code that cannot read CSS: the react-pdf report
 * (packages/pdf) and the email templates (apps/worker). The browser apps use `tokens.css` through
 * Tailwind. Both files hold the same names and values; `scripts/src/tokens.test.ts` keeps them
 * equal. Hex values are lower case, as in tokens.css.
 */

/** §14.1 colours. CSS: `--color-<kebab-name>` in @theme (e.g. `signalDeep` → `--color-signal-deep`). */
export const colors = {
  white: '#ffffff',
  black: '#000000',

  // Core
  signal: '#ff6a13',
  signalDeep: '#b23a0b',
  signalTint: '#ffe7d4',
  asphalt: '#16181b',
  steel: '#2a2e33',
  iron: '#4a4f57',
  concrete: '#efede7',
  chalk: '#fbfaf7',
  rebar: '#d9d5cc',
  dust: '#5c5850',
  dustLight: '#a8a49b',

  // Functional
  level: '#1d4ed8',
  filed: '#15803d',
  missing: '#b91c1c',

  // Chips (bg / fg)
  chipFiledBg: '#dcefe2',
  chipFiledFg: '#14532d',
  chipAwaitBg: '#ffe7d4',
  chipAwaitFg: '#9a3412',
  chipMissBg: '#fbe1df',
  chipMissFg: '#991b1b',
  chipReviewBg: '#e0e7fb',
  chipReviewFg: '#1e3a8a',
  chipWxBg: '#e5e2da',
  chipWxFg: '#2a2e33',

  // Heatmap ramp (hours lost, light → dark); white text only on heat6
  heat0: '#efede7',
  heat1: '#ffd2b3',
  heat2: '#ffc097',
  heat3: '#ffa56c',
  heat4: '#ff8a45',
  heat5: '#f06a1e',
  heat6: '#c2410c',
} as const;

export type ColorToken = keyof typeof colors;

/** §14.2 font stacks. CSS: `--font-sans`, `--font-mono`. */
export const fonts = {
  sans: "'Archivo', 'Helvetica Neue', Helvetica, Arial, sans-serif",
  mono: "'IBM Plex Mono', ui-monospace, Menlo, Consolas, monospace",
} as const;

/** §14.2 type scale. CSS: `--text-<name>` and `--text-<name>--line-height`. */
export const text = {
  body: { size: '15px', lineHeight: '22px' },
  caption: { size: '13px', lineHeight: '18px' },
  data: { size: '13px', lineHeight: '20px' },
  eyebrow: { size: '12px', lineHeight: '18px' },
  h2: { size: '20px', lineHeight: '28px' },
  h1: { size: '34px', lineHeight: '40px' },
  display: { size: '56px', lineHeight: '60px' },
} as const;

/** §14.3 radii. CSS: `--radius-<name>`. */
export const radius = {
  chip: '4px',
  btn: '6px',
  card: '8px',
  bubble: '14px',
} as const;

/** Layout widths. CSS: `--width-<name>`. */
export const widths = {
  sidebar: '240px',
  content: '1240px',
} as const;

/**
 * §12 PDF ink that is not a screen token: the header fill and the table rules. Print only, so not
 * in tokens.css.
 */
export const printColors = {
  fill: '#f2f0eb',
  rule: '#c9c4b9',
} as const;

/** `signalDeep` → `signal-deep`, `heat0` → `heat-0`, `chipFiledBg` → `chip-filed-bg`. */
export function tokenCssName(name: string): string {
  return name
    .replace(/([A-Z])/g, '-$1')
    .replace(/(\d+)/g, '-$1')
    .toLowerCase();
}

/** Every custom property of the `@theme` block in tokens.css, by name (`--color-signal` …). */
export function themeCssVars(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(colors)) out[`--color-${tokenCssName(k)}`] = v;
  out['--font-sans'] = fonts.sans;
  out['--font-mono'] = fonts.mono;
  for (const [k, v] of Object.entries(text)) {
    out[`--text-${k}`] = v.size;
    out[`--text-${k}--line-height`] = v.lineHeight;
  }
  for (const [k, v] of Object.entries(radius)) out[`--radius-${k}`] = v;
  for (const [k, v] of Object.entries(widths)) out[`--width-${k}`] = v;
  return out;
}

/**
 * The raw §14.1 custom properties of the `:root` block in tokens.css, for plain CSS and
 * third-party styling: `--sl-<core and functional>`, `--chip-*` and `--heat-*`.
 */
export function rootCssVars(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(colors)) {
    if (k === 'white' || k === 'black') continue;
    const name = tokenCssName(k);
    out[name.startsWith('chip-') || name.startsWith('heat-') ? `--${name}` : `--sl-${name}`] = v;
  }
  return out;
}
