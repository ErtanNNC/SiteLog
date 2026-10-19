/**
 * §18.1 — Kestrel Build Group demo data, generated deterministically.
 * Used by the seed generator (demo/seed-sql.ts → supabase/seed.sql and `pnpm seed:demo -- --apply`)
 * and by the web panel's demo mode.
 *
 * The channel layer is v1.2 (W1-06): reports come from the web recorder (`uploads`) or a phone call
 * (`calls`), texts are SMS rows of the console driver (`messages` with `copy_key`, rendered with
 * `renderSms` as the app sends them), reporters have consents, a personal link each and their
 * contact preference. History (Sep 21 – Oct 8) keeps its stored v1 report data (D20) with the voice
 * notes and photos as uploads under the same UUIDs; Oct 9 is v1.2 data (`schemaVersion 2`).
 * WhatsApp is left only as one empty thread per reporter for the /try simulator (D29).
 *
 * `buildKestrelDemo({ date })` builds the live demo for a date instead (D36, demo/calendar.ts).
 */
import { fromZonedTime } from 'date-fns-tz';
import type {
  AuditLogRow,
  CallRow,
  CompanyRow,
  ConsentRow,
  ConversationRow,
  EvidencePackRow,
  FieldLinkRow,
  GlossaryTermRow,
  ManpowerEntryRow,
  MessageRow,
  NotificationRow,
  OrgMemberRow,
  QuestionRow,
  ReportRow,
  ReportSourceRow,
  ReportVersionRow,
  ReporterRow,
  SiteDayRow,
  SiteRow,
  SubInvoiceRow,
  TranscriptRow,
  UnknownContactRow,
  UploadRow,
  WeatherEventRow,
  WorkItemRow,
} from '../db/types.ts';
import { V12_ROW_DEFAULTS } from '../db/defaults.ts';
import type { ContactPref, FieldChannel } from '../enums.ts';
import { addDays, firstName, formatMonthDay, formatPhone, isoWeekday } from '../format.ts';
import { languageOf, type ReporterLocale } from '../locale.ts';
import { deadlineInstant } from '../schedule/reminders.ts';
import type {
  DailyReportData,
  DailyReportDataV1,
  ManpowerEntryV1,
  Source,
  StoredReportData,
  WeatherPeriodV1,
} from '../schemas/report.ts';
import { emptyReportDataV1 } from '../schemas/report.ts';
import { deriveTotals } from '../report/hours.ts';
import { noticeData } from '../notifications.ts';
import { evidencePackStoragePath, formatReportNo } from '../report/numbering.ts';
import { PAYROLL_COLUMNS } from '../report/payroll.ts';
import { upgradeV1toV2 } from '../report/upgrade.ts';
import { smsRenderOptions } from '../channels.ts';
import { renderSms, type RenderSmsOptions, type SmsKey } from '../copy/sms.ts';
import { starterGlossaryRows } from '../glossary/starter.ts';
import { VOICE_RECORDING_NOTICE_VERSION } from '../voice.ts';
import { demoId, demoRand } from './ids.ts';
import { DEMO_CANONICAL_TODAY, DEMO_LIVE_START, demoCalendar } from './calendar.ts';
import { demoPack } from './countries.ts';
import {
  DEMO_LINK_BASE,
  demoConsents,
  demoLink,
  demoSms,
  memberAudit,
  numberAudit,
  versionRows,
  type DemoLink,
} from './rows.ts';
import type { DemoDataset, DemoUser } from './types.ts';
import { heroTranscriptSegments, heroSummary } from './hero.ts';
import { demoCallPeaks, demoCallTranscript } from './calls.ts';

export const DEMO_TZ = 'America/Chicago';
/** §18.1's Fri Oct 9, 2026: the default demo day. */
export const DEMO_TODAY = DEMO_CANONICAL_TODAY;
export const DEMO_NOW = fromZonedTime('2026-10-09T19:05:00', DEMO_TZ).toISOString();
export const DEMO_ORG_ID = demoId('org:kestrel');
/** §18.1: the org's TalkOlog number for texts and calls (the panel's sidebar footer, §11.2). */
export const DEMO_SITELOG_NUMBER = '+15550142290';
/** §18.1: locale en-US. */
export const DEMO_ORG_LOCALE = 'en-US' as const;
/** Version of the consent wording the seeded reporters agreed to (§6.3 consents.text_version). */
export const DEMO_CONSENT_TEXT_VERSION = 'demo-1';

const ORG = DEMO_ORG_ID;
const ORG_NAME = 'Kestrel Build Group';
const DEADLINE = '17:30';
/** §7.4 missing alert: deadline + 90 min (the time `reminder_2` names). */
const MISSING_AT = '19:00';

const V12_REPORT = V12_ROW_DEFAULTS.reports;
const V12_SOURCE = V12_ROW_DEFAULTS.report_sources;

export const DEMO_USERS: DemoUser[] = [
  {
    id: demoId('user:lena'),
    email: 'lena@kestrelbuild.example',
    name: 'Lena Ortiz',
    title: 'Operations',
    role: 'admin',
  },
  {
    id: demoId('user:sam'),
    email: 'sam@kestrelbuild.example',
    name: 'Sam Kowalski',
    title: 'Project manager',
    role: 'pm',
  },
  {
    id: demoId('user:accounts'),
    email: 'accounts@kestrelbuild.example',
    name: 'Accounts',
    title: 'Payroll',
    role: 'accounts',
  },
];
const LENA = DEMO_USERS[0]!.id;
const SAM = DEMO_USERS[1]!.id;

type SiteKey = 'riverside' | 'oakmont' | 'pier9' | 'northgate' | 'hillcrest' | 'elm';
type CompanyKey =
  'apex' | 'brightline' | 'delta' | 'ironclad' | 'clearview' | 'summit' | 'self' | 'ridgeway';

interface SiteDef {
  key: SiteKey;
  name: string;
  short: string;
  code: string;
  address: string;
  lat: number;
  lng: number;
  activeSince: string;
  reporter: ReporterDef;
  lastNoOct9: number;
  areas: string[];
  activities: Array<[string, string]>;
}
interface ReporterDef {
  key: string;
  name: string;
  phone: string;
  languages: string[];
  /** §18.1 "Language": what TalkOlog texts and speaks (Marco speaks ES · EN; his locale is EN). */
  locale: ReporterLocale;
  /** §18.1 "Prefers": Text link or Call. */
  contactPref: ContactPref;
}

const SITES: SiteDef[] = [
  {
    key: 'riverside',
    name: 'Riverside Lofts — Block B',
    short: 'Riverside B',
    code: 'RL-2041',
    address: '1420 Riverside Dr, Chicago, IL 60605',
    lat: 41.8625,
    lng: -87.6165,
    activeSince: '2026-03-02',
    reporter: {
      key: 'marco',
      name: 'Marco Ruiz',
      phone: '+15550143378',
      languages: ['es', 'en'],
      locale: 'en-US',
      contactPref: 'link',
    },
    lastNoOct9: 187,
    areas: ['Level 4', 'Level 3', 'Level 2', 'Level 5'],
    activities: [
      ['Level 4', 'Slab pour'],
      ['Level 3', 'Electrical rough-in'],
      ['Level 2', 'Ductwork, east wing'],
      ['Level 4', 'Formwork and rebar'],
      ['Level 2', 'Interior CMU partitions'],
    ],
  },
  {
    key: 'oakmont',
    name: 'Oakmont Medical Center',
    short: 'Oakmont',
    code: 'OM-1187',
    address: '880 Oakmont Ave, Naperville, IL 60540',
    lat: 41.7508,
    lng: -88.1535,
    activeSince: '2026-04-06',
    reporter: {
      key: 'dana',
      name: 'Dana Whitfield',
      phone: '+15550145521',
      languages: ['en'],
      locale: 'en-US',
      contactPref: 'link',
    },
    lastNoOct9: 133,
    areas: ['Level 2', 'Level 1', 'Exterior — north elevation'],
    activities: [
      ['Exterior — north elevation', 'Curtain wall glazing'],
      ['Level 2', 'Drywall, patient wing'],
      ['Level 1', 'Mechanical rough-in'],
      ['Level 2', 'Concrete topping slab'],
      ['Level 1', 'Door frames and hardware'],
    ],
  },
  {
    key: 'pier9',
    name: 'Pier 9 Warehouse Retrofit',
    short: 'Pier 9',
    code: 'P9-0932',
    address: '9 Pier Rd, Chicago, IL 60611',
    lat: 41.8919,
    lng: -87.6051,
    activeSince: '2026-06-01',
    reporter: {
      key: 'tomasz',
      name: 'Tomasz Nowak',
      phone: '+15550146604',
      languages: ['pl', 'en'],
      locale: 'en-US',
      contactPref: 'link',
    },
    lastNoOct9: 94,
    areas: ['Bay 3', 'Bay 2', 'Roof'],
    activities: [
      ['Bay 3', 'Drywall, office build-out'],
      ['Roof', 'Membrane repairs'],
      ['Bay 2', 'Slab saw-cutting'],
      ['Bay 3', 'Demolition of mezzanine'],
      ['Bay 2', 'Dock leveler installation'],
    ],
  },
  {
    key: 'northgate',
    name: 'Northgate Parking Structure',
    short: 'Northgate',
    code: 'NG-2210',
    address: '2200 Northgate Blvd, Evanston, IL 60201',
    lat: 42.0451,
    lng: -87.6877,
    activeSince: '2026-07-06',
    reporter: {
      key: 'kevin',
      name: "Kevin O'Brien",
      phone: '+15550142087',
      languages: ['en'],
      locale: 'en-US',
      contactPref: 'call',
    },
    lastNoOct9: 69,
    areas: ['Level 3', 'Level 2', 'Ramp B'],
    activities: [
      ['Level 3', 'Precast erection'],
      ['Level 2', 'Rebar, post-tension deck'],
      ['Ramp B', 'Concrete pour'],
      ['Level 3', 'Shear wall formwork'],
      ['Level 2', 'Column pours'],
    ],
  },
  {
    key: 'hillcrest',
    name: 'Hillcrest School Extension',
    short: 'Hillcrest',
    code: 'HS-0418',
    address: '418 Hillcrest Rd, Oak Park, IL 60302',
    lat: 41.885,
    lng: -87.7845,
    activeSince: '2026-08-03',
    reporter: {
      key: 'aisha',
      name: 'Aisha Bello',
      phone: '+15550149932',
      languages: ['en'],
      locale: 'en-US',
      contactPref: 'call',
    },
    lastNoOct9: 49,
    areas: ['Exterior — south elevation', 'Gym', 'Classroom wing'],
    activities: [
      ['Exterior — south elevation', 'Masonry, CMU'],
      ['Gym', 'Steel erection'],
      ['Classroom wing', 'Footings and foundation walls'],
      ['Classroom wing', 'Underslab plumbing'],
      ['Gym', 'Roof deck'],
    ],
  },
  {
    key: 'elm',
    name: 'Elm St. Townhomes',
    short: 'Elm St.',
    code: 'ES-0377',
    address: '377 Elm St, Aurora, IL 60505',
    lat: 41.7606,
    lng: -88.3201,
    activeSince: '2026-09-07',
    reporter: {
      key: 'priya',
      name: 'Priya Raman',
      phone: '+15550147719',
      languages: ['en', 'hi'],
      locale: 'en-US',
      contactPref: 'link',
    },
    lastNoOct9: 24,
    areas: ['Units 1–4', 'Units 5–8', 'Site'],
    activities: [
      ['Units 1–4', 'Framing'],
      ['Site', 'Excavation and backfill'],
      ['Units 5–8', 'Foundation walls'],
      ['Units 1–4', 'Roof trusses'],
      ['Site', 'Utility trenching'],
    ],
  },
];

