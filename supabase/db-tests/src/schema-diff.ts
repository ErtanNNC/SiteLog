import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { SUPABASE_STUB } from './harness.ts';

/**
 * D11 end-state diff: the schema the spec's §6.2–§6.4 SQL builds versus the schema the repo's
 * migrations build. Differences are plain strings, so the allowlist (schema-allowlist.ts) can
 * name each one exactly.
 */

export const SPEC_FILE = join(import.meta.dirname, '..', '..', '..', 'docs', 'SITELOG_SPEC.md');

/**
 * The SQL of the §6.2, §6.3 and §6.4 sections, in that order: every ```sql block between the
 * section's heading and the next `##`/`###` heading, joined in document order, so a block added
 * later (an `alter table`, indexes split from views) is compared too.
 */
export function specSqlBlocks(markdown = readFileSync(SPEC_FILE, 'utf8')): Record<string, string> {
  const blocks: Record<string, string> = {};
  for (const section of ['6.2', '6.3', '6.4']) {
    const heading = markdown.search(new RegExp(`^### ${section.replace('.', '\\.')} `, 'm'));
    if (heading < 0) throw new Error(`spec heading ### ${section} not found`);
    const rest = markdown.slice(heading);
    const next = rest.slice(4).search(/^#{2,3} /m);
    const body = next < 0 ? rest : rest.slice(0, next + 4);
    const sql = [...body.matchAll(/^```sql\n([\s\S]*?)^```/gm)].map((m) => m[1]!);
    if (sql.length === 0) throw new Error(`no sql block under ### ${section}`);
    blocks[section] = sql.join('\n');
  }
  return blocks;
}

/** A fresh PGlite with the Supabase stubs and only the spec's §6.2–§6.4 SQL. */
export async function bootSpecDatabase(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(SUPABASE_STUB);
  for (const [section, sql] of Object.entries(specSqlBlocks())) {
    try {
      await db.exec(sql);
    } catch (err) {
      throw new Error(`spec §${section} SQL failed: ${(err as Error).message}`, { cause: err });
    }
  }
  return db;
}

export interface Column {
  type: string;
  notNull: boolean;
  /** Default expression, `generated: <expr>` for a generated column, or null. */
  default: string | null;
}

export interface SchemaSnapshot {
  tables: Map<string, Map<string, Column>>;
  views: Map<string, Map<string, string>>;
  enums: Map<string, string[]>;
  /** Per table: primary key, unique, foreign key and check constraints (definitions, no names). */
  constraints: Map<string, Set<string>>;
  /** Per table: indexes that back no constraint, without their names. */
  indexes: Map<string, Set<string>>;
}

const push = <K, V>(m: Map<K, V[]>, k: K, v: V) => m.set(k, [...(m.get(k) ?? []), v]);

export async function schemaSnapshot(db: PGlite): Promise<SchemaSnapshot> {
  const cols = await db.query<{
    rel: string;
    relkind: string;
    col: string;
    type: string;
    not_null: boolean;
    def: string | null;
    generated: string;
  }>(`
    select c.relname as rel, c.relkind::text as relkind, a.attname as col,
           format_type(a.atttypid, a.atttypmod) as type, a.attnotnull as not_null,
           pg_get_expr(d.adbin, d.adrelid) as def, a.attgenerated::text as generated
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
    join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
    left join pg_attrdef d on d.adrelid = c.oid and d.adnum = a.attnum
    where c.relkind in ('r', 'v')
    order by c.relname, a.attnum`);
  const tables = new Map<string, Map<string, Column>>();
  const views = new Map<string, Map<string, string>>();
  for (const r of cols.rows) {
    if (r.relkind === 'v') {
      if (!views.has(r.rel)) views.set(r.rel, new Map());
      views.get(r.rel)!.set(r.col, r.type);
      continue;
    }
    if (!tables.has(r.rel)) tables.set(r.rel, new Map());
    tables.get(r.rel)!.set(r.col, {
      type: r.type,
      notNull: r.not_null,
      default: r.generated === 's' ? `generated: ${r.def}` : r.def,
    });
  }

  const enumRows = await db.query<{ name: string; label: string }>(`
    select t.typname as name, e.enumlabel as label
    from pg_type t join pg_namespace n on n.oid = t.typnamespace and n.nspname = 'public'
    join pg_enum e on e.enumtypid = t.oid
    order by t.typname, e.enumsortorder`);
  const enums = new Map<string, string[]>();
  for (const r of enumRows.rows) push(enums, r.name, r.label);

  const conRows = await db.query<{ rel: string; def: string }>(`
    select c.relname as rel, pg_get_constraintdef(k.oid) as def
    from pg_constraint k join pg_class c on c.oid = k.conrelid
    join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
    where k.contype in ('p', 'u', 'f', 'c')
    order by 1, 2`);
  const constraints = new Map<string, Set<string>>();
  for (const r of conRows.rows) {
    if (!constraints.has(r.rel)) constraints.set(r.rel, new Set());
    constraints.get(r.rel)!.add(r.def);
  }

  const idxRows = await db.query<{ rel: string; def: string }>(`
    select c.relname as rel, pg_get_indexdef(i.indexrelid) as def
    from pg_index i join pg_class c on c.oid = i.indrelid
    join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
    where not exists (select 1 from pg_constraint k where k.conindid = i.indexrelid)
    order by 1, 2`);
  const indexes = new Map<string, Set<string>>();
  for (const r of idxRows.rows) {
    if (!indexes.has(r.rel)) indexes.set(r.rel, new Set());
    // "CREATE INDEX name ON public.t USING btree (a, b DESC)" → "btree (a, b DESC)" (+ UNIQUE, WHERE)
    const m = /^CREATE (UNIQUE )?INDEX \S+ ON \S+ USING (.*)$/.exec(r.def);
    indexes.get(r.rel)!.add(m ? `${m[1] ?? ''}${m[2]}` : r.def);
  }

  return { tables, views, enums, constraints, indexes };
}

const show = (c: Column) =>
  `${c.type}${c.notNull ? ' not null' : ''}${c.default ? ` default ${c.default}` : ''}`;

/**
 * Every difference between the spec schema and the repo schema, as sorted strings:
 * tables and enums both ways; columns (type, nullability, default) both ways; constraints both
 * ways; spec indexes and spec view columns missing from the repo (extra repo indexes and view
 * columns are fine). A table on one side only is one difference (its columns are not listed).
 */
export function diffSchemas(spec: SchemaSnapshot, repo: SchemaSnapshot): string[] {
  const out: string[] = [];
  for (const [name, labels] of spec.enums) {
    const mine = repo.enums.get(name);
    if (!mine) out.push(`enum missing: ${name}`);
    else if (mine.join(',') !== labels.join(','))
      out.push(`enum labels: ${name} (spec ${labels.join(',')}; repo ${mine.join(',')})`);
  }
  for (const name of repo.enums.keys()) if (!spec.enums.has(name)) out.push(`enum extra: ${name}`);

  for (const [table, cols] of spec.tables) {
    const mine = repo.tables.get(table);
    if (!mine) {
      out.push(`table missing: ${table}`);
      continue;
    }
    for (const [col, c] of cols) {
      const m = mine.get(col);
      if (!m) {
        out.push(`column missing: ${table}.${col} (${show(c)})`);
        continue;
      }
      if (m.type !== c.type)
        out.push(`column type: ${table}.${col} (spec ${c.type}; repo ${m.type})`);
      if (m.notNull !== c.notNull)
        out.push(
          `column nullability: ${table}.${col} (spec ${c.notNull ? 'not null' : 'null'}; repo ${m.notNull ? 'not null' : 'null'})`,
        );
      if (m.default !== c.default)
        out.push(
          `column default: ${table}.${col} (spec ${c.default ?? 'none'}; repo ${m.default ?? 'none'})`,
        );
    }
    for (const [col, m] of mine)
      if (!cols.has(col)) out.push(`column extra: ${table}.${col} (${show(m)})`);

    const sc = spec.constraints.get(table) ?? new Set<string>();
    const rc = repo.constraints.get(table) ?? new Set<string>();
    for (const def of sc) if (!rc.has(def)) out.push(`constraint missing: ${table} ${def}`);
    for (const def of rc) if (!sc.has(def)) out.push(`constraint extra: ${table} ${def}`);

    const ri = repo.indexes.get(table) ?? new Set<string>();
    for (const def of spec.indexes.get(table) ?? []) {
      if (!ri.has(def)) out.push(`index missing: ${table} ${def}`);
    }
  }
  for (const table of repo.tables.keys())
    if (!spec.tables.has(table)) out.push(`table extra: ${table}`);

  for (const [view, cols] of spec.views) {
    const mine = repo.views.get(view);
    if (!mine) {
      out.push(`view missing: ${view}`);
      continue;
    }
    for (const [col, type] of cols) {
      const t = mine.get(col);
      if (!t) out.push(`view column missing: ${view}.${col} (${type})`);
      else if (t !== type) out.push(`view column type: ${view}.${col} (spec ${type}; repo ${t})`);
    }
  }
  return out.sort();
}
