/**
 * Compares the hand-maintained `Database` type (packages/shared/src/db/types.ts) with the types
 * Supabase generates from the real schema, so the two cannot drift apart silently.
 *
 *   supabase gen types typescript --local --schema public > /tmp/db.gen.ts
 *   pnpm --filter @sitelog/scripts db-types-drift -- /tmp/db.gen.ts
 *
 * Errors (exit 1): a table or view missing from the shared type, a column or RPC argument present
 * on one side only, a column whose types are incompatible in both directions. The shared type is
 * allowed to be stricter than the generated one (literal unions for text checks, non-null view
 * columns, nullable RPC arguments), so one-way assignability is fine. SQL helper functions that
 * clients never call are reported as notes only.
 */
import { mkdtempSync, writeFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import ts from 'typescript';

export interface DriftReport {
  errors: string[];
  notes: string[];
}

const SHARED_TYPES = resolve(import.meta.dirname, '../../packages/shared/src/db/types.ts');

export function compareDatabaseTypes(generatedFile: string): DriftReport {
  const dir = mkdtempSync(join(tmpdir(), 'sitelog-types-'));
  copyFileSync(generatedFile, join(dir, 'gen.ts'));
  const check = join(dir, 'check.ts');
  writeFileSync(
    check,
    [
      `import type { Database as G } from './gen';`,
      `import type { Database as O } from ${JSON.stringify(SHARED_TYPES.replace(/\.ts$/, ''))};`,
      `export declare const gt: G['public']['Tables']; export declare const ot: O['public']['Tables'];`,
      `export declare const gv: G['public']['Views']; export declare const ov: O['public']['Views'];`,
      `export declare const gf: G['public']['Functions']; export declare const of: O['public']['Functions'];`,
    ].join('\n'),
  );
  const program = ts.createProgram([check], {
    strict: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    allowImportingTsExtensions: true,
    noEmit: true,
    skipLibCheck: true,
  });
  const checker = program.getTypeChecker();
  const decl: Record<string, ts.Type> = {};
  ts.forEachChild(program.getSourceFile(check)!, (n) => {
    if (!ts.isVariableStatement(n)) return;
    for (const d of n.declarationList.declarations)
      if (ts.isIdentifier(d.name)) decl[d.name.text] = checker.getTypeAtLocation(d.name);
  });
  const props = (t: ts.Type) =>
    new Map(checker.getPropertiesOfType(t).map((p) => [p.name, checker.getTypeOfSymbol(p)]));
  const str = (t: ts.Type) => checker.typeToString(t, undefined, ts.TypeFormatFlags.NoTruncation);
  const assignable = (a: ts.Type, b: ts.Type) => checker.isTypeAssignableTo(a, b);

  const report: DriftReport = { errors: [], notes: [] };
  const members = (label: string, g: ts.Type, o: ts.Type) => {
    const G = props(g);
    const O = props(o);
    for (const [name, t] of G) {
      const mine = O.get(name);
      if (!mine) {
        report.errors.push(
          `${label}.${name}: in the database (${str(t)}), missing in shared types`,
        );
        continue;
      }
      if (!assignable(mine, t) && !assignable(t, mine))
        report.errors.push(`${label}.${name}: database ${str(t)} vs shared ${str(mine)}`);
    }
    for (const name of O.keys())
      if (!G.has(name))
        report.errors.push(`${label}.${name}: in shared types, not in the database`);
  };
  const group = (
    kind: 'table' | 'view' | 'function',
    g: ts.Type,
    o: ts.Type,
    part: 'Row' | 'Args',
  ) => {
    const G = props(g);
    const O = props(o);
    for (const name of G.keys()) {
      if (O.has(name)) continue;
      if (kind === 'function') report.notes.push(`function ${name}: not in shared types`);
      else report.errors.push(`${kind} ${name}: missing in shared types`);
    }
    for (const name of O.keys())
      if (!G.has(name)) report.errors.push(`${kind} ${name}: in shared types, not in the database`);
    for (const [name, gt] of G) {
      const ot = O.get(name);
      if (!ot) continue;
      const gp = props(gt).get(part);
      const op = props(ot).get(part);
      if (gp && op) members(`${kind} ${name}.${part}`, gp, op);
    }
  };
  group('table', decl.gt!, decl.ot!, 'Row');
  group('view', decl.gv!, decl.ov!, 'Row');
  group('function', decl.gf!, decl.of!, 'Args');
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const file = process.argv.slice(2).find((a) => a !== '--');
  if (!file) {
    console.error('usage: db-types-drift <generated-types.ts>');
    process.exit(2);
  }
  const { errors, notes } = compareDatabaseTypes(resolve(file));
  for (const n of notes) console.log(`note: ${n}`);
  for (const e of errors) console.error(`drift: ${e}`);
  console.log(
    errors.length ? `${errors.length} drift error(s)` : 'shared Database type matches the schema',
  );
  process.exit(errors.length ? 1 : 0);
}
