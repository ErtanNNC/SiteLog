import type { Page, Route } from '@playwright/test';
import type { FieldCountryView } from '@sitelog/shared/countries.ts';
import type {
  CompleteResponse,
  ConsentResponse,
  ReportView,
  ResolveResponse,
  TodayResponse,
  UploadResponse,
} from '@sitelog/shared/field-contract.ts';
import type { ReporterLocale } from '@sitelog/shared/locale.ts';

/**
 * A fake field-api for the screen flows of `e2e/screens.spec.ts` (W1-09): Playwright answers the
 * app's same-origin `/api/*` calls (no Supabase) with the shapes of `field-contract.ts`, and the
 * signed upload URL points at a fake Storage on the app's own origin. It keeps the state a real
 * flow changes (device verified, consent given, the uploads, the day's status) and records what
 * the app sent, so a spec can assert the requests. The real thing is `e2e/supabase/`.
 */

export interface Market {
  reporter: ResolveResponse['reporter'];
  org: ResolveResponse['org'];
  site: TodayResponse['site'];
  country: FieldCountryView;
  /** `today.date` and `deadlineAt` (17:30 at the site). */
  date: string;
  deadlineAt: string;
}

/** §18.1 Kestrel, Marco at Riverside Lofts (Field-01..04), Fri Oct 9. */
export function kestrel(locale: ReporterLocale = 'en-US'): Market {
  return {
    reporter: {
      name: 'Marco Ruiz',
      firstName: 'Marco',
      locale,
      contactPref: 'link',
      status: 'invited',
    },
    org: { name: 'Kestrel Build Group' },
    site: {
      id: 'a72cfd9d-46d6-4d33-8bd6-eb11c2437b8d',
      name: 'Riverside Lofts — Block B',
      timezone: 'America/Chicago',
      status: 'active',
    },
    country: {
      code: 'US',
      voiceNumber: null,
      fieldLocales: ['en-US', 'es-US'],
      twoWaySms: true,
      messageChannels: ['sms'],
      legalKeys: {},
    },
    date: '2026-10-09',
    deadlineAt: '2026-10-09T22:30:00.000Z',
  };
}

/** §18.2 Demir Yapı, Ataşehir Ofis Binası (Field-10), Fri Oct 9: a one-way pack, no voice number. */
export function demir(): Market {
  return {
    reporter: {
      name: 'Emre Yıldız',
      firstName: 'Emre',
      locale: 'tr-TR',
      contactPref: 'link',
      status: 'invited',
    },
    org: { name: 'Demir Yapı A.Ş.' },
    site: {
      id: 'b1f0a3c2-6d0e-4f7a-9a51-2c4d8e9f0a11',
      name: 'Ataşehir Ofis Binası',
      timezone: 'Europe/Istanbul',
      status: 'active',
    },
    country: {
      code: 'TR',
      voiceNumber: null,
      fieldLocales: ['tr-TR', 'en-US'],
      twoWaySms: false,
      messageChannels: ['sms'],
      legalKeys: {},
    },
    date: '2026-10-09',
    deadlineAt: '2026-10-09T14:30:00.000Z',
  };
}

export const OTP = '482913';
export const REPORT_ID = '6f1c2b9e-0d4a-4c1e-9b7a-3e2f1d0c9b8a';
export const REPORT_NO = 'RL-2041-0188';

export interface FakeFieldApi {
  state: {
    verified: boolean;
    consented: boolean;
    /** When true every field-api and Storage call fails like a phone without signal. */
    noSignal: boolean;
    dayStatus: TodayResponse['dayStatus'];
    report: TodayResponse['report'];
    /** `GET reports/:id` answers `processing` this many times, then a draft. */
    processingPolls: number;
  };
  calls: { method: string; path: string; body: unknown; headers: Record<string, string> }[];
  /** The files PUT to the fake Storage: content type and size. */
  stored: { uploadId: string; contentType: string; bytes: number }[];
  consent: unknown;
  completed: string[];
  /** What the fake refuses; change it between steps. */
  options: FakeOptions;
}

async function json(route: Route, status: number, body: unknown) {
  await route.fulfill({ status, json: body, headers: { 'cache-control': 'no-store' } });
}

/** A refusal field-api answers instead of the route's success. */
export interface Refusal {
  status: number;
  error: string;
  extra?: Record<string, unknown>;
}

export interface FakeOptions {
  verified?: boolean;
  consented?: boolean;
  /** `resolve` refuses the link (link_not_found, link_expired …) or fails (500). */
  resolveError?: Refusal;
  /** `today` fails (500: the "couldn't load today" screen). */
  todayError?: Refusal;
  /** `uploads/:id/complete` refuses every upload (day_closed …). */
  completeError?: Refusal;
  /** The reporter's other sites (the site switcher). */
  moreSites?: TodayResponse['site'][];
}