const COMPANIES: Array<{
  key: CompanyKey;
  name: string;
  trade: string | null;
  aliases: string[];
  self?: boolean;
  status: 'confirmed' | 'unconfirmed';
}> = [
  {
    key: 'apex',
    name: 'Apex Concrete',
    trade: 'Concrete',
    aliases: ['Apex', 'the Apex guys'],
    status: 'confirmed',
  },
  {
    key: 'brightline',
    name: 'BrightLine Electric',
    trade: 'Electrical',
    aliases: ['BrightLine', 'Bright Line'],
    status: 'confirmed',
  },
  {
    key: 'delta',
    name: 'Delta Mechanical',
    trade: 'HVAC',
    aliases: ['the Delta guys', 'Delta'],
    status: 'confirmed',
  },
  {
    key: 'ironclad',
    name: 'Ironclad Steel',
    trade: 'Rebar',
    aliases: ['Ironclad'],
    status: 'confirmed',
  },
  {
    key: 'clearview',
    name: 'ClearView Glazing',
    trade: 'Glazing',
    aliases: ['ClearView', 'Clear View'],
    status: 'confirmed',
  },
  {
    key: 'summit',
    name: 'Summit Drywall',
    trade: 'Drywall',
    aliases: ['Summit'],
    status: 'confirmed',
  },
  {
    key: 'self',
    name: 'Kestrel self-perform',
    trade: 'General labor',
    aliases: ['our guys', 'our crew'],
    self: true,
    status: 'confirmed',
  },
  {
    key: 'ridgeway',
    name: 'Ridgeway',
    trade: null,
    aliases: ['the Ridgeway crew'],
    status: 'unconfirmed',
  },
];
const companyId = (k: CompanyKey) => demoId(`company:${k}`);
const companyName = (k: CompanyKey) => COMPANIES.find((c) => c.key === k)!.name;
const companyTrade = (k: CompanyKey) => COMPANIES.find((c) => c.key === k)!.trade ?? undefined;
const siteId = (k: SiteKey) => demoId(`site:${k}`);
const reporterId = (k: string) => demoId(`reporter:${k}`);

const WORKING_DAYS = [1, 2, 3, 4, 5];
function workdays(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1))
    if (WORKING_DAYS.includes(isoWeekday(d))) out.push(d);
  return out;
}
/** The canonical working days of the demo: three weeks to §18.1's Fri Oct 9. */
const DAYS = workdays('2026-09-21', DEMO_TODAY);

type Crew = { company: CompanyKey; workers: number; hours: number; area?: string; heard?: string };

/** Crew allocations per site and day; the week of Oct 5–9 matches the §18 hours table exactly. */
function crewFor(site: SiteKey, date: string): Crew[] {
  const dow = isoWeekday(date);
  const w41 = date >= '2026-10-05' && date <= '2026-10-09';
  switch (site) {
    case 'riverside':
      return [
        {
          company: 'apex',
          workers: date === DEMO_TODAY ? 7 : 6,
          hours: 8,
          area: 'Level 4',
          heard: 'Apex',
        },
        {
          company: 'brightline',
          workers: w41 && dow === 3 ? 4 : 5,
          hours: 8,
          area: 'Level 3',
          heard: 'BrightLine',
        },
        { company: 'delta', workers: 5, hours: 8, area: 'Level 2', heard: 'the Delta guys' },
        {
          company: 'ironclad',
          workers: w41 && dow === 2 ? 2 : 3,
          hours: 8,
          area: 'Level 4',
          heard: 'Ironclad',
        },
        { company: 'self', workers: 4, hours: 8, area: 'Level 5', heard: 'our guys' },
      ];
    case 'oakmont': {
      const crews: Crew[] = [
        { company: 'apex', workers: 3, hours: 8, area: 'Level 2', heard: 'Apex' },
        {
          company: 'delta',
          workers: w41 && (dow === 2 || dow === 3 || dow === 5) ? 5 : 4,
          hours: 8,
          area: 'Level 1',
          heard: 'Delta',
        },
        {
          company: 'clearview',
          workers: w41 && dow === 4 ? 3 : 4,
          hours: 8,
          area: 'Exterior — north elevation',
          heard: 'ClearView',
        },
        {
          company: 'summit',
          workers: w41 && (dow === 2 || dow === 3) ? 4 : 3,
          hours: 8,
          area: 'Level 2',
          heard: 'Summit',
        },
        { company: 'self', workers: 2, hours: 8, area: 'Level 1', heard: 'our crew' },
      ];
      if (w41 && dow === 3)
        crews.push({
          company: 'brightline',
          workers: 1,
          hours: 4,
          area: 'Level 1',
          heard: 'a BrightLine guy',
        });
      if (date === DEMO_TODAY)
        crews.push({
          company: 'ridgeway',
          workers: 6,
          hours: 8,
          area: 'Level 2',
          heard: 'the Ridgeway crew',
        });
      return crews;
    }
    case 'pier9': {
      const crews: Crew[] = [
        {
          company: 'summit',
          workers: w41 && (dow === 2 || dow === 5) ? 4 : 3,
          hours: 8,
          area: 'Bay 3',
          heard: 'Summit',
        },
        { company: 'self', workers: 6, hours: 8, area: 'Bay 2', heard: 'our guys' },
      ];
      // Ironclad's Friday crew works here, not at Northgate (§18.1 gives Northgate 2 companies).
      if (date === DEMO_TODAY)
        crews.splice(1, 0, {
          company: 'ironclad',
          workers: 3,
          hours: 8,
          area: 'Bay 2',
          heard: 'Ironclad',
        });
      return crews;
    }
    case 'northgate':
      // §18.1 Oct 9 (the call): 14 workers from 2 companies, 100.0 h.
      if (date === DEMO_TODAY)
        return [
          { company: 'apex', workers: 3, hours: 8, area: 'Ramp B', heard: 'Apex' },
          { company: 'self', workers: 8, hours: 8, area: 'Level 3', heard: 'our crew' },
          { company: 'self', workers: 3, hours: 4, area: 'Ramp B', heard: 'three of ours' },
        ];
      return [
        {
          company: 'apex',
          workers: w41 && (dow === 2 || dow === 3 || dow === 5) ? 3 : 2,
          hours: 8,
          area: 'Ramp B',
          heard: 'Apex',
        },
        { company: 'ironclad', workers: 3, hours: 8, area: 'Level 2', heard: 'Ironclad' },
        { company: 'self', workers: 5, hours: 8, area: 'Level 3', heard: 'our crew' },
      ];
    case 'hillcrest':
      return [
        { company: 'summit', workers: 2, hours: 8, area: 'Classroom wing', heard: 'Summit' },
        {
          company: 'self',
          workers: 8,
          hours: 8,
          area: 'Exterior — south elevation',
          heard: 'our guys',
        },
      ];
    case 'elm':
      return [{ company: 'self', workers: 6, hours: 8, area: 'Units 1–4', heard: 'our crew' }];
  }
}

/** `awaiting`: a live demo's today (D36), not reported yet at 17:00. */
type DayKind = 'filed' | 'late' | 'missing' | 'weather_day' | 'signed_off' | 'awaiting';
interface DayPlan {
  kind: DayKind;
  receivedLocal: string;
  weather?: {
    condition: string;
    start?: string;
    end?: string;
    impact: string;
    lost: number;
    fullDay?: boolean;
    photo: boolean;
    precipIn: number;
    gust?: number;
  };
  needsReview?: string[];
}

function planFor(site: SiteKey, date: string): DayPlan {
  const base: DayPlan = {
    kind: 'filed',
    receivedLocal: ['16:52', '17:04', '17:12', '17:21', '16:58', '17:18', '17:26'][
      (demoRand(`${site}:${date}`) * 7) | 0
    ]!,
  };
  const rain = (
    lost: number,
    start: string,
    end: string,
    impact: string,
    photo = true,
    precipIn = 0.6,
  ) => ({ condition: 'Rain', start, end, impact, lost, photo, precipIn });
  if (date === '2026-10-02') {
    if (site === 'riverside')
      base.weather = rain(
        3.5,
        '07:00',
        '10:30',
        'Exterior masonry stopped; crew moved to interior blockwork',
      );
    if (site === 'pier9')
      base.weather = rain(
        4,
        '07:00',
        '11:00',
        'Roof membrane work stopped; crew moved to Bay 3 drywall',
      );
    if (site === 'northgate')
      base.weather = {
        condition: 'High wind',
        start: '09:00',
        end: '11:00',
        impact: 'Crane stood down; precast erection paused',
        lost: 2,
        photo: false,
        precipIn: 0,
        gust: 34,
      };
    if (site === 'hillcrest')
      base.weather = rain(
        4,
        '07:00',
        '11:00',
        'Masonry and footings stopped; crew on interior layout',
      );
    if (site === 'elm')
      base.weather = rain(3, '07:00', '10:00', 'Excavation stopped; trench pumped out', false);
  }
  if (site === 'riverside' && date === DEMO_TODAY) {
    base.weather = rain(
      3.5,
      '07:00',
      '10:30',
      'Exterior masonry stopped; crew moved to interior blockwork',
      true,
      0.4,
    );
    base.receivedLocal = '17:38';
  }
  if (site === 'pier9' && date === '2026-10-05')
    base.weather = rain(1.5, '13:00', '14:30', 'Roof work paused during shower', true, 0.2);
  if (site === 'pier9' && date === DEMO_TODAY) {
    base.weather = rain(
      2,
      '07:00',
      '09:00',
      'Roof membrane work stopped until decks dried',
      true,
      0.4,
    );
    base.receivedLocal = '16:58';
  }
  if (site === 'hillcrest' && date === '2026-10-06')
    return {
      kind: 'weather_day',
      receivedLocal: '07:40',
      weather: {
        condition: 'Rain',
        impact: 'Site closed: crew never started',
        lost: 8,
        fullDay: true,
        photo: true,
        precipIn: 1.1,
      },
    };
  if (site === 'hillcrest' && date === DEMO_TODAY)
    return {
      kind: 'weather_day',
      receivedLocal: '18:41',
      weather: {
        condition: 'Rain',
        start: '11:00',
        impact: 'Rained out; crew released at 11:00',
        lost: 5,
        photo: false,
        precipIn: 0.5,
      },
    };
  if (site === 'oakmont' && date === DEMO_TODAY) {
    base.receivedLocal = '17:21';
    base.needsReview = ['unknown_company:Ridgeway'];
  }
  // §18.1: Kevin called in at 17:10 (the report's start); it was filed at 17:12.
  if (site === 'northgate' && date === DEMO_TODAY) base.receivedLocal = '17:10';
  if (site === 'elm' && date === DEMO_TODAY) return { kind: 'missing', receivedLocal: '' };
  if (site === 'elm' && date === '2026-09-28') return { kind: 'missing', receivedLocal: '' };
  if (site === 'northgate' && date === '2026-09-25') return { kind: 'missing', receivedLocal: '' };
  if (site === 'oakmont' && date === '2026-09-24')
    return { ...base, kind: 'late', receivedLocal: '18:12' };
  if (site === 'northgate' && date === '2026-09-29')
    return { ...base, kind: 'late', receivedLocal: '18:40' };
  if (site === 'elm' && date === '2026-09-23')
    return { ...base, kind: 'late', receivedLocal: '18:12' };
  if (site === 'elm' && date === '2026-09-30')
    return { ...base, kind: 'late', receivedLocal: '19:20' };
  if (site === 'riverside' && date >= '2026-10-05' && date <= '2026-10-08')
    return { ...base, kind: 'signed_off' };
  if (date < '2026-10-05' && demoRand(`so:${site}:${date}`) < 0.6)
    return { ...base, kind: 'signed_off' };
  return base;
}

