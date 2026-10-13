import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';

/**
 * Boots an in-memory Postgres (PGlite), stubs the parts of Supabase the migrations rely on
 * (auth schema, auth.uid()/auth.jwt(), roles) and applies supabase/migrations in order.
 * RLS is exercised by `SET ROLE authenticated` + `request.jwt.claims` (asUser) or `SET ROLE anon`
 * (asAnon).
 *
 * Grants are Supabase's, and only those (supabase/postgres
 * migrations/db/init-scripts/00000000000000-initial-schema.sql): the API roles `anon`,
 * `authenticated` and `service_role` (noinherit; `service_role` bypasses RLS) get usage on the
 * schemas and, through default privileges of the role that runs the migrations (`postgres`), all
 * privileges on every table, view, sequence and function the migrations create. Postgres itself
 * also lets PUBLIC execute every new function. Nothing is re-granted after the migrations, so a
 * `revoke` in a migration (a function, a view, a column) is in force here as on the real stack,
 * and a grant a migration forgets shows up as a test failure.
 */

const ROOT = join(import.meta.dirname, '..', '..');
export const MIGRATIONS_DIR = join(ROOT, 'migrations');
export const SEED_FILE = join(ROOT, 'seed.sql');

export const SUPABASE_STUB = `
  create schema if not exists auth;
  create schema if not exists extensions;
  create table if not exists auth.users (
    id uuid primary key,
    instance_id uuid,
    email text,
    aud text,
    role text,
    encrypted_password text,
    email_confirmed_at timestamptz,
    raw_app_meta_data jsonb,
    raw_user_meta_data jsonb,
    created_at timestamptz,
    updated_at timestamptz,
    confirmation_token text,
    recovery_token text,
    email_change text,
    email_change_token_new text,
    is_sso_user boolean default false
  );
  create or replace function auth.uid() returns uuid language sql stable as $$
    select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
  $$;
  create or replace function auth.jwt() returns jsonb language sql stable as $$
    select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb
  $$;
  create or replace function auth.role() returns text language sql stable as $$
    select nullif(current_setting('request.jwt.claim.role', true), '')
  $$;
  do $$ begin
    if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin noinherit; end if;
    if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin noinherit; end if;
    if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin noinherit bypassrls; end if;
  end $$;
  grant usage on schema public to anon, authenticated, service_role;
  grant usage on schema extensions to anon, authenticated, service_role;
  grant usage on schema auth to anon, authenticated, service_role;
  alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
  alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
  alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
`;

/**
 * A stand-in for Supabase's `storage` schema (supabase/storage migrations): buckets, objects with
 * RLS, `storage.foldername()`, and the API roles' grants (all privileges on the tables to `anon`,
 * `authenticated` and `service_role`; RLS decides). There is no foreign key from objects to
 * buckets, so a test can put objects in a bucket the migrations never created.
 */
export const STORAGE_STUB = `
  create schema if not exists storage;
  create table storage.buckets (
    id text primary key,
    name text not null,
    public boolean default false,
    created_at timestamptz not null default now()
  );
  create table storage.objects (
    id uuid primary key default gen_random_uuid(),
    bucket_id text not null,
    name text not null,
    owner uuid default auth.uid(),
    created_at timestamptz not null default now()
  );
  create function storage.foldername(name text) returns text[] language sql immutable as $$
    select (string_to_array(name, '/'))[1:array_length(string_to_array(name, '/'), 1) - 1]
  $$;
  alter table storage.buckets enable row level security;
  alter table storage.objects enable row level security;
  grant usage on schema storage to anon, authenticated, service_role;
  grant all on storage.buckets, storage.objects to anon, authenticated, service_role;
`;

export async function installStorageStub(db: PGlite): Promise<void> {
  await db.exec(STORAGE_STUB);
}

/**
 * The storage blocks of one migration file (`do $$ … if exists (… nspname = 'storage') … $$;`),
 * in order, to replay on a database whose storage schema was added after the migrations.
 */
export function storageBlocks(file: string): string[] {
  const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
  return [
    ...sql.matchAll(
      /^do \$\$\nbegin\n {2}if exists \(select 1 from pg_namespace where nspname = 'storage'\) then\n[\s\S]*?^end \$\$;/gm,
    ),
  ].map((m) => m[0]);
}

