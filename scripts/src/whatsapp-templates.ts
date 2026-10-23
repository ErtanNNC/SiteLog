/**
 * Creates TalkOlog's WhatsApp templates in Twilio's Content API, submits them for WhatsApp
 * approval, and later writes the approved content sids into the country packs (W2-15, spec §19
 * Q39, Q372, Q373), so the owner no longer types them into the Content Template Builder:
 *
 *   pnpm whatsapp:templates -- --submit --code TR,US --lang tr,en   → create and submit the missing
 *   pnpm whatsapp:templates -- --submit --code TR,US --dry-run      → print the plan, call nothing
 *   pnpm whatsapp:templates -- --sync --code TR,US                  → approved sids into the packs
 *
 * Names (claude/whatsapp-templates.md): `talkolog_<key>_<lang>`, the welcome
 * `talkolog_welcome_v2_<lang>` (§19 Q373). Bodies come from `whatsappTemplate` for the pack's
 * variant, read from the database (its voice number decides the "or call {number}" clauses), as
 * `pnpm countries:set -- --print-whatsapp-templates` prints them. Every key is a Utility template
 * (`twilio/text`) but `verify_code`, an Authentication one (`whatsapp/authentication`: security
 * recommendation on, code expiry 10 minutes, a copy-code button in the template's language).
 *
 * `--submit` lists the account's content once and skips every template whose name already exists
 * (it reports that template's approval status; one created but never submitted is submitted), so a
 * re-run creates nothing twice. `--sync` sets, per pack, language and key, the sid of the template
 * with the current name only when WhatsApp approved it in the expected category (Utility, or
 * Authentication for `verify_code`) and its body is the pack's current one; a template Meta
 * recategorised (Marketing) is listed and never set. Existing entries are kept; the write goes
 * through the audited `set_country_endpoints()` exactly as `pnpm countries:set` writes
 * (`applyCountriesSet`, audit action `country.endpoints_set`), one transaction for all packs.
 *
 * Twilio credentials come from TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN (the token is never
 * printed); the database from SUPABASE_DB_URL with the same refusals as `countries:set` (a hosted
 * database needs `--yes`, the staging project also `--allow-staging`). No phone number is printed.
 */
import type { WhatsappKey } from '@sitelog/shared/channels.ts';
import {
  WHATSAPP_CONTENT_SID_RE,
  WhatsappTemplatesSchema,
  type WhatsappTemplates,
} from '@sitelog/shared/countries.ts';
import { assertE164 } from '@sitelog/shared/format.ts';
import { LANGUAGES, type Language } from '@sitelog/shared/locale.ts';
import {
  VERIFY_CODE_EXPIRY_MINUTES,
  whatsappTemplatesFor,
  type WhatsappTemplate,
} from '@sitelog/shared/whatsapp/templates.ts';
import {
  applyCountriesSet,
  connectPostgres,
  refuseCountriesTarget,
  type CountriesSetConnection,
  type PackEndpoints,
  type Query,
} from './countries-set.ts';
import { describeTarget } from './seed-target.ts';

// ---------------------------------------------------------------------------------------------
// Arguments

export interface WhatsappTemplatesArgs {
  mode: 'submit' | 'sync';
  codes: string[];
  /** Only these template languages (default: every field language of each pack). */
  languages: Language[] | null;
  dryRun: boolean;
  yes: boolean;
  allowStaging: boolean;
}

function list(flag: string, raw: string): string[] {
  const items = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (items.length === 0) throw new Error(`${flag} needs at least one value`);
  return [...new Set(items)];
}

