/**
 * The §18 demo seed (GAP D8, D36): Kestrel Build Group and Demir Yapı A.Ş.
 *
 *   pnpm seed:demo                          → writes supabase/seed.sql (Fri Oct 9, 2026; e2e)
 *   pnpm seed:demo -- --stdout              → prints it
 *   pnpm seed:demo -- --date today          → prints the live demo for today (or --date YYYY-MM-DD)
 *   pnpm seed:demo -- --date today --apply  → writes it to the database at SUPABASE_DB_URL
 *
 * `--apply` runs the same SQL as seed.sql (packages/shared/src/demo/seed-sql.ts) in one
 * transaction against SUPABASE_DB_URL, the Postgres connection string of the target (locally the
 * DB_URL of `supabase status -o env`; for a hosted project its connection string, never committed).
 * It upserts the demo orgs by their deterministic ids, replaces their rows (and drops the queued
 * or running jobs that name them), refuses an org that is not a demo org and never writes another
 * org's rows. It prints the target first and refuses the staging project unless `--allow-staging`
 * is given. It also needs, from the environment (this script reads no .env file):
 * - the field app's URL for the links in the seeded texts: `--link-base URL` or FIELD_APP_URL;
 * - DEMO_OFFICE_PASSWORD (16+ characters, never seed.sql's "sitelog-demo"): set as the demo
 *   office users' password, never printed. The database hashes it from a bind parameter first and
 *   the script carries only the hash, since a server may log the script's text.
 *
 * A live day (`--date`) built on that day before 17:00 Chicago stops at the clock: nothing of the
 * target day after it is seeded (before 16:59, Pier 9 is awaiting too).
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildSeedSql, OFFICE_PASSWORD_HASH_SQL } from '@sitelog/shared/demo/seed-sql.ts';
import { todayIn } from '@sitelog/shared/demo/calendar.ts';
import { buildKestrelDemo, DEMO_TZ } from '@sitelog/shared/demo/kestrel.ts';
import { formatTimeInTz } from '@sitelog/shared/format.ts';
import { describeTarget, parseSeedArgs, refuseTarget } from './seed-target.ts';

export { buildSeedSql };

async function main(argv: string[]): Promise<void> {
  const args = parseSeedArgs(argv);
  const date = args.date === 'today' ? todayIn(DEMO_TZ) : args.date;
  // A live day built on that day before 17:00 stops at the clock (no row in the future).
  const clock = date !== undefined ? new Date().toISOString() : undefined;
  if (!args.apply) {
    const sql = buildSeedSql({ date, clock, linkBase: args.linkBase });
    if (args.stdout || date !== undefined || args.linkBase !== undefined) {
      process.stdout.write(sql);
      return;
    }
    const out = join(import.meta.dirname, '..', '..', 'supabase', 'seed.sql');
    writeFileSync(out, sql);
    console.log(`wrote ${out} (${(sql.length / 1024).toFixed(0)} KB)`);
    return;
  }

  const dbUrl = process.env.SUPABASE_DB_URL?.trim() ?? '';
  const linkBase = args.linkBase ?? (process.env.FIELD_APP_URL?.trim() || undefined);
  const officePassword = process.env.DEMO_OFFICE_PASSWORD ?? '';
  const refusal = refuseTarget({
    dbUrl,
    supabaseUrl: process.env.SUPABASE_URL,
    allowStaging: args.allowStaging,
    linkBase,
    officePassword,
  });
  if (refusal) throw new Error(refusal);
  console.log(`seed:demo --apply → ${describeTarget(dbUrl)}`);
  const now = date !== undefined ? buildKestrelDemo({ date, clock }).now : null;
  console.log(
    `  demo day: ${date ?? '2026-10-09 (§18.1 as written)'}${now ? ` as of ${formatTimeInTz(now, DEMO_TZ)} Chicago` : ''}; links: ${linkBase}`,
  );
  if (now && formatTimeInTz(now, DEMO_TZ) < '16:59')
    console.log('  before 16:59 Chicago: Pier 9 has not filed yet, all six sites are awaiting');
  const { default: postgres } = await import('postgres');
  const db = postgres(dbUrl, { max: 1, onnotice: () => undefined });
  try {
    // The password goes to the database only as a bind parameter; the script gets its hash.
    const [row] = await db.unsafe<{ hash: string }[]>(OFFICE_PASSWORD_HASH_SQL, [officePassword]);
    const sql = buildSeedSql({
      date,
      clock,
      linkBase,
      officePasswordHash: row!.hash,
      globalRows: false,
    });
    // The script holds its own begin … commit: one transaction, all or nothing.
    await db.unsafe(sql);
    console.log('  applied: Kestrel Build Group, Demir Yapı A.Ş.');
  } finally {
    await db.end({ timeout: 5 });
  }
}

const isMain = process.argv[1]?.endsWith('seed-demo.ts');
if (isMain) {
  main(process.argv.slice(2)).catch((err: unknown) => {
    // The script's own refusal already starts with "seed:demo:".
    const message = err instanceof Error ? err.message : String(err);
    console.error(message.startsWith('seed:demo:') ? message : `seed:demo: ${message}`);
    process.exit(1);
  });
}
