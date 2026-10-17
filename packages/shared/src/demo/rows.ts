/**
 * Row helpers the demo org builders share (kestrel.ts, demir.ts): SMS rows, consents, field links,
 * the denormalised rows of a report version, the office users' memberships' audit rows and the
 * audit ids.
 */
import type {
  AuditLogRow,
  ConsentRow,
  FieldLinkRow,
  ManpowerEntryRow,
  MessageRow,
  OrgMemberRow,
  ReporterRow,
  WeatherEventRow,
  WorkItemRow,
} from '../db/types.ts';
import { V12_ROW_DEFAULTS } from '../db/defaults.ts';
import type { ConsentType, LinkKind } from '../enums.ts';
import {
  DAILY_LINK_TTL_HOURS_DEFAULT,
  fieldLinkUrl,
  linkCodeHash,
  photosLinkExpiresAt,
} from '../links.ts';
import type { SmsKey } from '../copy/sms.ts';
import type { StoredReportData } from '../schemas/report.ts';
import { demoId, demoLinkCode } from './ids.ts';

/** FIELD_APP_URL of the links in seeded texts (§5.1 example; `--link-base` overrides it). */
export const DEMO_LINK_BASE = 'https://go.sitelog.app';

/**
 * Seeded audit rows get ids from here up (org n: base + n × 1,000,000 + its row number), far above
 * any `audit_log_id_seq` value, so an apply writes the same ids every time and never takes an id
 * the sequence hands out. A collision would fail the insert (and the whole apply), never overwrite.
 */
export const DEMO_AUDIT_ID_BASE = 9_000_000_000_000;

/** Sorts audit rows by time (stable) and numbers them for org `orgIndex` (1 Kestrel, 2 Demir). */
export function numberAudit(audit: AuditLogRow[], orgIndex: number): AuditLogRow[] {
  const sorted = audit
    .map((a, i) => ({ a, i }))
    .sort((x, y) =>
      x.a.created_at < y.a.created_at ? -1 : x.a.created_at > y.a.created_at ? 1 : x.i - y.i,
    )
    .map(({ a }) => a);
  sorted.forEach((a, i) => (a.id = DEMO_AUDIT_ID_BASE + orgIndex * 1_000_000 + i + 1));
  return sorted;
}

/**
 * The `member.added` audit row of each office user's membership, at the member's `created_at`. The
 * seed writes members as the service, which the `org_members_audit` trigger does not log (its WHEN
 * clause runs as the caller), so the seed logs them itself, with the trigger's action, entity and
 * diff (`20261014000001_queue_rls_fixes.sql`) and a `system` actor. Ids come from `numberAudit`.
 */
export function memberAudit(members: readonly OrgMemberRow[]): AuditLogRow[] {
  return members.map((m) => ({
    id: 0,
    org_id: m.org_id,
    actor_type: 'system',
    actor_id: null,
    action: 'member.added',
    entity: 'org_member',
    entity_id: m.user_id,
    diff: { role: m.role },
    created_at: m.created_at,
  }));
}

/** A demo field link: the code (for the SMS text) and its row (hash only, as field-api stores it). */
export interface DemoLink {
  code: string;
  url: string;
  row: FieldLinkRow;
}

export function demoLink(input: {
  key: string;
  reporterId: string;
  kind: LinkKind;
  siteId: string | null;
  reportDate: string | null;
  createdAt: string;
  linkBase: string;
  /** The site's time zone: a photos link ends at 23:59 the next day there (F9). */
  siteTz?: string;
}): DemoLink {
  const code = demoLinkCode(input.key);
  let expires: string | null = null;
  if (input.kind === 'daily')
    expires = new Date(
      Date.parse(input.createdAt) + DAILY_LINK_TTL_HOURS_DEFAULT * 3_600_000,
    ).toISOString();
  else if (input.kind === 'photos') {
    if (!input.reportDate || !input.siteTz)
      throw new Error('demoLink: a photos link needs its report date and site time zone');
    expires = photosLinkExpiresAt(input.reportDate, input.siteTz);
  }
  return {
    code,
    url: fieldLinkUrl(input.linkBase, code),
    row: {
      id: demoId(`link:${input.key}`),
      code_hash: linkCodeHash(code),
      reporter_id: input.reporterId,
      site_id: input.siteId,
      kind: input.kind,
      report_date: input.reportDate,
      expires_at: expires,
      revoked_at: null,
      last_opened_at: null,
      created_at: input.createdAt,
    },
  };
}

