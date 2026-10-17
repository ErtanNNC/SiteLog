import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { i18n } from '@/i18n/i18n';
import { browserLanguages, resolveFieldLanguage } from '@/i18n/language';
import { SessionContext } from './context';
import { loadSession, saveSession, type FieldSession } from './session';

/**
 * The resolved link for the whole app (`session/session.ts`), persisted on every change. The UI
 * language follows the reporter's locale once a link is resolved (spec §9.3 "UI language").
 */
export function SessionProvider({
  initial,
  persist = true,
  children,
}: {
  /** For tests: the session to start with (default: the stored one). */
  initial?: FieldSession | null;
  persist?: boolean;
  children: ReactNode;
}) {
  const [session, setSession] = useState<FieldSession | null>(() =>
    initial === undefined ? loadSession() : initial,
  );

  const update = useCallback(
    (next: FieldSession | null) => {
      setSession(next);
      if (persist) saveSession(next);
    },
    [persist],
  );
  const patch = useCallback(
    (changes: Partial<FieldSession>) => {
      setSession((current) => {
        if (!current) return current;
        const next = { ...current, ...changes };
        if (persist) saveSession(next);
        return next;
      });
    },
    [persist],
  );

  // Before a link is resolved the language stays the phone's (set when i18n was initialised).
  const locale = session?.reporter.locale ?? null;
  useEffect(() => {
    if (!locale) return;
    const language = resolveFieldLanguage({ reporterLocale: locale, browser: browserLanguages() });
    if (i18n.resolvedLanguage !== language) void i18n.changeLanguage(language);
  }, [locale]);

  const value = useMemo(() => ({ session, update, patch }), [session, update, patch]);
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}
