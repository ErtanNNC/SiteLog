import { render } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router';
import { vi } from 'vitest';
import type { FieldCountryView } from '@sitelog/shared/countries.ts';
import type { TodayResponse } from '@sitelog/shared/field-contract.ts';
import { ApiProvider } from '@/api/ApiContext';
import { FieldApiError } from '@/api/client';
import type { FieldRoutes } from '@/api/field';
import { UploadQueue } from '@/queue/queue';
import { QueueProvider } from '@/queue/QueueContext';
import { MemoryQueueStore } from '@/queue/store';
import type { UploadOutcome } from '@/queue/uploader';
import { FieldRoutes as AppRoutes } from '@/routes';
import type { FieldSession } from '@/session/session';
import { SessionProvider } from '@/session/SessionContext';

/** The Kestrel pack subset as `resolve` returns it (§18.1): no voice number in week 1. */
export const US_COUNTRY: FieldCountryView = {
  code: 'US',
  voiceNumber: null,
  fieldLocales: ['en-US', 'es-US'],
  twoWaySms: true,
  messageChannels: ['sms'],
  legalKeys: {},
};

export const SITE = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Riverside Lofts — Block B',
  timezone: 'America/Chicago',
  status: 'active' as const,
};
export const SITE_2 = {
  id: '22222222-2222-4222-8222-222222222222',
  name: 'Pier 9 Warehouse',
  timezone: 'America/Chicago',
  status: 'active' as const,
};

/** Marco's resolved personal link, verified and consented. */
export function demoSession(patch: Partial<FieldSession> = {}): FieldSession {
  return {
    code: 'K7Q2MX',
    reporter: {
      name: 'Marco Ruiz',
      firstName: 'Marco',
      locale: 'en-US',
      contactPref: 'link',
      status: 'active',
    },
    org: { name: 'Kestrel Build Group' },
    link: { kind: 'personal', siteId: null, reportDate: null, expiresAt: null },
    country: US_COUNTRY,
    sites: [SITE],
    needsDeviceCheck: false,
    needsConsent: false,
    siteId: null,
    date: null,
    ...patch,
  };
}

/** Fri Oct 9, 2026: nothing sent yet, deadline 17:30 Chicago (22:30Z). */
export function todayResponse(patch: Partial<TodayResponse> = {}): TodayResponse {
  return {
    site: SITE,
    sites: [SITE],
    date: '2026-10-09',
    allowedDates: ['2026-10-09'],
    deadlineAt: '2026-10-09T22:30:00.000Z',
    dayStatus: 'pending',
    report: null,
    ...patch,
  };
}

export function apiError(status: number, error: string, extra: Record<string, unknown> = {}) {
  return new FieldApiError(status, 'test', { error, ...extra });
}

/** field-api routes that refuse everything until a test scripts them. */
export function fakeRoutes(overrides: Partial<FieldRoutes> = {}): FieldRoutes {
  const refuse = () => Promise.reject(apiError(404, 'not_found'));
  return {
    resolve: vi.fn(refuse),
    sendCode: vi.fn(refuse),
    verify: vi.fn(refuse),
    consent: vi.fn(refuse),
    today: vi.fn(refuse),
    createUpload: vi.fn(refuse),
    completeUpload: vi.fn(refuse),
    report: vi.fn(refuse),
    answer: vi.fn(refuse),
    confirm: vi.fn(refuse),
    dayStatus: vi.fn(refuse),
    ...overrides,
  };
}

/** A queue on a memory store whose uploader is scripted (default: everything succeeds). */
export function fakeQueue(
  upload?: (item: Parameters<UploadQueue['enqueue']>[0]) => Promise<UploadOutcome>,
) {
  const store = new MemoryQueueStore();
  const calls: Parameters<UploadQueue['enqueue']>[0][] = [];
  const queue = new UploadQueue({
    store,
    upload: async (item) => {
      calls.push(item);
      return upload
        ? upload(item)
        : {
            ok: true,
            result: {
              reportId: 'r1',
              reportNo: 'RL-2041-0188',
              reportStatus: 'processing',
              created: true,
              alreadyComplete: false,
            },
          };
    },
    random: () => 0.5,
  });
  return { queue, store, calls };
}

export function renderApp(
  path: string,
  {
    session = demoSession(),
    routes = fakeRoutes(),
    queue,
    children,
  }: {
    session?: FieldSession | null;
    routes?: FieldRoutes;
    queue?: UploadQueue;
    children?: ReactNode;
  } = {},
) {
  const q = queue ?? fakeQueue().queue;
  return render(
    <SessionProvider initial={session} persist={false}>
      <ApiProvider routes={routes}>
        <QueueProvider queue={q} routes={routes}>
          <MemoryRouter initialEntries={[path]}>{children ?? <AppRoutes />}</MemoryRouter>
        </QueueProvider>
      </ApiProvider>
    </SessionProvider>,
  );
}
