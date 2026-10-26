import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { colors, rootCssVars, themeCssVars, tokenCssName } from '@sitelog/shared';

/**
 * W1-02 / D4: the design tokens live in `packages/shared/src/tokens.css` (Tailwind 4 @theme, used by
 * the browser apps) and `packages/shared/src/tokens.ts` (PDF and email). This keeps them equal, keeps
 * the colours equal to spec §14.1, and proves the @theme moved out of apps/web unchanged.
 */

const ROOT = join(import.meta.dirname, '..', '..');
const read = (...p: string[]) => readFileSync(join(ROOT, ...p), 'utf8');
const SHARED_CSS = read('packages', 'shared', 'src', 'tokens.css');
const WEB_CSS = read('apps', 'web', 'src', 'styles', 'tokens.css');
const SPEC = read('docs', 'SITELOG_SPEC.md');

/** The body of the first `{ … }` block after `opener`, braces balanced. */
function block(css: string, opener: string): string {
  const at = css.indexOf(opener);
  if (at < 0) throw new Error(`No ${opener} block`);
  const start = css.indexOf('{', at) + 1;
  let depth = 1;
  let i = start;
  while (depth > 0 && i < css.length) {
    if (css[i] === '{') depth += 1;
    else if (css[i] === '}') depth -= 1;
    i += 1;
  }
  return css.slice(start, i - 1);
}

/** Custom-property declarations of a block, comments removed: `--name` → value. */
function decls(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  const clean = body.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const m of clean.matchAll(/(--[\w-]+(?:-\*)?)\s*:\s*([^;]+);/g)) out[m[1]!] = m[2]!.trim();
  return out;
}

describe('tokens.ts ⇄ tokens.css', () => {
  const theme = decls(block(SHARED_CSS, '@theme'));
  const root = decls(block(SHARED_CSS, ':root'));

  it('has every @theme token, with the same value, and nothing else', () => {
    expect(theme['--color-*']).toBe('initial');
    const { ['--color-*']: _reset, ...tokens } = theme;
    expect(tokens).toEqual(themeCssVars());
  });

  it('has every raw :root token, with the same value, and nothing else', () => {
    expect(root).toEqual(rootCssVars());
  });

  it('names tokens the CSS way', () => {
    expect(tokenCssName('signalDeep')).toBe('signal-deep');
    expect(tokenCssName('dustLight')).toBe('dust-light');
    expect(tokenCssName('chipReviewFg')).toBe('chip-review-fg');
    expect(tokenCssName('heat6')).toBe('heat-6');
  });
});

describe('tokens vs spec §14.1', () => {
  it('matches every colour of the spec block', () => {
    const section = SPEC.slice(SPEC.indexOf('### 14.1 Color tokens'), SPEC.indexOf('### 14.2'));
    const spec = decls(block(section, ':root'));
    expect(Object.keys(spec).length).toBeGreaterThanOrEqual(31);
    const ours = rootCssVars();
    for (const [name, value] of Object.entries(spec)) {
      expect(ours[name]?.toLowerCase(), name).toBe(value.toLowerCase());
    }
    expect(Object.keys(ours).sort()).toEqual(Object.keys(spec).sort());
    expect(colors.signal).toBe('#ff6a13');
  });
});

describe('the @theme moved from apps/web (W1-02, D4)', () => {
  it('apps/web imports the shared tokens right after Tailwind and defines none of its own', () => {
    expect(WEB_CSS).toMatch(/@import 'tailwindcss';\s*@import '@sitelog\/shared\/tokens\.css';/);
    expect(WEB_CSS.replace(/\/\*[\s\S]*?\*\//g, '')).not.toMatch(/@theme\b/);
    expect(Object.keys(decls(WEB_CSS))).toEqual([]);
  });

  it('keeps every name and value of the v1.0 @theme (apps/web/src/styles/tokens.css at 50b7632)', () => {
    // Added since (§14.3 targets, AUDIT_BACKLOG "41.25 px"): checked in the next test.
    const theme = Object.fromEntries(
      Object.entries(decls(block(SHARED_CSS, '@theme'))).filter(
        ([k]) => !k.startsWith('--spacing-target'),
      ),
    );
    const lines = Object.entries(theme)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}: ${v}`)
      .join('\n');
    expect(Object.keys(theme)).toHaveLength(56);
    // Fingerprint of the 56 declarations before the move. Change it only with a spec §14 change.
    expect(createHash('sha256').update(lines).digest('hex')).toBe(
      '7c00eec9ac518f0de7dd01383067f5ccb35020dde7b5c9548604e3e4b37ca1fc',
    );
  });

  it('sizes touch targets in pixels (§14.3: 44 px, 40 px in dense tables), not rem', () => {
    const theme = decls(block(SHARED_CSS, '@theme'));
    expect(theme['--spacing-target']).toBe('44px');
    expect(theme['--spacing-target-dense']).toBe('40px');
  });
});
