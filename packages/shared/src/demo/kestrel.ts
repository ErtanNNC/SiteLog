/**
 * §18 — Kestrel Build Group demo data, generated deterministically.
 * Used by scripts/seed-demo.ts (→ supabase/seed.sql) and by the web panel's demo mode.
 */
import { fromZonedTime } from 'date-fns-tz';
import type {
  AuditLogRow,
  CompanyRow,
  ConversationRow,
  EvidencePackRow,
  GlossaryTermRow,
  ManpowerEntryRow,
  MessageRow,
  NotificationRow,
  QuestionRow,
  ReportRow,
  ReportSourceRow,
  ReportVersionRow,
  ReporterRow,
  SiteDayRow,
  SiteRow,
  SubInvoiceRow,
  TranscriptRow,
  UnknownSenderRow,
  WeatherEventRow,
  WorkItemRow,
} from '../db/types.ts';
import { addDays, isoWeekday } from '../format.ts';
import { deadlineInstant } from '../schedule/reminders.ts';
import type { DailyReportData, ManpowerEntry, WeatherPeriod } from '../schemas/report.ts';
import { emptyReportData } from '../schemas/report.ts';
import { deriveTotals } from '../report/hours.ts';
import { formatReportNo } from '../report/numbering.ts';
import { PAYROLL_COLUMNS } from '../report/payroll.ts';
import { demoId, demoRand } from './ids.ts';
import type { DemoDataset, DemoUser } from './types.ts';
import { heroTranscriptSegments, heroSummary } from './hero.ts';

export const DEMO_TZ = 'America/Chicago';
export const DEMO_TODAY = '2026-10-09';
export const DEMO_NOW = fromZonedTime('2026-10-09T19:05:00', DEMO_TZ).toISOString();
export const DEMO_ORG_ID = demoId('org:kestrel');
export const DEMO_WA_NUMBER = '+15550142290';

const ORG = DEMO_ORG_ID;

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
    reporter: { key: 'marco', name: 'Marco Ruiz', phone: '+15550143378', languages: ['es', 'en'] },
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
    reporter: { key: 'dana', name: 'Dana Whitfield', phone: '+15550145521', languages: ['en'] },
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
    reporter: { key: 'kevin', name: "Kevin O'Brien", phone: '+15550142087', languages: ['en'] },
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
    reporter: { key: 'aisha', name: 'Aisha Bello', phone: '+15550149932', languages: ['en'] },
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
    reporter: { key: 'priya', name: 'Priya Raman', phone: '+15550147719', languages: ['en', 'hi'] },
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
const DAYS = workdays('2026-09-21', DEMO_TODAY);

/** Local Chicago wall-clock → ISO instant. */
export function at(date: string, hhmm: string): string {
  return fromZonedTime(`${date}T${hhmm}:00`, DEMO_TZ).toISOString();
}

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
    case 'pier9':
      return [
        {
          company: 'summit',
          workers: w41 && (dow === 2 || dow === 5) ? 4 : 3,
          hours: 8,
          area: 'Bay 3',
          heard: 'Summit',
        },
        { company: 'self', workers: 6, hours: 8, area: 'Bay 2', heard: 'our guys' },
      ];
    case 'northgate':
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

type DayKind = 'filed' | 'late' | 'missing' | 'weather_day' | 'signed_off';
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
  if (site === 'northgate' && date === DEMO_TODAY) base.receivedLocal = '17:12';
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

