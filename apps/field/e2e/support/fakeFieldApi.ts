import type { Page, Route } from '@playwright/test';
import type { FieldCountryView } from '@sitelog/shared/countries.ts';
import type {
  AnswerConfirmation,
  AnswerResponse,
  TestClipResponse,
  TestClipView,
  CompleteResponse,
  CorrectionView,
  ConfirmResponse,
  ConsentResponse,
  ExpiredLinkResponse,
  HistoryResponse,
  PreferencesResponse,
  ReportView,
  ResolveResponse,
  TodayResponse,
  UploadResponse,
  VoiceTokenResponse,
} from '@sitelog/shared/field-contract.ts';
import type { ReporterLocale } from '@sitelog/shared/locale.ts';
import { emptyReportData, type DailyReportData } from '@sitelog/shared/schemas/report.ts';

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
  /** The open question after processing (Field-05): the model's words in the reporter's language. */
  question: { prompt: string; options: [string, string] };
  /** The draft (Field-06) in the org's report language; the asked crew is `manpower[askedCrew]`. */
  draft: DailyReportData;
  askedCrew: number;
  /** W2-10: the model's question for a fix that names no crew, in the reporter's language. */
  fixClarification: string;
}

/** A crew line of a fake draft: `workers` null until the question is answered. */
function crew(
  companyName: string,
  workers: number | null,
  heardAt = 30,
): DailyReportData['manpower'][number] {
  return {
    companyId: null,
    companyNameHeard: companyName,
    companyName,
    workers,
    hoursPerWorker: 8,
    totalHours: workers === null ? null : workers * 8,
    hoursBasis: workers === null ? 'full_day_default' : 'stated',
    confidence: 0.9,
    source: [{ type: 'voice_note', uploadId: 'u1', start: heardAt }],
  };
}

/** The draft after the answer: the asked crew's headcount from it, the total computed (code's). */
/** F7's line for a headcount answered (code's numbers, as field-api and the worker make it). */
export function crewConfirmation(market: Market, workers: number): AnswerConfirmation {
  const entry = answeredDraft(market, workers).manpower[market.askedCrew]!;
  return {
    kind: 'crew',
    company: entry.companyName,
    workers,
    hoursPerWorker: entry.hoursPerWorker,
    totalHours: entry.totalHours,
  };
}

export function answeredDraft(market: Market, workers: number): DailyReportData {
  const draft = structuredClone(market.draft);
  const entry = draft.manpower[market.askedCrew]!;
  entry.workers = workers;
  entry.totalHours = workers * (entry.hoursPerWorker ?? 0);
  entry.source.push({ type: 'answer', questionId: QUESTION_ID });
  return draft;
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
    question:
      locale === 'es-US'
        ? {
            prompt: 'Dijo “los de Delta” en el Nivel 2. ¿Cuántos eran y por cuánto tiempo?',
            options: ['4 · todo el día', '5 · todo el día'],
          }
        : {
            prompt: 'You said “the Delta guys” were on Level 2. How many, and for how long?',
            options: ['4 · full day', '5 · full day'],
          },
    draft: {
      ...emptyReportData('2026-10-09', { reportLanguage: 'en', units: 'imperial' }),
      summary: 'Slab pour on Level 4; rain stopped masonry in the morning.',
      weather: {
        conditionsText: 'Rain AM',
        periods: [
          {
            start: '07:00',
            end: '10:30',
            condition: 'Rain',
            impact: 'masonry stopped',
            lostHours: 3.5,
            source: [],
          },
        ],
      },
      manpower: [
        crew('Apex Concrete', 6),
        crew('BrightLine Electric', 5),
        crew('Delta Mechanical', null, 80),
        crew('Ironclad Steel', 3),
        crew('Kestrel crew', 4),
      ],
      workPerformed: [{ area: 'Level 4', activity: 'slab pour', status: 'complete', source: [] }],
      deliveries: [{ item: 'Rebar', quantity: '2 loads', supplier: 'Ironclad', source: [] }],
      safety: {
        toolboxTalk: 'Ladders',
        incidents: [],
        noIncidentsStated: true,
        visitors: [],
        source: [],
      },
    },
    askedCrew: 2,
    fixClarification: locale === 'es-US' ? '¿Qué cuadrilla eran tres?' : 'Which crew had three?',
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
    question: {
      prompt: '“Kaya’nın ekibi” 3. katta dediniz. Kaç kişiydiler, ne kadar çalıştılar?',
      options: ['4 · tam gün', '5 · tam gün'],
    },
    draft: {
      ...emptyReportData('2026-10-09', { reportLanguage: 'tr', units: 'metric' }),
      summary: 'Kalıp işleri sürdü.',
      manpower: [crew('Kaya İnşaat', null, 45), crew('Demir Yapı ekibi', 6)],
      workPerformed: [
        {
          area: '3. kat',
          activity: 'kalıp',
          status: 'in_progress',
          percentComplete: 40,
          source: [],
        },
      ],
      safety: { incidents: [], noIncidentsStated: true, visitors: [], source: [] },
    },
    askedCrew: 0,
    fixClarification: 'Hangi ekip üç kişiydi?',
  };
}

