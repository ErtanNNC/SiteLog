import { QueryClient } from '@tanstack/react-query';

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      gcTime: 5 * 60_000,
      retry: (count, err) => {
        // Permission errors never succeed on retry.
        const msg = err instanceof Error ? err.message : '';
        if (/not allowed|permission|42501|no access/i.test(msg)) return false;
        return count < 1;
      },
      refetchOnWindowFocus: false,
    },
    mutations: { retry: 0 },
  },
});

/** Query keys — always scoped by org so an org switch never shows another org's cache. */
export const qk = {
  org: (org: string) => [org] as const,
  overview: (org: string) => [org, 'overview'] as const,
  sites: (org: string) => [org, 'sites'] as const,
  site: (org: string, siteId: string, month: string) => [org, 'site', siteId, month] as const,
  reports: (org: string, filters: unknown) => [org, 'reports', filters] as const,
  report: (org: string, reportId: string) => [org, 'report', reportId] as const,
  hours: (org: string, week: string, siteId: string | null) =>
    [org, 'hours', week, siteId ?? 'all'] as const,
  weather: (org: string, month: string, siteId: string | null) =>
    [org, 'weather', month, siteId ?? 'all'] as const,
  team: (org: string) => [org, 'team'] as const,
  glossary: (org: string) => [org, 'glossary'] as const,
  settings: (org: string) => [org, 'settings'] as const,
  billing: (org: string) => [org, 'billing'] as const,
  notifications: (org: string) => [org, 'notifications'] as const,
  setup: (org: string) => [org, 'setup'] as const,
  search: (org: string, q: string) => [org, 'search', q] as const,
  demoPhone: (org: string) => [org, 'demoPhone'] as const,
  demoPhoneThread: (org: string, reporterId: string) =>
    [org, 'demoPhone', 'thread', reporterId] as const,
  demoPhoneEmails: (org: string) => [org, 'demoPhone', 'emails'] as const,
  /** /ops is platform-wide (not org data): keyed by the signed-in user, invalidated by ['ops']. */
  opsAccess: (userId: string) => ['ops', userId, 'access'] as const,
  ops: (userId: string) => ['ops', userId, 'dashboard'] as const,
  orglessContacts: (userId: string) => ['ops', userId, 'orgless-contacts'] as const,
};
