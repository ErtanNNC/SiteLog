import { expect } from '@playwright/test';
import { deviceCookieName, FIELD_CONSENT_TEXT_VERSION } from '@sitelog/shared/field-api.ts';
import { formatDateInTz } from '@sitelog/shared/format.ts';
import { LINK_CODE_ALPHABET, linkCodeHash, sha256Hex } from '@sitelog/shared/links.ts';
import { emptyReportData, type DailyReportData } from '@sitelog/shared/schemas/report.ts';
import { FIELD_PREVIEW_PORT } from '../../config/server.ts';

/**
 * The local Supabase stack for the field app's `e2e:supabase` (W1-09): names as `supabase status
 * -o env` prints them, so locally
 *   set -a; eval "$(supabase status -o env)"; set +a
 *   pnpm --filter @sitelog/field e2e:supabase
 * Rows are arranged and checked through PostgREST with the service role (no extra client library);
 * the app itself only ever calls field-api.
 */
export const API_URL = (process.env.API_URL ?? 'http://127.0.0.1:54321').replace(/\/+$/, '');
const SERVICE_ROLE_KEY = process.env.SERVICE_ROLE_KEY ?? '';
const ANON_KEY = process.env.ANON_KEY ?? '';

/**
 * The preview server's own port (4176), next to the smoke test's 4175: field-api accepts its
 * origin only when `supabase/functions/.env` lists it (CI: CORS_EXTRA_ORIGINS).
 */
export const FIELD_E2E_PORT = FIELD_PREVIEW_PORT + 2;
export const FIELD_E2E_URL = `http://localhost:${FIELD_E2E_PORT}`;

/** A PostgREST call as the service role; throws with the answer's text on a non-2xx status. */
export async function rest<T = unknown>(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  path: string,
  body?: unknown,
): Promise<T> {
  if (!SERVICE_ROLE_KEY) {
    throw new Error('SERVICE_ROLE_KEY is not set: export the output of `supabase status -o env`');
  }
  const res = await fetch(`${API_URL}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: SERVICE_ROLE_KEY,
      authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      'content-type': 'application/json',
      prefer: 'return=representation',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path}: HTTP ${res.status} ${text}`);
  return (text ? JSON.parse(text) : null) as T;
}

/** A Storage object as the service role (W4-16: a filed report's PDF), as bytes. */
export async function storageObject(bucket: string, path: string): Promise<Buffer> {
  if (!SERVICE_ROLE_KEY) {
    throw new Error('SERVICE_ROLE_KEY is not set: export the output of `supabase status -o env`');
  }
  const res = await fetch(
    `${API_URL}/storage/v1/object/${bucket}/${path.split('/').map(encodeURIComponent).join('/')}`,
    { headers: { apikey: SERVICE_ROLE_KEY, authorization: `Bearer ${SERVICE_ROLE_KEY}` } },
  );
  if (!res.ok) throw new Error(`storage ${bucket}/${path}: HTTP ${res.status} ${await res.text()}`);
  return Buffer.from(await res.arrayBuffer());
}

/**
 * A PostgREST `in.(…)` list, each value quoted and percent-encoded: PostgREST reads a raw `+` in
 * the query string as a space, so the phone numbers in the rate-limit keys need `%2B`.
 */
export function inList(values: readonly string[]): string {
  return `in.(${values.map((v) => `"${encodeURIComponent(v)}"`).join(',')})`;
}

function randomCode(length = 8): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, (b) => LINK_CODE_ALPHABET[b % LINK_CODE_ALPHABET.length]).join('');
}

export interface FieldFixture {
  orgId: string;
  /** Reports the spec seeded itself (no upload names them): their jobs are removed too. */
  reportIds?: string[];
  site: { id: string; name: string; projectCode: string };
  reporter: { id: string; name: string; firstName: string; phone: string };
  /** The personal link's code (`/r/{code}`); only its hash is stored, as for real links. */
  code: string;
  /** Auth users a spec made as the org's admin (`officeSession`), removed with the fixture. */
  officeUserIds?: string[];
}

/**
 * A demo org of its own (field-api writes a demo org's device code as a console text, which the
 * spec reads like the Demo phone does), one site and an invited reporter with a personal link,
 * so the run never touches the §18 seed the panel specs read.
 */
