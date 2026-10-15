import type { Page, Route } from '@playwright/test';
import type { FieldCountryView } from '@sitelog/shared/countries.ts';
import type {
  AnswerResponse,
  CompleteResponse,
  ConfirmResponse,
  ConsentResponse,
  ReportView,
  ResolveResponse,
  TodayResponse,
  UploadResponse,
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
  };
}

export const OTP = '482913';
export const REPORT_ID = '6f1c2b9e-0d4a-4c1e-9b7a-3e2f1d0c9b8a';
export const REPORT_NO = 'RL-2041-0188';
export const QUESTION_ID = '11111111-0000-4000-8000-00000000f101';

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
    /** Confirm & send was accepted. */
    confirmed: boolean;
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
  /** The question has no answers to tap (D28: the number input). */
  noOptions?: boolean;
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
      answered: null,
      confirmed: false,
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
  let pollsSinceAnswer = 0;
  let pollsSinceConfirm = 0;

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
        const st = api.state;
        const written = ++reportPolls > st.processingPolls;
        const audio = api.completed.length;
        let status: ReportView['status'] = 'processing';
        let question: ReportView['question'] = null;
        let data: DailyReportData | null = null;
        if (written && st.answered === null) {
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
          };
        } else if (st.answered !== null) {
          // decide_next runs once after the answer, then the draft; filing after Confirm & send.
          data = answeredDraft(market, st.answered);
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
          progress: { voiceNotes: audio, transcribed: written ? audio : 0, photos: 0 },
          // A filed report's PDF, signed (W1-15's Filed screen opens it in a new tab).
          pdfUrl: status === 'filed' ? `/__storage/pdfs/${REPORT_NO}_v1.pdf?token=e2e` : null,
        };
        if (status === 'filed') api.state.report = { id: REPORT_ID, reportNo: REPORT_NO, status };
        return json(route, 200, res);
      }
      if (path === `reports/${REPORT_ID}/answer`) {
        const b = body as { questionId: string; optionId?: string; value?: number };
        if (b.questionId !== QUESTION_ID || api.state.answered !== null) {
          return json(route, 409, { error: 'question_closed' });
        }
        const workers = b.optionId ? Number(b.optionId === 'o1' ? 4 : 5) : b.value;
        if (typeof workers !== 'number') return json(route, 400, { error: 'answer_not_accepted' });
        api.state.answered = workers;
        const entry = answeredDraft(market, workers).manpower[market.askedCrew]!;
        const res: AnswerResponse = {
          status: 'processing',
          reportStatus: 'processing',
          confirmation: {
            kind: 'crew',
            company: entry.companyName,
            workers,
            hoursPerWorker: entry.hoursPerWorker,
            totalHours: entry.totalHours,
          },
        };
        return json(route, 202, res);
      }
      if (path === `reports/${REPORT_ID}/confirm`) {
        if (api.state.answered === null) return json(route, 409, { error: 'wrong_state' });
        api.state.confirmed = true;
        return json(route, 202, { status: 'queued' } satisfies ConfirmResponse);
      }
      return json(route, 404, { error: 'not_found' });
    },
  );
  return api;
}
