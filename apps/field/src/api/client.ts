/**
 * The field app's only way to the backend (CLAUDE.md: field users never get a database session):
 * `field-api`, same-origin at `VITE_FIELD_API_URL` (`/api`, spec §5.1, §6.5, D39). The field host
 * forwards `/api/<route>` to `{SUPABASE_URL}/functions/v1/field-api/<route>` (Vite proxy in dev and
 * preview, the host rewrite in production), so the device cookie stays first-party.
 *
 * The routes' request schemas are `@sitelog/shared/field-api.ts`, their answers, error codes and
 * constants `field-contract.ts` (no zod, so this bundle stays small; W1-07). `resolve` takes the
 * link code in its body, every other route in the `X-Link-Code` header (`linkCode` below), and the
 * device cookie goes with every call. W1-09 builds the screens that call them.
 */
import { FIELD_LINK_HEADER } from '@sitelog/shared/field-contract.ts';

/** The same-origin base path of field-api; `/api` unless the build sets another. */
export const FIELD_API_URL = (import.meta.env.VITE_FIELD_API_URL || '/api').replace(/\/+$/, '');

/** A route under field-api, without the base: `resolve`, `device/verify`, `reports/<id>`. */
export type FieldApiRoute = string;

/**
 * Why a call failed: `status`, a non-2xx answer; `not_json`, a 2xx answer that is not field-api's
 * JSON (the app's own `index.html` from the host's fallback when the build has no `/api` rule, or a
 * captive portal's login page on site Wi-Fi). Neither is ever a successful answer.
 */
export type FieldApiErrorReason = 'status' | 'not_json';

/** A failed call to field-api: the HTTP status and the body (JSON when it parses, else the text). */
export class FieldApiError extends Error {
  constructor(
    readonly status: number,
    readonly route: FieldApiRoute,
    readonly body: unknown,
    readonly reason: FieldApiErrorReason = 'status',
  ) {
    super(
      reason === 'not_json'
        ? `field-api ${route}: HTTP ${status} without a JSON body`
        : `field-api ${route}: HTTP ${status}`,
    );
    this.name = 'FieldApiError';
  }
}

/** `application/json`, or a `+json` type such as `application/problem+json`. */
const JSON_CONTENT_TYPE = /^application\/(?:[\w.-]+\+)?json\s*(?:;|$)/i;

export interface FieldApiRequest {
  method?: 'GET' | 'POST' | 'PATCH';
  /** Sent as JSON. */
  body?: unknown;
  /** The link code, for every route but `resolve` (sent as the X-Link-Code header). */
  linkCode?: string;
  signal?: AbortSignal;
}

export interface FieldApiClient {
  /** The URL of a route: `url('resolve')` → `/api/resolve`. */
  url(route: FieldApiRoute): string;
  /**
   * Calls a route and returns its JSON body (`null` for an empty answer). Throws `FieldApiError` on a
   * non-2xx status, and on a 2xx answer whose body is not JSON (reason `not_json`).
   */
  request<T>(route: FieldApiRoute, init?: FieldApiRequest): Promise<T>;
}

export function createFieldApi(
  options: { baseUrl?: string; fetch?: typeof fetch } = {},
): FieldApiClient {
  const base = (options.baseUrl ?? FIELD_API_URL).replace(/\/+$/, '');
  const doFetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const url = (route: FieldApiRoute) => `${base}/${route.replace(/^\/+/, '')}`;

  return {
    url,
    async request<T>(route: FieldApiRoute, init: FieldApiRequest = {}): Promise<T> {
      const hasBody = init.body !== undefined;
      const headers: Record<string, string> = { Accept: 'application/json' };
      if (hasBody) headers['Content-Type'] = 'application/json';
      if (init.linkCode) headers[FIELD_LINK_HEADER] = init.linkCode;
      const res = await doFetch(url(route), {
        method: init.method ?? (hasBody ? 'POST' : 'GET'),
        // Same origin: the device cookie goes with every call, and nowhere else.
        credentials: 'same-origin',
        headers,
        body: hasBody ? JSON.stringify(init.body) : undefined,
        signal: init.signal,
      });
      const text = await res.text();
      if (!res.ok) {
        let body: unknown = text || null;
        try {
          if (text) body = JSON.parse(text);
        } catch {
          // An error page from a proxy or the host: keep its text.
        }
        throw new FieldApiError(res.status, route, body);
      }
      if (!text) return null as T;
      // A 2xx answer must be field-api's JSON: the host's app fallback (no /api rule) and captive
      // portals also answer 200, with HTML.
      if (!JSON_CONTENT_TYPE.test(res.headers.get('content-type') ?? '')) {
        throw new FieldApiError(res.status, route, text, 'not_json');
      }
      try {
        return JSON.parse(text) as T;
      } catch {
        throw new FieldApiError(res.status, route, text, 'not_json');
      }
    },
  };
}

/** The app's client (the screens call it from W1-09). */
export const fieldApi = createFieldApi();
