import { UI_RESOURCES, type PanelCopyTree } from '@sitelog/shared';
import { describe, expect, it } from 'vitest';
import { copy } from '@/copy/en';

/**
 * D9: `copy/en.ts` is the panel's English (W1-03 serves it as the i18next `panel` EN resource), and
 * the panel's Turkish lives in `@sitelog/shared` (`UI_RESOURCES.tr.panel`). Every Turkish key must
 * name a string in this file, so a renamed or removed English key cannot leave a dead translation.
 */

function leaves(tree: PanelCopyTree, prefix = ''): string[] {
  return Object.entries(tree).flatMap(([k, v]) =>
    typeof v === 'string' ? [`${prefix}${k}`] : leaves(v, `${prefix}${k}.`),
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

describe('panel TR copy (D9)', () => {
  it('keys every Turkish string by a plain-string path of copy/en.ts', () => {
    const keys = leaves(UI_RESOURCES.tr.panel);
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) expect(typeof at(key), `panel.${key}`).toBe('string');
  });
});