function manpowerFor(crews: Crew[], audioMessageId: string, offset = 10): ManpowerEntryV1[] {
  return crews.map((c, i) => ({
    companyId: c.company === 'ridgeway' ? null : companyId(c.company),
    companyNameHeard: c.heard ?? companyName(c.company),
    companyName: companyName(c.company),
    trade: companyTrade(c.company),
    area: c.area,
    workers: c.workers,
    hoursPerWorker: c.hours,
    totalHours: c.workers * c.hours,
    hoursBasis: 'stated',
    confidence: c.company === 'ridgeway' ? 0.82 : 0.94,
    source: [
      {
        type: 'audio',
        messageId: audioMessageId,
        start: offset + i * 9.5,
        end: offset + i * 9.5 + 8.1,
      },
    ],
  }));
}

export interface KestrelOptions {
  /**
   * `YYYY-MM-DD` (Monday to Friday): the live demo for that date (D36, demo/calendar.ts): history
   * ends the working day before, today starts at the 17:00 daily link with Pier 9 filed at 16:58
   * (§18.1's only Oct 9 report before the daily links) and the other five sites awaiting.
   * Omitted: §18.1's Fri Oct 9 as written, "now" 19:05 (the e2e default).
   */
  date?: string;
  /** FIELD_APP_URL for the links in the seeded texts (default DEMO_LINK_BASE). */
  linkBase?: string;
  /**
   * With `date`: the real time the live demo is built at (`--date today`, ISO instant). When it
   * falls on the target day before 17:00 Chicago, the demo's "now" is the clock and nothing of
   * the target day after it is seeded (no row in the future). Omitted, or on another day: 17:00.
   */
  clock?: string;
}

/** §18.1 call lengths; the others (Hillcrest's ring and call-back, Luis) are seed values. */
const NORTHGATE_CALL_S = 2 * 60 + 41;
const HILLCREST_CALLBACK_S = 90;
const LUIS_CALL_S = 41;
/** The hero's spoken correction at 20:09 ("Apex was 7, not 6"); a seed value. */
const HERO_FIX_S = 3;

/** 64 waveform peaks for a file, deterministic per key (uploads.peaks, calls.peaks). */
function peaksFor(key: string, floor = 0.15, span = 0.85): number[] {
  return Array.from(
    { length: 64 },
    (_, i) => Math.round((floor + span * demoRand(`peak:${key}`, i)) * 100) / 100,
  );
}

const plusSeconds = (iso: string, s: number) => new Date(Date.parse(iso) + s * 1000).toISOString();

/** v1 data → the v1.2 shape of an Oct 9 report: `schemaVersion 2`, en / imperial (§9.6). */
function toV2(v1: DailyReportDataV1, heardLanguage: string): DailyReportData {
  const v2 = upgradeV1toV2(v1);
  v2.newTerms = v2.newTerms.map((t) => ({ ...t, heardLanguage }));
  return v2;
}

/** The voice-note seconds of a draft built for a call: the same seconds of the call (§10.3). */
function sourcesToCall(data: DailyReportData, callId: string): DailyReportData {
  const map = (list: Source[]): Source[] =>
    list.map((x) =>
      x.type === 'voice_note'
        ? { type: 'call', callId, start: x.start, ...(x.end !== undefined ? { end: x.end } : {}) }
        : x,
    );
  return {
    ...data,
    weather: {
      ...data.weather,
      periods: data.weather.periods.map((p) => ({ ...p, source: map(p.source) })),
    },
    manpower: data.manpower.map((m) => ({ ...m, source: map(m.source) })),
    workPerformed: data.workPerformed.map((w) => ({ ...w, source: map(w.source) })),
    deliveries: data.deliveries.map((d) => ({ ...d, source: map(d.source) })),
    equipment: data.equipment.map((e) => ({ ...e, source: map(e.source) })),
    safety: {
      ...data.safety,
      incidents: data.safety.incidents.map((i) => ({ ...i, source: map(i.source) })),
      source: map(data.safety.source),
    },
    issues: data.issues.map((i) => ({ ...i, source: map(i.source) })),
    nextWorkday: data.nextWorkday.map((n) => ({ ...n, source: map(n.source) })),
  };
}

