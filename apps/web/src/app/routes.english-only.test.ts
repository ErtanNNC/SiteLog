import { describe, expect, it } from 'vitest';

/**
 * W4-09 (spec §19 Q240): every panel page speaks the panel's language (EN/TR) but `/try` (v1.0's
 * WhatsApp simulator, until GAP step 22 removes it) and `/ops` (TalkOlog staff only), which stay
 * English under `<EnglishOnly>` (README "Deliberate deviations"). A new page that comes in wrapped,
 * or a wrapper used anywhere but the route map, fails here.
 *
 * The public legal pages `/sms`, `/terms` and `/privacy` (the US SMS program's documents for
 * Twilio's toll-free verification, owner decision 2026-10-20) are English too, but outside the
 * shell and its language: public routes before `<RequireAuth />`, not wrapped, their own
 * `lang="en"` root in `legal/Page.tsx`, their text in `legal/content.ts` rather than keyed copy.
 */

const sources = import.meta.glob<string>(['/src/**/*.tsx', '!/src/**/*.test.tsx'], {
  query: '?raw',
  import: 'default',
  eager: true,
});

/** The route paths whose element is wrapped in `<EnglishOnly>`. */
function englishOnlyPaths(routes: string): string[] {
  return routes
    .split('<Route')
    .slice(1)
    .filter((chunk) => chunk.includes('<EnglishOnly>'))
    .map((chunk) => /path="([^"]+)"/.exec(chunk)?.[1] ?? '(no path)');
}

describe('<EnglishOnly> (Q240)', () => {
  it('wraps only /try and /ops', () => {
    const routes = sources['/src/app/routes.tsx'];
    expect(routes).toBeTypeOf('string');
    expect(englishOnlyPaths(routes!).sort()).toEqual(['/ops', '/try']);
  });

  it('is imported by the route map only', () => {
    const users = Object.entries(sources)
      .filter(([, text]) => /import \{[^}]*\bEnglishOnly\b[^}]*\}/.test(text))
      .map(([file]) => file);
    expect(users).toEqual(['/src/app/routes.tsx']);
  });
});

describe('public legal pages (/sms, /terms, /privacy)', () => {
  const LEGAL = ['/sms', '/terms', '/privacy'];

  it('are public routes, before the auth guard, and not wrapped in <EnglishOnly>', () => {
    const routes = sources['/src/app/routes.tsx']!;
    const guard = routes.indexOf('<Route element={<RequireAuth />}>');
    expect(guard).toBeGreaterThan(0);
    for (const path of LEGAL) {
      const at = routes.indexOf(
        `<Route path="${path}" element={<LegalPage doc="${path.slice(1)}" />} />`,
      );
      expect(at, path).toBeGreaterThan(0);
      expect(at, path).toBeLessThan(guard);
    }
    for (const path of LEGAL) expect(englishOnlyPaths(routes)).not.toContain(path);
  });

  it('render in English: their own lang="en" root, no panel copy', () => {
    const page = sources['/src/app/legal/Page.tsx']!;
    expect(page).toMatch(/<div lang="en"/);
    expect(page).not.toMatch(/useCopy|i18n/);
  });
});
