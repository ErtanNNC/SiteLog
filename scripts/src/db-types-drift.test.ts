import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { compareDatabaseTypes } from './db-types-drift';

/** A tiny stand-in for `supabase gen types` output: one table, one view, one function. */
function generated(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'drift-test-'));
  const file = join(dir, 'db.gen.ts');
  writeFileSync(
    file,
    `export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];
export type Database = { public: { ${body} Enums: {}; CompositeTypes: {} } };`,
  );
  return file;
}

describe('db-types-drift', () => {
  it('reports tables, columns and arguments that exist on one side only', () => {
    const file = generated(`
      Tables: {
        orgs: { Row: { id: string; name: string; new_column: number }; Insert: {}; Update: {}; Relationships: [] };
        brand_new_table: { Row: { id: string }; Insert: {}; Update: {}; Relationships: [] };
      };
      Views: {};
      Functions: { sign_off_report: { Args: { p_report_id: string; p_extra: string }; Returns: undefined } };
    `);
    const { errors } = compareDatabaseTypes(file);
    expect(errors).toContain('table brand_new_table: missing in shared types');
    expect(errors.some((e) => e.startsWith('table orgs.Row.new_column: in the database'))).toBe(
      true,
    );
    expect(errors.some((e) => e.startsWith('table orgs.Row.timezone: in shared types'))).toBe(true);
    expect(errors.some((e) => e.startsWith('function sign_off_report.Args.p_extra'))).toBe(true);
    // Every other shared table is reported as absent from this (fake) database.
    expect(errors).toContain('table reports: in shared types, not in the database');
  });

  it('accepts a shared type that is stricter than the database', () => {
    const file = generated(`
      Tables: {};
      Views: {};
      Functions: {};
    `);
    const { errors } = compareDatabaseTypes(file);
    expect(errors.every((e) => e.endsWith('in shared types, not in the database'))).toBe(true);
  });
});
