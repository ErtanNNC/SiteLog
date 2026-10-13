/**
 * The field host's `_redirects` file (W1-04 step 7, D43, spec §6.5), written into `dist/` by the
 * build.
 *
 * The field app calls `field-api` same-origin at `/api` so its device cookie stays first-party. Dev
 * and preview use Vite's proxy (`config/server.ts`); on Netlify the host does the same with a proxy
 * rule (status 200 to an absolute URL). The project URL differs per deploy (the `preview`
 * Environment's project on pull requests, staging's on the live branch, none in CI), so the file is
 * generated at build time instead of living in a `netlify.toml` (a recorded deviation, README):
 *
 *     /api/*  https://<ref>.supabase.co/functions/v1/field-api/:splat  200
 *     /*  /index.html  200
 *
 * The `/api` rule comes first (Netlify takes the first matching rule) and the SPA fallback second;
 * the fallback never shadows a file that exists (assets, `sw.js`, the manifest). Without a usable
 * Supabase URL there is no `/api` rule at all: never a guessed or partial target.
 *
 * The URL is the same one the dev and preview proxy use (`supabaseUrlFrom`: `SUPABASE_URL`, else
 * `VITE_SUPABASE_URL`); the deploy job sets both to the project it checked. Node-side only: nothing
 * here reaches the browser bundle.
 */
import type { Plugin } from 'vite';
import { FIELD_API_FUNCTION_PATH, FIELD_API_PATH, supabaseUrlFrom } from './server.ts';

/** The file Netlify (and Cloudflare Pages) read from the publish directory. */
export const REDIRECTS_FILE = '_redirects';

/** Every other path is the app (React Router); existing files are served as they are. */
export const SPA_FALLBACK_RULE = '/*  /index.html  200';

/** Hosts a local build may proxy to over plain http (a `supabase start` stack). */
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

export type FieldApiTarget =
  | { ok: true; /** `{project URL}/functions/v1/field-api`, no trailing slash. */ target: string }
  | { ok: false; reason: string };

/**
 * Checks the shape of a Supabase project URL before it goes into a proxy rule, and returns the
 * `field-api` base it forwards to. Accepted: `https://<host>[:port][/path]`, or `http://` to a
 * loopback host for a local build. Refused, with the reason: anything that does not parse
 * (placeholders such as `https://<ref>.supabase.co`), other schemes, plain http to a remote host
 * (the proxy carries the device cookie), credentials, a query or fragment, whitespace, Netlify
 * placeholder characters (`:` and `*`) in the path, and a URL that already points at a function.
 */
export function fieldApiTarget(raw: string): FieldApiTarget {
  const value = raw.trim();
  if (!value) return { ok: false, reason: 'it is empty' };
  if (/[\s<>"'`]/.test(value)) return { ok: false, reason: 'it contains spaces or placeholders' };
  if (/[?#]/.test(value)) return { ok: false, reason: 'it has a query or a fragment' };
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { ok: false, reason: 'it is not a URL' };
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return { ok: false, reason: `its scheme is ${url.protocol.replace(/:$/, '')}, not https` };
  }
  if (url.protocol === 'http:' && !LOOPBACK.has(url.hostname)) {
    return { ok: false, reason: 'plain http is allowed only to localhost' };
  }
  if (url.username || url.password) return { ok: false, reason: 'it carries credentials' };
  const path = url.pathname.replace(/\/+$/, '');
  if (/[:*]/.test(path)) return { ok: false, reason: 'its path has ":" or "*"' };
  if (/\/functions\/v1(\/|$)/.test(path)) {
    return { ok: false, reason: 'it is a function URL, not the project URL' };
  }
  return { ok: true, target: `${url.origin}${path}${FIELD_API_FUNCTION_PATH}` };
}

export interface FieldRedirects {
  /** The file's text, ending with a newline. */
  content: string;
  /** The `/api` rule, or null when the build has no usable Supabase URL. */
  apiRule: string | null;
  /** Why a Supabase URL that is set was not used, for the build log. */
  warning: string | null;
}

/** The `_redirects` text for a Supabase project URL (or none). */
export function fieldRedirects(supabaseUrl: string | undefined): FieldRedirects {
  const header = '# Generated at build time by apps/field/config/redirects.ts (D43). Do not edit.';
  const checked = supabaseUrl?.trim() ? fieldApiTarget(supabaseUrl) : null;
  const apiRule = checked?.ok ? `${FIELD_API_PATH}/*  ${checked.target}/:splat  200` : null;
  const warning =
    checked && !checked.ok
      ? `[field] Supabase URL "${supabaseUrl}" not used for ${REDIRECTS_FILE}: ${checked.reason}. The build has no ${FIELD_API_PATH} rule.`
      : null;
  const lines = apiRule
    ? [header, apiRule, SPA_FALLBACK_RULE]
    : [
        header,
        `# No usable Supabase URL at build time: ${FIELD_API_PATH} is not forwarded.`,
        SPA_FALLBACK_RULE,
      ];
  return { content: `${lines.join('\n')}\n`, apiRule, warning };
}

type Env = Readonly<Record<string, string | undefined>>;

/** Vite plugin: emits `_redirects` next to `index.html` on `vite build` (dev and preview proxy instead). */
export function fieldRedirectsPlugin(env: Env): Plugin {
  const redirects = fieldRedirects(supabaseUrlFrom(env));
  return {
    name: 'sitelog-field-redirects',
    apply: 'build',
    buildStart() {
      if (redirects.warning) this.warn(redirects.warning);
    },
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: REDIRECTS_FILE, source: redirects.content });
    },
  };
}
