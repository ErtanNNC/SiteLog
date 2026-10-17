/**
 * Argument parsing and target checks for `pnpm seed:demo` (seed-demo.ts), kept apart so they are
 * unit-tested without a database.
 */

import { LOCAL_DEMO_PASSWORD } from '@sitelog/shared/demo/seed-sql.ts';

/** The hosted staging project (docs/RUNBOOK.md §2): never seeded without an explicit flag. */
export const STAGING_PROJECT_REF = 'abuanbyzttuqksdctqcp';

/** DEMO_OFFICE_PASSWORD: the demo office users' password an apply sets, at least this long. */
export const MIN_OFFICE_PASSWORD_LENGTH = 16;

export interface SeedArgs {
  apply: boolean;
  stdout: boolean;
  allowStaging: boolean;
  /** 'today' or YYYY-MM-DD. */
  date?: string;
  linkBase?: string;
}

export function parseSeedArgs(argv: readonly string[]): SeedArgs {
  const args: SeedArgs = { apply: false, stdout: false, allowStaging: false };
  const rest = argv.filter((a) => a !== '--');
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    const value = (name: string) => {
      const eq = a.indexOf('=');
      if (eq > 0) return a.slice(eq + 1);
      const next = rest[i + 1];
      if (next === undefined || next.startsWith('--')) throw new Error(`${name} needs a value`);
      i += 1;
      return next;
    };
    if (a === '--apply') args.apply = true;
    else if (a === '--stdout') args.stdout = true;
    else if (a === '--allow-staging') args.allowStaging = true;
    else if (a === '--date' || a.startsWith('--date=')) args.date = value('--date');
    else if (a === '--link-base' || a.startsWith('--link-base='))
      args.linkBase = value('--link-base');
    else throw new Error(`unknown argument ${a}`);
  }
  if (args.date !== undefined && args.date !== 'today' && !/^\d{4}-\d{2}-\d{2}$/.test(args.date))
    throw new Error(`--date takes "today" or YYYY-MM-DD (got "${args.date}")`);
  if (args.linkBase !== undefined && !/^https?:\/\/[^\s]+$/.test(args.linkBase))
    throw new Error(`--link-base must be an http(s) URL (got "${args.linkBase}")`);
  return args;
}

/**
 * Why the apply must not run against this target, or null when it may. Besides the target itself
 * it needs the field app's URL for the links in the seeded texts (`--link-base` or FIELD_APP_URL;
 * the spec's example host would not open the recorder) and its own office password
 * (DEMO_OFFICE_PASSWORD: the committed seed.sql one would let anyone sign in as the demo admin on
 * a hosted project).
 */
export function refuseTarget(input: {
  dbUrl: string;
  supabaseUrl?: string;
  allowStaging: boolean;
  linkBase?: string;
  officePassword?: string;
}): string | null {
  if (!input.dbUrl)
    return 'SUPABASE_DB_URL is not set: give the Postgres connection string of the target (locally the DB_URL of `supabase status -o env`)';
  let url: URL;
  try {
    url = new URL(input.dbUrl);
  } catch {
    return 'SUPABASE_DB_URL is not a postgres:// connection string';
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:')
    return 'SUPABASE_DB_URL is not a postgres:// connection string';
  const staging = [input.dbUrl, input.supabaseUrl ?? ''].some((s) =>
    s.toLowerCase().includes(STAGING_PROJECT_REF),
  );
  if (staging && !input.allowStaging)
    return `the target is the staging project ${STAGING_PROJECT_REF}; seeding it needs the owner's approval and --allow-staging`;
  const linkBase = input.linkBase?.trim() ?? '';
  if (!linkBase)
    return 'no field app URL for the links in the seeded texts: pass --link-base or set FIELD_APP_URL (the field app this database serves)';
  if (!/^https?:\/\/[^\s]+$/.test(linkBase))
    return `the field app URL must be an http(s) URL (got "${linkBase}")`;
  const password = input.officePassword ?? '';
  if (!password)
    return `DEMO_OFFICE_PASSWORD is not set: the demo office users' password on this database (at least ${MIN_OFFICE_PASSWORD_LENGTH} characters; never the committed "${LOCAL_DEMO_PASSWORD}")`;
  if (password === LOCAL_DEMO_PASSWORD)
    return `DEMO_OFFICE_PASSWORD must not be the committed seed.sql password "${LOCAL_DEMO_PASSWORD}"`;
  if ([...password].length < MIN_OFFICE_PASSWORD_LENGTH)
    return `DEMO_OFFICE_PASSWORD is too short: at least ${MIN_OFFICE_PASSWORD_LENGTH} characters`;
  return null;
}

/** The target as printed before writing: host, port, database, user and project ref, no password. */
export function describeTarget(dbUrl: string): string {
  const url = new URL(dbUrl);
  const ref =
    /(?:^|\.)db\.([a-z0-9]{20})\.supabase\.co$/i.exec(url.hostname)?.[1] ??
    /^postgres\.([a-z0-9]{20})$/i.exec(decodeURIComponent(url.username))?.[1] ??
    null;
  const db = url.pathname.replace(/^\//, '') || 'postgres';
  return `${decodeURIComponent(url.username) || '(no user)'}@${url.hostname}:${url.port || '5432'}/${db}${
    ref ? ` (Supabase project ${ref})` : ''
  }`;
}
