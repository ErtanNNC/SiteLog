import { describe, expect, it } from 'vitest';

/**
 * W4-09 (spec §19 Q240): every panel page speaks the panel's language (EN/TR) but `/try` (v1.0's
 * WhatsApp simulator, until GAP step 22 removes it) and `/ops` (TalkOlog staff only), which stay
 * English under `<EnglishOnly>` (README "Deliberate deviations"). A new page that comes in wrapped,
 * or a wrapper used anywhere but the route map, fails here.
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