export async function createFieldFixture(): Promise<FieldFixture> {
  const stamp = Date.now();
  const [org] = await rest<{ id: string }[]>('POST', 'orgs', {
    name: `e2e:field ${stamp}`,
    is_demo: true,
  });
  const projectCode = 'FE-1';
  const [site] = await rest<{ id: string; name: string }[]>('POST', 'sites', {
    org_id: org!.id,
    name: 'Riverside Lofts — Block B',
    project_code: projectCode,
    timezone: 'America/Chicago',
    deadline: '17:30',
  });
  const phone = `+1555${String(Math.floor(Math.random() * 9_000_000) + 1_000_000)}`;
  const [reporter] = await rest<{ id: string }[]>('POST', 'reporters', {
    org_id: org!.id,
    name: 'Marco Ruiz',
    phone_e164: phone,
    locale: 'en-US',
    contact_pref: 'link',
  });
  await rest('POST', 'site_reporters', {
    site_id: site!.id,
    reporter_id: reporter!.id,
    is_primary: true,
  });
  const code = randomCode();
  await rest('POST', 'field_links', {
    code_hash: linkCodeHash(code),
    reporter_id: reporter!.id,
    kind: 'personal',
  });
  return {
    orgId: org!.id,
    site: { id: site!.id, name: site!.name, projectCode },
    reporter: { id: reporter!.id, name: 'Marco Ruiz', firstName: 'Marco', phone },
    code,
  };
}

/**
 * Removes the fixture's rows (as `supabase/db-tests/stack/field-api.test.ts` does): the rows
 * without ON DELETE first (jobs, report sources, uploads, links), then the org with the rest.
 * Every step runs even when one fails; the first error is thrown at the end.
 */
export async function dropFieldFixture(f: FieldFixture | undefined): Promise<void> {
  if (!f) return;
  // Every site of the org (W2-17: a second site, `addSite`).
  const sites = await rest<{ id: string }[]>('GET', `sites?select=id&org_id=eq.${f.orgId}`).catch(
    () => [{ id: f.site.id }],
  );
  const siteIds = sites.length ? sites.map((s) => s.id) : [f.site.id];
  const uploads = await rest<{ id: string; report_id: string | null }[]>(
    'GET',
    `uploads?select=id,report_id&site_id=${inList(siteIds)}`,
  ).catch(() => []);
  const uploadIds = uploads.map((u) => u.id);
  const reportIds = [...new Set(uploads.map((u) => u.report_id).filter((r): r is string => !!r))];
  const devices = await rest<{ id: string }[]>(
    'GET',
    `field_devices?select=id&reporter_id=eq.${f.reporter.id}`,
  ).catch(() => []);
  const steps: (() => Promise<unknown>)[] = [];
  if (uploadIds.length)
    steps.push(() => rest('DELETE', `jobs?payload->>uploadId=${inList(uploadIds)}`));
  for (const id of f.reportIds ?? []) if (!reportIds.includes(id)) reportIds.push(id);
  // Reports field-api made with no upload (W2-08's weather and no-work records, W2-17).
  const orgReports = await rest<{ id: string }[]>(
    'GET',
    `reports?select=id&org_id=eq.${f.orgId}`,
  ).catch(() => []);
  for (const r of orgReports) if (!reportIds.includes(r.id)) reportIds.push(r.id);
  if (reportIds.length)
    steps.push(() => rest('DELETE', `jobs?payload->>reportId=${inList(reportIds)}`));
  // The reporter's own jobs (W1-15: the `filed` text's notify job names the reporter).
  steps.push(() => rest('DELETE', `jobs?payload->>reporterId=eq.${f.reporter.id}`));
  steps.push(() =>
    rest(
      'DELETE',
      `rate_limits?key=${inList([
        `code_send:${f.reporter.phone}`,
        `code:${f.reporter.phone}`,
        ...devices.map((d) => `dev:${d.id}`),
      ])}`,
    ),
  );
  if (uploadIds.length) {
    steps.push(() => rest('DELETE', `report_sources?upload_id=${inList(uploadIds)}`));
    steps.push(() => rest('DELETE', `uploads?id=${inList(uploadIds)}`));
  }
  steps.push(() => rest('DELETE', `field_links?reporter_id=eq.${f.reporter.id}`));
  steps.push(() => rest('DELETE', `orgs?id=eq.${f.orgId}`));
  // W2-17: the office user a spec made for the Demo phone's replies (`officeSession`).
  for (const userId of f.officeUserIds ?? [])
    steps.push(() => authAdmin('DELETE', `users/${userId}`));
  let first: unknown = null;
  for (const step of steps) {
    try {
      await step();
    } catch (err) {
      first ??= err;
    }
  }
  if (first) throw first;
}

