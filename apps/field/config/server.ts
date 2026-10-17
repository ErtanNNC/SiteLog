/**
 * Dev and preview servers of the field app (W1-04 step 6, D39, spec §6.5).
 *
 * The field app calls `field-api` same-origin, at `VITE_FIELD_API_URL` (`/api`), so its device
 * cookie stays first-party (Safari blocks third-party cookies). In production the field host
 * rewrites `/api/*` to the edge function (D43); here Vite's `server.proxy` and `preview.proxy` do the
 * same: `/api/<route>` → `{SUPABASE_URL}/functions/v1/field-api/<route>`. Without a Supabase URL
 * there is no proxy rule, so CI builds and tests the app with no env set.
 *
 * Node-side only (vite.config.ts): nothing here reaches the browser bundle.
 */
import type { ProxyOptions, ServerOptions, PreviewOptions } from 'vite';

/** `pnpm dev` (with `--host`, so a phone on the LAN or a tunnel can reach it). */
export const FIELD_DEV_PORT = 5174;
/** `pnpm --filter @sitelog/field preview`: the production build, as the phone check runs it. */
export const FIELD_PREVIEW_PORT = 4174;

/** The same-origin path the app calls (`VITE_FIELD_API_URL`, spec §5.1). */
export const FIELD_API_PATH = '/api';
/** Where `field-api` lives under a Supabase project URL (D39: Hono mounts under `/field-api`). */
export const FIELD_API_FUNCTION_PATH = '/functions/v1/field-api';

/** Matches `/api`, `/api/…` and `/api?…`, not `/apiary` (a key starting with `^` is a RegExp). */
export const FIELD_API_PROXY_KEY = '^/api(?:/|\\?|$)';

type Env = Readonly<Record<string, string | undefined>>;

/** A value that is set and not only whitespace. */
function value(env: Env, key: string): string | undefined {
  const v = env[key]?.trim();
  return v ? v : undefined;
}

/**
 * The Supabase project URL the proxy targets: `SUPABASE_URL` (the root `.env`, spec §5.1), else
 * `VITE_SUPABASE_URL` (what the field host's build reads, D43). Undefined when neither is set.
 */
export function supabaseUrlFrom(env: Env): string | undefined {
  return value(env, 'SUPABASE_URL') ?? value(env, 'VITE_SUPABASE_URL');
}

/** An http(s) URL, or null for anything else (a placeholder such as `https://<ref>.supabase.co`). */
function httpUrl(raw: string): URL | null {
  try {
    const url = new URL(raw);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}

/**
 * The `/api` proxy rule for a Supabase project URL, or `{}` when there is none. A URL with a path
 * (a self-hosted gateway) keeps it: `https://h/base` → `https://h/base/functions/v1/field-api/…`.
 * `changeOrigin` sends the project's own Host header, as the host rewrite does in production.
 */
export function fieldApiProxy(supabaseUrl: string | undefined): Record<string, ProxyOptions> {
  if (!supabaseUrl) return {};
  const url = httpUrl(supabaseUrl);
  if (!url) return {};
  const base = url.pathname.replace(/\/+$/, '') + FIELD_API_FUNCTION_PATH;
  return {
    [FIELD_API_PROXY_KEY]: {
      target: url.origin,
      changeOrigin: true,
      rewrite: (path) => path.replace(/^\/api(?=\/|\?|$)/, base),
    },
  };
}

/**
 * Hosts the servers answer besides localhost and IP addresses (Vite's default): the host of
 * `FIELD_APP_URL` when it is a tunnel or LAN name (`.env.example`: "use a LAN IP or tunnel to test
 * on a phone"). Vite refuses other Host headers (DNS rebinding), so a tunnel needs this.
 */
export function allowedHostsFrom(env: Env): string[] {
  const raw = value(env, 'FIELD_APP_URL');
  const url = raw ? httpUrl(raw) : null;
  if (!url) return [];
  const host = url.hostname;
  const isIp = /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.startsWith('[');
  if (isIp || host === 'localhost' || host.endsWith('.localhost')) return [];
  return [host];
}

/** A warning for a Supabase URL that is set but unusable (the proxy is then left out). */
export function proxyWarning(env: Env): string | null {
  const raw = supabaseUrlFrom(env);
  if (!raw || httpUrl(raw)) return null;
  return `[field] SUPABASE_URL "${raw}" is not an http(s) URL; /api is not proxied to field-api.`;
}

/** `server` and `preview` options for vite.config.ts. */
export function fieldServers(env: Env): { server: ServerOptions; preview: PreviewOptions } {
  const proxy = fieldApiProxy(supabaseUrlFrom(env));
  const allowedHosts = allowedHostsFrom(env);
  const common = { host: true, strictPort: true, proxy, allowedHosts };
  return {
    server: { ...common, port: FIELD_DEV_PORT },
    preview: { ...common, port: FIELD_PREVIEW_PORT },
  };
}
