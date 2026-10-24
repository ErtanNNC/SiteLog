/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL?: string;
  readonly VITE_SUPABASE_ANON_KEY?: string;
  readonly VITE_APP_URL?: string;
  readonly VITE_DEMO?: string;
  readonly VITE_SENTRY_DSN?: string;
  /** `true` on staging: the Demo phone for every org (§11.1), not only `is_demo` ones. */
  readonly VITE_DEMO_PHONE_ALL_ORGS?: string;
  /** `memory` for hosts without history-API routing (the demo artifact build). */
  readonly VITE_ROUTER?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
