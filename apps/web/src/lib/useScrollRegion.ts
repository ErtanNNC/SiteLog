import { useEffect, useState } from 'react';

/**
 * WCAG 2.1.1: a region that scrolls sideways (wide tables at 375 px) must be reachable from the
 * keyboard when nothing inside it can take focus. While the element overflows, it becomes a
 * focusable, labelled region; on wide screens it stays out of the tab order.
 */
export function useScrollRegion<T extends HTMLElement = HTMLDivElement>(label?: string) {
  const [el, setEl] = useState<T | null>(null);
  const [overflows, setOverflows] = useState(false);

  useEffect(() => {
    if (!el || typeof ResizeObserver === 'undefined') return;
    const check = () => setOverflows(el.scrollWidth > el.clientWidth + 1);
    check();
    const ro = new ResizeObserver(check);
    ro.observe(el);
    for (const child of Array.from(el.children)) ro.observe(child);
    return () => ro.disconnect();
  }, [el]);

  return {
    ref: setEl,
    tabIndex: overflows ? 0 : undefined,
    role: overflows ? 'region' : undefined,
    'aria-label': overflows ? label : undefined,
  } as const;
}
