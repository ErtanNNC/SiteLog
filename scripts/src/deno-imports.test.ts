import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The edge functions import `@sitelog/shared` from source through the Deno import map
 * (`supabase/functions/deno.json`). CI runs `deno check`; this catches the usual breaks before
 * that, without Deno: an npm dependency of shared that the import map lacks or pins to another
 * version, a relative import without its `.ts` extension, and a `deno.lock` that no longer matches
 * the import map (CI's `deno check` rewrites a stale lock in its own checkout and passes, so the
 * committed lock would silently lose the integrity pin for the new package).
 */

const ROOT = join(import.meta.dirname, '..', '..');
const SHARED = join(ROOT, 'packages', 'shared');
const pkg = JSON.parse(readFileSync(join(SHARED, 'package.json'), 'utf8')) as {
  dependencies: Record<string, string>;
};
const deno = JSON.parse(readFileSync(join(ROOT, 'supabase', 'functions', 'deno.json'), 'utf8')) as {
  imports: Record<string, string>;
};
const lock = JSON.parse(readFileSync(join(ROOT, 'supabase', 'functions', 'deno.lock'), 'utf8')) as {
  specifiers: Record<string, string>;
  jsr?: Record<string, { integrity: string }>;
  npm?: Record<string, { integrity: string }>;
  workspace: { dependencies: string[] };
};
const pnpmLock = readFileSync(join(ROOT, 'pnpm-lock.yaml'), 'utf8');

/** `npm:@scope/name@1.2.3/sub` -> `{ req: 'npm:@scope/name@1.2.3', registry, name }`. */
function packageReq(target: string) {
  const m = /^(npm|jsr):(@[^/@]+\/[^/@]+|[^/@]+)@([^/]+)(?:\/.*)?$/.exec(target);
  if (!m) return null;
  const [, registry, name, version] = m as unknown as [string, 'npm' | 'jsr', string, string];
  return { req: `${registry}:${name}@${version}`, registry, name };
}

const importReqs = [
  ...new Set(
    Object.values(deno.imports)
      .map(packageReq)
      .filter((r) => r !== null)
      .map((r) => r.req),
  ),
].sort();

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return sources(p);
    return /\.ts$/.test(name) && !/\.test\.ts$/.test(name) && !/\.d\.ts$/.test(name) ? [p] : [];
  });
}

/** Module specifiers of static imports and re-exports (`import … from 'x'`, `export … from 'x'`). */
function specifiers(code: string): string[] {
  return [...code.matchAll(/^\s*(?:import|export)\b[^'"]*?from\s+'([^']+)'/gm)].map((m) => m[1]!);
}

const files = sources(join(SHARED, 'src'));

describe('packages/shared is importable by Deno', () => {
  it('pins every npm dependency of shared in the import map, at the same version', () => {
    for (const [name, range] of Object.entries(pkg.dependencies)) {
      const version = range.replace(/^[\^~]/, '');
      expect(deno.imports[name], name).toBe(`npm:${name}@${version}`);
    }
  });

  it('maps every bare import used by shared source files', () => {
    const bare = new Set(
      files.flatMap((f) => specifiers(readFileSync(f, 'utf8'))).filter((s) => !s.startsWith('.')),
    );
    expect(bare.size).toBeGreaterThan(0);
    for (const s of bare) {
      const mapped =
        s in deno.imports ||
        Object.keys(deno.imports).some((k) => k.endsWith('/') && s.startsWith(k));
      expect(mapped, `${s} is not in supabase/functions/deno.json "imports"`).toBe(true);
      const target = deno.imports[s];
      if (target?.startsWith('npm:')) {
        const pkgName = s.startsWith('@') ? s.split('/').slice(0, 2).join('/') : s.split('/')[0]!;
        const version = pkg.dependencies[pkgName]?.replace(/^[\^~]/, '');
        expect(target, s).toMatch(
          new RegExp(`^npm:${pkgName.replace('/', '\\/')}@${version}(/|$)`),
        );
      }
    }
  });

  it('uses explicit .ts extensions on relative imports', () => {
    for (const f of files) {
      for (const s of specifiers(readFileSync(f, 'utf8'))) {
        if (!s.startsWith('.')) continue;
        expect(s, relative(ROOT, f)).toMatch(/\.ts$/);
      }
    }
  });
});

describe('supabase/functions/deno.lock matches the import map', () => {
  it('lists every npm:/jsr: import, and nothing else, in workspace.dependencies', () => {
    expect(importReqs.length).toBeGreaterThan(0);
    expect([...lock.workspace.dependencies].sort()).toEqual(importReqs);
  });

  it('resolves every locked specifier to a package with an integrity hash', () => {
    // `specifiers` holds only what the module graph reaches (date-fns, a peer of date-fns-tz, is
    // mapped but not imported directly), so the import map is checked against workspace.dependencies.
    const specs = Object.entries(lock.specifiers);
    expect(specs.length).toBeGreaterThan(0);
    for (const [req, resolved] of specs) {
      const parsed = packageReq(req);
      expect(parsed, req).not.toBeNull();
      const { registry, name } = parsed!;
      const entry = lock[registry]?.[`${name}@${resolved}`];
      expect(
        entry?.integrity,
        `${name}@${resolved} has no "${registry}" entry in deno.lock`,
      ).toBeTruthy();
    }
  });

  it('pins the same tarball as pnpm-lock.yaml for packages both lockfiles hold', () => {
    let compared = 0;
    for (const [key, { integrity }] of Object.entries(lock.npm ?? {})) {
      const id = key.replace(/_.*$/, ''); // Deno appends resolved peers: `date-fns-tz@3.2.0_date-fns@4.4.0`
      const quoted = id.startsWith('@') ? `'${id}'` : id;
      const m = new RegExp(
        `^  ${quoted.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}:\\n    resolution: \\{integrity: (\\S+)\\}`,
        'm',
      ).exec(pnpmLock);
      if (!m) continue;
      expect(integrity, id).toBe(m[1]);
      compared++;
    }
    expect(compared).toBeGreaterThan(0);
  });
});