export const OTP = '482913';
export const REPORT_ID = '6f1c2b9e-0d4a-4c1e-9b7a-3e2f1d0c9b8a';
export const REPORT_NO = 'RL-2041-0188';
export const QUESTION_ID = '11111111-0000-4000-8000-00000000f101';
/** The weather-day report `day-status` makes (W2-08). */
export const DAY_OFF_REPORT_ID = '6f1c2b9e-0d4a-4c1e-9b7a-3e2f1d0c9b90';

export interface FakeFieldApi {
  state: {
    verified: boolean;
    consented: boolean;
    /** When true every field-api and Storage call fails like a phone without signal. */
    noSignal: boolean;
    dayStatus: TodayResponse['dayStatus'];
    report: TodayResponse['report'];
    /**
     * `GET reports/:id` answers `processing` this many times, then the question (Field-05); after
     * the answer `processing` once more, then the draft (Field-06); after Confirm & send `filing`
     * (still awaiting confirmation) once, then `filed`.
     */
    processingPolls: number;
    /** The headcount answered (null: the question is open). */
    answered: number | null;
    /**
     * W2-09: the spoken answer being listened to (its clip), the unclear tries so far, and whether
     * the question was left for the office (unclear twice).
     */
    listening: string | null;
    unclearTries: number;
    leftForOffice: boolean;
    /** The question answered by voice (for `lastVoiceAnswer`). */
    spokenAnswer: boolean;
    /** The reporter consented once (resolve answers `active` from then on, as field-api). */
    activated: boolean;
    /** Confirm & send was accepted. */
    confirmed: boolean;
    /**
     * W2-10 (F8): the draft's revision (a fix or a stepper saved moves it on), the fix being made
     * (its preview after one listening poll) and the crew changes saved, oldest first.
     */
    draftRev: number;
    fix: {
      id: string;
      via: 'voice' | 'text';
      polls: number;
      applied: boolean;
      uploadId?: string;
    } | null;
    fixes: { index: number; workers: number | null; hoursPerWorker: number | null }[];
    /** Settings (F15, W2-02): what `preferences` answers; consent/revoke and PATCH change it. */
    prefs: PreferencesResponse;
  };
  calls: { method: string; path: string; body: unknown; headers: Record<string, string> }[];
  /** The files PUT to the fake Storage: content type and size. */
  stored: { uploadId: string; contentType: string; bytes: number }[];
  /** W2-13: the test recordings (F4): the request, the file PUT, and the polls. */
  testClips: { id: string; body: unknown; stored: boolean; polls: number }[];
  /** F9 (W2-04): the batches added to a filed report of `options.reports`, by batch id. */
  batches: Record<
    string,
    { reportId: string; size: number; photos: number; completed: string[]; version: number | null }
  >;
  /** W2-11 (F10): the changes of a filed report of `options.reports`, by correction id. */
  changes: Record<
    string,
    {
      reportId: string;
      via: 'voice' | 'text';
      polls: number;
      version: number | null;
      uploadId?: string;
    }
  >;
  consent: unknown;
  /** W2-14: the subscription `push/subscribe` stored, null once unsubscribed. */
  pushSubscription: unknown;
  completed: string[];
  /** W3-13: the `voice/token` requests (Talk now), with the call each made. */
  talkCalls: { siteId: string; callId: string }[];
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
  /** The question has no answers to tap (D28: the number input). */
  noOptions?: boolean;
  /** `resolve` answers a daily link of this site (F14: daily links are site-specific). */
  dailyLinkSite?: string;
  /**
   * Each site's deadline (ISO): `today` without a site picks the nearest to now, as field-api's
   * `nearestDeadlineSite` does (F14); without it, `market.site`.
   */
  deadlines?: Record<string, string>;
  /** `GET history` (W2-03). */
  history?: HistoryResponse['reports'];
  /** `GET reports/:id` for a past report (W2-03). */
  reports?: Record<string, ReportView>;
  /** `POST expired/daily-link` (F16): the answer, or a refusal. */
  expiredAnswer?: ExpiredLinkResponse | Refusal;
  /**
   * W2-09: what the worker makes of a spoken answer: a headcount (applied, full day), or
   * `unclear` (asked once more, then left for the office). Default 5.
   */
  voiceAnswer?: number | 'unclear';
  /** W2-13: what the worker makes of the test recording (default: heard, in the reporter's language). */
  testClip?: 'heard' | 'silent' | 'rate_limited';
  /** Settings (§19 Q86): the phone opted out of texts (STOP): `consent/grant` answers 409. */
  textsOptedOut?: boolean;
  /**
   * W2-10: what the worker makes of a fix: one more worker on the fixed crew (the first crew that
   * was not asked: "Apex had seven, not six"), or `unclear` (the model asks which crew).
   */
  fixAnswer?: 'one_more' | 'unclear';
  /** W2-14: this environment has a VAPID key pair and the pack lists push (the toggle shows). */
  push?: boolean;
  /** W2-15: the pack lists WhatsApp (*Message me on WhatsApp* on Welcome and in Settings). */
  whatsapp?: boolean;
  /**
   * W3-13: Talk now is offered (`talkNow` in resolve and today), and `voice/token` answers this
   * `livekitUrl`: a `fake:scripted?…` script the app's fake VoiceClient plays (`src/voice/fake.ts`).
   */
  talkNow?: string;
  /** W3-13: `voice/token` refuses (rate_limited …). */
  talkNowError?: Refusal;
  /** W3-13: the day's report once the call ended (what the agent filed or left as a draft). */
  talkReport?: NonNullable<TodayResponse['report']>;
  /** W3-13 (F9): `resolve` answers a photos link of `dailyLinkSite` (the call-filed report's day). */
  photosLink?: boolean;
  /**
   * W3-17 (spec §19 Q51, Q132): TalkOlog places automated calls for the org (`placesCalls`): the
   * Welcome box, Settings' automated-call row and, for a call reporter, "Don't call me today".
   */
  placesCalls?: boolean;
}