/**
 * A phone this reporter already verified, with the consents given (W1-13: the question flow
 * starts after the link flow W1-09's spec covers): a `field_devices` row verified now, whose
 * token the spec sets as the httpOnly device cookie, and the two required consents plus SMS.
 */
export async function verifiedDevice(
  f: FieldFixture,
  opts: { consent?: boolean } = {},
): Promise<{ name: string; value: string; deviceId: string }> {
  const token = Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('');
  const [device] = await rest<{ id: string }[]>('POST', 'field_devices', {
    reporter_id: f.reporter.id,
    device_token_hash: sha256Hex(token),
    user_agent: 'e2e:field',
    verified_at: new Date().toISOString(),
  });
  // `consent: false` (W2-13): a verified phone that has not consented yet (the Welcome screen).
  if (opts.consent === false)
    return { name: deviceCookieName(f.reporter.id), value: token, deviceId: device!.id };
  await rest(
    'POST',
    'consents',
    ['recording', 'data_processing', 'sms'].map((type) => ({
      reporter_id: f.reporter.id,
      type,
      method: 'web_checkbox',
      text_version: FIELD_CONSENT_TEXT_VERSION,
    })),
  );
  // As field-api's consent does (START reads activated_at to restore `active`, W2-17).
  await rest('PATCH', `reporters?id=eq.${f.reporter.id}`, {
    status: 'active',
    activated_at: new Date().toISOString(),
  });
  return { name: deviceCookieName(f.reporter.id), value: token, deviceId: device!.id };
}

export interface OpenQuestion {
  reportId: string;
  reportNo: string;
  questionId: string;
  prompt: string;
}

/**
 * Today's web report awaiting an answer, as the worker leaves it after extraction (W1-12): a v2
 * draft whose Delta crew has no headcount (heard at 1:20 of the voice note) and the open `web`
 * question with the model's two answers. The org asks one question per report here, so once the
 * answer is in, the CI worker's decide_next has nothing left to ask and shows the draft.
 */
