import { beforeAll, describe, expect, it } from 'vitest';
import { bootDatabase } from './harness.ts';
import { SCHEMA_ALLOWLIST } from './schema-allowlist.ts';
import {
  bootSpecDatabase,
  diffSchemas,
  schemaSnapshot,
  specSqlBlocks,
  type SchemaSnapshot,
} from './schema-diff.ts';

/**
 * D11: "DDL §6.3 verbatim" read as end-state equivalence. The spec's §6.2–§6.4 SQL goes into one
 * fresh PGlite, the repo's migrations into another; tables, columns (type, nullability, default),
 * enum labels in order, constraints, the §6.4 indexes and view columns are compared. Every
 * difference must be in schema-allowlist.ts with its reason and closing step, and every allowlist
 * line must still be a real difference.
 */

let spec: SchemaSnapshot;
let repo: SchemaSnapshot;
let diffs: string[];

beforeAll(async () => {
  spec = await schemaSnapshot(await bootSpecDatabase());
  repo = await schemaSnapshot(await bootDatabase());
  diffs = diffSchemas(spec, repo);
});

describe('schema end state (D11)', () => {
  it('reads the §6.2–§6.4 SQL blocks from the spec', () => {
    const blocks = specSqlBlocks();
    expect(blocks['6.2']).toMatch(/create type member_role/);
    expect(blocks['6.3']).toMatch(/create table orgs/);
    // countries before orgs: orgs.country references it.
    expect(blocks['6.3']!.indexOf('create table countries')).toBeLessThan(
      blocks['6.3']!.indexOf('create table orgs'),
    );
    expect(blocks['6.4']).toMatch(/create view current_manpower/);
    // The whole spec schema was read: 33 tables (GAP 9.2, plus countries since W1-06a and
    // console_emails and sms_opt_outs since W1-08) and the 26 enums of §6.2 (message_channel since W1-06a), and
    // from §6.4 its 9 indexes, the unique sender id of W1-08 and 2 views (spec.indexes also holds
    // §6.3's one, on jobs).
    expect(spec.tables.size).toBe(33);
    expect(spec.enums.size).toBe(26);
    expect(blocks['6.4']!.match(/^create index /gm)).toHaveLength(9);
    expect(blocks['6.4']!.match(/^create unique index /gm)).toHaveLength(1);
    const indexes = [...spec.indexes.values()].reduce((n, set) => n + set.size, 0);
    expect(indexes).toBe(11);
    expect(spec.indexes.get('countries')).toEqual(
      new Set(['UNIQUE btree (sms_sender_id) WHERE (sms_sender_id IS NOT NULL)']),
    );
    expect(spec.indexes.get('jobs')).toEqual(new Set(['btree (status, run_after)']));
    expect(spec.views.size).toBe(2);
  });

  it('reads every sql block of a section, up to the next heading', () => {
    const md = [
      '### 6.2 Enums',
      '```sql',
      "create type a as enum ('x');",
      '```',
      'Text between blocks.',
      '```sql',
      "create type b as enum ('y');",
      '```',
      '### 6.3 Tables',
      '```sql',
      'create table t (id int);',
      '```',
      '#### A sub-heading keeps the section open',
      '```sql',
      'alter table t add column c int;',
      '```',
      '### 6.4 Indexes',
      '```sql',
      'create index on t (id);',
      '```',
      '### 6.5 Next',
      '```sql',
      'create table not_read (id int);',
      '```',
    ].join('\n');
    const blocks = specSqlBlocks(md);
    expect(blocks['6.2']).toBe("create type a as enum ('x');\n\ncreate type b as enum ('y');\n");
    expect(blocks['6.3']).toMatch(/alter table t add column c int;/);
    expect(blocks['6.4']).not.toMatch(/not_read/);
  });

  it('compares like with like', () => {
    // Identical schemas give no difference, and step 8 gave report_status the spec's labels.
    expect(diffSchemas(spec, spec)).toEqual([]);
    expect(repo.enums.get('report_status')).toEqual(spec.enums.get('report_status'));
  });

  it('differs from the spec only where the allowlist says why', () => {
    const listed = new Map<string, string>();
    for (const entry of SCHEMA_ALLOWLIST) {
      for (const d of entry.diffs) {
        expect(listed.has(d), `listed twice: ${d}`).toBe(false);
        listed.set(d, entry.id);
      }
    }
    const actual = new Set(diffs);
    const unlisted = diffs.filter((d) => !listed.has(d));
    const problems: string[] = [];
    for (const d of unlisted) problems.push(`not in the allowlist: ${d}`);
    for (const entry of SCHEMA_ALLOWLIST) {
      for (const d of entry.diffs) {
        if (entry.pending && actual.has(d))
          problems.push(
            `${entry.id}: now a real difference, drop "pending" (${entry.pending}): ${d}`,
          );
        if (!entry.pending && !actual.has(d))
          problems.push(`${entry.id}: no longer a difference, remove it from the allowlist: ${d}`);
      }
      // A pending entry whose precondition is gone but whose deviation never appeared is stale:
      // the step landed in another shape (e.g. the column came out NOT NULL as in the spec).
      for (const d of entry.pendingWhile ?? []) {
        if (entry.pending && !actual.has(d))
          problems.push(
            `${entry.id}: still pending (${entry.pending}) but "${d}" is no longer a difference: the deviation did not appear, fix the schema or remove the entry and its README row`,
          );
      }
    }
    expect(problems).toEqual([]);
  });

  it('gives every allowlist entry a reason and a closing step', () => {
    const ids = new Set<string>();
    for (const entry of SCHEMA_ALLOWLIST) {
      expect(ids.has(entry.id), entry.id).toBe(false);
      ids.add(entry.id);
      expect(entry.reason.length, entry.id).toBeGreaterThan(20);
      expect(entry.closes, entry.id).toMatch(/^(kept|W1-\d\d( step \d+)?|step \d+)$/);
      if (entry.closes === 'kept') expect(entry.decision, entry.id).toBeTruthy();
      expect(entry.diffs.length, entry.id).toBeGreaterThan(0);
      // Pending and its precondition go together; the precondition is never the entry's own diff.
      expect(Boolean(entry.pendingWhile?.length), `${entry.id}: pending needs pendingWhile`).toBe(
        Boolean(entry.pending),
      );
      for (const d of entry.pendingWhile ?? []) expect(entry.diffs, entry.id).not.toContain(d);
    }
  });
});
