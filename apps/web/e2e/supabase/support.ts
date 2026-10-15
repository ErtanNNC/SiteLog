import { expect, type Page } from '@playwright/test';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { demoId } from '@sitelog/shared/demo/ids.ts';

/**
 * Local Supabase stack for the E2E specs (`supabase start` applies migrations + seed.sql).
 * Names match `supabase status -o env`, so locally:
 *   set -a; eval "$(supabase status -o env)"; set +a
 *   pnpm --filter @sitelog/web e2e:supabase
 */
export const SUPABASE_URL = process.env.API_URL ?? 'http://127.0.0.1:54321';
export const ANON_KEY = process.env.ANON_KEY ?? '';
const SERVICE_ROLE_KEY = process.env.SERVICE_ROLE_KEY ?? '';

/** Panel origin; must be in supabase/config.toml auth.additional_redirect_urls. */
export const APP_URL = 'http://localhost:5173';

/** §18 seed (supabase/seed.sql, generated from packages/shared/src/demo/kestrel.ts and demir.ts). */
export const SEED = {
  orgId: '7a0cfa5d-2a29-43fb-8665-fcd9bed4106d',
  admin: { id: '3dee836a-fca5-4d0c-8572-5e8e0c3fb25a', email: 'lena@kestrelbuild.example' },
  /** §18.2 Demir Yapı A.Ş.'s TR admin, Elif Aydın, a member of that org only (spec §19 question 18). */
  demirAdmin: { email: 'elif@demiryapi.example' },
  /** The seeded accounts (payroll) user: Crew hours and invoices only (§2.2). */
  accounts: { email: 'accounts@kestrelbuild.example' },
  sites: {
    riverside: 'a72cfd9d-46d6-4d33-8bd6-eb11c2437b8d',
    elm: 'fa26ea08-3843-4e06-8ba5-0bc44aea9a38',
  },
  /** Elm St. Townhomes, Fri Oct 9: `missing` (the Overview's needs-attention item). */
  elmSiteDay: 'fc862808-51dc-4786-8718-b6e4f8728bf8',
  /** Filed v1 reports on Fri Oct 9. */
  northgateReport: { id: '2cfeeeb5-d40a-4a67-8d3f-8bf197c2c605', no: 'NG-2210-0069' },
  pier9Report: { id: '9c575e00-00fb-45e6-85da-5994455633d0', no: 'P9-0932-0094' },
  /** §18.1 hero, Riverside Lofts Fri Oct 9: v2, voice note 17:38 + correction 20:09. */
  heroReport: { id: demoId('report:riverside:2026-10-09'), no: 'RL-2041-0187' },
  /** The demo's "now": Fri Oct 9, 2026 · 19:05 in Chicago (CDT, UTC−5). */
  now: new Date('2026-10-10T00:05:00Z'),
} as const;

let adminClient: SupabaseClient | null = null;

/** Service-role client for arranging and asserting database state (bypasses RLS). */
export function admin(): SupabaseClient {
  if (!SERVICE_ROLE_KEY) {
    throw new Error('SERVICE_ROLE_KEY is not set: export the output of `supabase status -o env`');
  }
  adminClient ??= createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return adminClient;
}

/**
 * Pins the browser clock to the seed's "today" so the Overview, Hours week and Weather month
 * line up with seed.sql. Timers keep running (Realtime heartbeats, polling).
 */
export async function pinSeedClock(page: Page) {
  await page.clock.setFixedTime(SEED.now);
}

/**
 * Signs in like a user opening an emailed magic link (§17: "Login (Supabase admin
 * generateLink)"): the admin API mints the link, the browser follows it through GoTrue's
 * /verify redirect to /auth/callback, and the panel lands on the role's home page (`landing`:
 * `/`, or `/hours` for an accounts user, §11.1).
 */
export async function signInWithMagicLink(
  page: Page,
  email: string = SEED.admin.email,
  landing = '/',
) {
  const { data, error } = await admin().auth.admin.generateLink({
    type: 'magiclink',
    email,
    options: { redirectTo: `${APP_URL}/auth/callback` },
  });
  if (error) throw error;
  await page.goto(data.properties.action_link);
  await page.waitForURL((url) => url.origin === APP_URL && url.pathname === landing, {
    timeout: 30_000,
  });
  // The tokens never stay in the address bar.
  expect(new URL(page.url()).hash).toBe('');
}