function manpowerFor(crews: Crew[], audioMessageId: string, offset = 10): ManpowerEntry[] {
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

export function buildKestrelDemo(): DemoDataset {
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
    active_since: s.activeSince,
    paused_at: null,
    report_seq: s.lastNoOct9,
    created_at: at(s.activeSince, '09:00'),
  }));

  const reporters: ReporterRow[] = SITES.map((s) => ({
    id: reporterId(s.reporter.key),
    org_id: ORG,
    name: s.reporter.name,
    phone_e164: s.reporter.phone,
    role: 'site_manager',
    languages: s.reporter.languages,
    status: 'verified',
    invited_at: at(s.activeSince, '09:05'),
    verified_at: at(s.activeSince, '09:40'),
    last_invite_error: null,
    created_at: at(s.activeSince, '09:05'),
  }));
  reporters.push({
    id: reporterId('jorge'),
    org_id: ORG,
    name: 'Jorge Medina',
    phone_e164: '+15550143390',
    role: 'backup',
    languages: ['es'],
    status: 'invited',
    invited_at: at('2026-10-07', '10:15'),
    verified_at: null,
    last_invite_error: null,
    created_at: at('2026-10-07', '10:15'),
  });
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
    created_at: at('2026-03-02', '09:30'),
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
      first_seen_at: at(addDays('2026-09-21', -i), '17:10'),
      last_seen_at: at(i < 10 ? '2026-10-09' : '2026-10-07', '17:20'),
    }),
  );
  glossary.push({
    id: demoId('term:llovió'),
    org_id: null,
    scope_site_id: null,
    scope_reporter_id: null,
    heard: 'llovió',
    official: 'Rain',
    language: 'es',
    kind: 'term',
    company_id: null,
    status: 'built_in',
    times_heard: 0,
    first_seen_at: at('2026-01-01', '00:00'),
    last_seen_at: null,
  });
  glossary.push({
    id: demoId('term:andamio'),
    org_id: null,
    scope_site_id: null,
    scope_reporter_id: null,
    heard: 'andamio',
    official: 'Scaffold',
    language: 'es',
    kind: 'term',
    company_id: null,
    status: 'built_in',
    times_heard: 0,
    first_seen_at: at('2026-01-01', '00:00'),
    last_seen_at: null,
  });

  const conversations: ConversationRow[] = reporters.map((r) => {
    const verified = r.status === 'verified';
    const lastIn =
      r.id === reporterId('marco')
        ? at(DEMO_TODAY, '20:10')
        : verified
          ? at(DEMO_TODAY, '17:15')
          : null;
    return {
      id: demoId(`convo:${r.phone_e164}`),
      org_id: ORG,
      reporter_id: r.id,
      phone_e164: r.phone_e164,
      state: verified ? 'idle' : 'welcome_sent',
      context: {},
      last_inbound_at: lastIn,
      last_outbound_at: lastIn ?? r.invited_at,
      state_changed_at: lastIn ?? r.invited_at ?? DEMO_NOW,
      updated_at: lastIn ?? r.invited_at ?? DEMO_NOW,
    };
  });

  const messages: MessageRow[] = [];
  const transcripts: TranscriptRow[] = [];
  const siteDays: SiteDayRow[] = [];
  const reports: ReportRow[] = [];
  const versions: ReportVersionRow[] = [];
  const sources: ReportSourceRow[] = [];
  const manpower: ManpowerEntryRow[] = [];
  const workItems: WorkItemRow[] = [];
  const weatherEvents: WeatherEventRow[] = [];
  const questions: QuestionRow[] = [];
  const audit: AuditLogRow[] = [];
  let auditSeq = 1;
  const logAudit = (row: Omit<AuditLogRow, 'id'>) => audit.push({ id: auditSeq++, ...row });

  for (const s of SITES) {
    const sid = siteId(s.key);
    const convo = conversations.find((c) => c.reporter_id === reporterId(s.reporter.key))!;
    const daysForSite = DAYS.filter((d) => d >= s.activeSince);
    const reportDays = daysForSite.filter((d) => planFor(s.key, d).kind !== 'missing');
    let seq = s.lastNoOct9 - reportDays.length;
    for (const date of daysForSite) {
      const plan = planFor(s.key, date);
      const siteDayId = demoId(`siteday:${s.key}:${date}`);
      const deadlineAt = deadlineInstant(date, '17:30', DEMO_TZ).toISOString();
      const observed = plan.weather
        ? {
            precipIn: plan.weather.precipIn,
            tempMinF: 56 + ((demoRand(`t:${date}`) * 6) | 0),
            tempMaxF: 63 + ((demoRand(`T:${date}`) * 8) | 0),
            windMph: 9,
            gustMph: plan.weather.gust ?? 18,
            provider: 'Open-Meteo',
          }
        : {
            precipIn: 0,
            tempMinF: 52 + ((demoRand(`t:${date}`) * 8) | 0),
            tempMaxF: 66 + ((demoRand(`T:${date}`) * 10) | 0),
            windMph: 7 + ((demoRand(`w:${date}`) * 6) | 0),
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
          created_at: at(date, '00:05'),
          updated_at: at(date, '19:00'),
        });
        continue;
      }
      seq += 1;
      const reportId = demoId(`report:${s.key}:${date}`);
      const reportNo = formatReportNo(s.code, seq);
      const audioId = demoId(`msg:${s.key}:${date}:audio`);
      const receivedAt = at(date, plan.receivedLocal);
      const isLate = receivedAt > deadlineAt;
      const isHero = s.key === 'riverside' && date === DEMO_TODAY;
      const durationS = isHero ? 168 : 95 + ((demoRand(`dur:${s.key}:${date}`) * 110) | 0);
      const photoCount =
        plan.kind === 'weather_day'
          ? plan.weather?.photo
            ? 1
            : 0
          : plan.weather
            ? plan.weather.photo
              ? 2
              : 0
            : isHero
              ? 2
              : demoRand(`ph:${s.key}:${date}`) < 0.8
                ? 1
                : 2;
      messages.push({
        id: audioId,
        conversation_id: convo.id,
        direction: 'in',
        wa_message_id: `wamid.demo.${s.key}.${date}.audio`,
        type: 'audio',
        body: null,
        payload: {
          peaks: Array.from(
            { length: 64 },
            (_, i) => Math.round((0.15 + 0.85 * demoRand(`peak:${s.key}:${date}`, i)) * 100) / 100,
          ),
        },
        media_id: `media-${s.key}-${date}`,
        media_mime: 'audio/ogg; codecs=opus',
        storage_path: `${ORG}/${sid}/${date}/${audioId}.ogg`,
        duration_s: durationS,
        template_name: null,
        status: 'received',
        error: null,
        created_at: receivedAt,
      });
      const photoIds: string[] = [];
      for (let p = 0; p < photoCount; p++) {
        const pid = demoId(`msg:${s.key}:${date}:photo${p}`);
        photoIds.push(pid);
        messages.push({
          id: pid,
          conversation_id: convo.id,
          direction: 'in',
          wa_message_id: `wamid.demo.${s.key}.${date}.photo${p}`,
          type: 'image',
          body:
            p === 0
              ? plan.weather
                ? 'Conditions this morning'
                : `${s.activities[(demoRand(`act:${s.key}:${date}`) * s.activities.length) | 0]![1]}`
              : 'End of day',
          payload: null,
          media_id: `media-${s.key}-${date}-p${p}`,
          media_mime: 'image/jpeg',
          storage_path: `${ORG}/${sid}/${date}/${pid}.jpg`,
          duration_s: null,
          template_name: null,
          status: 'received',
          error: null,
          created_at: at(date, plan.receivedLocal).replace(
            /:00\.000Z$/,
            `:${String(30 + p * 20).padStart(2, '0')}.000Z`,
          ),
        });
      }

      const crews = plan.kind === 'weather_day' ? [] : crewFor(s.key, date);
      const data = buildData(s, date, crews, plan, audioId, photoIds, isHero);
      const confirmedAt = new Date(new Date(receivedAt).getTime() + 5 * 60_000).toISOString();
      const status: ReportRow['status'] = plan.kind === 'signed_off' ? 'signed_off' : 'filed';
      const needsReview = !!plan.needsReview?.length;
      const currentVersion = isHero ? 2 : 1;
      const siteDayStatus: SiteDayRow['status'] =
        plan.kind === 'weather_day' ? 'weather_day' : 'filed';
      reports.push({
        id: reportId,
        org_id: ORG,
        site_id: sid,
        site_day_id: siteDayId,
        report_no: reportNo,
        status,
        current_version: currentVersion,
        reporter_id: reporterId(s.reporter.key),
        received_at: receivedAt,
        confirmed_at: confirmedAt,
        filed_at: confirmedAt,
        signed_off_by: status === 'signed_off' ? SAM : null,
        signed_off_at: status === 'signed_off' ? at(addDays(date, 1), '08:30') : null,
        needs_review: needsReview,
        review_reasons: plan.needsReview ?? [],
        is_late: isLate,
        kind: plan.kind === 'weather_day' ? 'weather_day' : 'daily',
        created_at: receivedAt,
        updated_at: isHero ? at(date, '20:10') : confirmedAt,
      });
      siteDays.push({
        id: siteDayId,
        site_id: sid,
        date,
        status: siteDayStatus,
        deadline_at: deadlineAt,
        reminder_stage: isLate ? 2 : 0,
        reminders_paused: false,
        is_late: isLate,
        weather: weatherJson,
        report_id: reportId,
        created_at: at(date, '00:05'),
        updated_at: confirmedAt,
      });
      sources.push({
        id: demoId(`src:${reportId}:audio`),
        report_id: reportId,
        message_id: audioId,
        kind: 'audio',
        caption: null,
        taken_at: receivedAt,
      });
      photoIds.forEach((pid, i) =>
        sources.push({
          id: demoId(`src:${reportId}:photo${i}`),
          report_id: reportId,
          message_id: pid,
          kind: 'photo',
          caption: messages.find((m) => m.id === pid)!.body,
          taken_at: messages.find((m) => m.id === pid)!.created_at,
        }),
      );

      const pushVersion = (
        version: number,
        d: DailyReportData,
        author: ReportVersionRow['author'],
        changeNote: string | null,
        createdAt: string,
        authorMessageId: string | null = null,
      ) => {
        versions.push({
          report_id: reportId,
          version,
          data: d as unknown as ReportVersionRow['data'],
          summary: d.summary,
          pdf_path: `${ORG}/${sid}/${reportNo}_v${version}.pdf`,
          author,
          author_user_id: null,
          author_message_id: authorMessageId,
          change_note: changeNote,
          created_at: createdAt,
        });
        d.manpower.forEach((m, i) =>
          manpower.push({
            id: demoId(`mp:${reportId}:${version}:${i}`),
            report_id: reportId,
            version,
            company_id: m.companyId,
            company_name_heard: m.companyNameHeard,
            company_name: m.companyName,
            trade: m.trade ?? null,
            area: m.area ?? null,
            workers: m.workers ?? 0,
            hours: m.totalHours ?? 0,
            hours_basis: m.hoursBasis,
            source: m.source[0] ?? null,
            confidence: m.confidence,
          }),
        );
        d.workPerformed.forEach((w, i) =>
          workItems.push({
            id: demoId(`wi:${reportId}:${version}:${i}`),
            report_id: reportId,
            version,
            area: w.area,
            activity: w.activity,
            status: w.status,
            percent: w.percentComplete ?? null,
            quantity: w.quantity ? `${w.quantity.value} ${w.quantity.unit}` : null,
            source: w.source[0] ?? null,
          }),
        );
        d.weather.periods.forEach((p, i) =>
          weatherEvents.push({
            id: demoId(`wx:${reportId}:${version}:${i}`),
            report_id: reportId,
            version,
            site_id: sid,
            date,
            start_local: p.start ?? null,
            end_local: p.end ?? null,
            condition: p.condition,
            impact: p.impact ?? null,
            lost_hours: p.lostHours,
            full_day: !!p.fullDay,
            audio_source: p.source.find((x) => x.type === 'audio') ?? null,
            photo_count: d.photos.length,
            observed: d.weather.observed ?? null,
            claim_ready:
              !!p.source.find((x) => x.type === 'audio') &&
              d.photos.length > 0 &&
              !!d.weather.observed,
          }),
        );
      };

      if (isHero) {
        const v1 = structuredClone(data);
        const apex = v1.manpower.find((m) => m.companyId === companyId('apex'))!;
        apex.workers = 6;
        apex.totalHours = 48;
        v1.summary = heroSummary(23, 184);
        pushVersion(1, v1, 'agent', null, confirmedAt);
        const editMsgId = demoId('msg:hero:edit');
        pushVersion(
          2,
          data,
          'reporter_reply',
          'Apex Concrete 6 → 7 workers',
          at(date, '20:10'),
          editMsgId,
        );
        transcripts.push({
          id: demoId('transcript:hero'),
          message_id: audioId,
          language: 'es+en',
          text: heroTranscriptSegments.map((x) => x.text).join(' '),
          segments: heroTranscriptSegments as unknown as TranscriptRow['segments'],
          model: 'whisper-1',
          created_at: at(date, '17:38'),
        });
        const qId = demoId('question:hero:delta');
        const askedId = demoId('msg:hero:question');
        const answerId = demoId('msg:hero:answer');
        const draftId = demoId('msg:hero:draft');
        const okId = demoId('msg:hero:ok');
        const filedId = demoId('msg:hero:filed');
        const pdfId = demoId('msg:hero:pdf');
        const ackId = demoId('msg:hero:ack');
        const editAckId = demoId('msg:hero:editack');
        const out = (
          id: string,
          type: MessageRow['type'],
          body: string,
          hhmm: string,
          extra: Partial<MessageRow> = {},
        ): MessageRow => ({
          id,
          conversation_id: convo.id,
          direction: 'out',
          wa_message_id: `wamid.demo.out.${id.slice(0, 8)}`,
          type,
          body,
          payload: null,
          media_id: null,
          media_mime: null,
          storage_path: null,
          duration_s: null,
          template_name: null,
          status: 'read',
          error: null,
          created_at: at(date, hhmm),
          ...extra,
        });
        messages.push(
          out(ackId, 'text', 'Got it, Marco — 2 min 48 s and 2 photos.', '17:38'),
          out(
            askedId,
            'interactive',
            "Quick check: you said 'the Delta guys' were on Level 2. How many, and for how long?",
            '17:40',
            {
              payload: {
                buttons: [
                  { id: `q:${qId}:0`, title: '4 · full day' },
                  { id: `q:${qId}:1`, title: '5 · full day' },
                  { id: `q:${qId}:other`, title: 'Other…' },
                ],
              },
            },
          ),
          {
            ...out(answerId, 'interactive', '5 · full day', '17:41'),
            direction: 'in',
            wa_message_id: 'wamid.demo.hero.answer',
            status: 'received',
            payload: { button_reply: { id: `q:${qId}:1`, title: '5 · full day' } },
          },
          out(
            demoId('msg:hero:answerack'),
            'text',
            'Thanks — Delta Mechanical: 5 workers × 8 h = 40 h.',
            '17:41',
          ),
          out(
            draftId,
            'interactive',
            'DRAFT · FRI OCT 9\nRiverside Lofts — Block B\nCREW      23 on site · 4 subs · 184 h\nWEATHER   Rain 07:00–10:30 · masonry stopped 3.5 h\nDONE      L4 slab pour complete · L3 electrical rough-in ~60% · L2 ductwork\nDELIVERED Rebar, 2 loads (Ironclad)\nSAFETY    Toolbox talk · no incidents\nReply OK to file it, or tell me what to fix.',
            '17:42',
            {
              payload: {
                buttons: [
                  { id: `draft:${reportId}:ok`, title: 'OK, file it' },
                  { id: `draft:${reportId}:fix`, title: 'Fix something' },
                ],
              },
            },
          ),
          {
            ...out(okId, 'interactive', 'OK, file it', '17:43'),
            direction: 'in',
            wa_message_id: 'wamid.demo.hero.ok',
            status: 'received',
            payload: { button_reply: { id: `draft:${reportId}:ok`, title: 'OK, file it' } },
          },
          out(
            filedId,
            'text',
            `Filed. Daily Report ${reportNo} is with the office. Thanks, Marco — that's it for today.`,
            '17:43',
          ),
          out(pdfId, 'document', `${reportNo}_${date}_v1.pdf`, '17:44', {
            storage_path: `${ORG}/${sid}/${reportNo}_v1.pdf`,
            media_mime: 'application/pdf',
          }),
          out(
            demoId('msg:hero:edithint'),
            'text',
            'Need a change later? Reply "edit Friday" any time. The office gets a new version; the old one is kept.',
            '17:44',
          ),
          {
            ...out(editMsgId, 'text', 'edit Friday — Apex was 7 guys, not 6', '20:10'),
            direction: 'in',
            wa_message_id: 'wamid.demo.hero.edit',
            status: 'received',
          },
          out(
            editAckId,
            'text',
            'Updated Friday: Apex Concrete 7 workers · 56 h (was 6 · 48 h). Version 2 sent to the office · version 1 kept in history.',
            '20:11',
          ),
          out(demoId('msg:hero:pdf2'), 'document', `${reportNo}_${date}_v2.pdf`, '20:11', {
            storage_path: `${ORG}/${sid}/${reportNo}_v2.pdf`,
            media_mime: 'application/pdf',
          }),
        );
        sources.push({
          id: demoId(`src:${reportId}:reply`),
          report_id: reportId,
          message_id: answerId,
          kind: 'reply',
          caption: null,
          taken_at: at(date, '17:41'),
        });
        questions.push({
          id: qId,
          report_id: reportId,
          field: 'manpower.workers',
          target: {
            manpowerIndex: 2,
            companyNameHeard: 'the Delta guys',
            companyName: 'Delta Mechanical',
          },
          prompt:
            "Quick check: you said 'the Delta guys' were on Level 2. How many, and for how long?",
          options: [
            { id: `q:${qId}:0`, title: '4 · full day' },
            { id: `q:${qId}:1`, title: '5 · full day' },
            { id: `q:${qId}:other`, title: 'Other…' },
          ],
          asked_message_id: askedId,
          answered_message_id: answerId,
          answer: { workers: 5, fullDay: true },
          asked_at: at(date, '17:40'),
          answered_at: at(date, '17:41'),
          created_at: at(date, '17:40'),
        });
        logAudit({
          org_id: ORG,
          actor_type: 'agent',
          actor_id: null,
          action: 'report.created',
          entity: 'report',
          entity_id: reportId,
          diff: { report_no: reportNo },
          created_at: at(date, '17:38'),
        });
        logAudit({
          org_id: ORG,
          actor_type: 'agent',
          actor_id: null,
          action: 'question.asked',
          entity: 'report',
          entity_id: reportId,
          diff: { field: 'manpower.workers', company: 'Delta Mechanical' },
          created_at: at(date, '17:40'),
        });
        logAudit({
          org_id: ORG,
          actor_type: 'reporter',
          actor_id: reporterId('marco'),
          action: 'question.answered',
          entity: 'report',
          entity_id: reportId,
          diff: { answer: '5 · full day' },
          created_at: at(date, '17:41'),
        });
        logAudit({
          org_id: ORG,
          actor_type: 'reporter',
          actor_id: reporterId('marco'),
          action: 'report.confirmed',
          entity: 'report',
          entity_id: reportId,
          diff: null,
          created_at: at(date, '17:43'),
        });
        logAudit({
          org_id: ORG,
          actor_type: 'agent',
          actor_id: null,
          action: 'report.filed',
          entity: 'report',
          entity_id: reportId,
          diff: { version: 1 },
          created_at: at(date, '17:43'),
        });
        logAudit({
          org_id: ORG,
          actor_type: 'reporter',
          actor_id: reporterId('marco'),
          action: 'report.version_created',
          entity: 'report',
          entity_id: reportId,
          diff: { version: 2, change_note: 'Apex Concrete 6 → 7 workers' },
          created_at: at(date, '20:10'),
        });
      } else {
        pushVersion(1, data, 'agent', null, confirmedAt);
        logAudit({
          org_id: ORG,
          actor_type: 'agent',
          actor_id: null,
          action: 'report.filed',
          entity: 'report',
          entity_id: reportId,
          diff: { version: 1 },
          created_at: confirmedAt,
        });
        if (status === 'signed_off') {
          logAudit({
            org_id: ORG,
            actor_type: 'user',
            actor_id: SAM,
            action: 'report.signed_off',
            entity: 'report',
            entity_id: reportId,
            diff: { version: 1 },
            created_at: at(addDays(date, 1), '08:30'),
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
            created_at: confirmedAt,
          });
        }
      }
    }
  }

  // Unknown sender (F11)
  const luisConvoId = demoId('convo:+15550194410');
  const luisMsgId = demoId('msg:luis');
  conversations.push({
    id: luisConvoId,
    org_id: ORG,
    reporter_id: null,
    phone_e164: '+15550194410',
    state: 'new',
    context: { unknown: true },
    last_inbound_at: at(DEMO_TODAY, '17:52'),
    last_outbound_at: at(DEMO_TODAY, '17:53'),
    state_changed_at: at(DEMO_TODAY, '17:52'),
    updated_at: at(DEMO_TODAY, '17:53'),
  });
  messages.push({
    id: luisMsgId,
    conversation_id: luisConvoId,
    direction: 'in',
    wa_message_id: 'wamid.demo.luis',
    type: 'audio',
    body: null,
    payload: {
      peaks: Array.from(
        { length: 64 },
        (_, i) => Math.round((0.1 + 0.8 * demoRand('peak:luis', i)) * 100) / 100,
      ),
    },
    media_id: 'media-luis',
    media_mime: 'audio/ogg; codecs=opus',
    storage_path: null,
    duration_s: 41,
    template_name: null,
    status: 'received',
    error: null,
    created_at: at(DEMO_TODAY, '17:52'),
  });
  transcripts.push({
    id: demoId('transcript:luis'),
    message_id: luisMsgId,
    language: 'en',
    text: "Hey, this is Luis, covering Elm St. today for Priya. We framed units one through four, six guys, no rain. I'll send photos.",
    segments: [
      { start: 0, end: 12.5, text: 'Hey, this is Luis, covering Elm St. today for Priya.' },
      { start: 12.5, end: 28, text: 'We framed units one through four, six guys, no rain.' },
      { start: 28, end: 41, text: "I'll send photos." },
    ],
    model: 'whisper-1',
    created_at: at(DEMO_TODAY, '17:53'),
  });
  const unknownSenders: UnknownSenderRow[] = [
    {
      id: demoId('unknown:luis'),
      org_id: ORG,
      phone_e164: '+15550194410',
      first_message_id: luisMsgId,
      snippet:
        'this is Luis, covering Elm St. today for Priya. We framed units one through four, six guys, no rain…',
      guessed_site_id: siteId('elm'),
      status: 'pending',
      created_at: at(DEMO_TODAY, '17:52'),
    },
  ];

  // Sub invoices (F15) — week Oct 5–9
  const inv = (
    key: CompanyKey,
    no: string,
    days: number[],
    total: number,
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
    created_at: at('2026-10-09', '15:30'),
  });
  const invoices: SubInvoiceRow[] = [
    inv('apex', 'AP-1097', [88, 96, 96, 88, 104], 472),
    inv('brightline', 'BL-3381', [40, 44, 40, 44, 44], 212),
    inv('ironclad', 'IC-0554', [48, 40, 48, 48, 48], 232),
    inv('clearview', 'CV-2210', [32, 32, 32, 32, 32], 160),
  ];

  const packs: EvidencePackRow[] = [
    {
      id: demoId('pack:riverside:sep'),
      org_id: ORG,
      site_id: siteId('riverside'),
      period_start: '2026-09-01',
      period_end: '2026-09-30',
      status: 'ready',
      pdf_path: `${ORG}/${siteId('riverside')}/eot_2026-09-01_2026-09-30.pdf`,
      sections: ['summary', 'reports', 'transcripts', 'photos', 'weather'],
      error: null,
      created_by: SAM,
      created_at: at('2026-10-02', '09:12'),
      ready_at: at('2026-10-02', '09:14'),
    },
  ];

  const notifications: NotificationRow[] = [
    {
      id: demoId('notif:missing:elm'),
      org_id: ORG,
      user_id: null,
      kind: 'missing_report',
      title: 'Elm St. Townhomes — no report',
      body: "Priya didn't answer 2 reminders.",
      target_path: '/',
      read_at: null,
      created_at: at(DEMO_TODAY, '19:00'),
    },
    {
      id: demoId('notif:review:oakmont'),
      org_id: ORG,
      user_id: null,
      kind: 'needs_review',
      title: 'Oakmont Medical Center needs review',
      body: 'Unknown subcontractor "Ridgeway" · 6 workers',
      target_path: `/reports/${demoId('report:oakmont:2026-10-09')}`,
      read_at: null,
      created_at: at(DEMO_TODAY, '17:21'),
    },
    {
      id: demoId('notif:unknown:luis'),
      org_id: ORG,
      user_id: null,
      kind: 'unknown_sender',
      title: 'Unknown number tried to report',
      body: '+1 555 019 4410 · "this is Luis, covering Elm St. today…"',
      target_path: '/team',
      read_at: null,
      created_at: at(DEMO_TODAY, '17:52'),
    },
    {
      id: demoId('notif:gap:brightline'),
      org_id: ORG,
      user_id: null,
      kind: 'invoice_gap',
      title: 'Invoice gap: BrightLine Electric +16 h',
      body: 'BL-3381 invoices 212 h · reports show 196 h',
      target_path: '/hours?week=2026-W41',
      read_at: null,
      created_at: at(DEMO_TODAY, '15:31'),
    },
    {
      id: demoId('notif:glossary'),
      org_id: ORG,
      user_id: null,
      kind: 'glossary_review',
      title: '3 glossary terms to review',
      body: '"mud", "colado", "the Ridgeway crew"',
      target_path: '/glossary',
      read_at: at(DEMO_TODAY, '16:00'),
      created_at: at(DEMO_TODAY, '12:00'),
    },
    {
      id: demoId('notif:pack'),
      org_id: ORG,
      user_id: SAM,
      kind: 'pack_ready',
      title: 'EOT evidence pack ready — Riverside Lofts, September',
      body: null,
      target_path: '/weather',
      read_at: at('2026-10-02', '10:00'),
      created_at: at('2026-10-02', '09:14'),
    },
  ];

  logAudit({
    org_id: ORG,
    actor_type: 'system',
    actor_id: null,
    action: 'site_day.missing',
    entity: 'site_day',
    entity_id: demoId('siteday:elm:2026-10-09'),
    diff: { reminders: 2 },
    created_at: at(DEMO_TODAY, '19:00'),
  });
  logAudit({
    org_id: ORG,
    actor_type: 'user',
    actor_id: LENA,
    action: 'reporter.invited',
    entity: 'reporter',
    entity_id: reporterId('jorge'),
    diff: { sites: ['Riverside Lofts — Block B', 'Pier 9 Warehouse Retrofit'] },
    created_at: at('2026-10-07', '10:15'),
  });
  audit.sort((a, b) => (a.created_at < b.created_at ? -1 : 1));
  audit.forEach((a, i) => (a.id = i + 1));

  return {
    now: DEMO_NOW,
    org: {
      id: ORG,
      name: 'Kestrel Build Group',
      address: '2101 W Fulton St, Chicago, IL 60612',
      license_no: 'IL GC-104-5582',
      logo_path: null,
      timezone: DEMO_TZ,
      stripe_customer_id: 'cus_demo_kestrel',
      stripe_subscription_id: 'sub_demo_kestrel',
      billing_status: 'active',
      trial_ends_at: null,
      created_at: at('2026-03-02', '09:00'),
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
      pdf_paper: 'letter',
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
      updated_at: at('2026-09-15', '11:00'),
    },
    users: DEMO_USERS,
    members: DEMO_USERS.map((u) => ({
      org_id: ORG,
      user_id: u.id,
      role: u.role,
      display_name: u.name,
      title: u.title,
      created_at: at('2026-03-02', '09:00'),
    })),
    sites,
    reporters,
    siteReporters,
    recipients,
    companies,
    glossary,
    conversations,
    messages,
    transcripts,
    unknownSenders,
    siteDays,
    reports,
    versions,
    sources,
    manpower,
    workItems,
    weatherEvents,
    questions,
    invoices,
    packs,
    notifications,
    audit,
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

function buildData(
  s: SiteDef,
  date: string,
  crews: Crew[],
  plan: DayPlan,
  audioId: string,
  photoIds: string[],
  isHero: boolean,
): DailyReportData {
  const d = emptyReportData(date);
  const src = (start: number, end?: number) => [
    { type: 'audio' as const, messageId: audioId, start, end: end ?? start + 7.5 },
  ];
  d.languageDetected = s.reporter.languages.includes('es') ? ['es', 'en'] : ['en'];
  d.photos = photoIds.map((id, i) => ({
    messageId: id,
    caption: i === 0 ? (plan.weather ? 'Conditions this morning' : undefined) : 'End of day',
    takenAt: at(date, plan.receivedLocal || '17:00'),
  }));
  d.workingHours = { start: '07:00', end: '15:30' };
  const periods: WeatherPeriod[] = plan.weather
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
          (demoRand(`cond:${s.key}:${date}`) * 3) | 0
        ]!,
    periods,
  };
  if (plan.kind === 'weather_day') {
    d.summary = plan.weather?.fullDay
      ? 'Site closed for the day because of heavy rain; crew did not start. No work performed.'
      : `Rain stopped work; crew released at ${plan.weather?.start}. ${plan.weather?.impact ?? ''}`.trim();
    d.safety = { incidents: [], noIncidentsStated: true, visitors: [], source: src(20) };
    return d;
  }
  d.manpower = manpowerFor(crews, audioId);
  const pick = (n: number) => {
    const start = (demoRand(`wp:${s.key}:${date}`) * s.activities.length) | 0;
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
    percentComplete: i === 1 ? 40 + ((demoRand(`pct:${s.key}:${date}`) * 50) | 0) : undefined,
    source: src(10 + i * 11),
  }));
  if (demoRand(`del:${s.key}:${date}`) < 0.5) {
    const del = [
      ['Drywall, 120 sheets', 'Summit Drywall'],
      ['Rebar, 1 load', 'Ironclad Steel'],
      ['Ready-mix, 4 trucks', 'Apex Concrete'],
      ['Glazing units, 1 crate', 'ClearView Glazing'],
    ][(demoRand(`del2:${s.key}:${date}`) * 4) | 0]!;
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
    toolboxTalk: isoWeekday(date) === 1 ? 'Weekly safety briefing' : undefined,
    incidents: [],
    noIncidentsStated: true,
    visitors: [],
    source: src(60),
  };
  if (s.key === 'oakmont' && date === DEMO_TODAY) {
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
export function kestrelDemo(): DemoDataset {
  if (!cached) cached = buildKestrelDemo();
  return cached;
}