export function parseWhatsappTemplatesArgs(argv: readonly string[]): WhatsappTemplatesArgs {
  const rest = argv.filter((a) => a !== '--');
  let mode: WhatsappTemplatesArgs['mode'] | undefined;
  let codes: string[] | undefined;
  let languages: Language[] | null = null;
  let dryRun = false;
  let yes = false;
  let allowStaging = false;
  const setMode = (m: WhatsappTemplatesArgs['mode']) => {
    if (mode !== undefined && mode !== m) throw new Error('pass one of --submit or --sync');
    mode = m;
  };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    const value = (name: string) => {
      const eq = a.indexOf('=');
      if (eq > 0) return a.slice(eq + 1);
      const next = rest[i + 1];
      if (next === undefined || next.startsWith('--')) throw new Error(`${name} needs a value`);
      i += 1;
      return next;
    };
    if (a === '--submit') setMode('submit');
    else if (a === '--sync') setMode('sync');
    else if (a === '--code' || a.startsWith('--code=')) {
      codes = list('--code', value('--code')).map((c) => c.toUpperCase());
      for (const c of codes)
        if (!/^[A-Z]{2}$/.test(c))
          throw new Error(`--code takes country codes like TR,US (got "${c}")`);
    } else if (a === '--lang' || a.startsWith('--lang=')) {
      const langs = list('--lang', value('--lang')).map((l) => l.toLowerCase());
      for (const l of langs)
        if (!(LANGUAGES as readonly string[]).includes(l))
          throw new Error(`--lang takes ${LANGUAGES.join(', ')} (got "${l}")`);
      languages = langs as Language[];
    } else if (a === '--dry-run') dryRun = true;
    else if (a === '--yes') yes = true;
    else if (a === '--allow-staging') allowStaging = true;
    else throw new Error(`unknown argument ${a}`);
  }
  if (mode === undefined) throw new Error('pass --submit (create and submit) or --sync (set ids)');
  if (codes === undefined) throw new Error('--code is required (the packs, e.g. --code TR,US)');
  if (dryRun && mode !== 'submit')
    throw new Error('--dry-run goes with --submit (--sync reads Twilio and writes the packs)');
  return { mode, codes, languages, dryRun, yes, allowStaging };
}

// ---------------------------------------------------------------------------------------------
// Names, categories and samples

/** A key whose template was resubmitted under a new name (§19 Q373: the welcome, v2). */
const NAME_VERSION: Partial<Record<WhatsappKey, string>> = { welcome: 'v2' };

/** The template's name in Twilio and at Meta (claude/whatsapp-templates.md). */
export function templateName(key: WhatsappKey, language: Language): string {
  const version = NAME_VERSION[key];
  return `talkolog_${key}${version ? `_${version}` : ''}_${language}`;
}

/** WhatsApp's approval category of a template, as Twilio takes and reports it. */
export function approvalCategory(t: Pick<WhatsappTemplate, 'category'>): string {
  return t.category === 'authentication' ? 'AUTHENTICATION' : 'UTILITY';
}

/** The copy-code button of the authentication template, per language. */
export const COPY_CODE_TEXT: Readonly<Record<Language, string>> = {
  en: 'Copy code',
  es: 'Copiar código',
  tr: 'Kodu kopyala',
};

/**
 * Meta's sample value for each variable, per language (claude/whatsapp-templates.md
 * "Değişkenler"). The phone number is a fictional one (555-01xx, 0212 555 01xx).
 */
export const SAMPLES: Readonly<Record<Language, Readonly<Record<string, string>>>> = {
  en: {
    first: 'Marco',
    company: 'Kestrel Build Group',
    site: 'Riverside Lofts',
    deadline: '5:30 PM',
    link: 'https://go.talkolog.com/r/K7Q2MX4P9ZTA',
    time: '4:30 PM',
    weather_phrase: 'Rain is forecast from 2:00 PM.',
    report_no: 'RL-2041-0187',
    pdf_link: 'https://go.talkolog.com/r/K7Q2MX4P9ZTA/report/1',
    weekday: 'Fri',
    change: 'Apex 7 workers, not 6',
    v: '2',
    code: '482913',
    number: '(555) 014-2290',
  },
  es: {
    first: 'Marco',
    company: 'Kestrel Build Group',
    site: 'Riverside Lofts',
    deadline: '5:30 PM',
    link: 'https://go.talkolog.com/r/K7Q2MX4P9ZTA',
    time: '4:30 PM',
    weather_phrase: 'Se pronostica lluvia desde las 2:00 PM.',
    report_no: 'RL-2041-0187',
    pdf_link: 'https://go.talkolog.com/r/K7Q2MX4P9ZTA/report/1',
    weekday: 'vie',
    change: 'Apex 7 trabajadores, no 6',
    v: '2',
    code: '482913',
    number: '(555) 014-2290',
  },
  tr: {
    first: 'Mehmet',
    company: 'Demir Yapı',
    site: 'İnallar Hayat 2',
    deadline: '17:30',
    link: 'https://go.talkolog.com/r/K7Q2MX4P9ZTA',
    time: '16:30',
    weather_phrase: "Saat 14:00'ten itibaren yağmur bekleniyor.",
    report_no: 'IH-2041-0187',
    pdf_link: 'https://go.talkolog.com/r/K7Q2MX4P9ZTA/report/1',
    weekday: 'Cuma',
    change: 'Apex 7 işçi, 6 değil',
    v: '2',
    code: '482913',
    number: '0212 555 01 42',
  },
};

