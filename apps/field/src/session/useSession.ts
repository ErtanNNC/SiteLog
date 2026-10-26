import { useContext } from 'react';
import { SessionContext, type SessionApi } from './context';

export function useSession(): SessionApi {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error('useSession needs a SessionProvider');
  return ctx;
}