export async function seedOpenQuestion(f: FieldFixture): Promise<OpenQuestion> {
  await rest('PATCH', `org_settings?org_id=eq.${f.orgId}`, { max_questions_per_report: 1 });
  const timezone = 'America/Chicago';
  const date = formatDateInTz(new Date(), timezone);
  const [day] = await rest<{ id: string }[]>('POST', 'site_days', {
    site_id: f.site.id,
    date,
    status: 'processing',
    deadline_at: new Date(Date.now() + 6 * 3600_000).toISOString(),
  });
  const reportNo = `${f.site.projectCode}-0001`;
  const [report] = await rest<{ id: string }[]>('POST', 'reports', {
    org_id: f.orgId,
    site_id: f.site.id,
    site_day_id: day!.id,
    report_no: reportNo,
    status: 'awaiting_answer',
    current_version: 1,
    reporter_id: f.reporter.id,
    channel: 'web',
    // NOT NULL since 20261014000002 (no default): field_complete_upload() stamps the org's.
    language: 'en',
    received_at: new Date().toISOString(),
  });
  const reportId = report!.id;
  (f.reportIds ??= []).push(reportId);
  await rest('PATCH', `site_days?id=eq.${day!.id}`, { report_id: reportId });
  const voice = { type: 'voice_note', uploadId: '00000000-0000-4000-8000-0000000000e2', start: 12 };
  const draft: DailyReportData = {
    ...emptyReportData(date, { reportLanguage: 'en', units: 'imperial' }),
    summary: 'Slab pour on Level 4; ductwork on Level 2.',
    weather: { conditionsText: 'Dry', periods: [] },
    manpower: [
      {
        companyId: null,
        companyNameHeard: 'Apex',
        companyName: 'Apex Concrete',
        workers: 6,
        hoursPerWorker: 8,
        totalHours: 48,
        hoursBasis: 'stated',
        confidence: 0.95,
        source: [voice as DailyReportData['manpower'][number]['source'][number]],
      },
      {
        companyId: null,
        companyNameHeard: 'the Delta guys',
        companyName: 'Delta Mechanical',
        area: 'Level 2',
        workers: null,
        hoursPerWorker: 8,
        totalHours: null,
        hoursBasis: 'full_day_default',
        confidence: 0.85,
        source: [{ ...voice, start: 80 } as DailyReportData['manpower'][number]['source'][number]],
      },
    ],
    workPerformed: [{ area: 'Level 4', activity: 'slab pour', status: 'complete', source: [] }],
    safety: { incidents: [], noIncidentsStated: true, visitors: [], source: [] },
    missingRequired: ['manpower.workers:Delta Mechanical'],
  };
  await rest('POST', 'report_versions', {
    report_id: reportId,
    version: 1,
    data: draft,
    summary: draft.summary,
    author: 'agent',
  });
  const prompt = 'You said “the Delta guys” were on Level 2. How many, and for how long?';
  const [question] = await rest<{ id: string }[]>('POST', 'questions', {
    report_id: reportId,
    channel: 'web',
    field: 'manpower.workers',
    target: {
      manpowerIndex: 1,
      companyName: 'Delta Mechanical',
      path: 'manpower.workers:Delta Mechanical',
    },
    prompt,
    options: [
      { id: 'o1', label: '4 · full day' },
      { id: 'o2', label: '5 · full day' },
    ],
    asked_at: new Date().toISOString(),
  });
  return { reportId, reportNo, questionId: question!.id, prompt };
}

export interface FiledReport {
  reportId: string;
  reportNo: string;
  date: string;
}

/**
 * Today's web report, filed (W2-04): version 1 as file_report leaves it (no photos), the site-day
 * filed. F9's window (until 23:59 tomorrow at the site) is open, so the Filed screen offers *Add
 * more photos*.
 */
export async function seedFiledReport(f: FieldFixture): Promise<FiledReport> {
  const timezone = 'America/Chicago';
  const date = formatDateInTz(new Date(), timezone);
  const [day] = await rest<{ id: string }[]>('POST', 'site_days', {
    site_id: f.site.id,
    date,
    status: 'filed',
    deadline_at: new Date(Date.now() + 6 * 3600_000).toISOString(),
  });
  const reportNo = `${f.site.projectCode}-0002`;
  const now = new Date().toISOString();
  const [report] = await rest<{ id: string }[]>('POST', 'reports', {
    org_id: f.orgId,
    site_id: f.site.id,
    site_day_id: day!.id,
    report_no: reportNo,
    status: 'filed',
    current_version: 1,
    reporter_id: f.reporter.id,
    channel: 'web',
    language: 'en',
    received_at: now,
    confirmed_at: now,
    confirmed_via: 'web',
    filed_at: now,
  });
  const reportId = report!.id;
  (f.reportIds ??= []).push(reportId);
  await rest('PATCH', `site_days?id=eq.${day!.id}`, { report_id: reportId });
  const data: DailyReportData = {
    ...emptyReportData(date, { reportLanguage: 'en', units: 'imperial' }),
    summary: 'Slab pour on Level 4.',
    weather: { conditionsText: 'Dry', periods: [] },
    workPerformed: [{ area: 'Level 4', activity: 'slab pour', status: 'complete', source: [] }],
    safety: { incidents: [], noIncidentsStated: true, visitors: [], source: [] },
  };
  await rest('POST', 'report_versions', {
    report_id: reportId,
    version: 1,
    data,
    summary: data.summary,
    author: 'agent',
  });
  return { reportId, reportNo, date };
}

export interface SeededDraft {
  reportId: string;
  reportNo: string;
}

/**
 * Today's web report awaiting confirmation, as decide_next leaves it (W2-10): a v2 draft with Apex
 * Concrete at 6 × 8 h = 48 h and Delta answered (5 × 8 h). The org asks one question per report
 * and that one is answered, so after a fix the CI worker's decide_next shows the draft again.
 */
