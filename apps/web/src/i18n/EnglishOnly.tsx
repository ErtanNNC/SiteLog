import type { ReactNode } from 'react';
import { PinnedLanguage } from './context';

/**
 * D9: a page whose copy still comes straight from `copy/en.ts` renders in English inside a shell in
 * the panel's language. Shared components in it (`ErrorState`, `ComingNext`…) follow the page, not
 * the shell, and `lang="en"` tells screen readers the page is English (WCAG 3.1.2). A page drops
 * this wrapper when it moves to `t()` and gets its Turkish.
 */
export function EnglishOnly({ children }: { children: ReactNode }) {
  return (
    <PinnedLanguage.Provider value="en">
      <div lang="en" className="contents">
        {children}
      </div>
    </PinnedLanguage.Provider>
  );
}
