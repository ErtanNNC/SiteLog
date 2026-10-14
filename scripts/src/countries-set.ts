/**
 * Sets a country pack's per-environment values in one database (spec §4.6, GAP D47):
 *
 *   pnpm countries:set -- --code TR --sms-sender SITELOG
 *   pnpm countries:set -- --code US --sms-sender +18885550142 --voice +15550142290
 *   pnpm countries:set -- --code TR --clear-sms-sender        → back to the console transport
 *
 * Policy values of a pack (languages, units, providers, two-way SMS …) change only by migration.
 * The SMS sender id and the voice number differ per environment, so every migration seeds them
 * null (null sender = `console`, null voice number = Talk now only) and this script sets them,
 * through the service-only, audited `set_country_endpoints()` (20261014000004; audit action
 * `country.endpoints_set`). A flag left out keeps the current value.
 *
 * It writes to the database at SUPABASE_DB_URL, the Postgres connection string of the target
 * (locally the DB_URL of `supabase status -o env`), read from the shell: this script reads no
 * .env file. It prints the target (never the password) and the pack's values before and after,
 * all in one transaction. A hosted database needs the owner's approval and `--yes`; the staging
 * project also `--allow-staging`. Never set a sender before its registration is approved
 * (US toll-free verification, the TR BTK title): from then on real messages go out from it.
 */
import { isE164 } from '@sitelog/shared/format.ts';
import {
  isValidSmsSenderId,
  SMS_SENDER_TYPES,
  type SmsSenderType,
} from '@sitelog/shared/countries.ts';
import { describeTarget, STAGING_PROJECT_REF } from './seed-target.ts';

/** `undefined` keeps the current value, `null` clears it. */
export interface CountriesSetArgs {
  code: string;
  smsSenderId?: string | null;
  voiceNumber?: string | null;
  yes: boolean;
  allowStaging: boolean;
}

export function parseCountriesSetArgs(argv: readonly string[]): CountriesSetArgs {
  const rest = argv.filter((a) => a !== '--');
  let code: string | undefined;
  const out: Omit<CountriesSetArgs, 'code'> = { yes: false, allowStaging: false };
  const once = (name: string, field: 'smsSenderId' | 'voiceNumber', value: string | null) => {
    if (out[field] !== undefined) throw new Error(`${name} conflicts with an earlier flag`);
    out[field] = value;
  };
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
    if (a === '--code' || a.startsWith('--code=')) code = value('--code');
    else if (a === '--sms-sender' || a.startsWith('--sms-sender='))
      once('--sms-sender', 'smsSenderId', value('--sms-sender'));
    else if (a === '--voice' || a.startsWith('--voice='))
      once('--voice', 'voiceNumber', value('--voice'));
    else if (a === '--clear-sms-sender') once('--clear-sms-sender', 'smsSenderId', null);
    else if (a === '--clear-voice') once('--clear-voice', 'voiceNumber', null);
    else if (a === '--yes') out.yes = true;
    else if (a === '--allow-staging') out.allowStaging = true;
    else throw new Error(`unknown argument ${a}`);
  }
  if (code === undefined) throw new Error('--code is required (the pack, e.g. --code TR)');
  code = code.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(code))
    throw new Error(`--code takes a country code like TR (got "${code}")`);
  // set_country_endpoints() treats a blank value as null; here a blank flag is a mistake.
  for (const [flag, field] of [
    ['--sms-sender', 'smsSenderId'],
    ['--voice', 'voiceNumber'],
  ] as const) {
    const v = out[field];
    if (typeof v === 'string') {
      out[field] = v.trim();
      if (!out[field])
        throw new Error(`${flag} is empty: use --clear-${flag.slice(2)} to clear it`);
    }
  }
  if (typeof out.voiceNumber === 'string' && !isE164(out.voiceNumber))
    throw new Error(`--voice must be E.164, e.g. +15550142290 (got "${out.voiceNumber}")`);
  if (out.smsSenderId === undefined && out.voiceNumber === undefined)
    throw new Error(
      'nothing to set: pass --sms-sender, --voice, --clear-sms-sender or --clear-voice',
    );
  return { code, ...out };
}

/** A local Supabase stack (`supabase start`) or another database on this machine. */
export function isLocalDbHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return host === 'localhost' || host === '::1' || /^127(\.\d{1,3}){3}$/.test(host);
}