/** The `variables` of a content create: `{"1": sample, …}`. Throws on a variable with no sample. */
export function sampleVariables(
  t: Pick<WhatsappTemplate, 'variables'>,
  language: Language,
): Record<string, string> {
  const out: Record<string, string> = {};
  t.variables.forEach((name, i) => {
    const sample = SAMPLES[language][name];
    if (sample === undefined) throw new Error(`no ${language} sample for {${name}}`);
    out[String(i + 1)] = sample;
  });
  return out;
}

// ---------------------------------------------------------------------------------------------
// The plan

export interface PlannedTemplate {
  name: string;
  key: WhatsappKey;
  language: Language;
  /** The packs that use this template. */
  codes: string[];
  template: WhatsappTemplate;
}

/** The pack's variant as `whatsappTemplatesFor` takes it. */
function packTemplates(row: PackEndpoints) {
  return whatsappTemplatesFor({
    voiceNumber: row.voice_number === null ? null : assertE164(row.voice_number),
    fieldLocales: row.field_locales,
  });
}

/**
 * Every template the packs need in the chosen languages, one per name. Two packs that need the
 * same name with different bodies (one has a voice number, the other not) are a conflict: the
 * name can carry one body only, so the plan refuses rather than submit the wrong one.
 */
export function buildPlan(
  packs: readonly PackEndpoints[],
  languages: readonly Language[] | null,
): PlannedTemplate[] {
  const byName = new Map<string, PlannedTemplate>();
  for (const pack of packs) {
    for (const t of packTemplates(pack)) {
      if (languages && !languages.includes(t.language)) continue;
      const name = templateName(t.key, t.language);
      const { key, language, ...template } = t;
      const known = byName.get(name);
      if (!known) {
        byName.set(name, { name, key, language, codes: [pack.code], template });
        continue;
      }
      if (known.template.body !== template.body)
        throw new Error(
          `${name}: packs ${known.codes.join(', ')} and ${pack.code} need different bodies (one has a voice number, the other not); a name carries one body, so submit one pack at a time and rename one of them first`,
        );
      known.codes.push(pack.code);
    }
  }
  return [...byName.values()];
}

/** Twilio's create-content request for a planned template. */
export function contentCreateBody(p: PlannedTemplate): Record<string, unknown> {
  const types =
    p.template.contentType === 'whatsapp/authentication'
      ? {
          'whatsapp/authentication': {
            add_security_recommendation: true,
            code_expiration_minutes: VERIFY_CODE_EXPIRY_MINUTES,
            actions: [{ type: 'COPY_CODE', copy_code_text: COPY_CODE_TEXT[p.language] }],
          },
        }
      : { 'twilio/text': { body: p.template.body } };
  return {
    friendly_name: p.name,
    language: p.language,
    variables: sampleVariables(p.template, p.language),
    types,
  };
}

/**
 * The WhatsApp approval request. `allow_category_change: false`: Meta rejects a template it would
 * move to another category instead of moving it (a Marketing welcome is what §19 Q373 avoided).
 */
export function approvalBody(p: PlannedTemplate): Record<string, unknown> {
  return { name: p.name, category: approvalCategory(p.template), allow_category_change: false };
}

// ---------------------------------------------------------------------------------------------
// Twilio's Content API

export const CONTENT_API_BASE = 'https://content.twilio.com';

export interface Approval {
  status: string;
  category: string | null;
  rejectionReason: string | null;
  name: string | null;
}

