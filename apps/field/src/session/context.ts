import { createContext } from 'react';
import type { FieldSession } from './session';

export interface SessionApi {
  session: FieldSession | null;
  /** Replaces the session (null signs this phone out of the link). */
  update(next: FieldSession | null): void;
  /** Changes some fields of the current session. */
  patch(changes: Partial<FieldSession>): void;
}

/** The resolved link for the whole app (`SessionProvider`, `useSession`). */
export const SessionContext = createContext<SessionApi | null>(null);