/** An outbound SMS as the console driver logs it (demo orgs always use `console`, §4.5). */
export function demoSms(input: {
  key: string;
  orgId: string;
  reporter: Pick<ReporterRow, 'id' | 'phone_e164'>;
  copyKey: SmsKey;
  body: string;
  at: string;
}): MessageRow {
  const id = demoId(`sms:${input.key}`);
  return {
    ...V12_ROW_DEFAULTS.messages,
    id,
    conversation_id: null,
    org_id: input.orgId,
    direction: 'out',
    wa_message_id: null,
    type: null,
    body: input.body,
    payload: null,
    media_id: null,
    media_mime: null,
    storage_path: null,
    duration_s: null,
    template_name: null,
    status: 'sent',
    error: null,
    created_at: input.at,
    reporter_id: input.reporter.id,
    phone_e164: input.reporter.phone_e164,
    provider: 'console',
    provider_message_id: `console:${id}`,
    copy_key: input.copyKey,
    channel: 'sms',
  };
}

/**
 * The consents a reporter gives on first open (F4, `web_checkbox`): the required recording and
 * processing consent, texts, and automated calls for a reporter who prefers calls.
 */
export function demoConsents(input: {
  reporter: Pick<ReporterRow, 'id' | 'contact_pref'>;
  givenAt: string;
  textVersion: string;
}): ConsentRow[] {
  const types: ConsentType[] = ['data_processing', 'recording', 'sms'];
  if (input.reporter.contact_pref === 'call') types.push('auto_call');
  return types.map((type) => ({
    id: demoId(`consent:${input.reporter.id}:${type}`),
    reporter_id: input.reporter.id,
    type,
    method: 'web_checkbox',
    text_version: input.textVersion,
    evidence: { user_agent: 'SiteLog demo seed' },
    given_at: input.givenAt,
    revoked_at: null,
  }));
}

/**
 * The rows denormalize_report_version() (20261014000002) writes for a version: manpower entries,
 * work items and weather events, from v1 or v2 data (the shapes it reads are the same; a weather
 * period's voice note is a v1 `audio` or a v2 `voice_note` source, never a call).
 */
export function versionRows(input: {
  reportId: string;
  siteId: string;
  version: number;
  date: string;
  data: StoredReportData;
}): { manpower: ManpowerEntryRow[]; workItems: WorkItemRow[]; weatherEvents: WeatherEventRow[] } {
  const { reportId, siteId, version, date, data } = input;
  const manpower = data.manpower.map((m, i): ManpowerEntryRow => ({
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
    source: (m.source[0] ?? null) as ManpowerEntryRow['source'],
    confidence: m.confidence,
  }));
  const workItems = data.workPerformed.map((w, i): WorkItemRow => ({
    id: demoId(`wi:${reportId}:${version}:${i}`),
    report_id: reportId,
    version,
    area: w.area,
    activity: w.activity,
    status: w.status,
    percent: w.percentComplete ?? null,
    quantity: w.quantity ? `${w.quantity.value} ${w.quantity.unit}` : null,
    source: (w.source[0] ?? null) as WorkItemRow['source'],
  }));
  const weatherEvents = data.weather.periods.map((p, i): WeatherEventRow => {
    const sources: ReadonlyArray<{ type: string }> = p.source;
    // A voice note, else a call second (20261016000280: P9's *Call ts* chip).
    const audio =
      sources.find((x) => x.type === 'audio' || x.type === 'voice_note') ??
      sources.find((x) => x.type === 'call') ??
      null;
    return {
      id: demoId(`wx:${reportId}:${version}:${i}`),
      report_id: reportId,
      version,
      site_id: siteId,
      date,
      start_local: p.start ?? null,
      end_local: p.end ?? null,
      condition: p.condition,
      impact: p.impact ?? null,
      lost_hours: p.lostHours,
      full_day: !!p.fullDay,
      audio_source: audio as WeatherEventRow['audio_source'],
      photo_count: data.photos.length,
      observed: (data.weather.observed ?? null) as WeatherEventRow['observed'],
      claim_ready: !!audio && data.photos.length > 0 && !!data.weather.observed,
    };
  });
  return { manpower, workItems, weatherEvents };
}
