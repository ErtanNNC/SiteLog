import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Database, Json, SchedulerStateRow, StripeEventRow } from '@sitelog/shared';

export type { SchedulerStateRow, StripeEventRow };
import { requireEnv } from './env.ts';

/**
 * Typed supabase-js clients.
 *
 * supabase-js requires every `Row` to extend `Record<string, unknown>`. The hand-maintained rows in
 * `@sitelog/shared/db/types.ts` are interfaces (no implicit index signature), which makes the
 * whole schema fall back to `never`. The schema is therefore re-mapped into plain object types
 * here, and the RPC signatures this layer relies on (`log_audit`, `notify_org`, `invoice_gaps`) are
 * pinned.
 */
type Plain<T> = { [K in keyof T]: T[K] };
type PlainTable<T> = T extends {
  Row: infer R;
  Insert: infer I;
  Update: infer U;
  Relationships: infer L;
}
  ? { Row: Plain<R>; Insert: Plain<I>; Update: Plain<U>; Relationships: L }
  : never;
type PlainView<T> = T extends { Row: infer R; Relationships: infer L }
  ? { Row: Plain<R>; Relationships: L }
  : never;

export interface InvoiceGapRow {
  company_id: string;
  company_name: string;
  invoiced: number;
  reported: number;
  gap: number;
  invoice_id: string;
  invoice_status: string;
}

type ExtraFunctions = {
  log_audit: {
    Args: {
      p_org: string | null;
      p_actor_type: string;
      p_actor_id: string | null;
      p_action: string;
      p_entity: string | null;
      p_entity_id: string | null;
      p_diff?: Json | null;
    };
    Returns: undefined;
  };
  notify_org: {
    Args: {
      p_org: string;
      p_kind: string;
      p_title: string;
      p_body?: string | null;
      p_target_path?: string | null;
      p_user_id?: string | null;
      p_data?: Json | null;
    };
    Returns: string;
  };
  invoice_gaps: {
    Args: { p_org: string; p_start: string; p_end: string };
    Returns: InvoiceGapRow[];
  };
};

type Tables0 = Database['public']['Tables'];
type Views0 = Database['public']['Views'];

export type AppDatabase = {
  public: {
    Tables: { [K in keyof Tables0]: PlainTable<Tables0[K]> };
    Views: { [K in keyof Views0]: PlainView<Views0[K]> };
    Functions: Database['public']['Functions'] & ExtraFunctions;
    Enums: Database['public']['Enums'];
    CompositeTypes: Database['public']['CompositeTypes'];
  };
};

export type AppClient = SupabaseClient<AppDatabase>;
export type TableName = keyof AppDatabase['public']['Tables'];
export type TableRow<T extends TableName> = AppDatabase['public']['Tables'][T]['Row'];
export type TableInsert<T extends TableName> = AppDatabase['public']['Tables'][T]['Insert'];
export type TableUpdate<T extends TableName> = AppDatabase['public']['Tables'][T]['Update'];

const AUTH_OPTIONS = {
  persistSession: false,
  autoRefreshToken: false,
  detectSessionInUrl: false,
} as const;

let cachedAdmin: AppClient | null = null;

/** Service-role client (bypasses RLS). Cached per isolate. */
export function adminClient(): AppClient {
  if (!cachedAdmin) {
    cachedAdmin = createClient<AppDatabase>(
      requireEnv('SUPABASE_URL'),
      requireEnv('SUPABASE_SERVICE_ROLE_KEY'),
      { auth: AUTH_OPTIONS },
    );
  }
  return cachedAdmin;
}

/** Anon-key client that forwards the caller's Authorization header, so RLS applies as that user. */
export function userClient(req: Request): AppClient {
  const authorization = req.headers.get('authorization');
  return createClient<AppDatabase>(requireEnv('SUPABASE_URL'), requireEnv('SUPABASE_ANON_KEY'), {
    auth: AUTH_OPTIONS,
    global: { headers: authorization ? { Authorization: authorization } : {} },
  });
}

/**
 * Reads every row of a query, paging past PostgREST's `max_rows` cap (1000 by default).
 * `page` must apply `.range(from, to)` on an ordered query and resolve with `{ data }`.
 */
export async function fetchAll<T>(
  page: (from: number, to: number) => PromiseLike<{ data: T[] }>,
  size = 1000,
): Promise<T[]> {
  const rows: T[] = [];
  for (let from = 0; ; from += size) {
    const { data } = await page(from, from + size - 1);
    rows.push(...data);
    if (data.length < size) break;
  }
  return rows;
}