export async function seedDraft(f: FieldFixture): Promise<SeededDraft> {
  await rest('PATCH', `org_settings?org_id=eq.${f.orgId}`, { max_questions_per_report: 1 });
  const timezone = 'America/Chicago';
  const date = formatDateInTz(new Date(), timezone);
  const [day] = await rest<{ id: string }[]>('POST', 'site_days', {
    site_id: f.site.id,
    date,
    status: 'processing',
    deadline_at: new Date(Date.now() + 6 * 3600_000).toISOString(),
  });
  const reportNo = `${f.site.projectCode}-0003`;
  const [report] = await rest<{ id: string }[]>('POST', 'reports', {
    org_id: f.orgId,
    site_id: f.site.id,
    site_day_id: day!.id,
    report_no: reportNo,
    status: 'awaiting_confirmation',
    current_version: 1,
    reporter_id: f.reporter.id,
    channel: 'web',
    language: 'en',
    received_at: new Date().toISOString(),
  });
  const reportId = report!.id;
  (f.reportIds ??= []).push(reportId);
  await rest('PATCH', `site_days?id=eq.${day!.id}`, { report_id: reportId });
  const voice = { type: 'voice_note', uploadId: '00000000-0000-4000-8000-0000000000e3', start: 12 };
  const line = (
    companyName: string,
    companyNameHeard: string,
    workers: number,
    start: number,
  ): DailyReportData['manpower'][number] => ({
    companyId: null,
    companyNameHeard,
    companyName,
    workers,
    hoursPerWorker: 8,
    totalHours: workers * 8,
    hoursBasis: 'full_day_default',
    confidence: 0.95,
    source: [{ ...voice, start } as DailyReportData['manpower'][number]['source'][number]],
  });
  const draft: DailyReportData = {
    ...emptyReportData(date, { reportLanguage: 'en', units: 'imperial' }),
    summary: 'Slab pour on Level 4; ductwork on Level 2.',
    weather: { conditionsText: 'Dry', periods: [] },
    manpower: [
      line('Apex Concrete', 'Apex', 6, 12),
      line('Delta Mechanical', 'the Delta guys', 5, 80),
    ],
    workPerformed: [{ area: 'Level 4', activity: 'slab pour', status: 'complete', source: [] }],
    safety: { incidents: [], noIncidentsStated: true, visitors: [], source: [] },
  };
  await rest('POST', 'report_versions', {
    report_id: reportId,
    version: 1,
    data: draft,
    summary: draft.summary,
    author: 'agent',
  });
  // The one question of the report, answered: decide_next asks nothing more.
  await rest('POST', 'questions', {
    report_id: reportId,
    channel: 'web',
    field: 'manpower.workers',
    target: { manpowerIndex: 1, companyName: 'Delta Mechanical' },
    prompt: 'How many from Delta?',
    options: [{ id: 'o2', label: '5 · full day' }],
    asked_at: new Date().toISOString(),
    answered_at: new Date().toISOString(),
    answer: { optionId: 'o2', text: '5 · full day', parsed: { workers: 5, fullDay: true } },
  });
  return { reportId, reportNo };
}

/**
 * The device code texted to the reporter (F4 step 2): the six digits of the newest console
 * `verify_code` row (what the Demo phone shows), once the reporter has more than `before` of them
 * (pass `codesSent()` from before the tap when an earlier code exists).
 */
export async function deviceCode(reporterId: string, before = 0): Promise<string> {
  let otp = '';
  await expect
    .poll(
      async () => {
        const rows = await rest<{ body: string; provider: string }[]>(
          'GET',
          `messages?select=body,provider&reporter_id=eq.${reporterId}&copy_key=eq.verify_code&order=created_at.desc`,
        );
        const m = /(\d{3})\s?(\d{3})/.exec(rows[0]?.body ?? '');
        if (rows.length > before && m && rows[0]!.provider === 'console') otp = `${m[1]}${m[2]}`;
        return otp;
      },
      { timeout: 15_000 },
    )
    .toMatch(/^\d{6}$/);
  return otp;
}

