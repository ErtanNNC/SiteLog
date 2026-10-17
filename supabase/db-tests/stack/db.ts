import postgres, { type Sql } from 'postgres';

/**
 * Connection to the Postgres of a running local Supabase stack, for the `test:stack` suites
 * (real Postgres: several sessions, row locks, LISTEN/NOTIFY; PGlite is one session).
 *
 *   supabase start
 *   SUPABASE_DB_URL="$(supabase status -o env | sed -n 's/^DB_URL="\(.*\)"$/\1/p')" pnpm test:stack
 *
 * The URL is the `postgres` superuser of the local stack (DB_URL in `supabase status`), the role
 * the worker uses. Never point it at a hosted project: the suites write and delete their own rows.
 */

export const STACK_DB_URL = process.env.SUPABASE_DB_URL?.trim() || undefined;

export const SKIP_MESSAGE =
  'test:stack skipped: SUPABASE_DB_URL is not set. Start a local stack (`supabase start`) and set ' +
  'SUPABASE_DB_URL to its DB_URL (`supabase status -o env`); CI runs it in the e2e-supabase job.';

const HOSTED = /\.supabase\.(co|com|net)\b|pooler\.supabase/i;

/** One client per suite; `max` is the number of parallel sessions the suite needs. */
export function connectStack(max = 10): Sql {
  if (!STACK_DB_URL) throw new Error(SKIP_MESSAGE);
  if (HOSTED.test(STACK_DB_URL))
    throw new Error(
      'SUPABASE_DB_URL points at a hosted Supabase project; test:stack runs only against a local stack',
    );
  return postgres(STACK_DB_URL, { max, onnotice: () => undefined, idle_timeout: 5 });
}