export function buildKestrelDemo(opts: KestrelOptions = {}): DemoDataset {
  const cal = demoCalendar(opts.date);
  /** §18.1: Kestrel is a US org; its SMS variant and paper come from the US pack (spec §4.6). */
  const usPack = demoPack('US');
  const linkBase = opts.linkBase ?? DEMO_LINK_BASE;
  /** Canonical date + local Chicago time → instant on the mapped date. */
  const t = (c: string, time: string) => cal.at(c, time, DEMO_TZ);
  /** A one-off event that must lie before today (see DemoCalendar.pastDay). */
  const tp = (c: string, time: string) => cal.atDate(cal.pastDay(c), time, DEMO_TZ);
  // "Now": §18.1's 19:05, or a live day's 17:00 daily link (D36). A live day built during the
  // target day before 17:00 (the clock of `--date today`) stops at the clock instead, so no row
  // lies in the future: Pier 9's 16:58 report and yesterday's 08:30 sign-off wait for their time.
  const liveStart = t(DEMO_TODAY, DEMO_LIVE_START);
  const clock = cal.live && opts.clock ? new Date(opts.clock).toISOString() : null;
  const now = !cal.live
    ? DEMO_NOW
    : clock && clock >= cal.atDate(cal.today, '00:00', DEMO_TZ) && clock < liveStart
      ? clock
      : liveStart;
  /** Pier 9's report today (filed 16:58, its photos within the minute) is seeded once it is past. */
  const pier9Today =
    !cal.live || plusSeconds(t(DEMO_TODAY, planFor('pier9', DEMO_TODAY).receivedLocal), 60) <= now;
  /** The last canonical day kept as history (a live day's yesterday). */
  const lastHistoryDay = DAYS.filter((c) => c < DEMO_TODAY && cal.isHistory(c)).at(-1)!;
  const sitelogNumber = formatPhone(DEMO_SITELOG_NUMBER);
  /**
   * Kestrel's SMS variant: two-way and links from the US pack (spec §4.6). The call option stays
   * on as §18.1 story data (`DEMO_SITELOG_NUMBER` for texts and calls), while the US pack's live
   * voice number is null until the LiveKit number exists (spec §19 Q34).
   */
  const smsOptions: RenderSmsOptions = {
    ...smsRenderOptions(usPack),
    hasVoiceNumber: true,
  };

  const reporters: ReporterRow[] = SITES.map((s) => ({
    id: reporterId(s.reporter.key),
    org_id: ORG,
    name: s.reporter.name,
    phone_e164: s.reporter.phone,
    role: 'site_manager',
    languages: s.reporter.languages,
    status: 'active',
    invited_at: t(s.activeSince, '09:05'),
    // WhatsApp verification (legacy): v1.2 reporters are activated by their first consent.
    verified_at: null,
    last_invite_error: null,
    created_at: t(s.activeSince, '09:05'),
    locale: s.reporter.locale,
    contact_pref: s.reporter.contactPref,
    activated_at: t(s.activeSince, '09:40'),
    opted_out_at: null,
    // null = the country pack's order (§4.5); a preference comes with week 2.
    message_channel: null,
    no_calls_until: null,
  }));
  // §18.1: backup for Riverside B and Pier 9, ES, Text link, invite sent (no consent yet).
  reporters.push({
    id: reporterId('jorge'),
    org_id: ORG,
    name: 'Jorge Medina',
    phone_e164: '+15550143390',
    role: 'backup',
    languages: ['es'],
    status: 'invited',
    invited_at: tp('2026-10-07', '10:15'),
    verified_at: null,
    last_invite_error: null,
    created_at: tp('2026-10-07', '10:15'),
    locale: 'es-US',
    contact_pref: 'link',
    activated_at: null,
    opted_out_at: null,
    // null = the country pack's order (§4.5); a preference comes with week 2.
    message_channel: null,
    no_calls_until: null,
  });
  const reporterById = new Map(reporters.map((r) => [r.id, r]));

  // Report numbers: the last seeded report of a site gets the number §18.1 gives it on Oct 9
  // (`lastNoOct9`); a live demo leaves today unreported, so its history ends one lower and the
  // next report filed today gets §18.1's number again (Marco's RL-2041-0187).
  const todayPlans = new Map(
    SITES.map((s) => {
      const plan: DayPlan =
        cal.live && (s.key !== 'pier9' || !pier9Today)
          ? { kind: 'awaiting', receivedLocal: '' }
          : planFor(s.key, DEMO_TODAY);
      return [s.key, plan] as const;
    }),
  );
  const siteDaysPlanned = new Map(
    SITES.map((s) => {
      const list = DAYS.filter((c) => c >= s.activeSince)
        .filter((c) => c === DEMO_TODAY || cal.isHistory(c))
        .map((c) => ({ c, plan: c === DEMO_TODAY ? todayPlans.get(s.key)! : planFor(s.key, c) }));
      return [s.key, list] as const;
    }),
  );
  const isReport = (k: DayKind) => k !== 'missing' && k !== 'awaiting';
  const lastNo = new Map(
    SITES.map((s) => {
      const todayDefault = planFor(s.key, DEMO_TODAY).kind;
      const dropped = isReport(todayDefault) && !isReport(todayPlans.get(s.key)!.kind);
      return [s.key, s.lastNoOct9 - (dropped ? 1 : 0)] as const;
    }),
  );

  const sites: SiteRow[] = SITES.map((s) => ({
    id: siteId(s.key),
    org_id: ORG,
    name: s.name,
    project_code: s.code,
    address: s.address,
    lat: s.lat,
    lng: s.lng,
    timezone: DEMO_TZ,
    deadline: null,
    working_hours: '07:00–15:30',
    status: 'active',
    active_since: cal.day(s.activeSince),
    paused_at: null,
    report_seq: lastNo.get(s.key)!,
    created_at: t(s.activeSince, '09:00'),
  }));

  const siteReporters = SITES.map((s) => ({
    site_id: siteId(s.key),
    reporter_id: reporterId(s.reporter.key),
    is_primary: true,
  }));
  siteReporters.push({
    site_id: siteId('riverside'),
    reporter_id: reporterId('jorge'),
    is_primary: false,
  });
  siteReporters.push({
    site_id: siteId('pier9'),
    reporter_id: reporterId('jorge'),
    is_primary: false,
  });
  const recipients = SITES.flatMap((s) => [
    { site_id: siteId(s.key), email: 'reports@kestrelbuild.example' },
    { site_id: siteId(s.key), email: 'sam@kestrelbuild.example' },
  ]);

  const companies: CompanyRow[] = COMPANIES.map((c) => ({
    id: companyId(c.key),
    org_id: ORG,
    name: c.name,
    trade: c.trade,
    aliases: c.aliases,
    is_self_perform: !!c.self,
    status: c.status,
    created_at: t('2026-03-02', '09:30'),
  }));

  const glossaryDefs: Array<
    [
      string,
      string,
      GlossaryTermRow['status'],
      number,
      GlossaryTermRow['kind'],
      SiteKey | null,
      string,
      string | null,
    ]
  > = [
    ['the deck', 'Elevated concrete slab', 'confirmed', 128, 'term', null, 'en', null],
    ['pour on four', 'Level 4 concrete pour', 'auto_learned', 9, 'area', 'riverside', 'en', null],
    ['block', 'Concrete masonry units (CMU)', 'confirmed', 74, 'term', null, 'en', null],
    ['stood down', 'Work stoppage', 'confirmed', 31, 'term', null, 'en', null],
    ['punch', 'Punch list items', 'confirmed', 22, 'term', null, 'en', null],
    [
      'topped out',
      'Structural frame complete to roof level',
      'confirmed',
      6,
      'term',
      null,
      'en',
      null,
    ],
    ['rough-in', 'MEP rough-in', 'confirmed', 58, 'term', null, 'en', null],
    ['mud', 'Joint compound', 'needs_review', 4, 'term', 'oakmont', 'en', null],
    ['colado', 'Concrete pour', 'needs_review', 3, 'term', 'riverside', 'es', null],
    ['the Ridgeway crew', 'Ridgeway', 'needs_review', 1, 'company', 'oakmont', 'en', 'ridgeway'],
    ['the Delta guys', 'Delta Mechanical', 'confirmed', 41, 'company', null, 'en', 'delta'],
    ['yards', 'Cubic yards (yd³)', 'confirmed', 65, 'unit', null, 'en', null],
    ['lift', 'Lift (concrete placement height)', 'rejected', 2, 'term', 'northgate', 'en', null],
  ];
  const glossary: GlossaryTermRow[] = glossaryDefs.map(
    ([heard, official, status, times, kind, site, language, comp], i) => ({
      id: demoId(`term:${heard}`),
      org_id: ORG,
      scope_site_id: site ? siteId(site) : null,
      scope_reporter_id: null,
      heard,
      official,
      language,
      kind,
      company_id: comp ? companyId(comp as CompanyKey) : null,
      status,
      times_heard: times,
      first_seen_at: tp(addDays('2026-09-21', -i), '17:10'),
      // Heard on Oct 9 at 16:20; on a live day, yesterday (today has only Pier 9's report).
      last_seen_at:
        i < 10
          ? cal.live
            ? t(lastHistoryDay, '16:20')
            : t(DEMO_TODAY, '16:20')
          : tp('2026-10-07', '16:20'),
    }),
  );
  // Built-in global terms (org_id null): seed.sql writes them; an apply never writes rows outside
  // the demo orgs, so it leaves them out.
  for (const [heard, official] of [
    ['llovió', 'Rain'],
    ['andamio', 'Scaffold'],
  ] as const) {
    glossary.push({
      id: demoId(`term:${heard}`),
      org_id: null,
      scope_site_id: null,
      scope_reporter_id: null,
      heard,
      official,
      language: 'es',
      kind: 'term',
      company_id: null,
      status: 'built_in',
      times_heard: 0,
      first_seen_at: fromZonedTime('2026-01-01T00:00:00', DEMO_TZ).toISOString(),
      last_seen_at: null,
    });
  }

  // §19 Q238 (W4-08): the English starter glossary the org got when it was created, as
  // seed_starter_glossary() writes it (built_in), less the phrases the org's own rows hold.
  glossary.push(
    ...starterGlossaryRows({
      orgId: ORG,
      language: 'en',
      existing: glossary.filter((g) => g.org_id === ORG),
      at: t('2026-03-02', '09:00'),
      id: (term) => demoId(`starter:${term.kind}:${term.heard}`),
    }),
  );

  // WhatsApp threads only for the panel's /try simulator (D29); no messages, nothing sent.
  const conversations: ConversationRow[] = reporters.map((r) => ({
    id: demoId(`convo:${r.phone_e164}`),
    org_id: ORG,
    reporter_id: r.id,
    phone_e164: r.phone_e164,
    state: r.status === 'active' ? 'idle' : 'welcome_sent',
    context: {},
    last_inbound_at: null,
    last_outbound_at: null,
    state_changed_at: r.invited_at ?? r.created_at,
    updated_at: r.invited_at ?? r.created_at,
  }));

  const messages: MessageRow[] = [];
  const transcripts: TranscriptRow[] = [];
  const siteDays: SiteDayRow[] = [];
  const reports: ReportRow[] = [];
  const versions: ReportVersionRow[] = [];
  const uploads: UploadRow[] = [];
  const sources: ReportSourceRow[] = [];
  const manpower: ManpowerEntryRow[] = [];
  const workItems: WorkItemRow[] = [];
  const weatherEvents: WeatherEventRow[] = [];
  const questions: QuestionRow[] = [];
  const consents: ConsentRow[] = [];
  const fieldLinks: FieldLinkRow[] = [];
  const calls: CallRow[] = [];
  const unknownContacts: UnknownContactRow[] = [];
  const audit: AuditLogRow[] = [];
  const logAudit = (row: Omit<AuditLogRow, 'id'>) => audit.push({ id: 0, ...row });

  const sms = (key: string, r: ReporterRow, copyKey: SmsKey, body: string, at: string) => {
    const m = demoSms({ key, orgId: ORG, reporter: r, copyKey, body, at });
    messages.push(m);
    logAudit({
      org_id: ORG,
      actor_type: 'system',
      actor_id: null,
      action: 'sms.sent',
      entity: 'message',
      entity_id: m.id,
      diff: { copy_key: copyKey, provider: 'console' },
      created_at: at,
    });
    return m;
  };
  const link = (
    key: string,
    r: ReporterRow,
    kind: FieldLinkRow['kind'],
    siteIdOrNull: string | null,
    reportDate: string | null,
    at: string,
  ): DemoLink => {
    const l = demoLink({
      key,
      reporterId: r.id,
      kind,
      siteId: siteIdOrNull,
      reportDate,
      createdAt: at,
      linkBase,
      siteTz: DEMO_TZ,
    });
    fieldLinks.push(l.row);
    logAudit({
      org_id: ORG,
      actor_type: 'system',
      actor_id: null,
      action: 'field_link.created',
      entity: 'reporter',
      entity_id: r.id,
      diff: { kind, site_id: siteIdOrNull, report_date: reportDate },
      created_at: at,
    });
    return l;
  };

  // Invites (F3): a personal link and the welcome text for every reporter; consents on first open.
  const personal = new Map<string, DemoLink>();
  for (const r of reporters) {
    const primary =
      siteReporters.find((sr) => sr.reporter_id === r.id && sr.is_primary) ??
      siteReporters.find((sr) => sr.reporter_id === r.id)!;
    const site = sites.find((s) => s.id === primary.site_id)!;
    const l = link(`personal:${r.id}`, r, 'personal', null, null, r.invited_at!);
    personal.set(r.id, l);
    sms(
      `welcome:${r.id}`,
      r,
      'welcome',
      renderSms(
        'welcome',
        languageOf(r.locale),
        {
          first: firstName(r.name),
          company: ORG_NAME,
          site: site.name,
          deadline: DEADLINE,
          number: sitelogNumber,
          link: l.url,
        },
        smsOptions,
      ),
      r.invited_at!,
    );
    if (r.status === 'active' && r.activated_at) {
      const given = demoConsents({
        reporter: r,
        givenAt: r.activated_at,
        textVersion: DEMO_CONSENT_TEXT_VERSION,
      });
      consents.push(...given);
      logAudit({
        org_id: ORG,
        actor_type: 'reporter',
        actor_id: r.id,
        action: 'consent.given',
        entity: 'reporter',
        entity_id: r.id,
        diff: {
          types: given.map((x) => x.type),
          method: 'web_checkbox',
          text_version: DEMO_CONSENT_TEXT_VERSION,
          contact_pref: r.contact_pref,
        },
        created_at: r.activated_at,
      });
    }
  }

  const logCall = (c: CallRow) => {
    calls.push(c);
    logAudit({
      org_id: ORG,
      actor_type: 'system',
      actor_id: null,
      action: 'call.ended',
      entity: 'call',
      entity_id: c.id,
      diff: {
        direction: c.direction,
        status: c.status,
        outcome: c.outcome,
        duration_s: c.duration_s,
      },
      created_at: c.ended_at ?? c.started_at!,
    });
  };
  const callRow = (input: {
    key: string;
    reporter: ReporterRow | null;
    from: string;
    site: string | null;
    report: string | null;
    direction: CallRow['direction'];
    purpose: string | null;
    status: CallRow['status'];
    outcome: CallRow['outcome'];
    startedAt: string;
    durationS: number | null;
    ringS?: number;
    recordingPath: string | null;
  }): CallRow => {
    const id = demoId(`call:${input.key}`);
    const answered = input.status === 'completed';
    return {
      id,
      org_id: ORG,
      reporter_id: input.reporter?.id ?? null,
      site_id: input.site,
      report_id: input.report,
      direction: input.direction,
      transport: 'pstn',
      purpose: input.purpose,
      provider_call_id: `call-${id}`,
      from_e164: input.direction === 'inbound' ? input.from : DEMO_SITELOG_NUMBER,
      to_e164: input.direction === 'inbound' ? DEMO_SITELOG_NUMBER : input.from,
      status: input.status,
      outcome: input.outcome,
      disclosure_played: answered,
      // W4-06: the US pack names no recording notice, so an answered call said the agent's own.
      disclosure_version: answered ? VOICE_RECORDING_NOTICE_VERSION : null,
      started_at: input.startedAt,
      answered_at: answered ? input.startedAt : null,
      ended_at: plusSeconds(input.startedAt, input.durationS ?? input.ringS ?? 0),
      duration_s: input.durationS,
      recording_path: answered && input.recordingPath ? input.recordingPath : null,
      peaks: answered ? peaksFor(`call:${input.key}`) : null,
      dialog_log: null,
      metrics: null,
      created_at: input.startedAt,
      language: input.reporter?.locale ?? null,
      call_token_issued_at: answered ? input.startedAt : null,
      attempt: null,
      site_day_id: null,
      fallback: null,
      reconcile: null,
      consent_declined_at: null,
    };
  };

  for (const s of SITES) {
    const sid = siteId(s.key);
    const reporter = reporterById.get(reporterId(s.reporter.key))!;
    const planned = siteDaysPlanned.get(s.key)!;
    const reportDays = planned.filter((p) => isReport(p.plan.kind));
    let seq = lastNo.get(s.key)! - reportDays.length;
    for (const { c, plan } of planned) {
      const date = cal.day(c);
      const isToday = c === DEMO_TODAY;
      const siteDayId = demoId(`siteday:${s.key}:${c}`);
      // The site-day row opens at 00:05 (a live day built in its first minutes: at the clock).
      const opened = t(c, '00:05') < now ? t(c, '00:05') : now;
      const deadlineAt = deadlineInstant(date, DEADLINE, DEMO_TZ).toISOString();
      const observed = plan.weather
        ? {
            precipIn: plan.weather.precipIn,
            tempMinF: 56 + ((demoRand(`t:${c}`) * 6) | 0),
            tempMaxF: 63 + ((demoRand(`T:${c}`) * 8) | 0),
            windMph: 9,
            gustMph: plan.weather.gust ?? 18,
            provider: 'Open-Meteo',
          }
        : {
            precipIn: 0,
            tempMinF: 52 + ((demoRand(`t:${c}`) * 8) | 0),
            tempMaxF: 66 + ((demoRand(`T:${c}`) * 10) | 0),
            windMph: 7 + ((demoRand(`w:${c}`) * 6) | 0),
            gustMph: 15,
            provider: 'Open-Meteo',
          };
      const weatherJson = {
        date,
        provider: 'Open-Meteo',
        summary: {
          ...observed,
          precipWorkingHoursIn: observed.precipIn,
          maxGustWorkingHoursMph: observed.gustMph,
        },
      };

      // Today's texts and links of the §7.4 ladder (default mode only: a live day starts at 17:00).
      let dailyLink: DemoLink | null = null;
      // §7.4: a link reporter gets it unless the day is already reported (Pier 9 filed at 16:58).
      const reportedBefore17 = isReport(plan.kind) && plan.receivedLocal < '17:00';
      if (isToday && !cal.live && reporter.contact_pref === 'link' && !reportedBefore17) {
        dailyLink = link(`daily:${reporter.id}:${c}`, reporter, 'daily', sid, date, t(c, '17:00'));
        sms(
          `daily_link:${s.key}:${c}`,
          reporter,
          'daily_link',
          renderSms(
            'daily_link',
            'en',
            { site: s.name, link: dailyLink.url, number: sitelogNumber },
            smsOptions,
          ),
          t(c, '17:00'),
        );
      }

      if (plan.kind === 'awaiting') {
        siteDays.push({
          id: siteDayId,
          site_id: sid,
          date,
          status: 'pending',
          deadline_at: deadlineAt,
          reminder_stage: 0,
          reminders_paused: false,
          is_late: false,
          weather: weatherJson,
          report_id: null,
          created_at: opened,
          updated_at: opened,
        });
        continue;
      }
      if (plan.kind === 'missing') {
        siteDays.push({
          id: siteDayId,
          site_id: sid,
          date,
          status: 'missing',
          deadline_at: deadlineAt,
          reminder_stage: 4,
          reminders_paused: false,
          is_late: false,
          weather: weatherJson,
          report_id: null,
          created_at: opened,
          updated_at: t(c, MISSING_AT),
        });
        if (isToday && dailyLink) {
          // §18.1 Elm St.: two SMS reminders, then the office alert at 19:00.
          sms(
            `reminder_1:${s.key}:${c}`,
            reporter,
            'reminder_1',
            renderSms('reminder_1', 'en', { site: s.name, link: dailyLink.url }, smsOptions),
            t(c, '17:45'),
          );
          sms(
            `reminder_2:${s.key}:${c}`,
            reporter,
            'reminder_2',
            renderSms(
              'reminder_2',
              'en',
              { time: MISSING_AT, link: dailyLink.url, number: sitelogNumber },
              smsOptions,
            ),
            t(c, '18:30'),
          );
        }
        continue;
      }

      seq += 1;
      const reportId = demoId(`report:${s.key}:${c}`);
      const reportNo = formatReportNo(s.code, seq);
      const isHero = s.key === 'riverside' && isToday;
      const channel: FieldChannel =
        isToday && (s.key === 'northgate' || s.key === 'hillcrest') ? 'voice' : 'web';
      // Received, confirmed, filed: §18.1's times on Oct 9; history files 5 min after the note.
      const receivedAt = t(c, plan.receivedLocal);
      let confirmedAt = plusSeconds(receivedAt, 5 * 60);
      let filedAt = confirmedAt;
      if (isHero) {
        confirmedAt = t(c, '17:43');
        filedAt = t(c, '17:44');
      } else if (isToday && (s.key === 'northgate' || s.key === 'hillcrest')) {
        // The calls (§18.1): confirmed by voice and filed as the call ends.
        confirmedAt = filedAt = t(c, s.key === 'northgate' ? '17:12' : '18:42');
      } else if (isToday) {
        confirmedAt = filedAt = receivedAt;
      }
      const isLate = receivedAt > deadlineAt;
      const durationS = isHero ? 168 : 95 + ((demoRand(`dur:${s.key}:${c}`) * 110) | 0);
      const photoCount =
        channel === 'voice'
          ? 0
          : plan.kind === 'weather_day'
            ? plan.weather?.photo
              ? 1
              : 0
            : plan.weather
              ? plan.weather.photo
                ? 2
                : 0
              : isHero
                ? 2
                : demoRand(`ph:${s.key}:${c}`) < 0.8
                  ? 1
                  : 2;

      // The call of a call-channel report (§18.1: Northgate called in; Hillcrest called back).
      let call: CallRow | null = null;
      if (channel === 'voice') {
        const ng = s.key === 'northgate';
        call = callRow({
          key: `${s.key}:${c}`,
          reporter,
          from: reporter.phone_e164,
          site: sid,
          report: reportId,
          direction: 'inbound',
          purpose: 'daily_report',
          status: 'completed',
          outcome: ng ? 'filed' : 'weather_day',
          startedAt: t(c, ng ? '17:10' : '18:41'),
          durationS: ng ? NORTHGATE_CALL_S : HILLCREST_CALLBACK_S,
          recordingPath: `${ORG}/${sid}/${date}/call-${demoId(`call:${s.key}:${c}`)}.ogg`,
        });
      }
      // Voice note and photos from the web recorder. The ids are the WhatsApp-era message ids of
      // the same media (the step 10 backfill gave uploads their message's UUID), so stored v1
      // data keeps pointing at them.
      const audioId = demoId(`msg:${s.key}:${c}:audio`);
      const photoUploads: UploadRow[] = [];
      if (channel === 'web') {
        uploads.push({
          id: audioId,
          report_id: reportId,
          reporter_id: reporter.id,
          site_id: sid,
          kind: 'audio',
          storage_path: `${ORG}/${sid}/${date}/${audioId}.webm`,
          mime: 'audio/webm;codecs=opus',
          bytes: null,
          duration_s: durationS,
          peaks: peaksFor(`${s.key}:${c}`),
          recorded_at: receivedAt,
          received_at: receivedAt,
          caption: null,
          uploaded_by: null,
          purged_at: null,
          batch_id: null,
          batch_size: null,
          question_id: null,
          correction_report_id: null,
        });
        for (let p = 0; p < photoCount; p++) {
          const pid = demoId(`msg:${s.key}:${c}:photo${p}`);
          const at = plusSeconds(receivedAt, 30 + p * 20);
          const u: UploadRow = {
            id: pid,
            report_id: reportId,
            reporter_id: reporter.id,
            site_id: sid,
            kind: 'photo',
            storage_path: `${ORG}/${sid}/${date}/${pid}.jpg`,
            mime: 'image/jpeg',
            bytes: null,
            duration_s: null,
            peaks: null,
            recorded_at: at,
            received_at: at,
            caption:
              p === 0
                ? plan.weather
                  ? 'Conditions this morning'
                  : `${s.activities[(demoRand(`act:${s.key}:${c}`) * s.activities.length) | 0]![1]}`
                : 'End of day',
            uploaded_by: null,
            purged_at: null,
            batch_id: null,
            batch_size: null,
            question_id: null,
            correction_report_id: null,
          };
          uploads.push(u);
          photoUploads.push(u);
        }
      }

      const crews = plan.kind === 'weather_day' ? [] : crewFor(s.key, c);
      // data.photos mirrors the photo sources below (caption + time), as filing does.
      const photos = photoUploads.map((u) => ({
        messageId: u.id,
        caption: u.caption ?? undefined,
        takenAt: u.received_at!,
      }));
      const dataV1 = buildData(s, c, date, crews, plan, audioId, photos, isHero);
      // Signed off the next morning at 08:30, once that has happened (a live day before 08:30
      // still has yesterday's report filed, not signed off).
      const signOffAt = plan.kind === 'signed_off' ? t(addDays(c, 1), '08:30') : null;
      const signedOffAt = signOffAt !== null && signOffAt < now ? signOffAt : null;
      const status: ReportRow['status'] = signedOffAt ? 'signed_off' : 'filed';
      const needsReview = !!plan.needsReview?.length;
      reports.push({
        ...V12_REPORT,
        id: reportId,
        org_id: ORG,
        site_id: sid,
        site_day_id: siteDayId,
        report_no: reportNo,
        status,
        current_version: isHero ? 2 : 1,
        reporter_id: reporter.id,
        received_at: receivedAt,
        confirmed_at: confirmedAt,
        filed_at: filedAt,
        signed_off_by: status === 'signed_off' ? SAM : null,
        signed_off_at: signedOffAt,
        needs_review: needsReview,
        review_reasons: plan.needsReview ?? [],
        is_late: isLate,
        kind: plan.kind === 'weather_day' ? 'weather_day' : 'daily',
        created_at: receivedAt,
        updated_at: isHero ? t(c, '20:10') : (signedOffAt ?? filedAt),
        channel,
        language: 'en',
        confirmed_via: channel,
      });
      siteDays.push({
        id: siteDayId,
        site_id: sid,
        date,
        status: plan.kind === 'weather_day' ? 'weather_day' : 'filed',
        deadline_at: deadlineAt,
        reminder_stage: isLate ? 2 : 0,
        reminders_paused: false,
        is_late: isLate,
        weather: weatherJson,
        report_id: reportId,
        created_at: opened,
        updated_at: filedAt,
      });
      if (call) {
        logCall(call);
        sources.push({
          ...V12_SOURCE,
          id: demoId(`src:${reportId}:call`),
          report_id: reportId,
          message_id: null,
          kind: 'call',
          caption: null,
          taken_at: call.started_at,
          call_id: call.id,
          created_at: call.started_at,
        });
      } else {
        sources.push({
          ...V12_SOURCE,
          id: demoId(`src:${reportId}:audio`),
          report_id: reportId,
          message_id: null,
          kind: 'voice_note',
          caption: null,
          taken_at: receivedAt,
          upload_id: audioId,
          created_at: receivedAt,
        });
        photoUploads.forEach((u, i) =>
          sources.push({
            ...V12_SOURCE,
            id: demoId(`src:${reportId}:photo${i}`),
            report_id: reportId,
            message_id: null,
            kind: 'photo',
            caption: u.caption,
            taken_at: u.received_at,
            upload_id: u.id,
            created_at: u.received_at,
          }),
        );
      }

      const pushVersion = (
        version: number,
        data: StoredReportData,
        author: ReportVersionRow['author'],
        changeNote: string | null,
        createdAt: string,
        via: FieldChannel | null = null,
      ) => {
        versions.push({
          report_id: reportId,
          version,
          data: data as unknown as ReportVersionRow['data'],
          summary: data.summary,
          pdf_path: `${ORG}/${sid}/${reportNo}_v${version}.pdf`,
          author,
          author_user_id: null,
          author_message_id: null,
          change_note: changeNote,
          created_at: createdAt,
          via,
        });
        const rows = versionRows({ reportId, siteId: sid, version, date, data });
        manpower.push(...rows.manpower);
        workItems.push(...rows.workItems);
        weatherEvents.push(...rows.weatherEvents);
      };
      const auditFiled = (at: string) =>
        logAudit({
          org_id: ORG,
          actor_type: 'agent',
          actor_id: null,
          action: 'report.filed',
          entity: 'report',
          entity_id: reportId,
          diff: { version: 1, channel },
          created_at: at,
        });

      if (isHero) {
        // §18.1 hero, channel link: daily link 17:00 → voice note 2 min 48 s + 2 photos at 17:38
        // → "Delta — how many and how long?" answered "5 · full day" on the recorder 17:41 →
        // confirmed 17:43 → filed 17:44 → v2 20:10 from Past reports ("Apex was 7, not 6").
        const qId = demoId('question:hero:delta');
        // F10: the change is spoken on Past reports at 20:09 ("Apex was 7, not 6"), a short voice
        // note of the report with its transcript; v2's Apex count cites it, not the 17:38 note
        // (which says six).
        const fixId = demoId('upload:hero:fix');
        const fixAt = t(c, '20:09');
        const heroV2 = structuredClone(heroDataV2(dataV1, audioId, qId, fixId));
        const draft = structuredClone(heroDataV2(dataV1, audioId, qId));
        const apex = draft.manpower.find((m) => m.companyId === companyId('apex'))!;
        apex.workers = 6;
        apex.totalHours = 48;
        draft.summary = heroSummary(23, 184);
        pushVersion(1, draft, 'agent', null, t(c, '17:42'));
        pushVersion(2, heroV2, 'reporter', 'Apex Concrete 6 → 7 workers', t(c, '20:10'), 'web');
        uploads.push({
          id: fixId,
          report_id: reportId,
          reporter_id: reporter.id,
          site_id: sid,
          kind: 'audio',
          storage_path: `${ORG}/${sid}/${date}/${fixId}.webm`,
          mime: 'audio/webm;codecs=opus',
          bytes: null,
          duration_s: HERO_FIX_S,
          peaks: peaksFor('hero:fix'),
          recorded_at: fixAt,
          received_at: fixAt,
          caption: null,
          uploaded_by: null,
          purged_at: null,
          batch_id: null,
          batch_size: null,
          question_id: null,
          correction_report_id: null,
        });
        transcripts.push({
          ...V12_ROW_DEFAULTS.transcripts,
          id: demoId('transcript:hero:fix'),
          message_id: null,
          upload_id: fixId,
          language: 'en',
          text: 'Apex was 7, not 6.',
          segments: [{ start: 0, end: 2, text: 'Apex was 7, not 6.' }],
          model: 'nova-3',
          created_at: plusSeconds(fixAt, 5),
        });
        transcripts.push({
          ...V12_ROW_DEFAULTS.transcripts,
          id: demoId('transcript:hero'),
          message_id: null,
          upload_id: audioId,
          language: 'es+en',
          text: heroTranscriptSegments.map((x) => x.text).join(' '),
          segments: heroTranscriptSegments as unknown as TranscriptRow['segments'],
          model: 'nova-3',
          created_at: t(c, '17:39'),
        });
        const prompt =
          "Quick check: you said 'the Delta guys' were on Level 2. How many, and for how long?";
        questions.push({
          ...V12_ROW_DEFAULTS.questions,
          id: qId,
          report_id: reportId,
          channel: 'web',
          field: 'manpower.workers',
          target: {
            manpowerIndex: 2,
            companyNameHeard: 'the Delta guys',
            companyName: 'Delta Mechanical',
          },
          prompt,
          // §6.3: up to 3 [{id,label}]; the recorder adds "Other…" itself (§9.3 Field-05).
          options: [
            { id: '4-full-day', label: '4 · full day' },
            { id: '5-full-day', label: '5 · full day' },
          ],
          asked_message_id: null,
          answered_message_id: null,
          answer: { workers: 5, fullDay: true },
          asked_at: t(c, '17:40'),
          answered_at: t(c, '17:41'),
          created_at: t(c, '17:40'),
        });
        sources.push({
          ...V12_SOURCE,
          id: demoId(`src:${reportId}:answer`),
          report_id: reportId,
          message_id: null,
          kind: 'answer',
          caption: null,
          taken_at: t(c, '17:41'),
          question_id: qId,
          created_at: t(c, '17:41'),
        });
        sources.push({
          ...V12_SOURCE,
          id: demoId(`src:${reportId}:fix`),
          report_id: reportId,
          message_id: null,
          kind: 'voice_note',
          caption: null,
          taken_at: fixAt,
          upload_id: fixId,
          created_at: fixAt,
        });
        for (const [action, actor, at, diff] of [
          ['report.created', 'agent', '17:38', { report_no: reportNo, channel: 'web' }],
          [
            'question.asked',
            'agent',
            '17:40',
            { field: 'manpower.workers', company: 'Delta Mechanical' },
          ],
          ['question.answered', 'reporter', '17:41', { answer: '5 · full day', channel: 'web' }],
          ['report.confirmed', 'reporter', '17:43', { via: 'web' }],
        ] as const) {
          logAudit({
            org_id: ORG,
            actor_type: actor,
            actor_id: actor === 'reporter' ? reporter.id : null,
            action,
            entity: 'report',
            entity_id: reportId,
            diff,
            created_at: t(c, at),
          });
        }
        auditFiled(filedAt);
        logAudit({
          org_id: ORG,
          actor_type: 'reporter',
          actor_id: reporter.id,
          action: 'report.version_created',
          entity: 'report',
          entity_id: reportId,
          diff: { version: 2, change_note: 'Apex Concrete 6 → 7 workers', via: 'web' },
          created_at: t(c, '20:10'),
        });
        sms(
          `filed:${reportId}`,
          reporter,
          'filed',
          renderSms('filed', 'en', { report_no: reportNo, pdf_link: dailyLink!.url }, smsOptions),
          filedAt,
        );
        sms(
          `edit_applied:${reportId}:2`,
          reporter,
          'edit_applied',
          renderSms(
            'edit_applied',
            'en',
            { weekday: 'Friday', change: 'Apex Concrete 7 workers, 56 h (was 6, 48 h)', v: 2 },
            smsOptions,
          ),
          t(c, '20:10'),
        );
        continue;
      }

      // Oct 9 is v1.2 data; history keeps the stored v1 shape (D20).
      let data: StoredReportData = dataV1;
      if (isToday) {
        const v2 = toV2(dataV1, languageOf(reporter.locale));
        data = call ? sourcesToCall(v2, call.id) : v2;
        if (call) {
          // W3-05: the call's two-speaker transcript and its two-lane peaks (reporter left,
          // assistant right), so P7's player shows both lanes; the history's calls keep v1's
          // single array (one lane).
          const callData = data as DailyReportData;
          const totals = deriveTotals(callData, {
            selfPerformCompanyIds: new Set([companyId('self')]),
          });
          const segments = demoCallTranscript(callData, {
            callId: call.id,
            firstName: firstName(reporter.name),
            company: ORG_NAME,
            durationS: Number(call.duration_s ?? 0),
            totals,
          });
          call.peaks = demoCallPeaks(
            segments,
            Number(call.duration_s ?? 0),
            `call:${s.key}:${c}`,
          ) as unknown as CallRow['peaks'];
          transcripts.push({
            ...V12_ROW_DEFAULTS.transcripts,
            id: demoId(`transcript:call:${s.key}:${c}`),
            message_id: null,
            call_id: call.id,
            language: 'en',
            text: segments.map((x) => x.text).join(' '),
            segments: segments as unknown as TranscriptRow['segments'],
            model: 'nova-3',
            created_at: plusSeconds(call.started_at!, Number(call.duration_s ?? 0) + 20),
          });
        }
      }
      pushVersion(1, data, 'agent', null, confirmedAt);
      auditFiled(filedAt);
      if (status === 'signed_off') {
        logAudit({
          org_id: ORG,
          actor_type: 'user',
          actor_id: SAM,
          action: 'report.signed_off',
          entity: 'report',
          entity_id: reportId,
          diff: { version: 1 },
          created_at: signedOffAt!,
        });
      }
      if (plan.needsReview) {
        logAudit({
          org_id: ORG,
          actor_type: 'agent',
          actor_id: null,
          action: 'report.needs_review',
          entity: 'report',
          entity_id: reportId,
          diff: { reasons: plan.needsReview },
          created_at: filedAt,
        });
      }
      if (!isToday) continue;

      if (s.key === 'hillcrest' && call) {
        // §18.1: R1 call 17:45 not answered → missed_call SMS → Aisha called back 18:41
        // ("rained out, sent the crew home at 11") → filed, photo link sent (below).
        logCall(
          callRow({
            key: `${s.key}:${c}:r1`,
            reporter,
            from: reporter.phone_e164,
            site: sid,
            report: null,
            direction: 'outbound',
            purpose: 'reminder',
            status: 'no_answer',
            outcome: 'not_reached',
            startedAt: t(c, '17:45'),
            durationS: null,
            ringS: 40,
            recordingPath: null,
          }),
        );
        sms(
          `missed_call:${s.key}:${c}`,
          reporter,
          'missed_call',
          renderSms(
            'missed_call',
            'en',
            { number: sitelogNumber, link: personal.get(reporter.id)!.url },
            smsOptions,
          ),
          t(c, '17:46'),
        );
      }
      // The PDF text after filing (§9.2 `filed`): the link opens the day's report in the recorder.
      const reportLink = dailyLink ?? personal.get(reporter.id)!;
      sms(
        `filed:${reportId}`,
        reporter,
        'filed',
        renderSms('filed', 'en', { report_no: reportNo, pdf_link: reportLink.url }, smsOptions),
        filedAt,
      );
      if (call) {
        // F9, §13: a report filed on a call also gets the photos link (valid to 23:59 next day).
        const photosLink = link(
          `photos:${reporter.id}:${c}`,
          reporter,
          'photos',
          sid,
          date,
          filedAt,
        );
        sms(
          `photos_link:${s.key}:${c}`,
          reporter,
          'photos_link',
          renderSms('photos_link', 'en', { link: photosLink.url }, smsOptions),
          filedAt,
        );
      }
    }
  }

  // §18.1 / F13: +1 555 019 4410 called Fri 17:52 ("this is Luis, covering Elm St. today…").
  if (!cal.live) {
    const luisCall = callRow({
      key: 'unknown:luis',
      reporter: null,
      from: '+15550194410',
      site: null,
      report: null,
      direction: 'inbound',
      purpose: null,
      status: 'completed',
      outcome: null,
      startedAt: t(DEMO_TODAY, '17:52'),
      durationS: LUIS_CALL_S,
      recordingPath: `${ORG}/_unknown/call-${demoId('call:unknown:luis')}.ogg`,
    });
    logCall(luisCall);
    transcripts.push({
      ...V12_ROW_DEFAULTS.transcripts,
      id: demoId('transcript:luis'),
      message_id: null,
      call_id: luisCall.id,
      language: 'en',
      text: "Hey, this is Luis, covering Elm St. today for Priya. We framed units one through four, six guys, no rain. I'll send photos.",
      segments: [
        { start: 0, end: 12.5, text: 'Hey, this is Luis, covering Elm St. today for Priya.' },
        { start: 12.5, end: 28, text: 'We framed units one through four, six guys, no rain.' },
        { start: 28, end: 41, text: "I'll send photos." },
      ],
      model: 'nova-3',
      created_at: luisCall.ended_at!,
    });
    unknownContacts.push({
      id: demoId('unknown:luis'),
      org_id: ORG,
      phone_e164: '+15550194410',
      message_id: null,
      channel: 'voice',
      call_id: luisCall.id,
      snippet:
        'this is Luis, covering Elm St. today for Priya. We framed units one through four, six guys, no rain…',
      guessed_site_id: siteId('elm'),
      status: 'pending',
      created_at: luisCall.started_at!,
    });
    logAudit({
      org_id: ORG,
      actor_type: 'system',
      actor_id: null,
      action: 'unknown_contact.created',
      entity: 'unknown_contact',
      entity_id: demoId('unknown:luis'),
      diff: { channel: 'voice', guessed_site_id: siteId('elm') },
      created_at: luisCall.ended_at!,
    });
  }

  // Sub invoices (F15) — the week of Oct 5–9. A live day has no Friday reports yet, so the
  // invoice check would compare against a week that has not happened: left out.
  const inv = (
    key: CompanyKey,
    no: string,
    days: number[],
    total: number,
    gapNotified: number | null = null,
    status: SubInvoiceRow['status'] = 'open',
  ): SubInvoiceRow => ({
    id: demoId(`invoice:${no}`),
    org_id: ORG,
    company_id: companyId(key),
    invoice_no: no,
    period_start: '2026-10-05',
    period_end: '2026-10-09',
    lines: ['2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09'].map(
      (date, i) => ({ date, hours: days[i] }),
    ),
    total_hours: total,
    file_path: null,
    status,
    queried_at: null,
    resolved_at: null,
    created_at: t('2026-10-09', '15:30'),
    // The gaps were notified when the invoices were saved (spec §19 Q133, W3-06): the seed writes
    // that state, so loading it posts no second notice. The bell keeps §18.1's one notice
    // (BrightLine); ClearView's is older and not in the seeded list.
    gap_notified: gapNotified,
  });
  const invoices: SubInvoiceRow[] = cal.live
    ? []
    : [
        inv('apex', 'AP-1097', [88, 96, 96, 88, 104], 472),
        inv('brightline', 'BL-3381', [40, 44, 40, 44, 44], 212, 16),
        inv('ironclad', 'IC-0554', [48, 40, 48, 48, 48], 232),
        inv('clearview', 'CV-2210', [32, 32, 32, 32, 32], 160, 8),
      ];

  // Riverside's EOT evidence pack for September, built Oct 2. A live demo moves its period with
  // the history (the seeded Sep 21–30 moved by whole weeks), so it covers seeded, past days.
  const packPeriod = cal.live
    ? { start: cal.day('2026-09-21'), end: cal.day('2026-09-30') }
    : { start: '2026-09-01', end: '2026-09-30' };
  const packName = cal.live
    ? `${formatMonthDay(packPeriod.start)} – ${formatMonthDay(packPeriod.end)}`
    : 'September';
  const packs: EvidencePackRow[] = [
    {
      id: demoId('pack:riverside:sep'),
      org_id: ORG,
      site_id: siteId('riverside'),
      period_start: packPeriod.start,
      period_end: packPeriod.end,
      status: 'ready',
      pdf_path: evidencePackStoragePath(
        ORG,
        siteId('riverside'),
        packPeriod.start,
        packPeriod.end,
        demoId('pack:riverside:sep'),
      ),
      sections: ['summary', 'reports', 'transcripts', 'photos', 'weather'],
      error: null,
      created_by: SAM,
      created_at: tp('2026-10-02', '09:12'),
      ready_at: tp('2026-10-02', '09:14'),
    },
  ];

  // Each notice carries its data as the producers write it (20261015000080), so the panel shows
  // it in the reader's language; the English title / body are the stored fallback.
  const oakmontToday = reports.find((r) => r.id === demoId(`report:oakmont:${DEMO_TODAY}`));
  const notifications: NotificationRow[] = [
    {
      id: demoId('notif:missing:elm'),
      org_id: ORG,
      user_id: null,
      kind: 'missing_report',
      title: 'Elm St. Townhomes — no report',
      body: "Priya didn't answer 2 reminders.",
      target_path: '/',
      data: noticeData('missing_report', {
        site: 'Elm St. Townhomes',
        first: 'Priya',
        reminders: 2,
      }),
      read_at: null,
      created_at: t(DEMO_TODAY, MISSING_AT),
    },
    {
      id: demoId('notif:review:oakmont'),
      org_id: ORG,
      user_id: null,
      kind: 'needs_review',
      title: 'Oakmont Medical Center needs review',
      body: 'Unknown subcontractor "Ridgeway" · 6 workers',
      data: oakmontToday
        ? noticeData('needs_review', {
            reportNo: oakmontToday.report_no,
            reasons: oakmontToday.review_reasons,
          })
        : null,
      target_path: `/reports/${demoId(`report:oakmont:${DEMO_TODAY}`)}`,
      read_at: null,
      created_at: t(DEMO_TODAY, '17:21'),
    },
    {
      id: demoId('notif:unknown:luis'),
      org_id: ORG,
      user_id: null,
      kind: 'unknown_contact',
      title: 'Unknown number tried to report',
      body: '+1 555 019 4410 · "this is Luis, covering Elm St. today…"',
      data: noticeData('unknown_contact', {}),
      target_path: '/team',
      read_at: null,
      created_at: t(DEMO_TODAY, '17:52'),
    },
    {
      id: demoId('notif:gap:brightline'),
      org_id: ORG,
      user_id: null,
      kind: 'invoice_gap',
      title: 'Invoice gap: BrightLine Electric +16 h',
      body: 'BL-3381 invoices 212 h · reports show 196 h',
      data: noticeData('invoice_gap', {
        company: 'BrightLine Electric',
        invoiceNo: 'BL-3381',
        invoiced: 212,
        reported: 196,
        gap: 16,
      }),
      target_path: '/hours?week=2026-W41',
      read_at: null,
      created_at: t(DEMO_TODAY, '15:31'),
    },
    {
      id: demoId('notif:glossary'),
      org_id: ORG,
      user_id: null,
      kind: 'glossary_review',
      title: '3 glossary terms to review',
      body: '"mud", "colado", "the Ridgeway crew"',
      data: noticeData('glossary_review', { count: 3 }),
      target_path: '/glossary',
      read_at: t(DEMO_TODAY, '16:00'),
      created_at: t(DEMO_TODAY, '12:00'),
    },
    {
      id: demoId('notif:pack'),
      org_id: ORG,
      user_id: SAM,
      kind: 'pack_ready',
      title: `EOT evidence pack ready — Riverside Lofts, ${packName}`,
      body: null,
      data: noticeData('pack_ready', {
        site: 'Riverside Lofts — Block B',
        from: packPeriod.start,
        to: packPeriod.end,
      }),
      target_path: '/weather',
      read_at: tp('2026-10-02', '10:00'),
      created_at: tp('2026-10-02', '09:14'),
    },
  ]
    // A live day keeps what happened before now, except the invoice gap (no invoices); one read
    // later than now is still unread.
    .filter((n) => !cal.live || (n.created_at < now && n.kind !== 'invoice_gap'))
    .map((n) => (n.read_at && n.read_at >= now ? { ...n, read_at: null } : n));

  if (!cal.live) {
    logAudit({
      org_id: ORG,
      actor_type: 'system',
      actor_id: null,
      action: 'site_day.missing',
      entity: 'site_day',
      entity_id: demoId(`siteday:elm:${DEMO_TODAY}`),
      diff: { reminders: 2 },
      created_at: t(DEMO_TODAY, MISSING_AT),
    });
  }
  logAudit({
    org_id: ORG,
    actor_type: 'user',
    actor_id: LENA,
    action: 'reporter.invited',
    entity: 'reporter',
    entity_id: reporterId('jorge'),
    diff: { sites: ['Riverside Lofts — Block B', 'Pier 9 Warehouse Retrofit'] },
    created_at: reporterById.get(reporterId('jorge'))!.invited_at!,
  });

  // The office users join when the org is set up; each membership has its `member.added` row,
  // as Demir Yapı's does (rows.ts `memberAudit`).
  const members: OrgMemberRow[] = DEMO_USERS.map((u) => ({
    org_id: ORG,
    user_id: u.id,
    role: u.role,
    display_name: u.name,
    title: u.title,
    created_at: t('2026-03-02', '09:00'),
    ...V12_ROW_DEFAULTS.org_members,
  }));

  return {
    now,
    org: {
      id: ORG,
      name: ORG_NAME,
      address: '2101 W Fulton St, Chicago, IL 60612',
      license_no: 'IL GC-104-5582',
      logo_path: null,
      timezone: DEMO_TZ,
      billing_status: 'active',
      trial_ends_at: null,
      created_at: t('2026-03-02', '09:00'),
      ...V12_ROW_DEFAULTS.orgs,
      // §18.1: en-US, imperial, USD (the column defaults), and a demo org (console SMS driver and
      // the Demo phone, §4.5).
      is_demo: true,
      // Legacy stripe_* mirror billing_* (the orgs_billing_ids trigger) until step 23.
      billing_customer_id: 'cus_demo_kestrel',
      billing_subscription_id: 'sub_demo_kestrel',
      stripe_customer_id: 'cus_demo_kestrel',
      stripe_subscription_id: 'sub_demo_kestrel',
      // §1.3 / §19 Q234: the org's own price, preset from billing_default_prices (USD 39900).
      price_per_site_minor: 39900,
      price_currency: 'USD',
    },
    settings: {
      org_id: ORG,
      default_deadline: '17:30:00',
      working_days: [1, 2, 3, 4, 5],
      default_shift_hours: 8,
      heads_up_enabled: true,
      heads_up_offset_min: -35,
      reminder1_enabled: true,
      reminder1_offset_min: 15,
      reminder2_enabled: true,
      reminder2_offset_min: 60,
      missing_enabled: true,
      missing_offset_min: 90,
      required_fields: ['manpower', 'hours', 'weather', 'work_performed', 'safety', 'photo'],
      filing_mode: 'confirm',
      signoff_required: true,
      email_pdf_on_file: true,
      max_questions_per_report: 3,
      payroll_csv_format: 'generic',
      pdf_paper: usPack.paper,
      pdf_footer_enabled: true,
      pdf_max_photos: 4,
      letterhead_lines: [
        '2101 W Fulton St, Chicago, IL 60612',
        'IL General Contractor License GC-104-5582',
      ],
      no_work_pdf: false,
      include_unconfirmed_in_payroll: true,
      past_due_grace_days: 14,
      payroll_columns: [...PAYROLL_COLUMNS],
      updated_at: t('2026-09-15', '11:00'),
      ...V12_ROW_DEFAULTS.org_settings,
    },
    users: DEMO_USERS,
    members,
    sites,
    reporters,
    siteReporters,
    recipients,
    companies,
    glossary,
    conversations,
    messages: messages.sort((a, b) =>
      a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0,
    ),
    transcripts,
    unknownContacts,
    siteDays,
    reports,
    versions,
    uploads,
    sources,
    manpower,
    workItems,
    weatherEvents,
    questions,
    consents,
    fieldLinks,
    calls,
    invoices,
    packs,
    notifications,
    audit: numberAudit([...audit, ...memberAudit(members)], 1),
    billing: {
      monthlyCents: 6 * 39900,
      nextInvoiceDate: '2026-11-01',
      paymentMethod: { brand: 'Visa', last4: '4242' },
      invoices: [
        { date: '2026-10-01', sites: 6, amountCents: 239400, status: 'paid', url: '#' },
        { date: '2026-09-01', sites: 6, amountCents: 239400, status: 'paid', url: '#' },
        { date: '2026-08-01', sites: 5, amountCents: 199500, status: 'paid', url: '#' },
        { date: '2026-07-01', sites: 4, amountCents: 159600, status: 'paid', url: '#' },
      ],
    },
  };
}

