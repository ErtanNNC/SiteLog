import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';
import { i18n } from './src/i18n/i18n';
import { FakeKeyRange } from './src/test/fakeIndexedDb';

// jsdom has no IndexedDB: the store's key ranges come from the fake (src/test/fakeIndexedDb.ts).
(globalThis as { IDBKeyRange?: unknown }).IDBKeyRange ??= FakeKeyRange;

afterEach(async () => {
  cleanup();
  // The language is global (i18next): a test that switches it must not leak it.
  if (i18n.language !== 'en') await i18n.changeLanguage('en');
});
