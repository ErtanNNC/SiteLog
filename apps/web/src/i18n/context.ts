import { createContext } from 'react';
import type { PanelLanguage } from './language';

/**
 * A language a subtree is pinned to, whatever the panel's language: `<EnglishOnly>` pins the pages
 * that have not moved to `t()` yet, so the shared components inside them stay in English too.
 */
export const PinnedLanguage = createContext<PanelLanguage | null>(null);