/** Why the script must not write to this target, or null when it may. */
export function refuseCountriesTarget(input: {
  dbUrl: string;
  supabaseUrl?: string;
  yes: boolean;
  allowStaging: boolean;
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
    return `the target is the staging project ${STAGING_PROJECT_REF}; its packs change only with the owner's approval and --allow-staging --yes`;
  if (!isLocalDbHost(url.hostname) && !input.yes)
    return `the target ${url.hostname} is not a local database; a hosted database's packs change only with the owner's approval and --yes`;
  return null;
}

/** The pack's columns this script reads and writes. */
export interface PackEndpoints {
  code: string;
  sms_provider: string;
  sms_sender_type: SmsSenderType;
  sms_sender_id: string | null;
  voice_number: string | null;
}

/** The values to store: a flag left out keeps the current one. */
export function nextEndpoints(
  before: PackEndpoints,
  args: Pick<CountriesSetArgs, 'smsSenderId' | 'voiceNumber'>,
): { smsSenderId: string | null; voiceNumber: string | null } {
  return {
    smsSenderId: args.smsSenderId === undefined ? before.sms_sender_id : args.smsSenderId,
    voiceNumber: args.voiceNumber === undefined ? before.voice_number : args.voiceNumber,
  };
}

/** The shape set_country_endpoints() takes for the pack's sender type, checked before writing. */
export function senderProblem(type: SmsSenderType, senderId: string | null): string | null {
  if (senderId === null || isValidSmsSenderId(type, senderId)) return null;
  const shape: Record<SmsSenderType, string> = {
    alphanumeric: 'an alphanumeric title of 1 to 11 letters, digits or spaces (e.g. SITELOG)',
    short_code: 'a short code of 3 to 8 digits',
    toll_free: 'an E.164 number (e.g. +18885550142)',
    long_code: 'an E.164 number',
  };
  return `"${senderId}" is not a valid ${type} sender: the pack takes ${shape[type]}`;
}

/** One line per pack value, for the before and after prints (nothing here is secret). */
export function describeEndpoints(row: PackEndpoints): string {
  const sender = row.sms_sender_id
    ? `${row.sms_sender_id} (sends through ${row.sms_provider})`
    : 'not set (console transport)';
  const voice = row.voice_number ?? 'not set (Talk now only)';
  return `${row.code} · ${row.sms_sender_type} SMS sender: ${sender} · voice number: ${voice}`;
}

const COLUMNS = 'code, sms_provider, sms_sender_type, sms_sender_id, voice_number';
export const SELECT_PACK_SQL = `select ${COLUMNS} from countries where code = $1 for update`;
export const SET_ENDPOINTS_SQL = `select ${COLUMNS} from set_country_endpoints($1, $2, $3)`;

/** A transaction's query function (postgres.js `sql.unsafe` in the script, a fake in tests). */
export type Query = (text: string, params: unknown[]) => Promise<readonly unknown[]>;

/**
 * Reads the pack (locked), checks the new values and writes them with set_country_endpoints(),
 * inside the caller's transaction. Nothing changes → nothing is written (and nothing audited).
 */
export async function applyCountriesSet(
  query: Query,
  args: CountriesSetArgs,
): Promise<{ before: PackEndpoints; after: PackEndpoints; changed: boolean }> {
  const [found] = (await query(SELECT_PACK_SQL, [args.code])) as PackEndpoints[];
  if (!found) throw new Error(`no country pack ${args.code} in this database`);
  if (!(SMS_SENDER_TYPES as readonly string[]).includes(found.sms_sender_type))
    throw new Error(`pack ${args.code} has an unknown sender type ${found.sms_sender_type}`);
  const next = nextEndpoints(found, args);
  const problem = senderProblem(found.sms_sender_type, next.smsSenderId);
  if (problem) throw new Error(problem);
  if (next.smsSenderId === found.sms_sender_id && next.voiceNumber === found.voice_number)
    return { before: found, after: found, changed: false };
  const [after] = (await query(SET_ENDPOINTS_SQL, [
    args.code,
    next.smsSenderId,
    next.voiceNumber,
  ])) as PackEndpoints[];
  if (!after) throw new Error('set_country_endpoints() returned no row');
  return { before: found, after, changed: true };
}

/** What the script needs of a Postgres connection (postgres.js here, PGlite in supabase/db-tests). */
export interface CountriesSetConnection {
  /** Runs `fn` in one transaction: committed when it resolves, rolled back when it throws. */
  transaction<T>(fn: (query: Query) => Promise<T>): Promise<T>;
  end(): Promise<void>;
}

/** The script's surroundings, injected so tests run it without a shell or a server. */
export interface CountriesSetDeps {
  env: Readonly<Record<string, string | undefined>>;
  /** Called only after the target passed refuseCountriesTarget(). */
  connect: (dbUrl: string) => Promise<CountriesSetConnection>;
  log: (line: string) => void;
}

/** postgres.js on SUPABASE_DB_URL, one connection; imported only once the target is allowed. */
export async function connectPostgres(dbUrl: string): Promise<CountriesSetConnection> {
  const { default: postgres } = await import('postgres');
  const db = postgres(dbUrl, { max: 1, onnotice: () => undefined });
  return {
    async transaction(fn) {
      let out: Awaited<ReturnType<typeof fn>> | undefined;
      await db.begin(async (sql) => {
        out = await fn((text, params) => sql.unsafe(text, params as never[]));
      });
      return out!;
    },
    end: () => db.end({ timeout: 5 }),
  };
}

/**
 * `pnpm countries:set`: parses the flags, refuses a target it must not write to before
 * connecting, prints the target (never its password) and the pack before and after, and writes in
 * one transaction. Throws on any refusal or failure; the connection is always closed.
 */
export async function runCountriesSet(
  argv: readonly string[],
  deps: CountriesSetDeps,
): Promise<{ before: PackEndpoints; after: PackEndpoints; changed: boolean }> {
  const args = parseCountriesSetArgs(argv);
  const dbUrl = deps.env.SUPABASE_DB_URL?.trim() ?? '';
  const refusal = refuseCountriesTarget({
    dbUrl,
    supabaseUrl: deps.env.SUPABASE_URL,
    yes: args.yes,
    allowStaging: args.allowStaging,
  });
  if (refusal) throw new Error(refusal);
  deps.log(`countries:set → ${describeTarget(dbUrl)}`);
  const db = await deps.connect(dbUrl);
  try {
    const result = await db.transaction((query) => applyCountriesSet(query, args));
    deps.log(`  before: ${describeEndpoints(result.before)}`);
    deps.log(
      result.changed
        ? `  after:  ${describeEndpoints(result.after)} (audited as country.endpoints_set)`
        : '  unchanged: nothing written',
    );
    return result;
  } finally {
    await db.end();
  }
}

const isMain = process.argv[1]?.endsWith('countries-set.ts');
if (isMain) {
  runCountriesSet(process.argv.slice(2), {
    env: process.env,
    connect: connectPostgres,
    log: (line) => console.log(line),
  }).catch((err: unknown) => {
    // postgres.js errors carry the server's message (e.g. a 22023 from set_country_endpoints()).
    console.error(`countries:set: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
