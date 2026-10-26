import { beforeAll, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { bootDatabase, probeAs, type Caller, type ProbeResult } from './harness.ts';
import {
  BUCKETS,
  ORG,
  ROLES,
  objectName,
  other,
  seedTwoOrgs,
  type OrgKey,
  type Role,
} from './fixtures/two-orgs.ts';
import {
  KNOWN_DEFECTS,
  OPS,
  PROBES,
  RPCS,
  STORAGE,
  TABLES,
  VIEWS,
  storageCell,
  type CellOp,
  type KnownDefect,
  type Op,
  type Scope,
} from './fixtures/role-matrix.ts';

/**
 * §2.2 role matrix (W1-05 step 9 test base): two orgs × admin/pm/ops/accounts ×
 * select/insert/update/delete on every table, plus the owner-privileged views, the storage
 * buckets, the role-checked report RPCs, and the probes for defects one row cannot show.
 * Expectations, known defects and probes: fixtures/role-matrix.ts.
 */

let db: PGlite;

beforeAll(async () => {
  db = await bootDatabase({ storage: true });
  await seedTwoOrgs(db);
});

const caller = (org: OrgKey, role: Role): Caller => ({
  role: 'authenticated',
  userId: ORG[org].users[role],
  email: `${role}-${org}@matrix.test`,
});

/**
 * Allowed (true), denied (false), or an unexpected error (its SQLSTATE and message), which the
 * matrix reports as a wrong cell. 42501 = no privilege or row-level security; class 23 on an
 * insert = RLS let the row through and a constraint stopped it.
 */
function allowed(res: ProbeResult, op: CellOp): boolean | string {
  if (res.ok) {
    if (op === 'select') return Number(res.rows[0]?.n ?? 0) > 0;
    if (op === 'execute') return true;
    return res.affectedRows > 0;
  }
  if (res.code === '42501') return false;
  if (op === 'insert' && res.code.startsWith('23')) return true;
  return `error ${res.code}: ${res.message}`;
}

function statement(table: string, op: Op, org: OrgKey): string {
  const t = TABLES[table]!;
  const o = ORG[org];
  const write = t.writeWhere ?? t.where;
  switch (op) {
    case 'select':
      return `select count(*)::int as n from ${table} where ${t.where(o)}`;
    case 'insert':
      return t.insert(o);
    case 'update':
      return `update ${table} set ${t.set} where ${write(o)}`;
    case 'delete':
      return `delete from ${table} where ${write(o)}`;
  }
}

/** The roles the matrix allows for a cell of its own org (tables, views, buckets, RPCs). */
function allowedRoles(table: string, op: CellOp): readonly Role[] | undefined {
  if (op === 'execute') return RPCS[table]?.allow;
  if (TABLES[table]) return TABLES[table].allow[op];
  if (op !== 'select') return undefined;
  if (VIEWS[table]) return VIEWS[table].select;
  const bucket = BUCKETS.find((b) => storageCell(b) === table);
  return bucket ? STORAGE[bucket].select : undefined;
}

interface Cell {
  /** The caller's org. */
  org: OrgKey;
  table: string;
  op: CellOp;
  role: Role;
  scope: Scope;
  expected: boolean;
  actual: boolean | string;
  sql: string;
}

const key = (c: { table: string; op: CellOp; role: Role; scope: Scope }) =>
  `${c.table} ${c.op} ${c.role} ${c.scope}`;

const scopes = ['own', 'other'] as const;
const orgs = ['A', 'B'] as const;

/** Not org-scoped (TableCase.orgless): only tables can be; views, buckets and RPCs are org data. */
const isOrgless = (table: string) => TABLES[table]?.orgless === true;

/**
 * The expectation of a cell: allowed for the matrix's roles in their own org, denied in the other
 * org. An orgless table has no other org's row: its other-org probe repeats the own one, so it
 * expects the same answer. Used by measure() and the KNOWN_DEFECTS check alike.
 */
const expectedFor = (table: string, scope: Scope, roles: readonly Role[], role: Role) =>
  (scope === 'own' || isOrgless(table)) && roles.includes(role);

/** Every cell: org × role × own/other for each statement, run as that caller and rolled back. */
async function measure(): Promise<Cell[]> {
  const cells: Cell[] = [];
  const run = async (
    table: string,
    op: CellOp,
    sqlFor: (target: OrgKey) => string,
    roles: readonly Role[],
  ) => {
    for (const org of orgs)
      for (const role of ROLES)
        for (const scope of scopes) {
          const sql = sqlFor(scope === 'own' || isOrgless(table) ? org : other(org));
          const actual = allowed(await probeAs(db, caller(org, role), sql), op);
          const expected = expectedFor(table, scope, roles, role);
          cells.push({ org, table, op, role, scope, expected, actual, sql });
        }
  };
  for (const [table, t] of Object.entries(TABLES))
    for (const op of OPS)
      await run(table, op, (target) => statement(table, op, target), t.allow[op]);
  for (const [view, v] of Object.entries(VIEWS))
    await run(
      view,
      'select',
      (target) => `select count(*)::int as n from ${view} where ${v.where(ORG[target])}`,
      v.select,
    );
  for (const bucket of BUCKETS)
    await run(
      storageCell(bucket),
      'select',
      (target) =>
        `select count(*)::int as n from storage.objects where bucket_id = '${bucket}' and name = '${objectName(ORG[target], bucket)}'`,
      STORAGE[bucket].select,
    );
  for (const [fn, r] of Object.entries(RPCS))
    await run(fn, 'execute', (target) => r.call(ORG[target]), r.allow);
  return cells;
}

describe('role matrix (§2.2)', () => {
  it('lists every table and view in public', async () => {
    const res = await db.query<{ relname: string; relkind: string }>(
      `select c.relname, c.relkind from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind in ('r', 'v') order by 1`,
    );
    const tables = res.rows.filter((r) => r.relkind === 'r').map((r) => r.relname);
    const views = res.rows.filter((r) => r.relkind === 'v').map((r) => r.relname);
    expect(Object.keys(TABLES).sort(), 'tables in fixtures/role-matrix.ts').toEqual(tables);
    expect(Object.keys(VIEWS).sort(), 'views in fixtures/role-matrix.ts').toEqual(views);
    const buckets = await db.query<{ id: string }>(`select id from storage.buckets order by 1`);
    expect([...BUCKETS].sort(), 'buckets in fixtures/two-orgs.ts').toEqual(
      buckets.rows.map((r) => r.id),
    );
  });

  it('probes real fixture rows (a denied cell on a missing row would prove nothing)', async () => {
    await db.exec('reset role;');
    const empty: string[] = [];
    const count = async (label: string, sql: string) => {
      const res = await db.query<{ n: number }>(sql);
      if (!(Number(res.rows[0]?.n) > 0)) empty.push(label);
    };
    for (const org of orgs) {
      const o = ORG[org];
      for (const [table, t] of Object.entries(TABLES)) {
        await count(
          `${table} (org ${org})`,
          `select count(*)::int as n from ${table} where ${t.where(o)}`,
        );
        if (t.writeWhere)
          await count(
            `${table} writeWhere (org ${org})`,
            `select count(*)::int as n from ${table} where ${t.writeWhere(o)}`,
          );
      }
      for (const [view, v] of Object.entries(VIEWS))
        await count(
          `${view} (org ${org})`,
          `select count(*)::int as n from ${view} where ${v.where(o)}`,
        );
      for (const bucket of BUCKETS)
        await count(
          `${storageCell(bucket)} (org ${org})`,
          `select count(*)::int as n from storage.objects where bucket_id = '${bucket}' and name = '${objectName(o, bucket)}'`,
        );
      // The RPC target: a filed report (sign-off and office edits need one).
      await count(
        `filed report (org ${org})`,
        `select count(*)::int as n from reports where id = '${o.report}' and status = 'filed'`,
      );
    }
    expect(empty).toEqual([]);
  });

  it('gives every role exactly its §2.2 access, in its own org only', async () => {
    const cells = await measure();
    const defects = new Map<string, KnownDefect>(KNOWN_DEFECTS.map((d) => [key(d), d]));
    const wrong: string[] = [];
    const seen = new Set<string>();
    const show = (a: boolean | string) => (typeof a === 'string' ? a : a ? 'allowed' : 'denied');
    for (const c of cells) {
      const where = `${key(c)} (caller in org ${c.org})`;
      if (typeof c.actual === 'string') {
        wrong.push(`${where}: ${c.actual} [${c.sql}]`);
        continue;
      }
      const d = defects.get(key(c));
      if (d) {
        seen.add(key(c));
        if (c.actual !== d.today)
          wrong.push(
            `${where}: now ${show(c.actual)}; the known defect (${d.fixedBy}) is fixed, remove its KNOWN_DEFECTS entry`,
          );
        continue;
      }
      if (c.actual !== c.expected)
        wrong.push(`${where}: ${show(c.actual)}, expected ${show(c.expected)}`);
    }
    for (const d of KNOWN_DEFECTS) {
      if (!seen.has(key(d))) {
        wrong.push(`KNOWN_DEFECTS entry matches no cell: ${key(d)}`);
        continue;
      }
      const roles = allowedRoles(d.table, d.op) ?? [];
      if (expectedFor(d.table, d.scope, roles, d.role) === d.today)
        wrong.push(`KNOWN_DEFECTS entry agrees with the expectation: ${key(d)}`);
    }
    expect(wrong).toEqual([]);
    // Every cell was probed with a caller from each org.
    const statements =
      Object.keys(TABLES).length * OPS.length +
      Object.keys(VIEWS).length +
      BUCKETS.length +
      Object.keys(RPCS).length;
    expect(cells.length).toBe(statements * orgs.length * ROLES.length * scopes.length);
  });

  it.each(PROBES.map((p) => [p.name, p] as const))('%s', async (_name, p) => {
    const res = await probeAs(db, caller(p.org, p.role), p.sql);
    const refusal = p.refusal ?? ['42501'];
    expect(
      res.ok || refusal.includes(res.code),
      res.ok
        ? ''
        : `unexpected error ${res.code} (refusals: ${refusal.join(', ')}): ${res.message}`,
    ).toBe(true);
    const actual = res.ok
      ? p.kind === 'select'
        ? res.rows.length > 0
        : res.affectedRows > 0
      : false;
    if (p.defect) {
      expect(
        actual,
        `known defect (${p.defect.fixedBy}; ${p.defect.ref}): if fixed, drop "defect" from the probe`,
      ).toBe(p.defect.today);
      expect(p.defect.today).not.toBe(p.expect);
    } else {
      expect(actual).toBe(p.expect);
    }
  });
});