export interface ContentRecord {
  sid: string;
  friendlyName: string;
  language: string | null;
  /** The `twilio/text` body, when the listing carries it. */
  body: string | null;
  /** The WhatsApp approval, or null when none was requested. */
  approval: Approval | null;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
const obj = (v: unknown): Record<string, unknown> | null =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

/**
 * A WhatsApp approval object, wherever the response puts it: `{whatsapp: {…}}` (the per-content
 * ApprovalRequests fetch) or the object itself (ContentAndApprovals' `approval_requests`).
 */
export function parseApproval(raw: unknown): Approval | null {
  const outer = obj(raw);
  if (!outer) return null;
  const a = obj(outer.whatsapp) ?? outer;
  const status = str(a.status);
  if (!status) return null;
  return {
    status: status.toLowerCase(),
    category: str(a.category)?.toUpperCase() ?? null,
    rejectionReason: str(a.rejection_reason),
    name: str(a.name),
  };
}

/** One page of GET /v1/ContentAndApprovals. */
export function parseContentPage(json: unknown): { items: ContentRecord[]; next: string | null } {
  const page = obj(json);
  if (!page || !Array.isArray(page.contents))
    throw new Error('Twilio ContentAndApprovals: the response has no contents list');
  const items: ContentRecord[] = [];
  for (const raw of page.contents) {
    const c = obj(raw);
    const sid = str(c?.sid);
    const friendlyName = str(c?.friendly_name);
    if (!c || !sid || !friendlyName) continue;
    const types = obj(c.types);
    items.push({
      sid,
      friendlyName,
      language: str(c.language),
      body: str(obj(types?.['twilio/text'])?.body),
      approval: parseApproval(c.approval_requests),
    });
  }
  return { items, next: str(obj(page.meta)?.next_page_url) };
}

export type Fetch = (url: string, init: RequestInit) => Promise<Response>;

export interface TwilioContent {
  listContent(): Promise<ContentRecord[]>;
  createContent(body: Record<string, unknown>): Promise<string>;
  submitApproval(sid: string, body: Record<string, unknown>): Promise<Approval | null>;
}

/** Twilio's error, without anything of the request (its Authorization header stays out). */
async function twilioError(what: string, res: Response): Promise<Error> {
  let detail = '';
  try {
    const body = obj(await res.json());
    const parts = [body?.code, body?.message].filter((v) => v !== undefined && v !== null);
    detail = parts.length ? `: ${parts.join(' ')}` : '';
  } catch {
    // Not JSON: the status says enough.
  }
  return new Error(`Twilio ${what} failed (HTTP ${res.status})${detail}`);
}

export function twilioContentClient(input: {
  accountSid: string;
  authToken: string;
  fetch: Fetch;
  base?: string;
}): TwilioContent {
  const base = input.base ?? CONTENT_API_BASE;
  const origin = new URL(base).origin;
  const auth = `Basic ${Buffer.from(`${input.accountSid}:${input.authToken}`).toString('base64')}`;
  const call = async (what: string, url: string, body?: unknown) => {
    // The credentials go to the Content API's own origin only (a next-page URL is followed only
    // when it stays there).
    const target = new URL(url, base);
    if (target.origin !== origin) throw new Error(`Twilio ${what}: refusing a URL off ${origin}`);
    const res = await input.fetch(target.toString(), {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        Authorization: auth,
        Accept: 'application/json',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!res.ok) throw await twilioError(what, res);
    return (await res.json()) as unknown;
  };
  return {
    async listContent() {
      const out: ContentRecord[] = [];
      let url: string | null = '/v1/ContentAndApprovals?PageSize=500';
      for (let pages = 0; url; pages++) {
        if (pages >= 50) throw new Error('Twilio ContentAndApprovals: more than 50 pages');
        const page = parseContentPage(await call('ContentAndApprovals', url));
        out.push(...page.items);
        url = page.next;
      }
      return out;
    },
    async createContent(body) {
      const sid = str(obj(await call('create content', '/v1/Content', body))?.sid);
      if (!sid || !WHATSAPP_CONTENT_SID_RE.test(sid))
        throw new Error('Twilio create content: no HX… sid in the response');
      return sid;
    },
    async submitApproval(sid, body) {
      const res = await call(
        'approval request',
        `/v1/Content/${encodeURIComponent(sid)}/ApprovalRequests/whatsapp`,
        body,
      );
      return parseApproval(res);
    },
  };
}

// ---------------------------------------------------------------------------------------------
// --submit

export type SubmitAction = 'exists' | 'submitted' | 'created' | 'would create' | 'failed';

export interface SubmitRow {
  name: string;
  key: WhatsappKey;
  language: Language;
  codes: string[];
  category: string;
  action: SubmitAction;
  sid: string | null;
  status: string | null;
  rejectionReason: string | null;
  error?: string;
  /** The existing template's body is not the pack's current one (a new name is needed). */
  bodyDiffers?: true;
}

/** The record to report for a name: an approved one first, then any with an approval, then any. */
export function pickRecord(records: readonly ContentRecord[], name: string): ContentRecord | null {
  const same = records.filter((r) => r.friendlyName === name);
  return (
    same.find((r) => r.approval?.status === 'approved') ??
    same.find((r) => r.approval !== null) ??
    same[0] ??
    null
  );
}

/**
 * Creates and submits every planned template whose name Twilio does not have yet; a template
 * created but never submitted (a run cut short) is submitted. One failure does not stop the rest.
 */
export async function submitTemplates(
  plan: readonly PlannedTemplate[],
  twilio: TwilioContent | null,
): Promise<SubmitRow[]> {
  const existing = twilio ? await twilio.listContent() : [];
  const rows: SubmitRow[] = [];
  for (const p of plan) {
    const row: SubmitRow = {
      name: p.name,
      key: p.key,
      language: p.language,
      codes: p.codes,
      category: approvalCategory(p.template),
      action: 'would create',
      sid: null,
      status: null,
      rejectionReason: null,
    };
    rows.push(row);
    const found = pickRecord(existing, p.name);
    if (found) {
      row.sid = found.sid;
      row.status = found.approval?.status ?? null;
      row.rejectionReason = found.approval?.rejectionReason ?? null;
      row.action = 'exists';
      if (
        p.template.contentType === 'twilio/text' &&
        found.body !== null &&
        found.body !== p.template.body
      )
        row.bodyDiffers = true;
    }
    if (!twilio) continue;
    try {
      if (!found) {
        row.sid = await twilio.createContent(contentCreateBody(p));
        row.action = 'created';
      }
      if (!found?.approval) {
        const approval = await twilio.submitApproval(row.sid!, approvalBody(p));
        row.status = approval?.status ?? 'received';
        row.action = found ? 'submitted' : 'created';
      }
    } catch (err) {
      row.action = 'failed';
      row.error = err instanceof Error ? err.message : String(err);
    }
  }
  return rows;
}

// ---------------------------------------------------------------------------------------------
// --sync

export type SyncOutcome =
  'set' | 'already set' | 'not approved' | 'wrong category' | 'body differs' | 'missing';

export interface SyncRow {
  code: string;
  key: WhatsappKey;
  language: Language;
  name: string;
  status: string | null;
  category: string | null;
  rejectionReason: string | null;
  sid: string | null;
  outcome: SyncOutcome;
}

/**
 * For each of the pack's templates (its variant, the chosen languages): whether the Twilio
 * template of the current name is approved in the expected category with the pack's body, and the
 * pack's `whatsapp_templates` with those sids merged in (every other entry kept).
 */
export function syncPack(
  pack: PackEndpoints,
  records: readonly ContentRecord[],
  languages: readonly Language[] | null,
): { rows: SyncRow[]; templates: WhatsappTemplates | null } {
  const merged: WhatsappTemplates = structuredClone(pack.whatsapp_templates ?? {});
  const rows: SyncRow[] = [];
  for (const t of packTemplates(pack)) {
    if (languages && !languages.includes(t.language)) continue;
    const name = templateName(t.key, t.language);
    const found = pickRecord(records, name);
    const row: SyncRow = {
      code: pack.code,
      key: t.key,
      language: t.language,
      name,
      status: found?.approval?.status ?? (found ? 'not submitted' : null),
      category: found?.approval?.category ?? null,
      rejectionReason: found?.approval?.rejectionReason ?? null,
      sid: found?.sid ?? null,
      outcome: 'missing',
    };
    rows.push(row);
    if (!found) continue;
    if (found.approval?.status !== 'approved') row.outcome = 'not approved';
    else if (found.approval.category !== approvalCategory(t)) row.outcome = 'wrong category';
    else if (t.contentType === 'twilio/text' && found.body !== null && found.body !== t.body)
      row.outcome = 'body differs';
    else if (!WHATSAPP_CONTENT_SID_RE.test(found.sid)) row.outcome = 'missing';
    else if (merged[t.key]?.[t.language] === found.sid) row.outcome = 'already set';
    else {
      merged[t.key] = { ...merged[t.key], [t.language]: found.sid };
      row.outcome = 'set';
    }
  }
  const parsed = WhatsappTemplatesSchema.parse(merged);
  return { rows, templates: Object.keys(parsed).length === 0 ? null : parsed };
}

// ---------------------------------------------------------------------------------------------
// Output

const cell = (v: string | null | undefined) => (v ? v.replaceAll('|', '\\|') : '-');

export function submitTable(rows: readonly SubmitRow[]): string[] {
  return [
    '| Template | Key | Lang | Packs | Category | Action | Status | Rejection reason | Sid |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...rows.map(
      (r) =>
        `| ${r.name} | ${r.key} | ${r.language} | ${r.codes.join(', ')} | ${r.category} | ${r.action}${r.bodyDiffers ? ' (body differs from the pack’s: rename to resubmit)' : ''}${r.error ? `: ${cell(r.error)}` : ''} | ${cell(r.status)} | ${cell(r.rejectionReason)} | ${cell(r.sid)} |`,
    ),
  ];
}

export function syncTable(rows: readonly SyncRow[]): string[] {
  return [
    '| Pack | Key | Lang | Status | Category | Rejection reason | Sid | In the pack |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
    ...rows.map(
      (r) =>
        `| ${r.code} | ${r.key} | ${r.language} | ${cell(r.status)} | ${cell(r.category)} | ${cell(r.rejectionReason)} | ${cell(r.sid)} | ${r.outcome === 'set' ? 'set now' : r.outcome === 'already set' ? 'set' : `not set (${r.outcome})`} |`,
    ),
  ];
}

/** The dry run's view of each template: what would be created, with its body and samples. */
export function describePlan(plan: readonly PlannedTemplate[]): string[] {
  return plan.map((p) => {
    const samples = Object.entries(sampleVariables(p.template, p.language))
      .map(([n, v]) => `{{${n}}}=${p.template.variables[Number(n) - 1]} "${v}"`)
      .join(', ');
    const what =
      p.template.contentType === 'whatsapp/authentication'
        ? `whatsapp/authentication (security recommendation, ${VERIFY_CODE_EXPIRY_MINUTES} min, button "${COPY_CODE_TEXT[p.language]}")`
        : `twilio/text: ${p.template.body}`;
    return `${p.name} [${approvalCategory(p.template)}; ${p.codes.join(', ')}] ${what} · samples ${samples}`;
  });
}

// ---------------------------------------------------------------------------------------------
// The run

export const SELECT_PACKS_SQL =
  'select code, sms_provider, sms_sender_type, sms_sender_id, voice_number, field_locales, whatsapp_provider, whatsapp_sender_id, whatsapp_templates, outbound_trunk_id from countries where code = $1';

async function readPack(query: Query, code: string, lock: boolean): Promise<PackEndpoints> {
  const [row] = (await query(SELECT_PACKS_SQL + (lock ? ' for update' : ''), [
    code,
  ])) as PackEndpoints[];
  if (!row) throw new Error(`no country pack ${code} in this database`);
  return row;
}

export interface WhatsappTemplatesDeps {
  env: Readonly<Record<string, string | undefined>>;
  connect: (dbUrl: string) => Promise<CountriesSetConnection>;
  fetch: Fetch;
  log: (line: string) => void;
}

export type WhatsappTemplatesResult =
  { mode: 'submit'; rows: SubmitRow[] } | { mode: 'sync'; rows: SyncRow[]; changed: string[] };

export async function runWhatsappTemplates(
  argv: readonly string[],
  deps: WhatsappTemplatesDeps,
): Promise<WhatsappTemplatesResult> {
  const args = parseWhatsappTemplatesArgs(argv);
  const accountSid = deps.env.TWILIO_ACCOUNT_SID?.trim() ?? '';
  const authToken = deps.env.TWILIO_AUTH_TOKEN?.trim() ?? '';
  let twilio: TwilioContent | null = null;
  if (!args.dryRun) {
    if (!accountSid || !authToken)
      throw new Error('TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN are needed (a dry run needs none)');
    if (!/^AC[0-9a-fA-F]{32}$/.test(accountSid))
      throw new Error('TWILIO_ACCOUNT_SID is not an AC… account sid');
    twilio = twilioContentClient({ accountSid, authToken, fetch: deps.fetch });
  }
  const dbUrl = deps.env.SUPABASE_DB_URL?.trim() ?? '';
  const refusal = refuseCountriesTarget({
    dbUrl,
    supabaseUrl: deps.env.SUPABASE_URL,
    yes: args.yes,
    allowStaging: args.allowStaging,
  });
  if (refusal) throw new Error(refusal);
  deps.log(
    `whatsapp:templates ${args.mode}${args.dryRun ? ' (dry run)' : ''} → ${describeTarget(dbUrl)}`,
  );

  deps.log('');

  if (args.mode === 'submit') {
    const db = await deps.connect(dbUrl);
    let packs: PackEndpoints[];
    try {
      packs = await db.transaction(async (query) => {
        const out: PackEndpoints[] = [];
        for (const code of args.codes) out.push(await readPack(query, code, false));
        return out;
      });
    } finally {
      await db.end();
    }
    const plan = buildPlan(packs, args.languages);
    if (args.dryRun) {
      deps.log(
        `Templates the packs ${args.codes.join(', ')} need (${plan.length}); nothing is called:`,
      );
      deps.log('');
      for (const line of describePlan(plan)) deps.log(`- ${line}`);
      deps.log('');
    }
    const rows = await submitTemplates(plan, twilio);
    for (const line of submitTable(rows)) deps.log(line);
    const failed = rows.filter((r) => r.action === 'failed');
    if (failed.length > 0)
      throw new Error(
        `${failed.length} template(s) failed: ${failed.map((r) => r.name).join(', ')}`,
      );
    return { mode: 'submit', rows };
  }

  // --sync: Twilio first, so the transaction holds the packs' locks only for the write.
  const records = await twilio!.listContent();
  const db = await deps.connect(dbUrl);
  let rows: SyncRow[];
  const changed: string[] = [];
  try {
    rows = await db.transaction(async (query) => {
      const out: SyncRow[] = [];
      for (const code of args.codes) {
        const pack = await readPack(query, code, true);
        const synced = syncPack(pack, records, args.languages);
        out.push(...synced.rows);
        const result = await applyCountriesSet(
          query,
          { code, yes: args.yes, allowStaging: args.allowStaging },
          synced.templates,
        );
        if (result.changed) changed.push(code);
      }
      return out;
    });
  } finally {
    await db.end();
  }
  for (const line of syncTable(rows)) deps.log(line);
  const marketing = rows.filter((r) => r.outcome === 'wrong category');
  if (marketing.length > 0) {
    deps.log('');
    deps.log(
      `Not set, approved in another category (Meta recategorised; resubmit under a new name): ${marketing.map((r) => `${r.name} (${r.category ?? '?'})`).join(', ')}`,
    );
  }
  deps.log('');
  deps.log(
    changed.length > 0
      ? `Written to ${changed.join(', ')} through set_country_endpoints() (audited as country.endpoints_set).`
      : 'Unchanged: nothing written.',
  );
  return { mode: 'sync', rows, changed };
}

const isMain = process.argv[1]?.endsWith('whatsapp-templates.ts');
if (isMain) {
  runWhatsappTemplates(process.argv.slice(2), {
    env: process.env,
    connect: connectPostgres,
    fetch: (url, init) => fetch(url, init),
    log: (line) => console.log(line),
  }).catch((err: unknown) => {
    console.error(`whatsapp:templates: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
