import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import { useFieldCopy } from '@/i18n/useFieldCopy';
import { DateLine } from './DateLine';
import { Header } from './Header';

/**
 * One field screen (§14.6: one decision per screen): the top bar, the date line and the content,
 * in a single column that never scrolls sideways at 390 px. `title` names the page in the browser
 * tab and the app switcher ("Today · TalkOlog"). `header` replaces the default top bar (Today's site
 * switcher, Recording's status bar); `dark` is the Recording screen (Chalk on Asphalt, Field-04).
 *
 * When a screen mounts, focus moves to its `h1`: the control that was focused (Stop & send, the
 * code field) is gone, and a screen reader starts reading the new screen there. A screen whose
 * phase changes on the same route (the link flow, Recording) passes a `key` per phase, so each
 * phase mounts its own `Screen`.
 */
export function Screen({
  title,
  settings = false,
  dateLine = true,
  header,
  dark = false,
  children,
}: {
  title: string;
  settings?: boolean;
  dateLine?: boolean;
  header?: ReactNode;
  dark?: boolean;
  children: ReactNode;
}) {
  const { tc } = useFieldCopy();
  const main = useRef<HTMLElement>(null);

  useEffect(() => {
    const heading = main.current?.querySelector<HTMLElement>('h1');
    if (!heading) return;
    // Focusable from script only, never a Tab stop; no ring on a heading (it is not a control).
    if (!heading.hasAttribute('tabindex')) heading.setAttribute('tabindex', '-1');
    heading.classList.add('outline-none');
    heading.focus({ preventScroll: true });
  }, []);

  return (
    <div
      data-on-dark={dark ? true : undefined}
      className={`flex min-h-dvh flex-col ${dark ? 'bg-asphalt text-chalk' : 'bg-chalk text-asphalt'}`}
    >
      <title>{`${title} · ${tc('appName')}`}</title>
      {header ?? <Header settings={settings} />}
      <main ref={main} className="flex min-w-0 flex-1 flex-col gap-4 px-[18px] pt-[18px] pb-4">
        {dateLine ? <DateLine /> : null}
        {children}
      </main>
    </div>
  );
}

/** A screen's heading: Archivo 800, stretched (§14.2 H1), wrapping rather than overflowing. */
export function ScreenTitle({ children, id }: { children: ReactNode; id?: string }) {
  return (
    <h1
      id={id}
      tabIndex={-1}
      className="m-0 text-[26px] leading-[30px] font-extrabold tracking-[-0.01em] outline-none [overflow-wrap:anywhere] [font-stretch:118%]"
    >
      {children}
    </h1>
  );
}

/** The sticky bottom action bar (§14.6): the screen's primary action, above the home indicator. */
export function ActionBar({ children, dark = false }: { children: ReactNode; dark?: boolean }) {
  return (
    <div
      className={`sticky bottom-0 mt-auto -mx-[18px] flex gap-3 border-t px-[18px] pt-3 pb-5 ${
        dark ? 'border-steel bg-asphalt' : 'border-rebar bg-chalk'
      }`}
    >
      {children}
    </div>
  );
}
