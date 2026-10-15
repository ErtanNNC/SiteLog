import { UI_RESOURCES, type PanelCopyTree } from '@sitelog/shared';
import { describe, expect, it } from 'vitest';
import { copy } from '@/copy/en';

/**
 * D9: `copy/en.ts` is the panel's English (the i18next `panel` EN resource, `src/i18n`), and the
 * panel's Turkish lives in `@sitelog/shared` (`UI_RESOURCES.tr.panel`). Every Turkish key must name
 * a string in this file, so a renamed or removed English key cannot leave a dead translation, and
 * every string of the parts of the panel that speak Turkish must have its Turkish.
 */

const PLURAL = ['_one', '_other'] as const;

function leaves(tree: PanelCopyTree, prefix = ''): Array<[string, string]> {
  return Object.entries(tree).flatMap(([k, v]) =>
    typeof v === 'string'
      ? [[`${prefix}${k}`, v] as [string, string]]
      : leaves(v, `${prefix}${k}.`),
  );
}

function at(path: string): unknown {
  return path
    .split('.')
    .reduce<unknown>(
      (node, k) =>
        node !== null && typeof node === 'object'
          ? (node as Record<string, unknown>)[k]
          : undefined,
      copy,
    );
}

/** The English text for a Turkish key: a plain string, or the `_other` form of a counted pair. */
function englishFor(key: string): string | undefined {
  const plain = at(key);
  if (typeof plain === 'string') return plain;
  const [one, other] = PLURAL.map((s) => at(`${key}${s}`));
  return typeof one === 'string' && typeof other === 'string' ? other : undefined;
}

/** The English strings (counted pairs folded into one key) under the given paths. */
function englishKeys(paths: readonly string[]): string[] {
  const all = leaves(stringsOnly(copy) as PanelCopyTree).map(([k]) =>
    k.replace(/_(one|other)$/, ''),
  );
  return [...new Set(all)].filter((k) => paths.some((p) => k === p || k.startsWith(`${p}.`)));
}

function stringsOnly(node: object): PanelCopyTree {
  const out: Record<string, string | PanelCopyTree> = {};
  for (const [k, v] of Object.entries(node)) {
    if (typeof v === 'string') out[k] = v;
    else if (v && typeof v === 'object' && !Array.isArray(v)) out[k] = stringsOnly(v);
  }
  return out;
}

const vars = (s: string) => [...s.matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map((m) => m[1]).sort();

/**
 * What speaks Turkish (W1-03): the shell (sidebar, top bar, drawer, user menu, footer), sign-in and
 * `/auth/callback`, the global states the shell renders, the error boundary and the Demo phone
 * placeholder; W1-16: the Overview with the shared parts it renders (status chips, channel icon,
 * KPI tile, table, confirm dialog). Pages that are not converted yet render in English under `<EnglishOnly>`.
 */
const TRANSLATED = [
  'app',
  'nav',
  'shell',
  'login',
  'errorBoundary',
  'devPhone',
  // W1-18: Sites and Site detail, with the streak bar and calendar they render.
  'sites',
  'siteDetail',
  'streak',
  'calendar',
  // W1-16: the Overview and the shared parts it renders.
  'overview',
  'channel',
  'chips.filed',
  'chips.awaiting',
  'chips.missing',
  'chips.needs_review',
  'chips.weather_day',
  'chips.no_work',
  'chips.signed_off',
  'chips.pending',
  'chips.late',
  'chips.lateAtTime',
  'reports.newReport',
  'table.empty',
  'team.officeRoles',
  'common.loading',
  'common.cancel',
  'common.confirm',
  'states.error',
  'states.errorId',
  'states.retry',
  'states.noAccessTitle',
  'states.noAccess',
  'states.goToHours',
  'states.goHome',
  'states.notFoundTitle',
  'states.notFound',
  'states.comingNextTitle',
  'states.comingNext',
  'a11y.searchResults',
  'a11y.loadingPage',
  'a11y.statusChipLabel',
  'a11y.lateBadge',
  'a11y.kpiBreakdown',
  'a11y.closeDialog',
  // W1-17: the Reports archive and Report review, with the shared pieces they render.
  'reports',
  'report',
  'source.links',
  'player',
  'channel',
  'chips',
  'errors.generic',
  'common.hoursUnit',
  'toasts.signedOffReport',
  'toasts.undone',
  'toasts.versionSavedN',
  'toasts.companyResolved',
] as const;

describe('panel TR copy (D9)', () => {
  const tr = leaves(UI_RESOURCES.tr.panel);

  it('keys every Turkish string by a string (or a counted pair) of copy/en.ts', () => {
    expect(tr.length).toBeGreaterThan(0);
    for (const [key] of tr) expect(englishFor(key), `panel.${key}`).toBeTypeOf('string');
  });

  it('uses the same {{variables}} as the English', () => {
    for (const [key, text] of tr) {
      const en = englishFor(key);
      if (en === undefined) continue; // reported by the test above
      expect(vars(text), `panel.${key}`).toEqual(vars(en));
    }
  });

  it('translates every string of the shell, sign-in and global states', () => {
    const translated = new Set(tr.map(([k]) => k));
    const missing = englishKeys(TRANSLATED).filter((k) => !translated.has(k));
    expect(missing).toEqual([]);
  });
});