/**
 * The hero's v1.2 data (§18.1, §10.3) from the v1 builder's: `schemaVersion 2`, voice-note seconds
 * of the upload, and Delta Mechanical's headcount from the recorder answer (`hoursBasis` answer,
 * sources: where the note mentions them and the answered question). With `fixUploadId` (v2), Apex
 * Concrete's count comes from the spoken correction ("Apex was 7, not 6", its first 2 s).
 */
function heroDataV2(
  v1: DailyReportDataV1,
  audioId: string,
  questionId: string,
  fixUploadId?: string,
): DailyReportData {
  const v2 = toV2(v1, 'es');
  const delta = v2.manpower.find((m) => m.companyId === companyId('delta'))!;
  delta.hoursBasis = 'answer';
  delta.source = [
    { type: 'voice_note', uploadId: audioId, start: 30.5, end: 41 },
    { type: 'answer', questionId },
  ];
  if (fixUploadId) {
    const apex = v2.manpower.find((m) => m.companyId === companyId('apex'))!;
    apex.source = [{ type: 'voice_note', uploadId: fixUploadId, start: 0, end: 2 }];
  }
  return v2;
}

/**
 * The hero report's data in the WhatsApp-era v1 shape (Apex 7, 24 on site, 192 h): what its v2 is
 * built from, kept for the tests of `upgradeV1toV2` (report/upgrade.test.ts).
 */
