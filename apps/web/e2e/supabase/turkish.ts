import { expect, type Page } from '@playwright/test';
import { UI_RESOURCES, type PanelCopyTree } from '@sitelog/shared/copy/ui/index.ts';
import { copy as en } from '../../src/copy/en';

/**
 * W4-16 (spec §16.2 M11 "Panel TR strings", §17 "E2E panel … TR locale", §19 Q240): what "no
 * English left" means for a Turkish page on the stack. Two checks, both on the rendered DOM:
 *
 * 1. no `<EnglishOnly>` wrapper (`<div lang="en" class="contents">`, `src/i18n/EnglishOnly.tsx`):
 *    since W4-09 only `/ops` and `/try` keep one, and those two are not visited;
 * 2. no text block is an English string of the panel's catalogue. Every English string of
 *    `src/copy/en.ts` (the panel's `en` resource) and of the shared `common` namespace becomes a
 *    pattern (`{{var}}` matching any text), unless it is also a Turkish string anywhere in the
 *    Turkish catalogue (brand and channel names such as "SiteLog", "WhatsApp", "PDF") or has
 *    fewer than four letters outside its variables. A text block is an element's whole text, an
 *    `aria-label`, `placeholder` or `title`; content marked as another language (`lang="en"`, the
 *    recording notice in English on Field channels, the language switch's "English") is left out,
 *    since it is English on purpose and says so to screen readers (WCAG 3.1.2), and so is content
 *    marked `translate="no"` (identifiers that are the same in every language: the payroll CSV's
 *    column names). Data is not copy, but data in English can match a catalogue string (a person's
 *    title "Operations", an English weather note): the specs check Demir Yapı, whose data is
 *    Turkish.
 */

const LETTERS = /[A-Za-z]/g;

function leaves(node: unknown, prefix = ''): Array<[string, string]> {
  if (typeof node === 'string') return [[prefix, node]];
  if (!node || typeof node !== 'object' || Array.isArray(node)) return [];
  return Object.entries(node as Record<string, unknown>).flatMap(([k, v]) =>
    leaves(v, prefix ? `${prefix}.${k}` : k),
  );
}

const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const VAR = /\{\{\s*[\w.]+\s*\}\}/g;
const HAS_VAR = /\{\{\s*[\w.]+\s*\}\}/;

interface EnglishCatalogue {
  exact: Set<string>;
  patterns: Array<{ key: string; re: RegExp }>;
  keyOf: Map<string, string>;
}

let catalogue: EnglishCatalogue | null = null;

/** The panel's English strings that a Turkish page must not show (built once). */
export function englishCatalogue(): EnglishCatalogue {
  if (catalogue) return catalogue;
  const tr = UI_RESOURCES.tr;
  const turkish = new Set(
    [...leaves(tr.panel as PanelCopyTree), ...leaves(tr.common)].map(([, v]) =>
      norm(v.replace(VAR, '')),
    ),
  );
  const english = [...leaves(en, 'panel'), ...leaves(UI_RESOURCES.en.common, 'common')];
  const exact = new Set<string>();
  const keyOf = new Map<string, string>();
  const patterns: Array<{ key: string; re: RegExp }> = [];
  for (const [key, raw] of english) {
    const text = norm(raw);
    const literal = norm(text.replace(VAR, ' '));
    if ((literal.match(LETTERS) ?? []).length < 4) continue;
    if (turkish.has(literal) || turkish.has(norm(text.replace(VAR, '')))) continue;
    if (!HAS_VAR.test(text)) {
      exact.add(text);
      keyOf.set(text, key);
    } else {
      const source = text
        .split(VAR)
        .map((part) => escape(part))
        .join('.+?');
      patterns.push({ key, re: new RegExp(`^${source}$`, 'u') });
    }
  }
  catalogue = { exact, patterns, keyOf };
  return catalogue;
}

/** Every text block of the page that is not marked as another language. */
async function textBlocks(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out = new Set<string>();
    const clean = (s: string) => s.replace(/\s+/g, ' ').trim();
    const skip = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE']);
    for (const el of Array.from(document.body.querySelectorAll('*'))) {
      if (skip.has(el.tagName) || el.closest('svg') || el.closest('[translate="no"]')) continue;
      const lang = (el.closest('[lang]')?.getAttribute('lang') ?? '').toLowerCase();
      if (lang && !lang.startsWith('tr')) continue;
      const text = clean(el.textContent ?? '');
      if (text && text.length <= 400) out.add(text);
      for (const attr of ['aria-label', 'placeholder', 'title']) {
        const v = el.getAttribute(attr);
        if (v) out.add(clean(v));
      }
    }
    return [...out];
  });
}

/** The page's text blocks that are English strings of the panel, with their catalogue keys. */
export async function englishOnPage(page: Page): Promise<string[]> {
  const { exact, patterns, keyOf } = englishCatalogue();
  const found: string[] = [];
  for (const text of await textBlocks(page)) {
    if (exact.has(text)) {
      found.push(`${keyOf.get(text)}: "${text}"`);
      continue;
    }
    const hit = patterns.find((p) => p.re.test(text));
    if (hit) found.push(`${hit.key}: "${text}"`);
  }
  return found;
}

/** A Turkish panel string by its key (`settings.channels.talkNowOnly`), `{{var}}`s filled in. */
export function tr(key: string, vars: Record<string, string | number> = {}): string {
  const value = key
    .split('.')
    .reduce<unknown>(
      (node, k) =>
        node && typeof node === 'object' ? (node as Record<string, unknown>)[k] : undefined,
      UI_RESOURCES.tr.panel,
    );
  if (typeof value !== 'string') throw new Error(`no Turkish panel string at ${key}`);
  return value.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, name: string) => String(vars[name] ?? ''));
}

/**
 * Waits for the page to settle (its queries answered), then checks it is Turkish: `<html
 * lang="tr">`, no `<EnglishOnly>` wrapper, no English text block.
 */
export async function expectTurkishPage(page: Page, where: string): Promise<void> {
  await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => undefined);
  await expect(page.locator('html'), where).toHaveAttribute('lang', 'tr');
  await expect(page.locator('div.contents[lang="en"]'), `${where}: <EnglishOnly>`).toHaveCount(0);
  expect(await englishOnPage(page), `${where}: English text`).toEqual([]);
}
