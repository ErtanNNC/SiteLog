import { z } from 'zod';
import { EnvError, optionalEnv } from './env.ts';
import { logError } from './log.ts';

/**
 * HTTP helpers shared by every function: CORS for the web panel origin (APP_URL), JSON
 * responses, method guards, body parsing with Zod and a handler wrapper that maps errors to
 * status codes without leaking internals.
 */

export class HttpError extends Error {
  readonly status: number;
  readonly details: unknown;

  constructor(status: number, message: string, details?: unknown) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.details = details;
  }
}

export const CORS_ALLOW_HEADERS = 'authorization, x-client-info, apikey, content-type';
export const CORS_ALLOW_METHODS = 'GET, POST, OPTIONS';

/** Browser origins allowed to call the api-* functions: APP_URL plus CORS_EXTRA_ORIGINS (comma-separated). */
export function allowedOrigins(): string[] {
  const candidates = [
    optionalEnv('APP_URL'),
    ...(optionalEnv('CORS_EXTRA_ORIGINS') ?? '').split(','),
  ];
  const origins: string[] = [];
  for (const candidate of candidates) {
    const trimmed = candidate?.trim();
    if (!trimmed) continue;
    try {
      origins.push(new URL(trimmed).origin);
    } catch {
      // ignore malformed entries; they are configuration mistakes, not request errors
    }
  }
  return origins;
}

export function isAllowedOrigin(origin: string | null, allowed: readonly string[]): boolean {
  return origin !== null && allowed.includes(origin);
}

export function corsHeaders(
  req: Request,
  allowed: readonly string[] = allowedOrigins(),
): Record<string, string> {
  const origin = req.headers.get('origin');
  if (origin === null || !isAllowedOrigin(origin, allowed)) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Headers': CORS_ALLOW_HEADERS,
    'Access-Control-Allow-Methods': CORS_ALLOW_METHODS,
    'Access-Control-Expose-Headers': 'content-disposition',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

export interface ResponseInitLite {
  status?: number;
  headers?: Record<string, string>;
}

export function json(req: Request, body: unknown, init: ResponseInitLite = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...corsHeaders(req),
      ...(init.headers ?? {}),
    },
  });
}

export function error(req: Request, status: number, message: string, details?: unknown): Response {
  return json(req, details === undefined ? { error: message } : { error: message, details }, {
    status,
  });
}

export function text(req: Request, body: string, init: ResponseInitLite = {}): Response {
  return new Response(body, {
    status: init.status ?? 200,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      ...corsHeaders(req),
      ...(init.headers ?? {}),
    },
  });
}

/** 204 for OPTIONS requests, null otherwise. */
export function preflight(req: Request): Response | null {
  if (req.method !== 'OPTIONS') return null;
  return new Response(null, { status: 204, headers: corsHeaders(req) });
}

export function requireMethod(req: Request, ...methods: string[]): void {
  if (!methods.includes(req.method)) {
    throw new HttpError(405, `Method not allowed; use ${methods.join(' or ')}`);
  }
}

export async function readJson(req: Request): Promise<unknown> {
  const body = await req.text();
  if (!body.trim()) return {};
  try {
    return JSON.parse(body);
  } catch {
    throw new HttpError(400, 'Body must be valid JSON');
  }
}

export function formatIssues(err: z.ZodError): string[] {
  return err.issues.map((issue) => {
    const path = issue.path.map(String).join('.');
    return `${path || '(root)'}: ${issue.message}`;
  });
}

/** Validate with a Zod schema; failures become a 400 with one line per issue. */
export function parseWith<S extends z.ZodType>(schema: S, input: unknown): z.output<S> {
  const result = schema.safeParse(input);
  if (!result.success) throw new HttpError(400, 'Invalid request', formatIssues(result.error));
  return result.data as z.output<S>;
}

export function bearerToken(req: Request): string | null {
  const header = req.headers.get('authorization') ?? '';
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  const token = match?.[1]?.trim();
  return token ? token : null;
}

/** Constant-time string comparison for shared secrets. */
export function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  if (ab.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  return diff === 0;
}

export type Handler = (req: Request) => Promise<Response>;

/**
 * Wraps a handler with CORS preflight and error mapping:
 * HttpError → its status, ZodError → 400, EnvError → 500 ("not configured"), anything else → 500.
 * Messages for 5xx never include internal details; the cause is logged instead.
 */
export function withHandler(name: string, fn: Handler): Handler {
  return async (req: Request): Promise<Response> => {
    const pre = preflight(req);
    if (pre) return pre;
    try {
      return await fn(req);
    } catch (err) {
      if (err instanceof HttpError) {
        if (err.status >= 500) logError(`${name}.error`, err, { status: err.status });
        return error(req, err.status, err.message, err.details);
      }
      if (err instanceof z.ZodError) return error(req, 400, 'Invalid request', formatIssues(err));
      if (err instanceof EnvError) {
        logError(`${name}.config`, err, { variable: err.variable });
        return error(req, 500, 'Function is not configured');
      }
      logError(`${name}.unhandled`, err);
      return error(req, 500, 'Internal error');
    }
  };
}