export function heroDataV1(): DailyReportDataV1 {
  const s = SITES.find((x) => x.key === 'riverside')!;
  const plan = planFor('riverside', DEMO_TODAY);
  const audioId = demoId(`msg:riverside:${DEMO_TODAY}:audio`);
  const at = (sec: number) =>
    new Date(
      Date.parse(fromZonedTime(`${DEMO_TODAY}T17:38:00`, DEMO_TZ).toISOString()) + sec * 1000,
    ).toISOString();
  const photos = [0, 1].map((p) => ({
    messageId: demoId(`msg:riverside:${DEMO_TODAY}:photo${p}`),
    caption: p === 0 ? 'Conditions this morning' : 'End of day',
    takenAt: at(30 + p * 20),
  }));
  return buildData(
    s,
    DEMO_TODAY,
    DEMO_TODAY,
    crewFor('riverside', DEMO_TODAY),
    plan,
    audioId,
    photos,
    true,
  );
}

/**
 * A report's data in the v1 shape. `c` is the canonical demo date (it keys the pseudo-random
 * picks, so a moved day reads the same), `date` the date the report is for.
 */
function buildData(
  s: SiteDef,
  c: string,
  date: string,
  crews: Crew[],
  plan: DayPlan,
  audioId: string,
  photos: DailyReportDataV1['photos'],
  isHero: boolean,
): DailyReportDataV1 {
  const d = emptyReportDataV1(date);
  const src = (start: number, end?: number) => [
    { type: 'audio' as const, messageId: audioId, start, end: end ?? start + 7.5 },
  ];
  d.languageDetected = s.reporter.languages.includes('es') ? ['es', 'en'] : ['en'];
  d.photos = photos;
  d.workingHours = { start: '07:00', end: '15:30' };
  const periods: WeatherPeriodV1[] = plan.weather
    ? [
        {
          start: plan.weather.start,
          end: plan.weather.end,
          condition: plan.weather.condition,
          impact: plan.weather.impact,
          lostHours: plan.weather.lost,
          fullDay: plan.weather.fullDay,
          source: src(41, 52.3),
        },
      ]
    : [];
  d.weather = {
    observed: plan.weather
      ? {
          precipIn: plan.weather.precipIn,
          tempMinF: 58,
          tempMaxF: 64,
          windMph: 9,
          gustMph: plan.weather.gust ?? 18,
          provider: 'Open-Meteo',
        }
      : {
          precipIn: 0,
          tempMinF: 54,
          tempMaxF: 68,
          windMph: 8,
          gustMph: 15,
          provider: 'Open-Meteo',
        },
    conditionsText: plan.weather
      ? plan.weather.fullDay
        ? 'Heavy rain all day; site closed'
        : plan.weather.condition === 'High wind'
          ? 'Clear, high wind AM'
          : 'Rain AM, overcast PM'
      : ['Clear', 'Overcast, dry', 'Sunny, light breeze'][
          (demoRand(`cond:${s.key}:${c}`) * 3) | 0
        ]!,
    periods,
  };
  if (plan.kind === 'weather_day') {
    d.summary = plan.weather?.fullDay
      ? 'Site closed for the day because of heavy rain; crew did not start. No work performed.'
      : // The period's impact ("Rained out; crew released at 11:00") is in the weather log, not here.
        `Rain stopped work; crew released at ${plan.weather?.start}.`;
    d.safety = { incidents: [], noIncidentsStated: true, visitors: [], source: src(20) };
    return d;
  }
  d.manpower = manpowerFor(crews, audioId);
  const pick = (n: number) => {
    const start = (demoRand(`wp:${s.key}:${c}`) * s.activities.length) | 0;
    return Array.from({ length: n }, (_, i) => s.activities[(start + i) % s.activities.length]!);
  };
  if (isHero) {
    d.workPerformed = [
      {
        area: 'Level 4',
        activity: 'Slab pour',
        status: 'complete',
        quantity: { value: 68, unit: 'yd³', heardAs: 'sixty-eight yards' },
        source: src(8.2, 18.9),
      },
      {
        area: 'Level 3',
        activity: 'Electrical rough-in',
        status: 'in_progress',
        percentComplete: 60,
        source: src(18.9, 30.5),
      },
      {
        area: 'Level 2',
        activity: 'Ductwork, east wing',
        status: 'in_progress',
        source: src(30.5, 41),
      },
    ];
    d.deliveries = [
      {
        item: 'Rebar',
        quantity: '2 loads',
        supplier: 'Ironclad Steel',
        time: '13:00',
        source: src(52.3, 63),
      },
    ];
    d.safety = {
      toolboxTalk: 'Wet-weather access',
      incidents: [],
      noIncidentsStated: true,
      visitors: [],
      source: src(74.4, 86),
    };
    d.nextWorkday = [
      { item: 'Concrete pump Monday 07:00 for Level 5 deck', source: src(86, 98.5) },
    ];
    d.weather.periods[0]!.source = src(41, 52.3);
    d.summary = heroSummary(24, 192);
    d.newTerms = [
      { heard: 'colado', proposedOfficial: 'Concrete pour', kind: 'term', confidence: 0.86 },
    ];
    return d;
  }
  const items = pick(3);
  d.workPerformed = items.map(([area, activity], i) => ({
    area,
    activity,
    status: i === 0 ? 'complete' : 'in_progress',
    percentComplete: i === 1 ? 40 + ((demoRand(`pct:${s.key}:${c}`) * 50) | 0) : undefined,
    source: src(10 + i * 11),
  }));
  if (demoRand(`del:${s.key}:${c}`) < 0.5) {
    const del = [
      ['Drywall, 120 sheets', 'Summit Drywall'],
      ['Rebar, 1 load', 'Ironclad Steel'],
      ['Ready-mix, 4 trucks', 'Apex Concrete'],
      ['Glazing units, 1 crate', 'ClearView Glazing'],
    ][(demoRand(`del2:${s.key}:${c}`) * 4) | 0]!;
    d.deliveries = [
      {
        item: del[0]!.split(',')[0]!,
        quantity: del[0]!.split(', ')[1],
        supplier: del[1],
        source: src(50),
      },
    ];
  }
  d.safety = {
    toolboxTalk: isoWeekday(c) === 1 ? 'Weekly safety briefing' : undefined,
    incidents: [],
    noIncidentsStated: true,
    visitors: [],
    source: src(60),
  };
  if (s.key === 'oakmont' && c === DEMO_TODAY) {
    d.newTerms = [
      {
        heard: 'the Ridgeway crew',
        proposedOfficial: 'Ridgeway',
        kind: 'company',
        confidence: 0.6,
      },
    ];
    d.lowConfidence = [{ path: 'manpower[5]', reason: 'unknown company "Ridgeway"' }];
  }
  const totals = deriveTotals(d, { selfPerformCompanyIds: new Set([companyId('self')]) });
  const first = items[0]!;
  d.summary = `${first[1]} ${first[0] === 'Site' ? 'on site' : `at ${first[0]}`} completed with ${totals.crewOnSite} on site (${totals.totalHours} h).${plan.weather ? ` ${plan.weather.impact}; ${plan.weather.lost} h lost to ${plan.weather.condition.toLowerCase()}.` : ''} No incidents reported.`;
  return d;
}

let cached: DemoDataset | null = null;
/** §18.1 as written (Fri Oct 9, 19:05), built once. */
export function kestrelDemo(): DemoDataset {
  if (!cached) cached = buildKestrelDemo();
  return cached;
}
