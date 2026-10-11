import { useState } from 'react';
import { Outlet } from 'react-router';
import { copy } from '@/copy/en';
import { Dialog, DialogContent, DialogTitle } from '../ui/Dialog';
import { OfflineBanner } from '../sitelog/States';
import { Sidebar } from './Sidebar';
import { TopBar, TopBarSlotProvider } from './TopBar';

/**
 * §11.2 app shell: 240 px sidebar + top bar + content (max 1240, padding 28/32).
 * < 768 px: top app bar with a menu button opening a drawer (Radix Dialog).
 */
export function AppShell() {
  const [drawer, setDrawer] = useState(false);
  const [slot, setSlot] = useState<HTMLDivElement | null>(null);
  return (
    <TopBarSlotProvider value={slot}>
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded-btn focus:bg-chalk focus:px-3 focus:py-2"
      >
        {copy.app.skipToContent}
      </a>
      <div className="min-h-screen bg-concrete md:grid md:grid-cols-[240px_minmax(0,1fr)]">
        <aside className="sticky top-0 hidden h-screen md:block">
          <Sidebar />
        </aside>
        <div className="flex min-w-0 flex-col">
          <OfflineBanner />
          <TopBar onOpenMenu={() => setDrawer(true)} slotRef={setSlot} />
          <main
            id="main"
            className="mx-auto w-full max-w-[var(--width-content)] px-4 py-6 md:px-8 md:py-7"
            tabIndex={-1}
          >
            <Outlet />
          </main>
        </div>
      </div>
      <Dialog open={drawer} onOpenChange={setDrawer}>
        <DialogContent side="left" hideClose className="bg-asphalt p-0 text-chalk">
          <DialogTitle className="sr-only">{copy.nav.mainNavigation}</DialogTitle>
          <Sidebar onNavigate={() => setDrawer(false)} />
        </DialogContent>
      </Dialog>
    </TopBarSlotProvider>
  );
}