/** How many device codes the reporter was texted so far (`deviceCode`'s `before`). */
export async function codesSent(reporterId: string): Promise<number> {
  const rows = await rest<{ id: string }[]>(
    'GET',
    `messages?select=id&reporter_id=eq.${reporterId}&copy_key=eq.verify_code`,
  );
  return rows.length;
}

/**
 * Every day a working day for the fixture's org (W2-03, W2-08): field-api refuses a day off or
 * today's daily link on a day that is not one (`not_working_day`), and CI runs on weekends too.
 */
export async function everyDayWorking(f: FieldFixture): Promise<void> {
  await rest('PATCH', `org_settings?org_id=eq.${f.orgId}`, { working_days: [1, 2, 3, 4, 5, 6, 7] });
}

/**
 * A second site of the fixture's org, the reporter on it as its primary (F14, W2-03): `deadline`
 * is the site's `HH:MM` in America/Chicago.
 */
export async function addSite(
  f: FieldFixture,
  site: { name: string; projectCode: string; deadline?: string },
): Promise<{ id: string; name: string; projectCode: string }> {
  const [row] = await rest<{ id: string }[]>('POST', 'sites', {
    org_id: f.orgId,
    name: site.name,
    project_code: site.projectCode,
    timezone: 'America/Chicago',
    deadline: site.deadline ?? '17:30',
  });
  await rest('POST', 'site_reporters', {
    site_id: row!.id,
    reporter_id: f.reporter.id,
    is_primary: true,
  });
  return { id: row!.id, name: site.name, projectCode: site.projectCode };
}

/** A GoTrue admin call as the service role. */
async function authAdmin<T = unknown>(
  method: 'POST' | 'DELETE',
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(`${API_URL}/auth/v1/admin/${path}`, {
    method,
    headers: {
      apikey: SERVICE_ROLE_KEY,
      authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      'content-type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`auth ${method} ${path}: HTTP ${res.status} ${text}`);
  return (text ? JSON.parse(text) : null) as T;
}

/**
 * An admin of the fixture's demo org, signed in (W2-17, F15): a fresh auth user, its
 * `org_members` row, and a session minted as `supabase/db-tests/stack/api-invite-reporter.test.ts`
 * does (a magic link's token hash verified). The Demo phone's replies (`sms-webhook/demo-reply`)
 * take its access token. The user goes with the fixture (`dropFieldFixture`).
 */
export async function officeSession(f: FieldFixture): Promise<string> {
  if (!ANON_KEY)
    throw new Error('ANON_KEY is not set: export the output of `supabase status -o env`');
  const email = `e2e-field-${Date.now()}@e2e-field.example`;
  const user = await authAdmin<{ id: string }>('POST', 'users', { email, email_confirm: true });
  (f.officeUserIds ??= []).push(user.id);
  await rest('POST', 'org_members', { org_id: f.orgId, user_id: user.id, role: 'admin' });
  const link = await authAdmin<{ hashed_token?: string }>('POST', 'generate_link', {
    type: 'magiclink',
    email,
  });
  if (!link.hashed_token) throw new Error('generate_link gave no hashed_token');
  const res = await fetch(`${API_URL}/auth/v1/verify`, {
    method: 'POST',
    headers: { apikey: ANON_KEY, 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'magiclink', token_hash: link.hashed_token }),
  });
  const session = (await res.json()) as { access_token?: string };
  if (!res.ok || !session.access_token) throw new Error(`verify: HTTP ${res.status}`);
  return session.access_token;
}

/**
 * A text typed as the reporter in the panel's Demo phone (F15: STOP, START): sms-webhook's
 * `/demo-reply`, handled inline on the console driver, as an admin of the demo org.
 */
export async function demoReply(
  jwt: string,
  reporterId: string,
  body: string,
): Promise<{ keyword: string | null; replyId: string | null }> {
  const res = await fetch(`${API_URL}/functions/v1/sms-webhook/demo-reply`, {
    method: 'POST',
    headers: {
      apikey: ANON_KEY,
      authorization: `Bearer ${jwt}`,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify({ reporterId, body }),
  });
  const text = await res.text();
  if (res.status !== 201) throw new Error(`demo-reply ${body}: HTTP ${res.status} ${text}`);
  return JSON.parse(text) as { keyword: string | null; replyId: string | null };
}
