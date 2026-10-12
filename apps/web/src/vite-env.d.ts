/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL?: string;
  readonly VITE_SUPABASE_ANON_KEY?: string;
  readonly VITE_APP_URL?: string;
  readonly VITE_WA_DISPLAY_NUMBER?: string;
  readonly VITE_DEMO?: string;
  readonly VITE_SENTRY_DSN?: string;
  /** `memory` for hosts without history-API routing (the demo artifact build). */
  readonly VITE_ROUTER?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