export async function installFakeFieldApi(
  page: Page,
  market: Market,
  opts: FakeOptions = {},
): Promise<FakeFieldApi> {
  const api: FakeFieldApi = {
    state: {
      verified: opts.verified ?? false,
      consented: opts.consented ?? false,
      noSignal: false,
      dayStatus: 'pending',
      report: null,
      processingPolls: 1,
    },
    calls: [],
    stored: [],
    consent: null,
    completed: [],
    options: { ...opts },
  };
  const options = api.options;
  let uploads = 0;
  let reportPolls = 0;

  await page.route('**/__storage/upload/**', async (route) => {
    if (api.state.noSignal) return route.abort('internetdisconnected');
    const req = route.request();
    const uploadId = new URL(req.url()).pathname.split('/').pop()!;
    api.stored.push({
      uploadId,
      contentType: req.headers()['content-type'] ?? '',
      bytes: req.postDataBuffer()?.length ?? 0,
    });
    await json(route, 200, { Key: `audio/${uploadId}` });
  });

  await page.route(
    (url) => url.pathname === '/api' || url.pathname.startsWith('/api/'),
    async (route) => {
      if (api.state.noSignal) return route.abort('internetdisconnected');
      const req = route.request();
      const url = new URL(req.url());
      const path = url.pathname.replace(/^\/api\/?/, '');
      const raw = req.postData();
      const body: unknown = raw ? JSON.parse(raw) : null;
      api.calls.push({ method: req.method(), path, body, headers: req.headers() });

      const refuse = (r: Refusal) => json(route, r.status, { error: r.error, ...r.extra });
      const sites = [market.site, ...(options.moreSites ?? [])];

      if (path === 'resolve') {
        if (options.resolveError) return refuse(options.resolveError);
        const res: ResolveResponse = {
          reporter: { ...market.reporter, status: api.state.consented ? 'active' : 'invited' },
          org: market.org,
          link: { kind: 'personal', siteId: null, reportDate: null, expiresAt: null },
          needsDeviceCheck: !api.state.verified,
          needsConsent: !api.state.consented,
          sites: api.state.verified ? sites : [],
          country: market.country,
        };
        return json(route, 200, res);
      }
      if (path === 'device/send-code') {
        return json(route, 202, { sent: true, expiresAt: '2026-10-09T20:10:00.000Z' });
      }
      if (path === 'device/verify') {
        if ((body as { code?: string }).code !== OTP) {
          return json(route, 400, { error: 'code_invalid', details: { attemptsLeft: 4 } });
        }
        api.state.verified = true;
        return json(route, 200, { verified: true, needsConsent: !api.state.consented });
      }
      if (!api.state.verified) return json(route, 401, { error: 'device_unverified' });
      if (path === 'consent') {
        api.consent = body;
        api.state.consented = true;
        const b = body as { contactPref: ConsentResponse['contactPref']; locale: ReporterLocale };
        const res: ConsentResponse = {
          consents: ['data_processing', 'recording', 'sms'],
          status: 'active',
          contactPref: b.contactPref,
          locale: b.locale,
        };
        return json(route, 200, res);
      }
      if (!api.state.consented) return json(route, 403, { error: 'consent_required' });
      if (path === 'today') {
        if (options.todayError) return refuse(options.todayError);
        const res: TodayResponse = {
          site: market.site,
          sites,
          date: market.date,
          allowedDates: [market.date],
          deadlineAt: market.deadlineAt,
          dayStatus: api.state.dayStatus,
          report: api.state.report,
        };
        return json(route, 200, res);
      }
      if (path === 'day-status') {
        api.state.dayStatus = (body as { status: TodayResponse['dayStatus'] }).status;
        return json(route, 200, { siteDayId: 'sd1', status: api.state.dayStatus, changed: true });
      }
      if (path === 'uploads') {
        const uploadId = `00000000-0000-4000-8000-${String(++uploads).padStart(12, '0')}`;
        const res: UploadResponse = {
          uploadId,
          bucket: 'audio',
          path: `org/site/${market.date}/${uploadId}.webm`,
          signedUrl: `${url.origin}/__storage/upload/${uploadId}?token=t`,
          token: 't',
        };
        return json(route, 201, res);
      }
      const complete = /^uploads\/([^/]+)\/complete$/.exec(path);
      if (complete) {
        const uploadId = complete[1]!;
        if (!api.stored.some((s) => s.uploadId === uploadId)) {
          return json(route, 409, { error: 'upload_missing' });
        }
        if (options.completeError) return refuse(options.completeError);
        api.completed.push(uploadId);
        api.state.dayStatus = 'processing';
        api.state.report = { id: REPORT_ID, reportNo: REPORT_NO, status: 'processing' };
        const res: CompleteResponse = {
          reportId: REPORT_ID,
          reportNo: REPORT_NO,
          reportStatus: 'processing',
          created: api.completed.length === 1,
          alreadyComplete: false,
        };
        return json(route, 200, res);
      }
      if (path === `reports/${REPORT_ID}`) {
        const done = ++reportPolls > api.state.processingPolls;
        const audio = api.completed.length;
        const res: ReportView = {
          id: REPORT_ID,
          reportNo: REPORT_NO,
          status: done ? 'awaiting_confirmation' : 'processing',
          siteId: market.site.id,
          siteName: market.site.name,
          date: market.date,
          channel: 'web',
          currentVersion: done ? 1 : 0,
          needsReview: false,
          filedAt: null,
          confirmedAt: null,
          question: null,
          data: null,
          progress: { voiceNotes: audio, transcribed: done ? audio : 0, photos: 0 },
          pdfUrl: null,
        };
        return json(route, 200, res);
      }
      return json(route, 404, { error: 'not_found' });
    },
  );
  return api;
}
