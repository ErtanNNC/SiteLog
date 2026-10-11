import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Database } from './db-types';
import { env, isDemo } from './env';

export type Db = SupabaseClient<Database>;

/**
 * Typed Supabase client (anon key + the signed-in user's JWT; RLS does the rest).
 * `null` in demo mode — every consumer must go through the DataSource, never the client directly.
 */
export const supabase: Db | null =
  !isDemo && env.supabaseUrl && env.supabaseAnonKey
    ? createClient<Database>(env.supabaseUrl, env.supabaseAnonKey, {
        auth: {
          persistSession: true,
          autoRefreshToken: true,
          detectSessionInUrl: true,
          flowType: 'pkce',
          storageKey: 'sitelog.auth',
        },
        realtime: { params: { eventsPerSecond: 5 } },
      })
    : null;

export function requireSupabase(): Db {
  if (!supabase) throw new Error('Supabase client is not configured (demo mode)');
  return supabase;
}
