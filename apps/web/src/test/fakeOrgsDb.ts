import type { Db } from '@/lib/supabase';

type Row = Record<string, unknown>;

/**
 * PostgREST as `fetchOrgs` meets it: a select with `.eq()` filters, where an embedded resource
 * (`orgs(id, name)`, joined on `org_id`) answers only the columns the select names. A column the
 * query leaves out is missing here as it is on the server, so a test sees what the panel would.
 */
export function fakeOrgsDb(tables: Record<string, Row[]>): { db: Db; selects: string[] } {
  const selects: string[] = [];
  const pick = (r: Row, cols: string[]) =>
    Object.fromEntries(cols.filter((c) => r[c] !== undefined).map((c) => [c, r[c]]));
  const db = {
    from(table: string) {
      let columns = '*';
      const filters: Array<(r: Row) => boolean> = [];
      const query = {
        select(cols: string) {
          columns = cols;
          selects.push(`${table}: ${cols}`);
          return query;
        },
        eq(column: string, value: unknown) {
          filters.push((r) => r[column] === value);
          return query;
        },
        then<A>(onfulfilled: (v: { data: Row[]; error: null }) => A) {
          const embed = /(\w+)\(([^)]*)\)/.exec(columns);
          const own = columns
            .replace(/\w+\([^)]*\)/g, '')
            .split(',')
            .map((c) => c.trim())
            .filter(Boolean);
          const data = (tables[table] ?? [])
            .filter((r) => filters.every((f) => f(r)))
            .map((r) => {
              const out = own.includes('*') ? { ...r } : pick(r, own);
              if (embed) {
                const resource = embed[1]!;
                const target = (tables[resource] ?? []).find((x) => x.id === r.org_id);
                out[resource] = target
                  ? pick(
                      target,
                      embed[2]!.split(',').map((c) => c.trim()),
                    )
                  : null;
              }
              return out;
            });
          return Promise.resolve({ data, error: null }).then(onfulfilled);
        },
      };
      return query;
    },
  };
  return { db: db as unknown as Db, selects };
}