/** W2-14: the fake VAPID public key `push/key` answers (65 bytes, base64url). */
export const FAKE_VAPID_KEY =
  'BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U';

/** The fake transcript of a test recording, in the reporter's language (fixtures/voice, kind test). */
export const TEST_SNIPPETS: Record<string, string> = {
  en: 'Testing, one, two, three. Can you hear me?',
  es: 'Probando, uno, dos, tres. ¿Me oye bien?',
  tr: 'Deneme, bir, iki, üç. Beni duyuyor musunuz?',
};

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
      answered: null,
      listening: null,
      unclearTries: 0,
      leftForOffice: false,
      spokenAnswer: false,
      activated: opts.consented ?? false,
      confirmed: false,
      draftRev: 1,
      fix: null,
      fixes: [],
      prefs: {
        contactPref: market.reporter.contactPref,
        locale: market.reporter.locale,
        messageChannel: null,
        messageChannels: market.country.messageChannels.filter((c) => c === 'sms'),
        consents: opts.consented
          ? [
              { type: 'sms', held: true },
              ...(opts.placesCalls
                ? [
                    {
                      type: 'auto_call' as const,
                      held: market.reporter.contactPref === 'call',
                    },
                  ]
                : []),
              { type: 'recording', held: true },
              { type: 'data_processing', held: true },
            ]
          : [],
        textsOptedOut: opts.textsOptedOut ?? false,
        push: { offered: opts.push ?? false, on: false },
        placesCalls: opts.placesCalls ?? false,
        noCallsUntil: null,
      },
    },
    calls: [],
    stored: [],
    testClips: [],
    batches: {},
    changes: {},
    consent: null,
    pushSubscription: null,
    completed: [],
    talkCalls: [],
    options: { ...opts },
  };
  const options = api.options;
  let uploads = 0;
  const batchOf = new Map<string, string>();
  /** W2-09: answer clips (uploads with `answerTo`). */
  const answerClips = new Set<string>();
  /** W2-10: correction clips (uploads with `fixTo`). */
  const fixClips = new Set<string>();
  /** The crew a fix changes: the first one that was not asked. */
  const fixCrew = market.askedCrew === 0 ? 1 : 0;
  /** The draft shown: the answered one, with the fixes saved on it (totals in code). */
  const fixedDraft = (workers: number): DailyReportData => {
    const draft = answeredDraft(market, workers);
    for (const f of api.state.fixes) {
      const entry = draft.manpower[f.index]!;
      entry.workers = f.workers;
      entry.hoursPerWorker = f.hoursPerWorker;
      entry.totalHours =
        f.workers === null || f.hoursPerWorker === null ? null : f.workers * f.hoursPerWorker;
    }
    return draft;
  };
  const fixView = (st: FakeFieldApi['state']): CorrectionView | null => {
    const f = st.fix;
    if (!f || f.applied) return null;
    const base = fixedDraft(st.answered ?? 0).manpower[fixCrew]!;
    const listening = f.polls < 1;
    const unclear = !listening && options.fixAnswer === 'unclear';
    const to = (base.workers ?? 0) + 1;
    return {
      id: f.id,
      status: listening ? 'listening' : unclear ? 'unclear' : 'ready',
      via: f.via,
      changes:
        listening || unclear
          ? null
          : [
              {
                kind: 'crew',
                company: base.companyName,
                change: 'changed',
                workers: [base.workers, to],
                hoursPerWorker: [base.hoursPerWorker, base.hoursPerWorker],
                totalHours: [base.totalHours, to * (base.hoursPerWorker ?? 0)],
              },
            ],
      clarification: unclear ? market.fixClarification : null,
      reason: unclear ? 'clarification' : null,
      version: listening || unclear ? null : 1,
      draftRev: listening || unclear ? null : st.draftRev,
      afterFiling: false,
    };
  };
  let reportPolls = 0;
  let pollsSinceAnswer = 0;
  let pollsSinceConfirm = 0;
  let listeningPolls = 0;

  // W2-13: the test recording's PUT (its own path, so `stored` holds report files only).
  await page.route('**/__storage/test/**', async (route) => {
    if (api.state.noSignal) return route.abort('internetdisconnected');
    const id = new URL(route.request().url()).pathname.split('/').pop()!;
    const clip = api.testClips.find((c) => c.id === id);
    if (clip) clip.stored = true;
    await json(route, 200, { Key: `audio/test/${id}` });
  });

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

      // F16: the expired link's own route needs no device (W2-03).
      if (path === 'expired/daily-link') {
        const answer = options.expiredAnswer ?? { sent: true, channel: 'sms' };
        return 'error' in answer ? refuse(answer) : json(route, 200, answer);
      }
      if (path === 'resolve') {
        if (options.resolveError) return refuse(options.resolveError);
        const res: ResolveResponse = {
          reporter: {
            ...market.reporter,
            // What Settings changed (W2-02).
            locale: api.state.prefs.locale,
            contactPref: api.state.prefs.contactPref,
            status: api.state.activated ? 'active' : 'invited',
          },
          org: market.org,
          link: options.dailyLinkSite
            ? {
                kind: options.photosLink ? 'photos' : 'daily',
                siteId: options.dailyLinkSite,
                reportDate: market.date,
                expiresAt: '2026-10-12T22:00:00.000Z',
              }
            : { kind: 'personal', siteId: null, reportDate: null, expiresAt: null },
          needsDeviceCheck: !api.state.verified,
          needsConsent: !api.state.consented,
          sites: api.state.verified
            ? sites.filter((s) => !options.dailyLinkSite || s.id === options.dailyLinkSite)
            : [],
          country: options.whatsapp
            ? { ...market.country, messageChannels: ['push', 'whatsapp', 'sms'] }
            : market.country,
          talkNow: options.talkNow !== undefined,
          placesCalls: options.placesCalls ?? false,
        };
        return json(route, 200, res);
      }
      if (path === 'device/send-code') {
        return json(route, 202, { sent: true, expiresAt: '2026-10-09T20:10:00.000Z' });
      }
      if (path === 'device/verify') {
        if ((body as { code?: string }).code !== OTP) {
          return json(route, 400, { error: 'code_invalid', attemptsLeft: 4 });
        }
        api.state.verified = true;
        return json(route, 200, { verified: true, needsConsent: !api.state.consented });
      }
      if (!api.state.verified) return json(route, 401, { error: 'device_unverified' });
      // Settings (W2-02): a verified device, with or without the required consents.
      if (path === 'preferences') {
        if (req.method() === 'PATCH') {
          const b = body as Partial<PreferencesResponse>;
          api.state.prefs = {
            ...api.state.prefs,
            ...(b.contactPref ? { contactPref: b.contactPref } : {}),
            ...(b.locale ? { locale: b.locale } : {}),
            ...(b.messageChannel !== undefined ? { messageChannel: b.messageChannel } : {}),
            // W3-17 (§19 Q129): until the end of today (a few hours on, whatever the clock).
            ...((body as { noCallsToday?: boolean }).noCallsToday
              ? { noCallsUntil: new Date(Date.now() + 6 * 3600_000).toISOString() }
              : {}),
          };
        }
        return json(route, 200, api.state.prefs);
      }
      if (path === 'consent/revoke') {
        const { type } = body as { type: string };
        api.state.prefs = {
          ...api.state.prefs,
          consents: api.state.prefs.consents.map((c) =>
            c.type === type ? { ...c, held: false } : c,
          ),
        };
        if (type === 'recording' || type === 'data_processing') api.state.consented = false;
        return json(route, 200, api.state.prefs);
      }
      // §19 Q86: texts back on; an opted-out phone is refused (field-api's 409).
      if (path === 'consent/grant') {
        const { type } = body as { type: string };
        if (type === 'sms' && api.state.prefs.textsOptedOut)
          return json(route, 409, { error: 'texts_opted_out' });
        api.state.prefs = {
          ...api.state.prefs,
          consents: api.state.prefs.consents.map((c) =>
            c.type === type ? { ...c, held: true } : c,
          ),
        };
        return json(route, 200, api.state.prefs);
      }
      // W2-14: web push, a verified device with or without the required consents.
      if (path === 'push/key') {
        return json(route, 200, { publicKey: options.push ? FAKE_VAPID_KEY : null });
      }
      if (path === 'push/subscribe') {
        api.pushSubscription = (body as { subscription: unknown }).subscription;
        api.state.prefs = { ...api.state.prefs, push: { ...api.state.prefs.push, on: true } };
        return json(route, 200, api.state.prefs);
      }
      if (path === 'push/unsubscribe') {
        api.pushSubscription = null;
        api.state.prefs = { ...api.state.prefs, push: { ...api.state.prefs.push, on: false } };
        return json(route, 200, api.state.prefs);
      }
      if (path === 'device/sign-out') {
        api.state.verified = false;
        return json(route, 200, { signedOut: true });
      }
      if (path === 'consent') {
        api.consent = body;
        api.state.consented = true;
        api.state.activated = true;
        api.state.prefs = {
          ...api.state.prefs,
          consents: [
            ...(['sms', 'recording', 'data_processing'] as const)
              .filter((t) => (body as { types: string[] }).types.includes(t))
              .map((type) => ({ type, held: true })),
            // W3-17: listed wherever TalkOlog places calls, held when ticked.
            ...(options.placesCalls
              ? [
                  {
                    type: 'auto_call' as const,
                    held: (body as { types: string[] }).types.includes('auto_call'),
                  },
                ]
              : []),
            // W2-15: listed wherever the pack lists WhatsApp, held when ticked.
            ...(options.whatsapp
              ? [
                  {
                    type: 'whatsapp' as const,
                    held: (body as { types: string[] }).types.includes('whatsapp'),
                  },
                ]
              : []),
          ],
        };
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
      if (path === 'test-clip') {
        if (options.testClip === 'rate_limited')
          return json(route, 429, { error: 'rate_limited', retryAfter: 3000 });
        const id = `7e570000-0000-4000-8000-${String(api.testClips.length + 1).padStart(12, '0')}`;
        api.testClips.push({ id, body, stored: false, polls: 0 });
        const res: TestClipResponse = {
          testClipId: id,
          bucket: 'audio',
          path: `test/org/${id}.webm`,
          signedUrl: `${url.origin}/__storage/test/${id}?token=t`,
          token: 't',
        };
        return json(route, 201, res);
      }
      const testComplete = /^test-clip\/([^/]+)\/complete$/.exec(path);
      if (testComplete) {
        const clip = api.testClips.find((c) => c.id === testComplete[1]);
        if (!clip) return json(route, 404, { error: 'not_found' });
        if (!clip.stored) return json(route, 409, { error: 'upload_missing' });
        return json(route, 202, { status: 'pending', snippet: null } satisfies TestClipView);
      }
      const testRead = /^test-clip\/([^/]+)$/.exec(path);
      if (testRead) {
        const clip = api.testClips.find((c) => c.id === testRead[1]);
        if (!clip) return json(route, 404, { error: 'not_found' });
        // The worker hears it on the second poll; the words go once read.
        if (++clip.polls < 2)
          return json(route, 200, { status: 'pending', snippet: null } satisfies TestClipView);
        if (clip.polls > 2)
          return json(route, 200, { status: 'gone', snippet: null } satisfies TestClipView);
        const view: TestClipView =
          options.testClip === 'silent'
            ? { status: 'silent', snippet: null }
            : {
                status: 'heard',
                snippet: TEST_SNIPPETS[api.state.prefs.locale.split('-')[0]!] ?? TEST_SNIPPETS.en!,
              };
        return json(route, 200, view);
      }
      if (path === 'today') {
        if (options.todayError) return refuse(options.todayError);
        // The asked site, else the daily link's, else the nearest deadline (F14).
        const scoped = sites.filter(
          (s) => !options.dailyLinkSite || s.id === options.dailyLinkSite,
        );
        const asked = url.searchParams.get('site') ?? options.dailyLinkSite;
        const deadlines = options.deadlines ?? {};
        const nearest = [...scoped].sort(
          (a, b) =>
            Math.abs(Date.parse(deadlines[a.id] ?? market.deadlineAt) - Date.now()) -
            Math.abs(Date.parse(deadlines[b.id] ?? market.deadlineAt) - Date.now()),
        )[0]!;
        const site = asked ? scoped.find((s) => s.id === asked) : nearest;
        if (!site) return json(route, 404, { error: 'not_found' });
        const res: TodayResponse = {
          site,
          sites: scoped,
          date: market.date,
          allowedDates: [market.date],
          deadlineAt: deadlines[site.id] ?? market.deadlineAt,
          dayStatus: api.state.dayStatus,
          report: api.state.report,
          talkNow: options.talkNow !== undefined,
        };
        return json(route, 200, res);
      }
      if (path === 'history') {
        return json(route, 200, { reports: options.history ?? [] } satisfies HistoryResponse);
      }
      // W3-13: Talk now's call (the fake VoiceClient plays `options.talkNow`'s script).
      if (path === 'voice/token') {
        if (options.talkNow === undefined)
          return refuse({ status: 403, error: 'talk_now_unavailable' });
        if (options.photosLink) return refuse({ status: 400, error: 'kind_not_allowed' });
        if (options.talkNowError) return refuse(options.talkNowError);
        const siteId = (body as { siteId: string }).siteId;
        const callId = `7a1c0000-0000-4000-8000-${String(api.talkCalls.length + 1).padStart(12, '0')}`;
        api.talkCalls.push({ siteId, callId });
        // What the call leaves: the agent filed the report (or saved a draft) before it ends.
        if (options.talkReport) {
          api.state.report = options.talkReport;
          api.state.dayStatus = options.talkReport.status === 'filed' ? 'filed' : 'processing';
        }
        const res: VoiceTokenResponse = {
          livekitUrl: options.talkNow,
          token: 'fake-participant-token',
          room: `call-${callId}`,
          callId,
        };
        return json(route, 201, res);
      }
      const past = /^reports\/([^/]+)$/.exec(path);
      if (past && options.reports?.[past[1]!]) return json(route, 200, options.reports[past[1]!]);
      // ── W2-11: Change something on a filed report of `options.reports` (F10) ────────────────
      const change = /^reports\/([^/]+)\/correction(?:\/([^/]+)(\/apply)?)?$/.exec(path);
      if (change && options.reports?.[change[1]!]) {
        const reportId = change[1]!;
        const report = options.reports[reportId]!;
        const crew = report.data!.manpower[0]!;
        const to = (crew.workers ?? 0) + 1;
        const view = (id: string): CorrectionView => {
          const c = api.changes[id]!;
          const listening = c.polls < 1;
          return {
            id,
            status: c.version !== null ? 'applied' : listening ? 'listening' : 'ready',
            via: c.via,
            changes: listening
              ? null
              : [
                  {
                    kind: 'crew',
                    company: crew.companyName,
                    change: 'changed',
                    workers: [crew.workers, to],
                    hoursPerWorker: [crew.hoursPerWorker, crew.hoursPerWorker],
                    totalHours: [crew.totalHours, to * (crew.hoursPerWorker ?? 0)],
                  },
                ],
            clarification: null,
            reason: null,
            version: listening ? null : report.currentVersion,
            draftRev: listening ? null : 1,
            afterFiling: true,
          };
        };
        if (!change[2]) {
          if (!report.change?.canChange)
            return json(route, 409, {
              error: report.change?.locked ? 'report_locked' : 'wrong_state',
            });
          const b = body as { uploadId?: string; text?: string };
          // The same clip again (the queue sent it, then the screen): the same change.
          const seen = Object.entries(api.changes).find(
            ([, c]) => b.uploadId !== undefined && c.uploadId === b.uploadId,
          );
          if (seen) return json(route, 202, view(seen[0]));
          const id = `f${api.calls.length}-0000-4000-8000-000000000000`;
          api.changes[id] = {
            reportId,
            via: b.uploadId ? 'voice' : 'text',
            polls: 0,
            version: null,
            ...(b.uploadId ? { uploadId: b.uploadId } : {}),
          };
          return json(route, 202, view(id));
        }
        const c = api.changes[change[2]];
        if (!c || c.reportId !== reportId) return json(route, 404, { error: 'not_found' });
        if (!change[3]) {
          const res = view(change[2]);
          c.polls++;
          return json(route, 200, res);
        }
        if (view(change[2]).status !== 'ready')
          return json(route, 409, { error: 'correction_not_ready' });
        // Save change: version n+1 with code's numbers and its _v{n} PDF.
        const version = report.currentVersion + 1;
        c.version = version;
        const hours = crew.hoursPerWorker ?? 0;
        options.reports[reportId] = {
          ...report,
          currentVersion: version,
          changeNote: `${crew.companyName} ${crew.workers} → ${to} workers, ${crew.totalHours} → ${to * hours} h`,
          pdfUrl: `/__storage/pdfs/${report.reportNo}_v${version}.pdf?token=e2e`,
          data: {
            ...report.data!,
            manpower: [
              { ...crew, workers: to, totalHours: to * hours },
              ...report.data!.manpower.slice(1),
            ],
          },
        };
        return json(route, 200, { status: 'applied', reportStatus: 'filed', version });
      }
      if (path === 'day-status') {
        // W2-08 (spec §19 Q41): a weather day makes a report, which the worker files; no work
        // (no no-work PDF here) the site-day only.
        const status = (body as { status: 'no_work' | 'weather_day' }).status;
        api.state.dayStatus = status;
        const report =
          status === 'weather_day' ? { id: DAY_OFF_REPORT_ID, reportNo: 'RL-2041-0190' } : null;
        if (report) api.state.report = { ...report, status: 'filed', kind: 'weather_day' };
        return json(route, 200, { siteDayId: 'sd1', status, changed: true, report });
      }
      if (path === 'uploads') {
        const uploadId = `00000000-0000-4000-8000-${String(++uploads).padStart(12, '0')}`;
        const addTo = (
          body as {
            addTo?: { reportId: string; batchId: string; photos: number; caption: boolean };
          }
        ).addTo;
        if ((body as { answerTo?: unknown }).answerTo) answerClips.add(uploadId);
        if ((body as { fixTo?: unknown }).fixTo) fixClips.add(uploadId);
        if (addTo) {
          // F9: a photo (or caption) for a filed report of `options.reports`, in a batch.
          api.batches[addTo.batchId] ??= {
            reportId: addTo.reportId,
            size: addTo.photos + (addTo.caption ? 1 : 0),
            photos: addTo.photos,
            completed: [],
            version: null,
          };
          batchOf.set(uploadId, addTo.batchId);
        }
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
        const batchId = batchOf.get(uploadId);
        if (batchId) {
          const batch = api.batches[batchId]!;
          if (!batch.completed.includes(uploadId)) batch.completed.push(uploadId);
          const report = options.reports![batch.reportId]!;
          const ready = batch.completed.length >= batch.size;
          if (ready && batch.version === null) {
            // The batch is whole: the next version, "N photos added", its _v{n} PDF.
            const version = report.currentVersion + 1;
            batch.version = version;
            options.reports![batch.reportId] = {
              ...report,
              currentVersion: version,
              changeNote: batch.photos === 1 ? '1 photo added' : `${batch.photos} photos added`,
              pdfUrl: `/__storage/pdfs/${report.reportNo}_v${version}.pdf?token=e2e`,
              addPhotos: report.addPhotos && {
                ...report.addPhotos,
                remaining: report.addPhotos.remaining - batch.photos,
                canAdd: report.addPhotos.remaining - batch.photos > 0,
              },
            };
          }
          const res: CompleteResponse = {
            reportId: batch.reportId,
            reportNo: report.reportNo,
            reportStatus: 'filed',
            created: false,
            alreadyComplete: false,
            batch: { id: batchId, ready, version: batch.version },
          };
          return json(route, 200, res);
        }
        if (fixClips.has(uploadId)) {
          // W2-10: a correction clip is staged on the draft, not a voice note of it.
          const res: CompleteResponse = {
            reportId: REPORT_ID,
            reportNo: REPORT_NO,
            reportStatus: 'awaiting_confirmation',
            created: false,
            alreadyComplete: false,
          };
          return json(route, 200, res);
        }
        if (answerClips.has(uploadId)) {
          // W2-09: an answer clip is staged on the question's report, not a voice note of it.
          const res: CompleteResponse = {
            reportId: REPORT_ID,
            reportNo: REPORT_NO,
            reportStatus: 'awaiting_answer',
            created: false,
            alreadyComplete: false,
          };
          return json(route, 200, res);
        }
        if (options.completeError) return refuse(options.completeError);
        api.completed.push(uploadId);
        api.state.dayStatus = 'processing';
        api.state.report = {
          id: REPORT_ID,
          reportNo: REPORT_NO,
          status: 'processing',
          kind: 'daily',
        };
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
        const st = api.state;
        const written = ++reportPolls > st.processingPolls;
        const audio = api.completed.length;
        let status: ReportView['status'] = 'processing';
        let question: ReportView['question'] = null;
        let data: DailyReportData | null = null;
        // W2-09: the worker settles a spoken answer on the poll after the one that showed it.
        let voice: NonNullable<ReportView['question']>['voice'] = null;
        if (written && st.listening !== null) {
          if (listeningPolls++ >= 1) {
            st.listening = null;
            listeningPolls = 0;
            const said = options.voiceAnswer ?? 5;
            if (said === 'unclear') {
              st.unclearTries++;
              if (st.unclearTries >= 2) st.leftForOffice = true;
              else voice = { state: 'retry', unclear: st.unclearTries };
            } else {
              st.answered = said;
              st.spokenAnswer = true;
            }
          } else {
            voice = { state: 'listening', unclear: st.unclearTries };
          }
        } else if (st.unclearTries === 1 && !st.leftForOffice) {
          voice = { state: 'retry', unclear: st.unclearTries };
        }
        if (written && st.answered === null && !st.leftForOffice) {
          status = 'awaiting_answer';
          data = market.draft;
          question = {
            id: QUESTION_ID,
            field: 'manpower.workers',
            prompt: market.question.prompt,
            options: options.noOptions
              ? null
              : market.question.options.map((label, i) => ({ id: `o${i + 1}`, label })),
            manpowerIndex: market.askedCrew,
            voice,
          };
        } else if (st.leftForOffice) {
          // Unclear twice (F7): left for the office, the draft without the headcount.
          data = market.draft;
          status = ++pollsSinceAnswer <= 1 ? 'processing' : 'awaiting_confirmation';
        } else if (st.answered !== null) {
          // decide_next runs once after the answer, then the draft; filing after Confirm & send.
          data = fixedDraft(st.answered);
          status =
            ++pollsSinceAnswer <= 1
              ? 'processing'
              : st.confirmed && ++pollsSinceConfirm > 1
                ? 'filed'
                : 'awaiting_confirmation';
        }
        const res: ReportView = {
          id: REPORT_ID,
          reportNo: REPORT_NO,
          status,
          kind: 'daily',
          siteId: market.site.id,
          siteName: market.site.name,
          date: market.date,
          channel: 'web',
          currentVersion: written ? 1 : 0,
          needsReview: false,
          filedAt: status === 'filed' ? '2026-10-09T22:44:00.000Z' : null,
          confirmedAt: st.confirmed ? '2026-10-09T22:43:00.000Z' : null,
          question,
          data,
          draftRev: data ? st.draftRev : null,
          progress: { voiceNotes: audio, transcribed: written ? audio : 0, photos: 0 },
          // A filed report's PDF, signed (W1-15's Filed screen opens it in a new tab).
          pdfUrl: status === 'filed' ? `/__storage/pdfs/${REPORT_NO}_v1.pdf?token=e2e` : null,
          // F9 (W2-04): the Filed screen offers more photos until 23:59 the next day.
          addPhotos:
            status === 'filed'
              ? { canAdd: true, remaining: 4, until: '2026-10-11T04:59:00.000Z', pending: 0 }
              : null,
          changeNote: null,
          correction: status === 'awaiting_confirmation' ? fixView(st) : null,
          change: status === 'filed' ? { canChange: false, locked: false } : null,
          lastVoiceAnswer: st.leftForOffice
            ? { questionId: QUESTION_ID, outcome: 'unclear' }
            : st.spokenAnswer && st.answered !== null
              ? {
                  questionId: QUESTION_ID,
                  outcome: 'applied',
                  confirmation: crewConfirmation(market, st.answered),
                }
              : null,
        };
        if (status === 'filed')
          api.state.report = { id: REPORT_ID, reportNo: REPORT_NO, status, kind: 'daily' };
        return json(route, 200, res);
      }
      if (path === `reports/${REPORT_ID}/answer`) {
        const b = body as {
          questionId: string;
          optionId?: string;
          value?: number;
          uploadId?: string;
        };
        if (b.questionId !== QUESTION_ID || api.state.answered !== null) {
          return json(route, 409, { error: 'question_closed' });
        }
        if (b.uploadId) {
          // W2-09: a spoken answer, listened to by the worker.
          if (!answerClips.has(b.uploadId)) return json(route, 404, { error: 'not_found' });
          api.state.listening = b.uploadId;
          const res: AnswerResponse = {
            status: 'listening',
            reportStatus: 'awaiting_answer',
            confirmation: null,
          };
          return json(route, 202, res);
        }
        const workers = b.optionId ? Number(b.optionId === 'o1' ? 4 : 5) : b.value;
        if (typeof workers !== 'number') return json(route, 400, { error: 'answer_not_accepted' });
        api.state.answered = workers;
        const res: AnswerResponse = {
          status: 'processing',
          reportStatus: 'processing',
          confirmation: crewConfirmation(market, workers),
        };
        return json(route, 202, res);
      }
      // ── W2-10: Fix by voice and the steppers ─────────────────────────────────────────────────
      if (path === `reports/${REPORT_ID}/correction`) {
        const st = api.state;
        if (st.answered === null) return json(route, 409, { error: 'wrong_state' });
        const b = body as { uploadId?: string; text?: string };
        if (b.uploadId && !fixClips.has(b.uploadId))
          return json(route, 404, { error: 'not_found' });
        // The same clip again (the queue sent it, then the screen): the same fix.
        if (b.uploadId && st.fix?.uploadId === b.uploadId) return json(route, 202, fixView(st));
        if (st.fix && !st.fix.applied && st.fix.polls < 1)
          return json(route, 409, { error: 'correction_pending' });
        st.fix = {
          id: `c${api.calls.length}-0000-4000-8000-000000000000`,
          via: b.uploadId ? 'voice' : 'text',
          polls: 0,
          applied: false,
          ...(b.uploadId ? { uploadId: b.uploadId } : {}),
        };
        return json(route, 202, fixView(st));
      }
      const fixPoll = /^reports\/[^/]+\/correction\/([^/]+)$/.exec(path);
      if (fixPoll) {
        const st = api.state;
        if (!st.fix || st.fix.id !== fixPoll[1]) return json(route, 404, { error: 'not_found' });
        const view = fixView(st);
        st.fix.polls++;
        return json(route, 200, view);
      }
      const fixApply = /^reports\/[^/]+\/correction\/([^/]+)\/apply$/.exec(path);
      if (fixApply) {
        const st = api.state;
        const view = fixView(st);
        if (!st.fix || st.fix.id !== fixApply[1] || view?.status !== 'ready')
          return json(route, 409, { error: 'correction_not_ready' });
        const line = view.changes![0] as {
          workers: [number, number];
          hoursPerWorker: [number, number];
        };
        st.fixes.push({
          index: fixCrew,
          workers: line.workers[1],
          hoursPerWorker: line.hoursPerWorker[1],
        });
        st.fix.applied = true;
        st.draftRev++;
        pollsSinceAnswer = 0;
        return json(route, 200, { status: 'applied', reportStatus: 'processing' });
      }
      if (path === `reports/${REPORT_ID}/edit`) {
        const st = api.state;
        const b = body as {
          version: number;
          draftRev: number;
          index: number;
          workers: number | null;
          hoursPerWorker: number | null;
        };
        if (b.draftRev !== st.draftRev) return json(route, 409, { error: 'draft_changed' });
        st.fixes.push({ index: b.index, workers: b.workers, hoursPerWorker: b.hoursPerWorker });
        st.draftRev++;
        pollsSinceAnswer = 0;
        return json(route, 202, { status: 'processing', reportStatus: 'processing' });
      }
      if (path === `reports/${REPORT_ID}/confirm`) {
        if (api.state.answered === null) return json(route, 409, { error: 'wrong_state' });
        // The draft shown is version 1 at its revision (field-api checks both, 20261015000070).
        const b = body as { version?: number; draftRev?: number };
        if (b.version !== 1 || b.draftRev !== api.state.draftRev)
          return json(route, 409, { error: 'draft_changed' });
        api.state.confirmed = true;
        return json(route, 202, { status: 'queued' } satisfies ConfirmResponse);
      }
      return json(route, 404, { error: 'not_found' });
    },
  );
  return api;
}
