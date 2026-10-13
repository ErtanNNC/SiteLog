import type { ReactNode } from 'react';
import { useFieldCopy } from '@/i18n/useFieldCopy';
import { DateLine } from './DateLine';
import { Header } from './Header';

/**
 * One field screen (§14.6: one decision per screen): the top bar, the date line and the content,
 * in a single column that never scrolls sideways at 390 px. `title` names the page in the browser
 * tab and the app switcher ("Today · SiteLog").
 */
export function Screen({
  title,
  settings = false,
  dateLine = true,
  children,
}: {
  title: string;
  settings?: boolean;
  dateLine?: boolean;
  children: ReactNode;
}) {
  const { tc } = useFieldCopy();
  return (
    <div className="flex min-h-dvh flex-col bg-chalk text-asphalt">
      <title>{`${title} · ${tc('appName')}`}</title>
      <Header settings={settings} />
      <main className="flex min-w-0 flex-1 flex-col gap-4 px-[18px] pt-[18px] pb-4">
        {dateLine ? <DateLine /> : null}
        {children}
      </main>
    </div>
  );
}

/** A screen's heading: Archivo 800, stretched (§14.2 H1), wrapping rather than overflowing. */
export function ScreenTitle({ children }: { children: ReactNode }) {
  return (
    <h1 className="m-0 text-[30px] leading-9 font-extrabold tracking-[-0.01em] [overflow-wrap:anywhere] [font-stretch:120%]">
      {children}
    </h1>
  );
}
