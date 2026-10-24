/**
 * Runtime configuration (Vite env). Demo mode runs the whole panel on the in-memory §18
 * Kestrel dataset: `VITE_DEMO=true`, or simply no `VITE_SUPABASE_URL`.
 */
const e = import.meta.env;

function str(v: string | undefined): string | undefined {
  const t = v?.trim();
  return t ? t : undefined;
}

export const env = {
  supabaseUrl: str(e.VITE_SUPABASE_URL),
  supabaseAnonKey: str(e.VITE_SUPABASE_ANON_KEY),
  appUrl:
    str(e.VITE_APP_URL) ??
    (typeof window !== 'undefined' ? window.location.origin : 'http://localhost:5173'),
  sentryDsn: str(e.VITE_SENTRY_DSN),
  demo: e.VITE_DEMO === 'true' || !str(e.VITE_SUPABASE_URL),
  /**
   * Staging (§11.1): the Demo phone for every org, not only `is_demo` ones. A real org's texts
   * are stored with their link codes masked, so it shows what went out without working links.
   */
  demoPhoneAllOrgs: e.VITE_DEMO_PHONE_ALL_ORGS === 'true',
  dev: !!e.DEV,
} as const;

export const isDemo: boolean = env.demo;

/** Edge function base URL (`${VITE_SUPABASE_URL}/functions/v1`). */
export function functionsUrl(name: string): string {
  return `${env.supabaseUrl ?? ''}/functions/v1/${name}`;
}
