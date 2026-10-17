import { describe, expect, it } from 'vitest';
import { UI_LANGUAGES, UI_NAMESPACES, UI_RESOURCES, type UiKey } from './index.ts';

type Tree = { readonly [k: string]: string | Tree };

/** Every leaf as [dotted key, text]. */
function leaves(tree: Tree, prefix = ''): Array<[string, string]> {
  return Object.entries(tree).flatMap(([k, v]) =>
    typeof v === 'string'
      ? [[`${prefix}${k}`, v] as [string, string]]
      : leaves(v, `${prefix}${k}.`),
  );
}

const vars = (s: string) => [...s.matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map((m) => m[1]).sort();

describe('UI copy skeleton (D9)', () => {
  it('has the namespaces each surface needs in each of its languages', () => {
    expect(UI_NAMESPACES).toEqual(['common', 'panel', 'field']);
    expect(Object.keys(UI_RESOURCES.en).sort()).toEqual(['common', 'field']);
    expect(Object.keys(UI_RESOURCES.es).sort()).toEqual(['common', 'field']);
    expect(Object.keys(UI_RESOURCES.tr).sort()).toEqual([...UI_NAMESPACES].sort());
    expect(UI_LANGUAGES.panel).toEqual(['en', 'tr']);
    expect(UI_LANGUAGES.field).toEqual(['en', 'es', 'tr']);
  });

  it('has the same keys and interpolations in every language, and no empty text', () => {
    for (const ns of ['common', 'field'] as const) {
      const en = leaves(UI_RESOURCES.en[ns] as Tree);
      for (const lang of ['tr', 'es'] as const) {
        const other = new Map(leaves(UI_RESOURCES[lang][ns] as Tree));
        expect([...other.keys()].sort(), `${lang}.${ns}`).toEqual(en.map(([k]) => k).sort());
        for (const [key, text] of en) {
          expect(vars(other.get(key)!), `${lang}.${ns}.${key}`).toEqual(vars(text));
          expect(other.get(key)!.trim(), `${lang}.${ns}.${key}`).not.toBe('');
        }
      }
    }
  });

  it('keeps no English panel copy here (the panel EN resource is apps/web/src/copy/en.ts)', () => {
    expect('panel' in UI_RESOURCES.en).toBe(false);
    const tr = leaves(UI_RESOURCES.tr.panel as Tree);
    expect(tr.length).toBeGreaterThan(0);
    for (const [key, text] of tr) expect(text.trim(), `tr.panel.${key}`).not.toBe('');
    // apps/web/src/copy/tr-keys.test.ts checks every key against en.ts.
  });

  it('writes Turkish without exclamation marks and no language with emoji', () => {
    for (const [lang, res] of Object.entries(UI_RESOURCES)) {
      for (const [key, text] of leaves(res as unknown as Tree)) {
        expect(text, `${lang}.${key}`).not.toMatch(/\p{Extended_Pictographic}/u);
        if (lang === 'tr') expect(text, key).not.toContain('!');
      }
    }
  });

  it('types dotted keys', () => {
    const key: UiKey<'field'> = 'routes.today';
    const common: UiKey<'common'> = 'languageNames.tr';
    expect([key, common]).toEqual(['routes.today', 'languageNames.tr']);
  });
});
