import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MIGRATIONS_DIR, migrationFiles } from './harness.ts';

/**
 * How the Supabase CLI applies a migration file (2.118.0: `supabase start` and `db reset` through
 * apps/cli `migration-apply.ts`, `db push` through pkg/migration `ExecBatch`): it splits the file
 * into statements and sends them as one extended-protocol pipeline with a single final Sync and
 * no BEGIN. That is one transaction, but on Postgres 17 (supabase/config.toml, the hosted project)
 * not a transaction block, so a top-level statement that requires one fails with 25P01 ("LOCK
 * TABLE can only be used in transaction blocks"). The harness runs each file as one
 * simple-protocol query, which is an implicit block, and PGlite is Postgres 18, which treats
 * pipelined statements after the first as one: the other tests cannot see it. Inside a DO block
 * such a statement is not top-level, and a lock taken there is held until the file commits.
 */
const NEEDS_TRANSACTION_BLOCK = /^(lock|savepoint|release|rollback\s+to)\b/i;

/** The file's top-level statements: `;` outside comments, quotes and dollar quotes. */
export function topLevelStatements(sql: string): string[] {
  const out: string[] = [];
  let start = 0;
  let i = 0;
  while (i < sql.length) {
    const c = sql[i]!;
    if (sql.startsWith('--', i)) {
      const nl = sql.indexOf('\n', i);
      i = nl < 0 ? sql.length : nl + 1;
    } else if (sql.startsWith('/*', i)) {
      const end = sql.indexOf('*/', i + 2);
      i = end < 0 ? sql.length : end + 2;
    } else if (c === "'") {
      const backslashes = /[eE]/.test(sql[i - 1] ?? '') && !/\w/.test(sql[i - 2] ?? '');
      for (i++; i < sql.length; i++) {
        if (backslashes && sql[i] === '\\') i++;
        else if (sql[i] === "'") {
          if (sql[i + 1] === "'") i++;
          else break;
        }
      }
      i++;
    } else if (c === '"') {
      const end = sql.indexOf('"', i + 1);
      i = end < 0 ? sql.length : end + 1;
    } else if (c === '$' && !/\w/.test(sql[i - 1] ?? '')) {
      const tag = /^\$(?:[A-Za-z_]\w*)?\$/.exec(sql.slice(i, i + 64))?.[0];
      if (tag) {
        const end = sql.indexOf(tag, i + tag.length);
        i = end < 0 ? sql.length : end + tag.length;
      } else i++;
    } else if (c === ';') {
      out.push(sql.slice(start, i));
      start = ++i;
    } else i++;
  }
  out.push(sql.slice(start));
  return out
    .map((s) => s.replace(/^(?:\s|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)*/, '').trim())
    .filter(Boolean);
}

describe('migration files as the Supabase CLI runs them', () => {
  it('splits statements outside comments, quotes and dollar quotes', () => {
    expect(
      topLevelStatements(
        "-- a; comment\nselect 'a;b', E'c\\';d';\ndo $$ begin perform ';'; end $$;\n/* x; */ create function f() returns text language sql as $f$ select 'y;' $f$;\nselect \"q;\" from t",
      ),
    ).toEqual([
      "select 'a;b', E'c\\';d'",
      "do $$ begin perform ';'; end $$",
      "create function f() returns text language sql as $f$ select 'y;' $f$",
      'select "q;" from t',
    ]);
  });

  it('has no top-level statement that needs a transaction block (wrap it in a DO block)', () => {
    const offending = migrationFiles().flatMap((file) =>
      topLevelStatements(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'))
        .filter((s) => NEEDS_TRANSACTION_BLOCK.test(s))
        .map((s) => `${file}: ${s.split('\n')[0]}`),
    );
    expect(offending).toEqual([]);
  });

  it('takes the step 10 backfill lock inside a DO block, before anything else it changes', () => {
    const statements = topLevelStatements(
      readFileSync(join(MIGRATIONS_DIR, '20261014000002_backfill_uploads_compat.sql'), 'utf8'),
    );
    expect(statements.slice(0, 2)).toEqual([
      "set local lock_timeout = '5s'",
      'do $$ begin lock table reports in access exclusive mode; end $$',
    ]);
  });
});
