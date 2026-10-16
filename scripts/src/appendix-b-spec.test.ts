import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * W3-01: spec Appendix B lists every route `field-api` serves. The routes are read from the Hono
 * app (`supabase/functions/field-api/app.ts`, `app.get|post|patch|put|delete('<path>'`) and each
 * must appear in Appendix B as `` `METHOD /field<path>` `` (the field app's logical prefix, GAP
 * D39), or `` `METHOD <path>` `` for the server-to-server `/voice/*` routes. A route added
 * without its Appendix B entry fails here.
 */

const ROOT = join(import.meta.dirname, '..', '..');
const SPEC = readFileSync(join(ROOT, 'docs', 'SITELOG_SPEC.md'), 'utf8');
const APP = readFileSync(join(ROOT, 'supabase', 'functions', 'field-api', 'app.ts'), 'utf8');

function appendixB(): string {
  const start = SPEC.indexOf('### Appendix B · Server API surface');
  const end = SPEC.indexOf('### Appendix C', start);
  expect(start).toBeGreaterThan(0);
  return SPEC.slice(start, end);
}

/** The routes the app registers: `METHOD path`. */
function servedRoutes(source: string): string[] {
  const routes = [...source.matchAll(/\bapp\.(get|post|patch|put|delete)\(\s*'([^']+)'/g)].map(
    (m) => `${m[1]!.toUpperCase()} ${m[2]!}`,
  );
  return [...new Set(routes)];
}

/** How Appendix B writes a served route. */
function specForm(route: string): string {
  const [method, path] = route.split(' ') as [string, string];
  return path.startsWith('/voice/') ? `${method} ${path}` : `${method} /field${path}`;
}

function listed(section: string, route: string): boolean {
  const form = specForm(route).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp('`' + form + '(?=[`? ])').test(section);
}

describe('spec Appendix B vs field-api', () => {
  const section = appendixB();
  const routes = servedRoutes(APP);

  it('finds the routes the app serves', () => {
    expect(routes.length).toBeGreaterThanOrEqual(28);
    expect(routes).toContain('POST /resolve');
    expect(routes).toContain('PATCH /preferences');
  });

  it('lists every served route', () => {
    const missing = routes.filter((r) => !listed(section, r));
    expect(missing, `Add these to spec Appendix B: ${missing.map(specForm).join(', ')}`).toEqual(
      [],
    );
  });

  it('notices a route that is not listed', () => {
    expect(listed(section, 'POST /no-such-route')).toBe(false);
    expect(listed(section, 'GET /resolve')).toBe(false);
    expect(servedRoutes("app.post('/voice/tools/x', h); app.get('/a/:id', h)")).toEqual([
      'POST /voice/tools/x',
      'GET /a/:id',
    ]);
    expect(specForm('POST /voice/tools/x')).toBe('POST /voice/tools/x');
  });
});
