/// <reference types="vite/client" />

/** The field app's browser env (spec §5.1): public values only, never a key or secret. */
interface ImportMetaEnv {
  /** Same-origin path of field-api; `/api` when unset (D39). */
  readonly VITE_FIELD_API_URL?: string;
  /** `'true'` shows Talk now on Today (week 2; needs LiveKit). Off by default. */
  readonly VITE_FEATURE_TALK_NOW?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
