import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router';

/**
 * Unsaved-changes guard that works with <BrowserRouter> (no data router → no useBlocker):
 * intercepts clicks on in-app links while `dirty`, asks, and navigates on confirm. Also warns on
 * tab close via beforeunload. Links inside `allowPrefix` (the settings tabs) never prompt.
 */
export function useUnsavedGuard(dirty: boolean, allowPrefix: string) {
  const navigate = useNavigate();
  const location = useLocation();
  const [pending, setPending] = useState<string | null>(null);

  useEffect(() => {
    if (!dirty) return;
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey) return;
      const a = (e.target as HTMLElement | null)?.closest?.('a[href]');
      if (!(a instanceof HTMLAnchorElement)) return;
      if (a.target && a.target !== '_self') return;
      if (a.hasAttribute('download')) return;
      const url = new URL(a.href, window.location.href);
      if (url.origin !== window.location.origin) return;
      const to = url.pathname + url.search;
      if (url.pathname.startsWith(allowPrefix)) return;
      if (to === location.pathname + location.search) return;
      e.preventDefault();
      e.stopPropagation();
      setPending(to);
    };
    const onUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    document.addEventListener('click', onClick, true);
    window.addEventListener('beforeunload', onUnload);
    return () => {
      document.removeEventListener('click', onClick, true);
      window.removeEventListener('beforeunload', onUnload);
    };
  }, [dirty, allowPrefix, location.pathname, location.search]);

  return {
    pending,
    cancel: () => setPending(null),
    proceed: () => {
      const to = pending;
      setPending(null);
      if (to) void navigate(to);
    },
  };
}
