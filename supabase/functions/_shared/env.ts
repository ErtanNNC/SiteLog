/**
 * Environment access for the Edge Functions (§5.1).
 *
 * Values are read lazily (never at import time) so modules and tests can be loaded without
 * secrets. `SUPABASE_URL`, `SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY` are injected by the
 * platform; everything else is set with `supabase secrets set NAME=value` (see README.md).
 */

export class EnvError extends Error {
  readonly variable: string;

  constructor(variable: string) {
    super(`Missing required environment variable: ${variable}`);
    this.name = 'EnvError';
    this.variable = variable;
  }
}

export function requireEnv(name: string): string {
  const value = Deno.env.get(name)?.trim();
  if (!value) throw new EnvError(name);
  return value;
}

export function optionalEnv(name: string): string | undefined {
  const value = Deno.env.get(name)?.trim();
  return value ? value : undefined;
}

export function envOr(name: string, fallback: string): string {
  return optionalEnv(name) ?? fallback;
}
