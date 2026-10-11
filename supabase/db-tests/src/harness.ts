import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';

/**
 * Boots an in-memory Postgres (PGlite), stubs the parts of Supabase the migrations rely on
 * (auth schema, auth.uid()/auth.jwt(), roles) and applies supabase/migrations in order.
 * RLS is exercised by `SET ROLE authenticated` + `request.jwt.claims`.
 */

const ROOT = join(import.meta.dirname, '..', '..');
export const MIGRATIONS_DIR = join(ROOT, 'migrations');
export const SEED_FILE = join(ROOT, 'seed.sql');

const SUPABASE_STUB = `
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
    if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
    if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
    if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
  end $$;
  grant usage on schema public to anon, authenticated, service_role;
  grant usage on schema auth to anon, authenticated, service_role;
  alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
  alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
  alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;
`;

export async function bootDatabase(opts: { seed?: boolean } = {}): Promise<PGlite> {
  const db = new PGlite({ extensions: { pgcrypto } });
  await db.exec(SUPABASE_STUB);
  for (const file of migrationFiles()) {
    const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
    try {
      await db.exec(sql);
    } catch (err) {
      throw new Error(`Migration ${file} failed: ${(err as Error).message}`, { cause: err });
    }
  }
  // Mirror Supabase's grants for the stub roles (migrations create tables after the default privileges).
  await db.exec(`
    grant all on all tables in schema public to anon, authenticated, service_role;
    grant all on all sequences in schema public to anon, authenticated, service_role;
    grant execute on all functions in schema public to anon, authenticated, service_role;
  `);
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

export async function asService<T>(db: PGlite, fn: (q: typeof db.query) => Promise<T>): Promise<T> {
  await db.exec('reset role;');
  return fn(db.query.bind(db));
}
