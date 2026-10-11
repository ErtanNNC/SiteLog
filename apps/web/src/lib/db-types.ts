/**
 * supabase-js needs table rows typed as object literals (`Record<string, unknown>`-assignable).
 * The shared `Database` type uses interfaces, which lack implicit index signatures, so the client
 * would infer `never`. This adapter re-maps every Row/Insert/Update/Args into a plain object type.
 * (Kept here instead of in packages/shared — the web app must not modify the shared package.)
 */
import type { Database as SharedDatabase } from '@sitelog/shared/db/types.ts';

type Plain<T> = { [K in keyof T]: T[K] };

type SharedTables = SharedDatabase['public']['Tables'];
type SharedViews = SharedDatabase['public']['Views'];
type SharedFunctions = SharedDatabase['public']['Functions'];

export type Database = {
  public: {
    Tables: {
      [K in keyof SharedTables]: {
        Row: Plain<SharedTables[K]['Row']>;
        Insert: Plain<SharedTables[K]['Insert']>;
        Update: Plain<SharedTables[K]['Update']>;
        Relationships: [];
      };
    };
    Views: {
      [K in keyof SharedViews]: { Row: Plain<SharedViews[K]['Row']>; Relationships: [] };
    };
    Functions: {
      [K in keyof SharedFunctions]: {
        Args: Plain<SharedFunctions[K]['Args']>;
        Returns: SharedFunctions[K]['Returns'];
      };
    };
    Enums: SharedDatabase['public']['Enums'];
    CompositeTypes: Record<string, never>;
  };
};