/**
 * `storage: true` adds the storage stub before the migrations, as on the real stack, so their
 * guarded storage blocks create the buckets and every storage policy in migration order.
 */
export async function bootDatabase(
  opts: { seed?: boolean; storage?: boolean } = {},
): Promise<PGlite> {
  const db = new PGlite({ extensions: { pgcrypto } });
  await db.exec(SUPABASE_STUB);
  if (opts.storage) await installStorageStub(db);
  for (const file of migrationFiles()) {
    const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
    try {
      await db.exec(sql);
    } catch (err) {
      throw new Error(`Migration ${file} failed: ${(err as Error).message}`, { cause: err });
    }
  }
  if (opts.seed) {
    const sql = readFileSync(SEED_FILE, 'utf8');
    await db.exec(sql);
  }
  return db;
}

export function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();
}

/** Run `fn` as an authenticated user (RLS applies). */
export async function asUser<T>(
  db: PGlite,
  userId: string,
  fn: (q: typeof db.query) => Promise<T>,
  email = 'user@example.com',
): Promise<T> {
  await db.exec(`
    set role authenticated;
    select set_config('request.jwt.claim.sub', '${userId}', false);
    select set_config('request.jwt.claim.role', 'authenticated', false);
    select set_config('request.jwt.claims', '${JSON.stringify({ sub: userId, role: 'authenticated', email }).replace(/'/g, "''")}', false);
  `);
  try {
    return await fn(db.query.bind(db));
  } finally {
    await db.exec(`
      reset role;
      select set_config('request.jwt.claim.sub', '', false);
      select set_config('request.jwt.claim.role', '', false);
      select set_config('request.jwt.claims', '', false);
    `);
  }
}

/** Run `fn` as the anonymous API role (`anon` key without a session): RLS applies, no auth.uid(). */
export async function asAnon<T>(db: PGlite, fn: (q: typeof db.query) => Promise<T>): Promise<T> {
  await db.exec(`
    set role anon;
    select set_config('request.jwt.claim.sub', '', false);
    select set_config('request.jwt.claim.role', 'anon', false);
    select set_config('request.jwt.claims', '{"role":"anon"}', false);
  `);
  try {
    return await fn(db.query.bind(db));
  } finally {
    await db.exec(`
      reset role;
      select set_config('request.jwt.claim.role', '', false);
      select set_config('request.jwt.claims', '', false);
    `);
  }
}

/** Who runs a probe: the anonymous API role, or a signed-in office user. */
export type Caller = { role: 'anon' } | { role: 'authenticated'; userId: string; email?: string };

export type ProbeResult =
  | { ok: true; rows: Record<string, unknown>[]; affectedRows: number }
  | { ok: false; code: string; message: string };

/**
 * Runs one statement as `caller` inside a transaction that is always rolled back, so a matrix of
 * probes can share one database. Returns the rows and affected-row count, or the SQLSTATE of the
 * error (42501 = no privilege or a row-level security violation).
 */
export async function probeAs(
  db: PGlite,
  caller: Caller,
  sql: string,
  params: unknown[] = [],
): Promise<ProbeResult> {
  const claims =
    caller.role === 'anon'
      ? { role: 'anon' }
      : { sub: caller.userId, role: 'authenticated', email: caller.email ?? 'user@example.com' };
  await db.exec('begin');
  try {
    await db.query(`select set_config('request.jwt.claim.sub', $1, true)`, [
      caller.role === 'anon' ? '' : caller.userId,
    ]);
    await db.query(`select set_config('request.jwt.claim.role', $1, true)`, [caller.role]);
    await db.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify(claims)]);
    await db.exec(`set local role ${caller.role}`);
    const res = await db.query<Record<string, unknown>>(sql, params);
    return { ok: true, rows: res.rows, affectedRows: res.affectedRows ?? 0 };
  } catch (err) {
    const e = err as { code?: string; message?: string };
    return { ok: false, code: e.code ?? '', message: e.message ?? String(err) };
  } finally {
    await db.exec('rollback');
  }
}

export async function asService<T>(db: PGlite, fn: (q: typeof db.query) => Promise<T>): Promise<T> {
  await db.exec('reset role;');
  return fn(db.query.bind(db));
}
