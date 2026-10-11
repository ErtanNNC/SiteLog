/** Tiny SQL literal helpers for the seed generator (Postgres). */

export function lit(v: unknown): string {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NULL';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'string') return `'${v.replace(/'/g, "''")}'`;
  if (v instanceof Date) return `'${v.toISOString()}'`;
  if (Array.isArray(v)) {
    if (v.length === 0) return `'{}'`;
    if (v.every((x) => typeof x === 'string')) return `array[${v.map(lit).join(',')}]::text[]`;
    if (v.every((x) => typeof x === 'number')) return `array[${v.map(lit).join(',')}]`;
    return jsonLit(v);
  }
  if (typeof v === 'object') return jsonLit(v);
  throw new Error(`Cannot serialise ${typeof v}`);
}

export function jsonLit(v: unknown): string {
  return `'${JSON.stringify(v)
    .replace(/'/g, "''")
    .replace(/\\u0000/g, '')}'::jsonb`;
}

export function ident(name: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error(`Bad identifier: ${name}`);
  return name;
}

/** `insert into t (cols) values (...), (...);` in chunks. Column list = keys of the first row minus `omit`. */
export function insertRows<T extends object>(
  table: string,
  rows: T[],
  opts: { omit?: string[]; onConflict?: string; chunk?: number } = {},
): string {
  if (rows.length === 0) return `-- ${table}: no rows\n`;
  const omit = new Set(opts.omit ?? []);
  const cols = Object.keys(rows[0] as Record<string, unknown>).filter((c) => !omit.has(c));
  const chunk = opts.chunk ?? 200;
  const out: string[] = [];
  for (let i = 0; i < rows.length; i += chunk) {
    const values = rows
      .slice(i, i + chunk)
      .map((r) => `  (${cols.map((c) => lit((r as Record<string, unknown>)[c])).join(', ')})`)
      .join(',\n');
    out.push(
      `insert into ${ident(table)} (${cols.map(ident).join(', ')}) values\n${values}${opts.onConflict ? `\n${opts.onConflict}` : ''};\n`,
    );
  }
  return out.join('\n');
}
