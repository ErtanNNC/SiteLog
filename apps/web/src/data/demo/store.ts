/**
 * In-memory demo store over the §18 Kestrel dataset. One clone per browser session; every
 * mutation updates rows in place (with audit + notifications) so the panel behaves like the
 * real thing until the page is reloaded.
 */
import { DEMO_NOW, DEMO_ORG_ID, DEMO_USERS, kestrelDemo } from '@sitelog/shared/demo/kestrel.ts';
import type { DemoDataset, DemoUser } from '@sitelog/shared/demo/types.ts';
import { demoId, demoRand } from '@sitelog/shared/demo/ids.ts';
import { V12_ROW_DEFAULTS } from '@sitelog/shared/db/defaults.ts';
import type {
  AuditLogRow,
  CompanyRow,
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
  SiteReporterRow,
  SiteRow,
  TranscriptRow,
  WeatherEventRow,
  WorkItemRow,
} from '@sitelog/shared/db/types.ts';
import {
  isActiveReporterStatus,
  type InvoiceStatus,
  type MemberRole,
  type ReporterStatus,
  type SiteDayStatus,
} from '@sitelog/shared/enums.ts';
import type { DailyReportDataV1, StoredReportData } from '@sitelog/shared/schemas/report.ts';
import { emptyReportDataV1 } from '@sitelog/shared/schemas/report.ts';
import {
  OFFICE_PHOTO_MAX,
  PHOTO_CAPTION_MAX,
  isOfficePhotoMime,
  placeOfficePhotos,
  type OfficePhotoMime,
  type OfficePhotoUpload,
} from '@sitelog/shared/report/photos.ts';
import {
  formatReportNo,
  logoStoragePath,
  pdfStoragePath,
} from '@sitelog/shared/report/numbering.ts';
import { deriveTotals } from '@sitelog/shared/report/hours.ts';
import { sourceMediaId } from '@sitelog/shared/report/media.ts';
import { reportLanguageFor } from '@sitelog/shared/locale.ts';
import { formatDateInTz } from '@sitelog/shared/format.ts';
import { deadlineInstant } from '@sitelog/shared/schedule/reminders.ts';
import { fromZonedTime } from 'date-fns-tz';
import { copy } from '@/copy/en';
import { CodedError, localId } from '@/lib/utils';
import type { RowSet } from '../assemble';
import { reporterDefaultsFor, reporterLocaleFor } from '@sitelog/shared/countries.ts';
import {
  demoDailyLink,
  demoOrgPack,
  demoPhoneData,
  demoPhoneThread,
  demoReply,
  demoWelcome,
} from './demoPhone';
import type {
  AddGlossaryTermInput,
  AddInvoiceInput,
  CreateSiteInput,
  InviteReporterInput,
  LinkUnknownSenderInput,
  RequestEvidencePackInput,
  ResolveUnknownCompanyInput,
  ReviewGlossaryTermInput,
  UpdateOrgInput,
  UpdateReporterInput,
  UpdateSitePatch,
} from '../source';
import type {
  ChangeEvent,
  DemoPhoneData,
  DemoPhoneEmail,
  DemoPhoneMessage,
  OrgSettingsPatch,
  OrglessContacts,
  TextDailyLinkErrorCode,
  TextDailyLinkResult,
} from '../types';

/** Extra demo office user so `?as=ops` has someone to be (not part of the §18 seed). */
export const DEMO_OPS_USER: DemoUser = {
  id: demoId('user:ravi'),
  email: 'ravi@kestrelbuild.example',
  name: 'Ravi Patel',
  title: 'Site coordinator',
  role: 'ops',
};

export const DEMO_LOGIN_KEYS = ['admin', 'pm', 'ops', 'accounts'] as const;
export type DemoLoginKey = (typeof DEMO_LOGIN_KEYS)[number];

export function demoUserFor(key: DemoLoginKey | string | null | undefined): DemoUser {
  switch (key) {
    case 'pm':
      return DEMO_USERS[1]!;
    case 'accounts':
      return DEMO_USERS[2]!;
    case 'ops':
      return DEMO_OPS_USER;
    default:
      return DEMO_USERS[0]!;
  }
}

/** An office upload that passed checkOfficePhotos(). */
interface CheckedPhoto {
  path: string;
  mime: OfficePhotoMime;
  caption: string | null;
  takenAt: string;
  position: number | null;
}

/** The key a version's data.photos entries use: `uploadId` in v2 data, `messageId` in v1. */
type PhotoKey = 'uploadId' | 'messageId';
/** A data.photos entry of either version. */
type PhotoEntry = Partial<{
  uploadId: unknown;
  messageId: unknown;
  caption: unknown;
  takenAt: unknown;
}>;
type KeyedPhoto = { caption?: string; takenAt: string } & Partial<Record<PhotoKey, string>>;

/** The media id of a data.photos entry (lower case), whichever key it has. */
function photoEntryId(p: PhotoEntry | null | undefined): string {
  const id = typeof p?.uploadId === 'string' ? p.uploadId : p?.messageId;
  return typeof id === 'string' ? id.toLowerCase() : '';
}

export class DemoStore {
  readonly data: DemoDataset;
  private listeners = new Set<(e: ChangeEvent) => void>();
  private timers: Array<ReturnType<typeof setTimeout>> = [];
  /** Demo logo: an object URL of the picked file, kept for this session only. */
  logoUrl: string | null = null;
  /** The demo `photos` bucket: paths of office uploads (DemoSource keeps their object URLs). */
  private readonly uploadedPhotos = new Set<string>();
  /** What the console email provider would have sent in this session (the Demo phone's Email tab). */
  readonly consoleEmails: DemoPhoneEmail[] = [];

  constructor(dataset: DemoDataset = kestrelDemo()) {
    this.data = structuredClone(dataset);
    if (!this.data.users.some((u) => u.id === DEMO_OPS_USER.id)) {
      this.data.users.push({ ...DEMO_OPS_USER });
      this.data.members.push({
        ...V12_ROW_DEFAULTS.org_members,
        org_id: this.data.org.id,
        user_id: DEMO_OPS_USER.id,
        role: DEMO_OPS_USER.role,
        display_name: DEMO_OPS_USER.name,
        title: DEMO_OPS_USER.title,
        created_at: this.data.org.created_at,
      });
    }
  }

  get now(): Date {
    return new Date(this.data.now);
  }

  nowIso(): string {
    return this.data.now;
  }

  rows(): RowSet {
    const d = this.data;
    const emailByUser = new Map(d.users.map((u) => [u.id, u.email]));
    return {
      org: d.org,
      settings: d.settings,
      members: d.members.map((m) => ({ ...m, email: emailByUser.get(m.user_id) ?? null })),
      sites: d.sites,
      reporters: d.reporters,
      siteReporters: d.siteReporters,
      recipients: d.recipients,
      companies: d.companies,
      glossary: d.glossary,
      messages: d.messages,
      transcripts: d.transcripts,
      calls: d.calls,
      unknownContacts: d.unknownContacts,
      siteDays: d.siteDays,
      reports: d.reports,
      versions: d.versions,
      uploads: d.uploads,
      sources: d.sources,
      manpower: d.manpower,
      weatherEvents: d.weatherEvents,
      questions: d.questions,
      invoices: d.invoices,
      packs: d.packs,
      notifications: d.notifications,
      audit: d.audit,
      billing: {
        monthlyCents: d.billing.monthlyCents,
        activeSites: d.sites.filter((s) => s.status === 'active').length,
        pricePerSiteCents: 39_900,
        nextInvoiceDate: d.billing.nextInvoiceDate,
        paymentMethod: d.billing.paymentMethod,
        status: d.org.billing_status,
        trialEndsAt: d.org.trial_ends_at,
        invoices: d.billing.invoices,
      },
    };
  }

  subscribe(fn: (e: ChangeEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  dispose(): void {
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
    this.listeners.clear();
  }

  private emit(e: ChangeEvent): void {
    for (const fn of this.listeners) fn(e);
  }

  private audit(row: Omit<AuditLogRow, 'id' | 'created_at'> & { created_at?: string }): void {
    const id = (this.data.audit.at(-1)?.id ?? 0) + 1;
    this.data.audit.push({ id, created_at: this.nowIso(), ...row });
  }

  private notify(n: Omit<NotificationRow, 'id' | 'org_id' | 'read_at' | 'created_at'>): void {
    this.data.notifications.unshift({
      id: localId('notif'),
      org_id: this.data.org.id,
      read_at: null,
      created_at: this.nowIso(),
      ...n,
    });
  }

  private report(reportId: string): ReportRow {
    const r = this.data.reports.find((x) => x.id === reportId);
    if (!r) throw new Error(copy.errors.notFound);
    return r;
  }

  private site(siteId: string): SiteRow {
    const s = this.data.sites.find((x) => x.id === siteId);
    if (!s) throw new Error(copy.errors.notFound);
    return s;
  }

  /**
   * Mirror of denormalize_report_version() in the migrations, for v1 and v2 data: the fields it
   * copies have one shape in both (the voice note of a weather period is a v1 `audio` or a v2
   * `voice_note` source; `observed` is copied as written). The report_sources sync of the SQL is
   * not mirrored: the demo's sources are written with the media.
   */
  private denormalize(report: ReportRow, version: number, stored: StoredReportData): void {
    const data = stored as DailyReportDataV1;
    const d = this.data;
    d.manpower = d.manpower.filter((m) => !(m.report_id === report.id && m.version === version));
    d.workItems = d.workItems.filter((w) => !(w.report_id === report.id && w.version === version));
    d.weatherEvents = d.weatherEvents.filter(
      (w) => !(w.report_id === report.id && w.version === version),
    );
    data.manpower.forEach((m, i) => {
      const row: ManpowerEntryRow = {
        id: demoId(`mp:${report.id}:${version}:${i}`),
        report_id: report.id,
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
      };
      d.manpower.push(row);
    });
    data.workPerformed.forEach((w, i) => {
      const row: WorkItemRow = {
        id: demoId(`wi:${report.id}:${version}:${i}`),
        report_id: report.id,
        version,
        area: w.area,
        activity: w.activity,
        status: w.status,
        percent: w.percentComplete ?? null,
        quantity: w.quantity ? `${w.quantity.value} ${w.quantity.unit}` : null,
        source: (w.source[0] ?? null) as WorkItemRow['source'],
      };
      d.workItems.push(row);
    });
    const date = data.reportDate;
    data.weather.periods.forEach((p, i) => {
      const audio =
        p.source.find((s) => {
          const type: string = s.type;
          return type === 'audio' || type === 'voice_note';
        }) ?? null;
      const row: WeatherEventRow = {
        id: demoId(`wx:${report.id}:${version}:${i}`),
        report_id: report.id,
        version,
        site_id: report.site_id,
        date,
        start_local: p.start ?? null,
        end_local: p.end ?? null,
        condition: p.condition,
        impact: p.impact ?? null,
        lost_hours: p.lostHours,
        full_day: !!p.fullDay,
        audio_source: (audio ?? null) as WeatherEventRow['audio_source'],
        photo_count: data.photos.length,
        observed: (data.weather.observed ?? null) as WeatherEventRow['observed'],
        claim_ready: !!audio && data.photos.length > 0 && !!data.weather.observed,
      };
      d.weatherEvents.push(row);
    });
  }

  private pushVersion(
    report: ReportRow,
    data: StoredReportData,
    author: ReportVersionRow['author'],
    userId: string | null,
    changeNote: string | null,
    auditExtra: Record<string, number> = {},
  ): number {
    const next = report.current_version + 1;
    const site = this.site(report.site_id);
    this.data.versions.push({
      ...V12_ROW_DEFAULTS.report_versions,
      report_id: report.id,
      version: next,
      data: data as unknown as ReportVersionRow['data'],
      summary: data.summary,
      pdf_path: `${this.data.org.id}/${site.id}/${report.report_no}_v${next}.pdf`,
      author,
      author_user_id: userId,
      author_message_id: null,
      change_note: changeNote,
      created_at: this.nowIso(),
    });
    this.denormalize(report, next, data);
    const wasSigned = report.status === 'signed_off';
    const signer = report.signed_off_by;
    report.current_version = next;
    report.status = 'filed';
    report.signed_off_by = null;
    report.signed_off_at = null;
    report.updated_at = this.nowIso();
    this.audit({
      org_id: this.data.org.id,
      actor_type: 'user',
      actor_id: userId,
      action: 'report.version_created',
      entity: 'report',
      entity_id: report.id,
      diff: { version: next, change_note: changeNote, ...auditExtra },
    });
    if (wasSigned) {
      this.audit({
        org_id: this.data.org.id,
        actor_type: 'user',
        actor_id: userId,
        action: 'report.signoff_reverted',
        entity: 'report',
        entity_id: report.id,
        diff: { version: next },
      });
      this.notify({
        user_id: signer,
        kind: 'report_edited',
        title: `${report.report_no} was edited after sign-off`,
        body: changeNote,
        target_path: `/reports/${report.id}`,
      });
    }
    return next;
  }

  // ─── Mutations ───

  signOff(reportId: string, userId: string): void {
    const r = this.report(reportId);
    if (r.status !== 'filed')
      throw new Error(`Only filed reports can be signed off (status ${r.status})`);
    r.status = 'signed_off';
    r.signed_off_by = userId;
    r.signed_off_at = this.nowIso();
    r.updated_at = this.nowIso();
    this.audit({
      org_id: this.data.org.id,
      actor_type: 'user',
      actor_id: userId,
      action: 'report.signed_off',
      entity: 'report',
      entity_id: r.id,
      diff: { version: r.current_version },
    });
    this.emit({ table: 'reports', id: r.id });
  }

  undoSignOff(reportId: string, userId: string): void {
    const r = this.report(reportId);
    if (r.status !== 'signed_off') throw new Error('Report is not signed off');
    r.status = 'filed';
    r.signed_off_by = null;
    r.signed_off_at = null;
    this.audit({
      org_id: this.data.org.id,
      actor_type: 'user',
      actor_id: userId,
      action: 'report.signoff_undone',
      entity: 'report',
      entity_id: r.id,
      diff: null,
    });
    this.emit({ table: 'reports', id: r.id });
  }

  /**
   * Mirror of link_typed_companies(): each crew row added with "Add new…" (companyId null) is
   * linked to the org's company with that name or alias (case-insensitive), confirming it, or to
   * a new confirmed company, with an audit row. Names in `skip` (pending `unknown_company:`
   * review reasons) stay unlinked for the review banner.
   */
  private linkTypedCompanies<D extends StoredReportData>(
    stored: D,
    reportId: string,
    userId: string,
    skip: string[] = [],
  ): D {
    // The crew rows it reads and writes have one shape in v1 and v2 data.
    const data = stored as DailyReportDataV1;
    const d = this.data;
    const skipped = new Set(skip.map((s) => s.trim().toLowerCase()));
    const links = new Map<string, CompanyRow>();
    for (const m of data.manpower) {
      const name = m.companyName.trim();
      const key = name.toLowerCase();
      if (m.companyId !== null || !name || skipped.has(key) || links.has(key)) continue;
      let company =
        d.companies.find((c) => c.name.toLowerCase() === key) ??
        d.companies.find((c) => c.aliases.some((a) => a.toLowerCase() === key));
      if (!company) {
        company = {
          id: localId('company'),
          org_id: d.org.id,
          name,
          trade: m.trade?.trim() || null,
          aliases: [],
          is_self_perform: false,
          status: 'confirmed',
          created_at: this.nowIso(),
        };
        d.companies.push(company);
        this.audit({
          org_id: d.org.id,
          actor_type: 'user',
          actor_id: userId,
          action: 'company.created',
          entity: 'company',
          entity_id: company.id,
          diff: {
            name,
            trade: company.trade,
            status: 'confirmed',
            report_id: reportId,
            trigger: 'office_entry',
          },
        });
      } else if (company.status === 'unconfirmed') {
        company.status = 'confirmed';
        this.audit({
          org_id: d.org.id,
          actor_type: 'user',
          actor_id: userId,
          action: 'company.confirmed',
          entity: 'company',
          entity_id: company.id,
          diff: {
            name: company.name,
            from: 'unconfirmed',
            report_id: reportId,
            trigger: 'office_entry',
          },
        });
      }
      links.set(key, company);
    }
    if (!links.size) return stored;
    return {
      ...data,
      manpower: data.manpower.map((m) => {
        const company = m.companyId === null ? links.get(m.companyName.trim().toLowerCase()) : null;
        return company ? { ...m, companyId: company.id, companyName: company.name } : m;
      }),
    } as D;
  }

  /**
   * Mirror of create_report_version() for v1 and v2 data: `data.photos` keeps the report's photos
   * it still lists (by `uploadId` or `messageId`: first occurrence, caption as sent, time as
   * recorded), with `photos` (new uploads) placed among them at their positions
   * (placeOfficePhotos), each keyed as the version's data keys photos (`uploadId` in v2,
   * `messageId` in v1).
   */
  createReportVersion(
    reportId: string,
    stored: StoredReportData,
    changeNote: string,
    userId: string,
    photos: OfficePhotoUpload[] = [],
  ): number {
    const key: PhotoKey = stored.schemaVersion === 2 ? 'uploadId' : 'messageId';
    const r = this.report(reportId);
    if (!changeNote.trim()) throw new Error(copy.report.edit.changeNoteRequired);
    const pending = r.review_reasons
      .filter((x) => x.startsWith('unknown_company:'))
      .map((x) => x.slice('unknown_company:'.length));

    const photoSources = this.data.sources.filter(
      (s) => s.report_id === r.id && s.kind === 'photo' && sourceMediaId(s),
    );
    const byMedia = new Map(photoSources.map((s) => [sourceMediaId(s)!.toLowerCase(), s]));
    const prevData = this.data.versions.find(
      (v) => v.report_id === r.id && v.version === r.current_version,
    )?.data as unknown as { photos?: unknown } | undefined;
    const prevList: PhotoEntry[] | null = Array.isArray(prevData?.photos)
      ? (prevData.photos as PhotoEntry[])
      : null;
    const prevIds = prevList
      ? prevList.flatMap((p) => {
          const src = byMedia.get(photoEntryId(p));
          return src ? [sourceMediaId(src)!] : [];
        })
      : photoSources.map((s) => sourceMediaId(s)!);
    const listed: PhotoEntry[] = Array.isArray(stored.photos)
      ? (stored.photos as PhotoEntry[])
      : (prevList ??
        photoSources.map((s) => ({
          uploadId: sourceMediaId(s)!,
          caption: s.caption ?? undefined,
        })));
    const seen = new Set<string>();
    const kept: KeyedPhoto[] = [];
    for (const p of listed) {
      const id = photoEntryId(p);
      const src = byMedia.get(id);
      if (!src || seen.has(id)) continue;
      seen.add(id);
      const caption = typeof p.caption === 'string' ? p.caption.trim() : '';
      if (caption.length > PHOTO_CAPTION_MAX) throw new Error('photo caption is too long');
      const recorded = prevList?.find(
        (x) => photoEntryId(x) === id && typeof x.takenAt === 'string',
      )?.takenAt;
      const mediaId = sourceMediaId(src)!;
      const file =
        this.data.uploads.find((u) => u.id === mediaId) ??
        this.data.messages.find((m) => m.id === src.message_id);
      const fileTime = file && ('received_at' in file ? file.received_at : file.created_at);
      kept.push({
        [key]: mediaId,
        ...(caption ? { caption } : {}),
        takenAt: recorded ?? src.taken_at ?? fileTime ?? this.nowIso(),
      } as KeyedPhoto);
    }
    const uploads = this.checkOfficePhotos(r.org_id, r.site_id, photos);
    const added = this.insertOfficePhotos(r.id, r.site_id, uploads, userId, key);
    const shown = placeOfficePhotos(kept, added, uploads);
    const ids = shown.map((p) => photoEntryId(p));

    const next = this.pushVersion(
      r,
      {
        ...this.linkTypedCompanies(structuredClone(stored), r.id, userId, pending),
        photos: shown,
      } as StoredReportData,
      'office_user',
      userId,
      changeNote.trim(),
      {
        photos: ids.length,
        photos_added: ids.filter((id) => !prevIds.includes(id)).length,
        photos_removed: new Set(prevIds.filter((id) => !ids.includes(id))).size,
      },
    );
    this.emit({ table: 'reports', id: r.id });
    return next;
  }

  /** The demo bucket received this office upload (DemoSource.uploadReportPhoto). */
  recordPhotoUpload(path: string): void {
    this.uploadedPhotos.add(path);
  }

  /**
   * Mirror of attach_office_photos()'s checks, all before anything is written (the RPC is one
   * transaction): office path of this org and site, type matching the name, uploaded, unused.
   */
  private checkOfficePhotos(
    orgId: string,
    siteId: string,
    photos: OfficePhotoUpload[] | undefined,
  ): CheckedPhoto[] {
    const list: unknown = photos ?? [];
    if (!Array.isArray(list)) throw new Error('photos must be a JSON array');
    if (list.length > OFFICE_PHOTO_MAX) throw new Error('at most 20 photos at a time');
    const esc = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pathRe = new RegExp(
      `^${esc(orgId)}/${esc(siteId)}/office/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\.(jpg|jpeg|png|webp)$`,
    );
    const now = this.now.getTime();
    const seen = new Set<string>();
    return (list as Array<Partial<OfficePhotoUpload> | null>).map((p) => {
      if (!p || typeof p !== 'object') throw new Error('photo must be a JSON object');
      const path = typeof p.path === 'string' ? p.path : '';
      if (!pathRe.test(path)) throw new Error('unexpected photo path');
      const mime = String(p.mime ?? '');
      if (!isOfficePhotoMime(mime)) throw new Error('unsupported photo type');
      const ext = path.slice(path.lastIndexOf('.') + 1);
      const extMime = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg';
      if (mime !== extMime) throw new Error('photo type does not match its file name');
      if (p.caption != null && typeof p.caption !== 'string')
        throw new Error('photo caption must be text');
      const caption = p.caption?.trim() || null;
      if (caption && caption.length > PHOTO_CAPTION_MAX)
        throw new Error('photo caption is too long');
      let taken = now;
      if (typeof p.takenAt === 'string') {
        const t = Date.parse(p.takenAt);
        if (!Number.isFinite(t)) throw new Error('invalid photo time');
        taken = Math.min(t, now);
      } else if (p.takenAt != null) throw new Error('invalid photo time');
      const position = p.position ?? null;
      if (
        position !== null &&
        (typeof position !== 'number' ||
          !Number.isInteger(position) ||
          position < 0 ||
          position > 1000)
      )
        throw new Error('invalid photo position');
      if (
        seen.has(path) ||
        this.data.uploads.some((u) => u.storage_path === path) ||
        this.data.messages.some((m) => m.storage_path === path)
      )
        throw new Error('photo already attached');
      if (!this.uploadedPhotos.has(path)) throw new Error('photo not uploaded');
      seen.add(path);
      return { path, mime, caption, takenAt: new Date(taken).toISOString(), position };
    });
  }

  /**
   * Each checked upload as an office upload (no reporter, uploaded_by the user, D14) + a photo
   * source with its upload_id; returns its data.photos entry, keyed as `key`.
   */
  private insertOfficePhotos(
    reportId: string,
    siteId: string,
    uploads: CheckedPhoto[],
    userId: string,
    key: PhotoKey,
  ): KeyedPhoto[] {
    return uploads.map((u) => {
      const id = localId('upload');
      this.data.uploads.push({
        id,
        report_id: reportId,
        reporter_id: null,
        site_id: siteId,
        kind: 'photo',
        storage_path: u.path,
        mime: u.mime,
        bytes: null,
        duration_s: null,
        peaks: null,
        recorded_at: u.takenAt,
        received_at: this.nowIso(),
        caption: u.caption,
        uploaded_by: userId,
        purged_at: null,
      });
      this.data.sources.push({
        ...V12_ROW_DEFAULTS.report_sources,
        id: localId('src'),
        report_id: reportId,
        message_id: null,
        upload_id: id,
        kind: 'photo',
        caption: u.caption,
        taken_at: u.takenAt,
        created_at: this.nowIso(),
      });
      return {
        [key]: id,
        ...(u.caption ? { caption: u.caption } : {}),
        takenAt: u.takenAt,
      } as KeyedPhoto;
    });
  }

  /** The report (not void) the site's day has, as createOfficeReport() looks it up. */
  findDayReport(siteId: string, date: string): { reportId: string; reportNo: string } | null {
    const day = this.data.siteDays.find((x) => x.site_id === siteId && x.date === date);
    const r = day && this.data.reports.find((x) => x.site_day_id === day.id && x.status !== 'void');
    return r ? { reportId: r.id, reportNo: r.report_no } : null;
  }

  /**
   * Mirror of create_office_report(): a report typed in the panel, filed at once as version 1, in
   * report data v2 (W1-12: the date, the org's report language and units stamped; v1 data from a
   * panel built before W1-12 stays v1, as in SQL).
   */
  createOfficeReport(input: {
    siteId: string;
    date: string;
    data: StoredReportData;
    userId: string;
    photos?: OfficePhotoUpload[];
  }): { reportId: string; reportNo: string; created: boolean } {
    const d = this.data;
    const site = this.site(input.siteId);
    if (site.status === 'archived') throw new Error(copy.errors.notFound);
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(input.date) ||
      input.date > formatDateInTz(this.now, site.timezone)
    )
      throw new Error(copy.newReport.future);
    const sd = this.siteDayFor(site, input.date);
    const live = d.reports.find((r) => r.site_day_id === sd.id && r.status !== 'void');
    if (live) return { reportId: live.id, reportNo: live.report_no, created: false };
    const uploads = this.checkOfficePhotos(d.org.id, site.id, input.photos);

    site.report_seq += 1;
    const reportNo = formatReportNo(site.project_code, site.report_seq);
    const at = this.nowIso();
    const isLate = Date.parse(at) > Date.parse(sd.deadline_at);
    const reportId = localId('report');
    const v1 = input.data.schemaVersion === 1;
    // Version 1 shows exactly the photos uploaded with it, ordered by their positions.
    const photos = placeOfficePhotos(
      [],
      this.insertOfficePhotos(
        reportId,
        site.id,
        uploads,
        input.userId,
        v1 ? 'messageId' : 'uploadId',
      ),
      uploads,
    );
    const stamped = (
      v1
        ? { ...structuredClone(input.data), reportDate: input.date, schemaVersion: 1, photos }
        : {
            ...structuredClone(input.data),
            schemaVersion: 2,
            reportDate: input.date,
            reportLanguage: reportLanguageFor(d.org.locale),
            units: d.org.units,
            photos,
          }
    ) as StoredReportData;
    // Every crew row here was typed by the office: each "Add new…" name becomes a company.
    const data = this.linkTypedCompanies(stamped, reportId, input.userId);
    const report: ReportRow = {
      ...V12_ROW_DEFAULTS.reports,
      id: reportId,
      org_id: d.org.id,
      site_id: site.id,
      site_day_id: sd.id,
      report_no: reportNo,
      status: 'filed',
      current_version: 1,
      reporter_id: null,
      received_at: at,
      confirmed_at: null,
      filed_at: at,
      signed_off_by: null,
      signed_off_at: null,
      needs_review: false,
      review_reasons: [],
      is_late: isLate,
      kind: 'daily',
      created_at: at,
      updated_at: at,
      // As create_office_report: typed in the panel, in the org's report language (D13).
      channel: 'office',
      language: reportLanguageFor(d.org.locale),
    };
    d.reports.push(report);
    d.versions.push({
      ...V12_ROW_DEFAULTS.report_versions,
      report_id: report.id,
      version: 1,
      data: data as unknown as ReportVersionRow['data'],
      summary: data.summary || null,
      pdf_path: null,
      author: 'office_user',
      author_user_id: input.userId,
      author_message_id: null,
      change_note: null,
      created_at: at,
    });
    this.denormalize(report, 1, data);
    sd.status = 'filed';
    sd.report_id = report.id;
    sd.is_late = isLate;
    sd.updated_at = at;
    this.audit({
      org_id: d.org.id,
      actor_type: 'user',
      actor_id: input.userId,
      action: 'report.filed',
      entity: 'report',
      entity_id: report.id,
      diff: {
        trigger: 'office_entry',
        version: 1,
        is_late: isLate,
        date: input.date,
        photos: photos.length,
      },
    });
    this.emit({ table: 'reports', id: report.id });
    this.emit({ table: 'site_days', id: sd.id });
    return { reportId: report.id, reportNo, created: true };
  }

  /**
   * Mirror of attach_version_pdf(): a PDF rendered in the browser is now the version's PDF (the
   * path pdfStoragePath() builds), with an audit row. The file itself stays in the DemoSource.
   */
  attachVersionPdf(reportId: string, version: number, userId: string): void {
    const r = this.report(reportId);
    const v = this.data.versions.find((x) => x.report_id === reportId && x.version === version);
    if (!v) throw new Error(copy.errors.notFound);
    const path = pdfStoragePath(this.data.org.id, r.site_id, r.report_no, version);
    v.pdf_path = path;
    this.audit({
      org_id: this.data.org.id,
      actor_type: 'user',
      actor_id: userId,
      action: 'report.pdf_rendered',
      entity: 'report',
      entity_id: reportId,
      diff: { version, path, renderer: 'browser' },
    });
  }

  markNoWork(siteDayId: string, userId: string): void {
    const sd = this.data.siteDays.find((d) => d.id === siteDayId);
    if (!sd) throw new Error(copy.errors.notFound);
    if (sd.status === 'filed') throw new Error('A filed day cannot be marked no work');
    const from = sd.status;
    sd.status = 'no_work';
    sd.updated_at = this.nowIso();
    this.audit({
      org_id: this.data.org.id,
      actor_type: 'user',
      actor_id: userId,
      action: 'site_day.marked_no_work',
      entity: 'site_day',
      entity_id: sd.id,
      diff: { from },
    });
    this.emit({ table: 'site_days', id: sd.id });
  }

  /** "Text today's link" request ids already answered: one tap, one text (api-text-daily-link). */
  private readonly dailyLinkRequests = new Map<string, TextDailyLinkResult>();

  /**
   * F17 "Text today's link" (W1-16), as api-text-daily-link does it: the site's primary reporter
   * (else its first active one), today's daily link in the site's day, and the `daily_link` text
   * unless they cannot get texts (disabled, opted out, no SMS consent). Audited like the function.
   */
  textDailyLink(siteId: string, requestId: string, userId: string): TextDailyLinkResult {
    const done = this.dailyLinkRequests.get(requestId);
    if (done) return done;
    const d = this.data;
    const site = d.sites.find((x) => x.id === siteId);
    if (!site) throw new Error(copy.errors.notFound);
    if (site.status !== 'active') throw new Error('This site is not active');
    // As api-text-daily-link's pickReporter: the primary among the active reporters, else the
    // first active one; nobody linked → 409 no_reporter, nobody active → 409 no_active_reporter.
    const links = d.siteReporters.filter((sr) => sr.site_id === siteId);
    const reporters = links
      .map((sr) => ({ sr, r: d.reporters.find((x) => x.id === sr.reporter_id) }))
      .filter((x): x is { sr: SiteReporterRow; r: ReporterRow } => !!x.r);
    if (!reporters.length) {
      throw new CodedError(
        'no_reporter' satisfies TextDailyLinkErrorCode,
        'No site manager is linked to this site',
      );
    }
    const active = reporters.filter((x) => isActiveReporterStatus(x.r.status));
    const reporter = (active.find((x) => x.sr.is_primary) ?? active[0])?.r;
    if (!reporter) {
      throw new CodedError(
        'no_active_reporter' satisfies TextDailyLinkErrorCode,
        'No active site manager on this site: the linked ones are disabled, opted out or have not accepted their invite yet',
      );
    }
    const date = formatDateInTz(this.now, site.timezone);
    const sms = d.consents.some(
      (c) => c.reporter_id === reporter.id && c.type === 'sms' && c.revoked_at === null,
    );
    // An active reporter: the Notifier's only refusal left is consent.
    const reason = sms ? null : ('no_consent' as const);
    let result: TextDailyLinkResult;
    if (reason) {
      result = { sent: false, reason, detail: null };
    } else {
      const row = demoDailyLink(d, reporter, site, date, this.nowIso());
      this.audit({
        org_id: d.org.id,
        actor_type: 'system',
        actor_id: null,
        action: 'sms.sent',
        entity: 'message',
        entity_id: row.id,
        diff: { copy_key: 'daily_link', provider: 'console' },
      });
      result = { sent: true, channel: 'sms' };
    }
    this.audit({
      org_id: d.org.id,
      actor_type: 'user',
      actor_id: userId,
      action: 'daily_link.texted',
      entity: 'reporter',
      entity_id: reporter.id,
      diff: {
        site_id: site.id,
        report_date: date,
        request_id: requestId,
        channel: result.sent ? 'sms' : null,
        ...(result.sent ? {} : { reason: result.reason }),
      },
    });
    this.dailyLinkRequests.set(requestId, result);
    this.emit({ table: 'all' });
    return result;
  }

  resolveUnknownCompany(input: ResolveUnknownCompanyInput, userId: string): void {
    const r = this.report(input.reportId);
    const d = this.data;
    let company: CompanyRow | undefined;
    if (input.action === 'add') {
      company = d.companies.find((c) => c.name.toLowerCase() === input.name.toLowerCase());
      if (company) company.status = 'confirmed';
      else {
        company = {
          id: localId('company'),
          org_id: d.org.id,
          name: input.name,
          trade: null,
          aliases: [],
          is_self_perform: false,
          status: 'confirmed',
          created_at: this.nowIso(),
        };
        d.companies.push(company);
      }
    } else {
      company = d.companies.find((c) => c.id === input.companyId);
      if (!company) throw new Error('Company not found');
      if (company.name !== input.name && !company.aliases.includes(input.name))
        company.aliases.push(input.name);
    }
    const term = d.glossary.find(
      (t) => t.kind === 'company' && t.heard.toLowerCase() === input.name.toLowerCase(),
    );
    if (term) {
      term.status = 'confirmed';
      term.official = company.name;
      term.company_id = company.id;
    } else {
      d.glossary.push({
        id: localId('term'),
        org_id: d.org.id,
        scope_site_id: null,
        scope_reporter_id: null,
        heard: input.name,
        official: company.name,
        language: 'en',
        kind: 'company',
        company_id: company.id,
        status: 'confirmed',
        times_heard: 1,
        first_seen_at: this.nowIso(),
        last_seen_at: this.nowIso(),
      });
    }
    const cur = d.versions.find((v) => v.report_id === r.id && v.version === r.current_version)!;
    const data = structuredClone(cur.data as unknown as DailyReportDataV1);
    const cid = company.id;
    const cname = company.name;
    data.manpower = data.manpower.map((m) =>
      m.companyId === null &&
      (m.companyName.toLowerCase() === input.name.toLowerCase() ||
        m.companyNameHeard.toLowerCase() === input.name.toLowerCase())
        ? {
            ...m,
            companyId: cid,
            companyName: cname,
            source: [...m.source, { type: 'office_edit' as const, userId, at: this.nowIso() }],
          }
        : m,
    );
    const note =
      input.action === 'add'
        ? `Added ${company.name} as subcontractor`
        : `"${input.name}" mapped to ${company.name}`;
    this.pushVersion(r, data, 'office_user', userId, note);
    r.review_reasons = r.review_reasons.filter((x) => x !== `unknown_company:${input.name}`);
    r.needs_review = r.review_reasons.length > 0;
    this.audit({
      org_id: d.org.id,
      actor_type: 'user',
      actor_id: userId,
      action: 'report.unknown_company_resolved',
      entity: 'report',
      entity_id: r.id,
      diff: { name: input.name, action: input.action, company_id: company.id },
    });
    this.emit({ table: 'reports', id: r.id });
  }

  reviewGlossaryTerm(input: ReviewGlossaryTermInput, userId: string): void {
    const d = this.data;
    const t = d.glossary.find((x) => x.id === input.termId);
    if (!t || !t.org_id) throw new Error(copy.errors.notFound);
    const upsertCompany = (name: string): CompanyRow => {
      let c = d.companies.find((x) => x.name.toLowerCase() === name.toLowerCase());
      if (!c) {
        c = {
          id: localId('company'),
          org_id: d.org.id,
          name,
          trade: null,
          aliases: [],
          is_self_perform: false,
          status: 'confirmed',
          created_at: this.nowIso(),
        };
        d.companies.push(c);
      } else c.status = 'confirmed';
      if (!c.aliases.includes(t.heard) && c.name !== t.heard) c.aliases.push(t.heard);
      return c;
    };
    switch (input.action) {
      case 'approve':
        t.status = 'confirmed';
        t.official = input.official ?? t.official;
        break;
      case 'change':
        if (!input.official?.trim()) throw new Error('Official term required');
        t.status = 'confirmed';
        t.official = input.official.trim();
        break;
      case 'reject':
        t.status = 'rejected';
        break;
      case 'add_company': {
        const c = upsertCompany(input.official ?? t.official ?? t.heard);
        t.status = 'confirmed';
        t.kind = 'company';
        t.official = c.name;
        t.company_id = c.id;
        break;
      }
      case 'map_company': {
        const c = d.companies.find((x) => x.id === input.companyId);
        if (!c) throw new Error('Company not found');
        if (!c.aliases.includes(t.heard)) c.aliases.push(t.heard);
        t.status = 'confirmed';
        t.kind = 'company';
        t.official = c.name;
        t.company_id = c.id;
        break;
      }
    }
    this.audit({
      org_id: d.org.id,
      actor_type: 'user',
      actor_id: userId,
      action: 'glossary.reviewed',
      entity: 'glossary_term',
      entity_id: t.id,
      diff: {
        action: input.action,
        official: input.official ?? null,
        company_id: input.companyId ?? null,
      },
    });
    this.emit({ table: 'all' });
  }

  addGlossaryTerm(input: AddGlossaryTermInput, userId: string): void {
    const row: GlossaryTermRow = {
      id: localId('term'),
      org_id: this.data.org.id,
      scope_site_id: input.scopeSiteId ?? null,
      scope_reporter_id: null,
      heard: input.heard.trim(),
      official: input.official.trim(),
      language: input.language ?? 'en',
      kind: input.kind,
      company_id: null,
      status: 'confirmed',
      times_heard: 0,
      first_seen_at: this.nowIso(),
      last_seen_at: null,
    };
    this.data.glossary.push(row);
    this.audit({
      org_id: this.data.org.id,
      actor_type: 'user',
      actor_id: userId,
      action: 'glossary.added',
      entity: 'glossary_term',
      entity_id: row.id,
      diff: { heard: row.heard, official: row.official },
    });
    this.emit({ table: 'all' });
  }

  saveSettings(patch: OrgSettingsPatch, userId: string): void {
    Object.assign(this.data.settings, patch, { updated_at: this.nowIso() });
    this.audit({
      org_id: this.data.org.id,
      actor_type: 'user',
      actor_id: userId,
      action: 'settings.updated',
      entity: 'org',
      entity_id: this.data.org.id,
      diff: patch as AuditLogRow['diff'],
    });
    this.emit({ table: 'all' });
  }

  saveSiteRecipients(siteId: string, emails: string[], userId: string): void {
    this.site(siteId);
    this.data.recipients = this.data.recipients.filter((r) => r.site_id !== siteId);
    for (const email of emails) this.data.recipients.push({ site_id: siteId, email });
    this.audit({
      org_id: this.data.org.id,
      actor_type: 'user',
      actor_id: userId,
      action: 'site.recipients_updated',
      entity: 'site',
      entity_id: siteId,
      diff: { emails },
    });
    this.emit({ table: 'all' });
  }

  addInvoice(input: AddInvoiceInput, userId: string): void {
    const total = input.totalHours ?? input.lines.reduce((a, l) => a + l.hours, 0);
    this.data.invoices.push({
      id: localId('invoice'),
      org_id: this.data.org.id,
      company_id: input.companyId,
      invoice_no: input.invoiceNo,
      period_start: input.periodStart,
      period_end: input.periodEnd,
      lines: input.lines,
      total_hours: total,
      file_path: input.file ? `${this.data.org.id}/invoices/${input.file.name}` : null,
      status: 'open',
      queried_at: null,
      resolved_at: null,
      created_at: this.nowIso(),
    });
    this.audit({
      org_id: this.data.org.id,
      actor_type: 'user',
      actor_id: userId,
      action: 'invoice.added',
      entity: 'company',
      entity_id: input.companyId,
      diff: { invoice_no: input.invoiceNo, total },
    });
    this.emit({ table: 'all' });
  }

  setInvoiceStatus(invoiceId: string, status: InvoiceStatus, userId: string): void {
    const inv = this.data.invoices.find((i) => i.id === invoiceId);
    if (!inv) throw new Error(copy.errors.notFound);
    inv.status = status;
    if (status === 'queried') inv.queried_at = this.nowIso();
    if (status === 'resolved') inv.resolved_at = this.nowIso();
    this.audit({
      org_id: this.data.org.id,
      actor_type: 'user',
      actor_id: userId,
      action: `invoice.${status}`,
      entity: 'company',
      entity_id: inv.company_id,
      diff: { invoice_no: inv.invoice_no },
    });
    this.emit({ table: 'all' });
  }

  inviteReporter(input: InviteReporterInput, userId: string): string {
    const id = localId('reporter');
    // As api-invite-reporter: the first pack locale among the "Speaks" languages, else the pack's.
    const pack = demoOrgPack(this.data);
    this.data.reporters.push({
      ...V12_ROW_DEFAULTS.reporters,
      id,
      org_id: this.data.org.id,
      name: input.name.trim(),
      phone_e164: input.phone,
      role: input.role,
      languages: input.languages,
      locale: reporterLocaleFor(pack, input.languages) ?? reporterDefaultsFor(pack).locale,
      status: 'invited',
      invited_at: this.nowIso(),
      verified_at: null,
      last_invite_error: null,
      created_at: this.nowIso(),
    });
    for (const siteId of input.siteIds) {
      const hasPrimary = this.data.siteReporters.some(
        (sr) => sr.site_id === siteId && sr.is_primary,
      );
      this.data.siteReporters.push({
        site_id: siteId,
        reporter_id: id,
        is_primary: input.role === 'site_manager' && !hasPrimary,
      });
    }
    this.audit({
      org_id: this.data.org.id,
      actor_type: 'user',
      actor_id: userId,
      action: 'reporter.invited',
      entity: 'reporter',
      entity_id: id,
      diff: { sites: input.siteIds },
    });
    // The worker's send_welcome (F3): a demo org's welcome text lands in the Demo phone.
    demoWelcome(this.data, this.data.reporters.at(-1)!, input.siteIds[0], this.nowIso());
    this.emit({ table: 'all' });
    return id;
  }

  // ─── Demo phone (/dev/phone, §11.1) ───
  demoPhone(): DemoPhoneData {
    return demoPhoneData(this.data);
  }

  demoPhoneThread(reporterId: string): DemoPhoneMessage[] {
    return demoPhoneThread(this.data, reporterId);
  }

  demoPhoneReply(reporterId: string, body: string): void {
    demoReply(this.data, reporterId, body.trim(), this.nowIso());
    this.emit({ table: 'all' });
  }

  linkUnknownSender(input: LinkUnknownSenderInput, userId: string): void {
    const u = this.data.unknownContacts.find((x) => x.id === input.unknownSenderId);
    if (!u) throw new Error(copy.errors.notFound);
    if (u.status !== 'pending') throw new Error(`This contact was already ${u.status}`);
    // As api-link-unknown-contact (checkContactLink, W1-16): a number that opted out or whose
    // reporter is disabled is not linked by the office.
    const existing = this.data.reporters.find((r) => r.phone_e164 === u.phone_e164);
    if (existing?.status === 'opted_out' || existing?.status === 'disabled') {
      throw new Error(copy.errors.notAllowed);
    }
    let id: string;
    if (existing) {
      // Already a reporter of the org: link the site, keep their status.
      id = existing.id;
      if (
        !this.data.siteReporters.some((sr) => sr.site_id === input.siteId && sr.reporter_id === id)
      ) {
        this.data.siteReporters.push({
          site_id: input.siteId,
          reporter_id: id,
          is_primary: !this.data.siteReporters.some(
            (sr) => sr.site_id === input.siteId && sr.is_primary,
          ),
        });
      }
      demoWelcome(this.data, existing, input.siteId, this.nowIso());
    } else {
      id = this.inviteReporter(
        {
          name: input.name,
          phone: u.phone_e164,
          role: input.role ?? 'backup',
          siteIds: [input.siteId],
          languages: ['en'],
        },
        userId,
      );
    }
    const r = this.data.reporters.find((x) => x.id === id)!;
    // A WhatsApp-era sender already wrote to us, so it is active; a caller or texter is invited
    // until their first consent (F3, F13 step 4).
    if (u.channel === null && !isActiveReporterStatus(r.status)) {
      r.status = 'active';
      r.verified_at = this.nowIso();
      r.activated_at = r.verified_at;
    }
    u.status = 'linked';
    u.org_id = this.data.org.id;
    u.guessed_site_id = input.siteId;
    this.audit({
      org_id: this.data.org.id,
      actor_type: 'user',
      actor_id: userId,
      action: 'unknown_contact.linked',
      entity: 'unknown_contact',
      entity_id: u.id,
      diff: {
        reporterId: id,
        siteId: input.siteId,
        channel: u.channel,
        consent: u.channel === null ? 'whatsapp' : 'pending',
      },
    });
    this.emit({ table: 'unknown_contacts', id: u.id });
  }

  // ─── /ops: org-less unknown contacts (spec §19 Q44, W1-16) ───

  /** As ops_unknown_contacts() and ops_real_orgs(): the demo has no real org to give one to. */
  orglessContacts(): OrglessContacts {
    return {
      contacts: this.data.unknownContacts
        .filter((u) => u.org_id === null && u.status === 'pending')
        .sort((a, b) => b.created_at.localeCompare(a.created_at))
        .map((u) => ({
          id: u.id,
          phone: u.phone_e164,
          channel: u.channel,
          snippet: u.snippet,
          createdAt: u.created_at,
        })),
      orgs: this.data.org.is_demo
        ? []
        : [{ id: this.data.org.id, name: this.data.org.name, country: this.data.org.country }],
    };
  }

  private orgless(contactId: string) {
    const u = this.data.unknownContacts.find((x) => x.id === contactId);
    if (!u) throw new Error(copy.errors.notFound);
    if (u.org_id !== null || u.status !== 'pending') {
      throw new Error('only a pending contact with no organisation can be changed here');
    }
    return u;
  }

  assignUnknownContact(contactId: string, orgId: string, userId: string): void {
    const u = this.orgless(contactId);
    if (orgId !== this.data.org.id || this.data.org.is_demo) {
      throw new Error('a demo organisation cannot take a real contact');
    }
    u.org_id = orgId;
    this.audit({
      org_id: orgId,
      actor_type: 'user',
      actor_id: userId,
      action: 'ops.unknown_contact_assigned',
      entity: 'unknown_contact',
      entity_id: u.id,
      diff: { channel: u.channel },
    });
    this.emit({ table: 'unknown_contacts', id: u.id });
  }

  ignoreOrglessContact(contactId: string, userId: string): void {
    const u = this.orgless(contactId);
    u.status = 'ignored';
    this.audit({
      org_id: null,
      actor_type: 'user',
      actor_id: userId,
      action: 'ops.unknown_contact_ignored',
      entity: 'unknown_contact',
      entity_id: u.id,
      diff: { channel: u.channel },
    });
    this.emit({ table: 'unknown_contacts', id: u.id });
  }

  setReporterStatus(reporterId: string, status: ReporterStatus, userId: string): void {
    const r = this.data.reporters.find((x) => x.id === reporterId);
    if (!r) throw new Error(copy.errors.notFound);
    r.status = status;
    if (status === 'invited') {
      r.invited_at = this.nowIso();
      r.verified_at = null;
    }
    this.audit({
      org_id: this.data.org.id,
      actor_type: 'user',
      actor_id: userId,
      action: status === 'disabled' ? 'reporter.disabled' : 'reporter.enabled',
      entity: 'reporter',
      entity_id: reporterId,
      diff: { status },
    });
    this.emit({ table: 'all' });
  }

  resendInvite(reporterId: string, userId: string): void {
    const r = this.data.reporters.find((x) => x.id === reporterId);
    if (!r) throw new Error(copy.errors.notFound);
    r.invited_at = this.nowIso();
    r.last_invite_error = null;
    if (r.status === 'disabled') r.status = 'invited';
    this.audit({
      org_id: this.data.org.id,
      actor_type: 'user',
      actor_id: userId,
      action: 'reporter.invite_resent',
      entity: 'reporter',
      entity_id: reporterId,
      diff: null,
    });
    this.emit({ table: 'all' });
  }

  /** Mirror of update_reporter() (20261012000001_web_gaps.sql). The phone never changes. */
  updateReporter(input: UpdateReporterInput, userId: string): void {
    const r = this.data.reporters.find((x) => x.id === input.reporterId);
    if (!r) throw new Error(copy.errors.notFound);
    const name = input.name.trim();
    if (!name) throw new Error(copy.team.invite.nameRequired);
    const siteIds = [...new Set(input.siteIds)];
    if (!siteIds.length) throw new Error(copy.team.invite.sitesRequired);
    for (const id of siteIds) this.site(id);
    const languages = [
      ...new Set(input.languages.map((l) => l.trim().toLowerCase()).filter(Boolean)),
    ];
    const langs = languages.length ? languages : ['en'];

    const before = this.data.siteReporters.filter((sr) => sr.reporter_id === r.id);
    const added = siteIds.filter((id) => !before.some((sr) => sr.site_id === id));
    const removed = before.filter((sr) => !siteIds.includes(sr.site_id));
    const diff: Record<string, unknown> = {};
    if (r.name !== name) diff.name = { from: r.name, to: name };
    if (r.role !== input.role) diff.role = { from: r.role, to: input.role };
    if (r.languages.join() !== langs.join()) diff.languages = { from: r.languages, to: langs };
    if (added.length) diff.sites_added = added;
    if (removed.length) diff.sites_removed = removed.map((sr) => sr.site_id);

    r.name = name;
    r.role = input.role;
    r.languages = langs;
    this.data.siteReporters = this.data.siteReporters.filter(
      (sr) => !(sr.reporter_id === r.id && removed.includes(sr)),
    );
    for (const siteId of added) {
      const hasPrimary = this.data.siteReporters.some(
        (sr) => sr.site_id === siteId && sr.is_primary,
      );
      this.data.siteReporters.push({ site_id: siteId, reporter_id: r.id, is_primary: !hasPrimary });
    }
    // A site that lost its primary promotes the next reporter (enabled, site managers first).
    for (const gone of removed.filter((sr) => sr.is_primary)) {
      const site = this.data.siteReporters.filter((sr) => sr.site_id === gone.site_id);
      if (site.some((sr) => sr.is_primary)) continue;
      const rank = (sr: { reporter_id: string }) => {
        const rep = this.data.reporters.find((x) => x.id === sr.reporter_id);
        return (rep?.status === 'disabled' ? 2 : 0) + (rep?.role === 'site_manager' ? 0 : 1);
      };
      const next = [...site].sort((a, b) => rank(a) - rank(b))[0];
      if (next) next.is_primary = true;
    }
    this.audit({
      org_id: this.data.org.id,
      actor_type: 'user',
      actor_id: userId,
      action: 'reporter.updated',
      entity: 'reporter',
      entity_id: r.id,
      diff: diff as AuditLogRow['diff'],
    });
    this.emit({ table: 'all' });
  }

  /** Demo logo: keeps the object URL in memory and records the path like set_org_logo(). */
  /** Same rules as update_org(): name required, blanks clear address / licence, audited diff. */
  updateOrg(input: UpdateOrgInput, userId: string): void {
    const org = this.data.org;
    const name = input.name.trim();
    if (!name) throw new Error(copy.setup.company.nameRequired);
    const next = {
      name,
      timezone: input.timezone.trim() || org.timezone,
      address: input.address?.trim() || null,
      license_no: input.licenseNo?.trim() || null,
    };
    const diff: Record<string, { from: string | null; to: string | null }> = {};
    for (const key of Object.keys(next) as Array<keyof typeof next>) {
      if (org[key] !== next[key]) diff[key] = { from: org[key], to: next[key] };
    }
    if (!Object.keys(diff).length) return;
    Object.assign(org, next);
    this.audit({
      org_id: org.id,
      actor_type: 'user',
      actor_id: userId,
      action: 'org.updated',
      entity: 'org',
      entity_id: org.id,
      diff,
    });
    this.emit({ table: 'all' });
  }

  setLogo(file: { url: string; ext: 'png' | 'svg' } | null, userId: string): void {
    const org = this.data.org;
    const from = org.logo_path;
    if (this.logoUrl && this.logoUrl !== file?.url) URL.revokeObjectURL(this.logoUrl);
    this.logoUrl = file?.url ?? null;
    org.logo_path = file ? logoStoragePath(org.id, file.ext) : null;
    this.audit({
      org_id: org.id,
      actor_type: 'user',
      actor_id: userId,
      action: file ? 'org.logo_updated' : 'org.logo_removed',
      entity: 'org',
      entity_id: org.id,
      diff: { from, to: org.logo_path },
    });
    this.emit({ table: 'all' });
  }

  ignoreUnknownSender(id: string, userId: string): void {
    const u = this.data.unknownContacts.find((x) => x.id === id);
    if (!u) throw new Error(copy.errors.notFound);
    u.status = 'ignored';
    this.audit({
      org_id: this.data.org.id,
      actor_type: 'user',
      actor_id: userId,
      action: 'unknown_contact.ignored',
      entity: 'unknown_contact',
      entity_id: id,
      diff: null,
    });
    this.emit({ table: 'unknown_contacts', id });
  }

  addOfficeUser(input: { email: string; role: MemberRole; name?: string }, userId: string): void {
    const id = localId('user');
    this.data.users.push({
      id,
      email: input.email,
      name: input.name ?? input.email,
      title: null as unknown as string,
      role: input.role,
    });
    this.data.members.push({
      ...V12_ROW_DEFAULTS.org_members,
      org_id: this.data.org.id,
      user_id: id,
      role: input.role,
      display_name: input.name ?? input.email,
      title: null,
      created_at: this.nowIso(),
    });
    this.audit({
      org_id: this.data.org.id,
      actor_type: 'user',
      actor_id: userId,
      action: 'member.invited',
      entity: 'org',
      entity_id: this.data.org.id,
      diff: { email: input.email, role: input.role },
    });
    this.emit({ table: 'all' });
  }

  changeMemberRole(targetUserId: string, role: MemberRole, userId: string): void {
    const m = this.data.members.find((x) => x.user_id === targetUserId);
    if (!m) throw new Error(copy.errors.notFound);
    if (
      m.role === 'admin' &&
      role !== 'admin' &&
      this.data.members.filter((x) => x.role === 'admin').length <= 1
    )
      throw new Error(copy.team.addUser.lastAdmin);
    m.role = role;
    const u = this.data.users.find((x) => x.id === targetUserId);
    if (u) u.role = role;
    this.audit({
      org_id: this.data.org.id,
      actor_type: 'user',
      actor_id: userId,
      action: 'member.role_changed',
      entity: 'org',
      entity_id: this.data.org.id,
      diff: { user_id: targetUserId, role },
    });
    this.emit({ table: 'all' });
  }

  removeMember(targetUserId: string, userId: string): void {
    const m = this.data.members.find((x) => x.user_id === targetUserId);
    if (!m) throw new Error(copy.errors.notFound);
    if (m.role === 'admin' && this.data.members.filter((x) => x.role === 'admin').length <= 1)
      throw new Error(copy.team.addUser.lastAdmin);
    this.data.members = this.data.members.filter((x) => x.user_id !== targetUserId);
    this.audit({
      org_id: this.data.org.id,
      actor_type: 'user',
      actor_id: userId,
      action: 'member.removed',
      entity: 'org',
      entity_id: this.data.org.id,
      diff: { user_id: targetUserId },
    });
    this.emit({ table: 'all' });
  }

  createSite(input: CreateSiteInput, userId: string): string {
    const id = localId('site');
    const today = formatDateInTz(this.now, input.timezone);
    this.data.sites.push({
      id,
      org_id: this.data.org.id,
      name: input.name.trim(),
      project_code: input.projectCode.trim(),
      address: input.address ?? null,
      lat: input.lat ?? null,
      lng: input.lng ?? null,
      timezone: input.timezone,
      deadline: input.deadline ?? null,
      working_hours: input.workingHours ?? null,
      status: 'active',
      active_since: today,
      paused_at: null,
      report_seq: 0,
      created_at: this.nowIso(),
    });
    for (const email of input.recipients ?? []) this.data.recipients.push({ site_id: id, email });
    if (input.reporter) this.inviteReporter({ ...input.reporter, siteIds: [id] }, userId);
    this.audit({
      org_id: this.data.org.id,
      actor_type: 'user',
      actor_id: userId,
      action: 'site.created',
      entity: 'site',
      entity_id: id,
      diff: { name: input.name },
    });
    this.emit({ table: 'all' });
    return id;
  }

  updateSite(siteId: string, patch: UpdateSitePatch, userId: string): void {
    const s = this.site(siteId);
    if (patch.name !== undefined) s.name = patch.name;
    if (patch.projectCode !== undefined) s.project_code = patch.projectCode;
    if (patch.address !== undefined) s.address = patch.address ?? null;
    if (patch.lat !== undefined) s.lat = patch.lat ?? null;
    if (patch.lng !== undefined) s.lng = patch.lng ?? null;
    if (patch.timezone !== undefined) s.timezone = patch.timezone;
    if (patch.deadline !== undefined) s.deadline = patch.deadline ?? null;
    if (patch.workingHours !== undefined) s.working_hours = patch.workingHours ?? null;
    this.audit({
      org_id: this.data.org.id,
      actor_type: 'user',
      actor_id: userId,
      action: 'site.updated',
      entity: 'site',
      entity_id: siteId,
      diff: patch as AuditLogRow['diff'],
    });
    this.emit({ table: 'all' });
  }

  setSiteStatus(siteId: string, status: 'active' | 'paused', userId: string): void {
    const s = this.site(siteId);
    s.status = status;
    s.paused_at = status === 'paused' ? this.nowIso() : null;
    this.audit({
      org_id: this.data.org.id,
      actor_type: 'user',
      actor_id: userId,
      action: status === 'paused' ? 'site.paused' : 'site.resumed',
      entity: 'site',
      entity_id: siteId,
      diff: null,
    });
    this.emit({ table: 'all' });
  }

  requestEvidencePack(input: RequestEvidencePackInput, userId: string): string {
    const id = localId('pack');
    const site = input.siteId ? this.site(input.siteId) : null;
    this.data.packs.unshift({
      id,
      org_id: this.data.org.id,
      site_id: input.siteId,
      period_start: input.periodStart,
      period_end: input.periodEnd,
      status: 'queued',
      pdf_path: null,
      sections: input.sections,
      error: null,
      created_by: userId,
      created_at: this.nowIso(),
      ready_at: null,
    });
    this.audit({
      org_id: this.data.org.id,
      actor_type: 'user',
      actor_id: userId,
      action: 'evidence_pack.requested',
      entity: 'evidence_pack',
      entity_id: id,
      diff: { site_id: input.siteId, period: [input.periodStart, input.periodEnd] },
    });
    this.emit({ table: 'evidence_packs', id });
    const t = setTimeout(() => {
      const p = this.data.packs.find((x) => x.id === id);
      if (!p) return;
      p.status = 'ready';
      p.ready_at = this.nowIso();
      p.pdf_path = `${this.data.org.id}/${input.siteId ?? 'all'}/eot_${input.periodStart}_${input.periodEnd}.pdf`;
      this.notify({
        user_id: userId,
        kind: 'pack_ready',
        title: `EOT evidence pack ready — ${site?.name ?? copy.hours.allSites}`,
        body: null,
        target_path: '/weather',
      });
      this.emit({ table: 'evidence_packs', id });
    }, 1500);
    this.timers.push(t);
    return id;
  }

  markNotificationsRead(ids: string[]): void {
    const set = new Set(ids);
    for (const n of this.data.notifications)
      if (set.has(n.id) && !n.read_at) n.read_at = this.nowIso();
    this.emit({ table: 'notifications' });
  }

  /** Demo realtime: Priya's late report for Elm St. arrives. Deterministic, only when triggered. */
  simulateIncomingReport(): boolean {
    const d = this.data;
    const site = d.sites.find((s) => s.project_code === 'ES-0377');
    if (!site) return false;
    const today = formatDateInTz(this.now, site.timezone);
    const sd = d.siteDays.find((x) => x.site_id === site.id && x.date === today);
    if (!sd || sd.status === 'filed') return false;
    const reporter = d.reporters.find((r) => r.name === 'Priya Raman');
    const convo = d.conversations.find((c) => c.reporter_id === reporter?.id);
    const self = d.companies.find((c) => c.is_self_perform)!;
    const receivedAt = fromZonedTime(`${today}T19:04:00`, site.timezone).toISOString();
    const audioId = localId('msg');
    const reportId = localId('report');
    site.report_seq += 1;
    const reportNo = formatReportNo(site.project_code, site.report_seq);
    const data: DailyReportDataV1 = {
      ...emptyReportDataV1(today),
      languageDetected: ['en'],
      summary:
        'Framing continued at Units 1–4 with 6 on site (48 h). Roof trusses set on Unit 2; backfill at the north trench completed. Dry all day. No incidents reported.',
      workingHours: { start: '07:00', end: '15:30' },
      weather: {
        observed: {
          precipIn: 0,
          tempMinF: 55,
          tempMaxF: 67,
          windMph: 8,
          gustMph: 14,
          provider: 'Open-Meteo',
        },
        conditionsText: 'Overcast, dry',
        periods: [],
      },
      manpower: [
        {
          companyId: self.id,
          companyNameHeard: 'our crew',
          companyName: self.name,
          trade: 'General labor',
          area: 'Units 1–4',
          workers: 6,
          hoursPerWorker: 8,
          totalHours: 48,
          hoursBasis: 'stated',
          confidence: 0.93,
          source: [{ type: 'audio', messageId: audioId, start: 6, end: 15 }],
        },
      ],
      workPerformed: [
        {
          area: 'Units 1–4',
          activity: 'Framing',
          status: 'in_progress',
          percentComplete: 70,
          source: [{ type: 'audio', messageId: audioId, start: 15, end: 26 }],
        },
        {
          area: 'Site',
          activity: 'Excavation and backfill',
          status: 'complete',
          source: [{ type: 'audio', messageId: audioId, start: 26, end: 34 }],
        },
      ],
      safety: {
        incidents: [],
        noIncidentsStated: true,
        visitors: [],
        source: [{ type: 'audio', messageId: audioId, start: 34, end: 41 }],
      },
      photos: [],
    };
    if (convo) {
      const msg: MessageRow = {
        ...V12_ROW_DEFAULTS.messages,
        id: audioId,
        conversation_id: convo.id,
        org_id: null,
        direction: 'in',
        wa_message_id: `wamid.demo.sim.${audioId.slice(-6)}`,
        type: 'audio',
        body: null,
        payload: {
          peaks: Array.from(
            { length: 64 },
            (_, i) => Math.round((0.15 + 0.85 * demoRand('peak:sim', i)) * 100) / 100,
          ),
        },
        media_id: null,
        media_mime: 'audio/ogg; codecs=opus',
        storage_path: null,
        duration_s: 58,
        template_name: null,
        status: 'received',
        error: null,
        created_at: receivedAt,
      };
      d.messages.push(msg);
      d.transcripts.push({
        ...V12_ROW_DEFAULTS.transcripts,
        id: localId('transcript'),
        message_id: audioId,
        language: 'en',
        text: 'Hey, sorry this is late. Elm Street, Friday. Six of us framing on one through four, full day. Trusses went up on unit two, and we finished the backfill on the north trench. Dry all day, no incidents.',
        segments: [
          { start: 0, end: 6, text: 'Hey, sorry this is late. Elm Street, Friday.' },
          { start: 6, end: 15, text: 'Six of us framing on one through four, full day.' },
          { start: 15, end: 26, text: 'Trusses went up on unit two,' },
          { start: 26, end: 34, text: 'and we finished the backfill on the north trench.' },
          { start: 34, end: 41, text: 'Dry all day, no incidents.' },
        ],
        model: 'whisper-1',
        created_at: receivedAt,
      });
      d.sources.push({
        ...V12_ROW_DEFAULTS.report_sources,
        id: localId('src'),
        report_id: reportId,
        message_id: audioId,
        kind: 'audio',
        caption: null,
        taken_at: receivedAt,
      });
    }
    const report: ReportRow = {
      ...V12_ROW_DEFAULTS.reports,
      id: reportId,
      org_id: d.org.id,
      site_id: site.id,
      site_day_id: sd.id,
      report_no: reportNo,
      status: 'filed',
      current_version: 0,
      reporter_id: reporter?.id ?? null,
      received_at: receivedAt,
      confirmed_at: receivedAt,
      filed_at: receivedAt,
      signed_off_by: null,
      signed_off_at: null,
      needs_review: false,
      review_reasons: [],
      is_late: true,
      kind: 'daily',
      created_at: receivedAt,
      updated_at: receivedAt,
    };
    d.reports.push(report);
    d.versions.push({
      ...V12_ROW_DEFAULTS.report_versions,
      report_id: reportId,
      version: 1,
      data: data as unknown as ReportVersionRow['data'],
      summary: data.summary,
      pdf_path: `${d.org.id}/${site.id}/${reportNo}_v1.pdf`,
      author: 'agent',
      author_user_id: null,
      author_message_id: null,
      change_note: null,
      created_at: receivedAt,
    });
    report.current_version = 1;
    this.denormalize(report, 1, data);
    const totals = deriveTotals(data);
    sd.status = 'filed';
    sd.is_late = true;
    sd.report_id = reportId;
    sd.updated_at = receivedAt;
    this.audit({
      org_id: d.org.id,
      actor_type: 'agent',
      actor_id: null,
      action: 'report.filed',
      entity: 'report',
      entity_id: reportId,
      diff: { version: 1, late: true },
      created_at: receivedAt,
    });
    this.notify({
      user_id: null,
      kind: 'report_filed',
      title: `${site.name} — late report in`,
      body: `${reportNo} · ${totals.crewOnSite} on site · ${totals.totalHours} h`,
      target_path: `/reports/${reportId}`,
    });
    const missingNotif = d.notifications.find(
      (n) => n.kind === 'missing_report' && !n.read_at && n.title.startsWith(site.name),
    );
    if (missingNotif) missingNotif.read_at = this.nowIso();
    this.emit({ table: 'site_days', id: sd.id });
    this.emit({ table: 'reports', id: reportId });
    return true;
  }

  // ─── Field simulator (/try): what the worker writes while a reporter talks to the agent ───

  private todaySiteDay(site: SiteRow): SiteDayRow {
    return this.siteDayFor(site, formatDateInTz(this.now, site.timezone));
  }

  private siteDayFor(site: SiteRow, date: string): SiteDayRow {
    let sd = this.data.siteDays.find((x) => x.site_id === site.id && x.date === date);
    if (!sd) {
      const deadline = (site.deadline ?? this.data.settings.default_deadline).slice(0, 5);
      sd = {
        id: localId('siteday'),
        site_id: site.id,
        date,
        status: 'pending',
        deadline_at: deadlineInstant(date, deadline, site.timezone).toISOString(),
        reminder_stage: 0,
        reminders_paused: false,
        is_late: false,
        weather: null,
        report_id: null,
        created_at: this.nowIso(),
        updated_at: this.nowIso(),
      };
      this.data.siteDays.push(sd);
    }
    return sd;
  }

  /** The status an unreported day has at "now" on the §7.4 ladder (pending → reminded → missing). */
  private unreportedStatus(sd: SiteDayRow): SiteDayStatus {
    const s = this.data.settings;
    const deadline = Date.parse(sd.deadline_at);
    const now = this.now.getTime();
    if (s.missing_enabled && now >= deadline + s.missing_offset_min * 60_000) return 'missing';
    if (s.reminder1_enabled && now >= deadline + s.reminder1_offset_min * 60_000) return 'reminded';
    return 'pending';
  }

  /** Today at a site, and what replacing it for the simulator would leave behind. */
  fieldDay(siteId: string): FieldDayInfo {
    const site = this.site(siteId);
    const sd = this.todaySiteDay(site);
    const reports = this.data.reports.filter((r) => r.site_day_id === sd.id);
    const shown =
      (sd.report_id ? reports.find((r) => r.id === sd.report_id) : undefined) ??
      reports.find((r) => r.status !== 'void') ??
      null;
    const numbers = new Set(reports.map((r) => r.report_no));
    let seq = site.report_seq;
    while (seq > 0 && numbers.has(formatReportNo(site.project_code, seq))) seq -= 1;
    return {
      siteDayId: sd.id,
      date: sd.date,
      status: sd.status,
      deadlineAt: sd.deadline_at,
      reportId: shown?.id ?? null,
      reportNo: shown?.report_no ?? null,
      reportStatus: shown?.status ?? null,
      needsReview: shown?.needs_review ?? false,
      receivedAt: shown?.received_at ?? null,
      remindersPaused: sd.reminders_paused,
      weather: sd.weather,
      needsReset:
        reports.length > 0 ||
        !(sd.status === 'pending' || sd.status === 'reminded' || sd.status === 'missing'),
      statusAfterReset: this.unreportedStatus(sd),
      reportSeqAfterReset: seq,
    };
  }

  /**
   * Clears today at a site so the simulator can file a fresh report: removes the day's reports
   * (with versions, sources, questions, denormalised rows and their notifications) and the
   * reporter's messages of the day, rolls the report sequence back over the removed numbers and
   * puts the site-day back where the reminder ladder has it now.
   */
  resetFieldDay(
    siteId: string,
    reporterId: string | null,
    opts: { keepMessageIdPrefix?: string } = {},
  ): void {
    const site = this.site(siteId);
    const info = this.fieldDay(siteId);
    const sd = this.todaySiteDay(site);
    const d = this.data;
    const removed = d.reports.filter((r) => r.site_day_id === sd.id);
    const ids = new Set(removed.map((r) => r.id));
    d.reports = d.reports.filter((r) => !ids.has(r.id));
    d.versions = d.versions.filter((v) => !ids.has(v.report_id));
    d.sources = d.sources.filter((s) => !ids.has(s.report_id));
    d.questions = d.questions.filter((q) => !ids.has(q.report_id));
    d.manpower = d.manpower.filter((m) => !ids.has(m.report_id));
    d.workItems = d.workItems.filter((w) => !ids.has(w.report_id));
    d.weatherEvents = d.weatherEvents.filter((w) => !ids.has(w.report_id));
    d.notifications = d.notifications.filter(
      (n) => !removed.some((r) => n.target_path === `/reports/${r.id}`),
    );
    // The day's recorder files and their transcripts go with the reports; a call stays, unlinked.
    const goneUploads = new Set(
      d.uploads.filter((u) => u.report_id && ids.has(u.report_id)).map((u) => u.id),
    );
    d.uploads = d.uploads.filter((u) => !goneUploads.has(u.id));
    d.transcripts = d.transcripts.filter((t) => !(t.upload_id && goneUploads.has(t.upload_id)));
    for (const c of d.calls) if (c.report_id && ids.has(c.report_id)) c.report_id = null;
    const convo = d.conversations.find((c) => c.reporter_id === reporterId);
    if (convo) {
      const gone = new Set(
        d.messages
          .filter(
            (m) =>
              m.conversation_id === convo.id &&
              formatDateInTz(m.created_at, site.timezone) === sd.date &&
              !(opts.keepMessageIdPrefix && m.id.startsWith(opts.keepMessageIdPrefix)),
          )
          .map((m) => m.id),
      );
      d.messages = d.messages.filter((m) => !gone.has(m.id));
      d.transcripts = d.transcripts.filter((t) => !(t.message_id && gone.has(t.message_id)));
    }
    site.report_seq = info.reportSeqAfterReset;
    sd.status = info.statusAfterReset;
    sd.report_id = null;
    sd.is_late = false;
    sd.updated_at = this.nowIso();
    this.audit({
      org_id: d.org.id,
      actor_type: 'system',
      actor_id: null,
      action: 'site_day.reset',
      entity: 'site_day',
      entity_id: sd.id,
      diff: { reason: 'field_simulator', removed: removed.map((r) => r.report_no) },
    });
    this.emit({ table: 'site_days', id: sd.id });
    this.emit({ table: 'reports' });
  }

  /** WhatsApp messages of the simulated chat (the report page shows the day's thread). */
  recordFieldMessages(reporterId: string, messages: FieldMessageInput[]): void {
    const convo = this.data.conversations.find((c) => c.reporter_id === reporterId);
    if (!convo) return;
    for (const m of messages) {
      this.data.messages.push({
        ...V12_ROW_DEFAULTS.messages,
        id: m.id,
        conversation_id: convo.id,
        org_id: null,
        direction: m.direction,
        wa_message_id: null,
        type: m.type,
        body: m.body,
        payload: (m.payload ?? null) as MessageRow['payload'],
        media_id: null,
        media_mime: m.type === 'audio' ? 'audio/ogg; codecs=opus' : null,
        storage_path: null,
        duration_s: m.durationS ?? null,
        template_name: null,
        status: m.direction === 'in' ? 'received' : 'sent',
        error: null,
        created_at: m.at,
      });
      if (m.transcript) {
        this.data.transcripts.push({
          ...V12_ROW_DEFAULTS.transcripts,
          id: localId('transcript'),
          message_id: m.id,
          language: m.transcript.language,
          text: m.transcript.text,
          segments: m.transcript.segments as TranscriptRow['segments'],
          model: 'replayed-fixture',
          created_at: m.at,
        });
      }
      if (m.direction === 'in') convo.last_inbound_at = m.at;
      else convo.last_outbound_at = m.at;
    }
  }

  /** Drops the messages of an abandoned simulator chat that changed nothing else. */
  removeFieldMessages(reporterId: string, idPrefix: string): void {
    const convo = this.data.conversations.find((c) => c.reporter_id === reporterId);
    if (!convo || !idPrefix) return;
    const gone = new Set(
      this.data.messages
        .filter((m) => m.conversation_id === convo.id && m.id.startsWith(idPrefix))
        .map((m) => m.id),
    );
    if (gone.size === 0) return;
    this.data.messages = this.data.messages.filter((m) => !gone.has(m.id));
    this.data.transcripts = this.data.transcripts.filter(
      (t) => !(t.message_id && gone.has(t.message_id)),
    );
  }

  /** §F5 step 1: report row (collecting) with the site's next number. */
  openFieldReport(input: {
    id: string;
    siteId: string;
    reporterId: string;
    reportNo: string;
    kind: string;
    at: string;
  }): void {
    const site = this.site(input.siteId);
    const sd = this.todaySiteDay(site);
    const seq = Number(input.reportNo.slice(site.project_code.length + 1));
    if (Number.isInteger(seq)) site.report_seq = Math.max(site.report_seq, seq);
    this.data.reports.push({
      ...V12_ROW_DEFAULTS.reports,
      id: input.id,
      org_id: this.data.org.id,
      site_id: site.id,
      site_day_id: sd.id,
      report_no: input.reportNo,
      status: 'collecting',
      current_version: 0,
      reporter_id: input.reporterId,
      received_at: input.at,
      confirmed_at: null,
      filed_at: null,
      signed_off_by: null,
      signed_off_at: null,
      needs_review: false,
      review_reasons: [],
      is_late: false,
      kind: input.kind,
      created_at: input.at,
      updated_at: input.at,
    });
    this.emit({ table: 'reports', id: input.id });
  }

  setFieldDayStatus(siteId: string, status: SiteDayStatus): void {
    const sd = this.todaySiteDay(this.site(siteId));
    sd.status = status;
    sd.updated_at = this.nowIso();
    this.emit({ table: 'site_days', id: sd.id });
  }

  /** sendQuestion / sendDraft: the report waits for an answer or the reporter's OK. */
  setFieldReportStatus(
    reportId: string,
    status: 'collecting' | 'awaiting_answer' | 'awaiting_confirmation',
    at: string,
  ): void {
    const r = this.report(reportId);
    if (r.status === 'filed' || r.status === 'signed_off' || r.status === 'void') return;
    r.status = status;
    r.updated_at = at;
    this.emit({ table: 'reports', id: r.id });
  }

  /** storeDraft: the working draft lives in version 1 until filing freezes it. */
  storeFieldDraft(input: {
    reportId: string;
    data: DailyReportDataV1;
    messageId: string | null;
    at: string;
  }): void {
    const d = this.data;
    const r = this.report(input.reportId);
    if (r.status === 'filed' || r.status === 'signed_off' || r.status === 'void') return;
    const data = structuredClone(input.data);
    const existing = d.versions.find((v) => v.report_id === r.id && v.version === 1);
    d.versions = d.versions.filter((v) => !(v.report_id === r.id && v.version === 1));
    d.versions.push({
      ...V12_ROW_DEFAULTS.report_versions,
      report_id: r.id,
      version: 1,
      data: data as unknown as ReportVersionRow['data'],
      summary: data.summary || null,
      pdf_path: null,
      author: 'agent',
      author_user_id: null,
      author_message_id: input.messageId ?? existing?.author_message_id ?? null,
      change_note: null,
      created_at: existing?.created_at ?? input.at,
    });
    r.updated_at = input.at;
    this.emit({ table: 'reports', id: r.id });
  }

  /** F6 "Add …": the report is flagged for review as soon as the company is added. */
  flagFieldReview(reportId: string, reasons: string[], at: string): void {
    const r = this.report(reportId);
    r.review_reasons = [...new Set([...r.review_reasons, ...reasons])];
    r.needs_review = r.review_reasons.length > 0;
    r.updated_at = at;
    this.emit({ table: 'reports', id: r.id });
  }

  /** "stop": no more reminders for today's site-day (§F11). Returns false when already paused. */
  pauseFieldReminders(siteId: string): boolean {
    const sd = this.todaySiteDay(this.site(siteId));
    if (sd.reminders_paused) return false;
    sd.reminders_paused = true;
    sd.updated_at = this.nowIso();
    this.emit({ table: 'site_days', id: sd.id });
    return true;
  }

  voidFieldReport(reportId: string, at: string): void {
    const r = this.report(reportId);
    r.status = 'void';
    r.updated_at = at;
    this.emit({ table: 'reports', id: r.id });
  }

  fieldAudit(row: {
    actor: 'agent' | 'reporter' | 'system';
    actorId: string | null;
    action: string;
    entity: string;
    entityId: string;
    diff: Record<string, unknown>;
    at: string;
  }): void {
    this.audit({
      org_id: this.data.org.id,
      actor_type: row.actor,
      actor_id: row.actorId,
      action: row.action,
      entity: row.entity,
      entity_id: row.entityId,
      diff: row.diff as AuditLogRow['diff'],
      created_at: row.at,
    });
  }

  /**
   * F6 "Add …": an unconfirmed subcontractor for the office to confirm. A company with the same
   * name (a re-run of the same scenario) is reused; returns the id in use.
   */
  addFieldCompany(input: { id: string; name: string; at: string }): string {
    const same = this.data.companies.find(
      (c) => c.id === input.id || c.name.toLowerCase() === input.name.trim().toLowerCase(),
    );
    if (same) return same.id;
    this.data.companies.push({
      id: input.id,
      org_id: this.data.org.id,
      name: input.name,
      trade: null,
      aliases: [],
      is_self_perform: false,
      status: 'unconfirmed',
      created_at: input.at,
    });
    return input.id;
  }

  /** §F7 step 3 / pipeline/file.ts: freeze v1, write rows, file, flip the site-day, notify. */
  fileFieldReport(input: FieldFileInput): void {
    const d = this.data;
    const r = this.report(input.reportId);
    const site = this.site(r.site_id);
    const sd = d.siteDays.find((x) => x.id === r.site_day_id)!;
    const data = structuredClone(input.data);
    r.kind = input.kind;
    d.versions = d.versions.filter((v) => !(v.report_id === r.id && v.version === 1));
    d.versions.push({
      ...V12_ROW_DEFAULTS.report_versions,
      report_id: r.id,
      version: 1,
      data: data as unknown as ReportVersionRow['data'],
      summary: data.summary || null,
      pdf_path: `${d.org.id}/${site.id}/${r.report_no}_v1.pdf`,
      author: 'agent',
      author_user_id: null,
      author_message_id: null,
      change_note: null,
      created_at: input.at,
    });
    d.sources = d.sources.filter((s) => s.report_id !== r.id);
    input.sources.forEach((s, i) =>
      d.sources.push({
        ...V12_ROW_DEFAULTS.report_sources,
        id: `${r.id}-s${i + 1}`,
        report_id: r.id,
        message_id: s.messageId,
        kind: s.kind,
        caption: s.caption,
        taken_at: s.at,
      }),
    );
    d.questions = d.questions.filter((q) => q.report_id !== r.id);
    for (const q of input.questions) {
      d.questions.push({
        ...V12_ROW_DEFAULTS.questions,
        id: q.id,
        report_id: r.id,
        field: q.field,
        target: { ...q.target, path: q.path } as QuestionRow['target'],
        prompt: q.prompt,
        options: q.buttons as unknown as QuestionRow['options'],
        asked_message_id: null,
        answered_message_id: null,
        answer: (q.answer ?? null) as QuestionRow['answer'],
        asked_at: q.askedAt,
        answered_at: q.answeredAt,
        created_at: q.askedAt,
      });
    }
    r.current_version = 1;
    this.denormalize(r, 1, data);
    const isLate = Date.parse(input.at) > Date.parse(sd.deadline_at);
    r.status = 'filed';
    r.filed_at = input.at;
    r.confirmed_at = input.trigger === 'confirm' ? input.at : null;
    r.is_late = isLate;
    r.needs_review = input.reasons.length > 0;
    r.review_reasons = [...input.reasons];
    r.updated_at = input.at;
    sd.status =
      input.kind === 'weather_day' ? 'weather_day' : input.kind === 'no_work' ? 'no_work' : 'filed';
    sd.report_id = r.id;
    sd.is_late = isLate;
    sd.updated_at = input.at;
    this.audit({
      org_id: d.org.id,
      actor_type: input.trigger === 'confirm' ? 'reporter' : 'agent',
      actor_id: input.trigger === 'confirm' ? r.reporter_id : null,
      action: 'report.filed',
      entity: 'report',
      entity_id: r.id,
      diff: {
        trigger: input.trigger,
        version: 1,
        is_late: isLate,
        review_reasons: input.reasons,
        confirm_message_id: input.confirmMessageId ?? null,
      },
      created_at: input.at,
    });
    // pipeline/file.ts notifies the panel only for review; "Report filed" is email-only (§13).
    if (input.reasons.length > 0) {
      this.notify({
        user_id: null,
        kind: 'needs_review',
        title: `${r.report_no} needs review`,
        body: input.reasons.join(', '),
        target_path: `/reports/${r.id}`,
      });
    }
    if (input.kind !== 'no_work' || d.settings.no_work_pdf) this.pdfRendered(r, 1, input.at);
    const missingNotif = d.notifications.find(
      (n) => n.kind === 'missing_report' && !n.read_at && n.title.startsWith(site.name),
    );
    if (missingNotif) missingNotif.read_at = this.nowIso();
    this.emit({ table: 'site_days', id: sd.id });
    this.emit({ table: 'reports', id: r.id });
  }

  /** A new version of a filed report from the field (late photo, weather follow-up, "edit Friday"). */
  addFieldVersion(input: FieldVersionInput): void {
    const d = this.data;
    const r = this.report(input.reportId);
    const site = this.site(r.site_id);
    const data = structuredClone(input.data);
    d.versions.push({
      ...V12_ROW_DEFAULTS.report_versions,
      report_id: r.id,
      version: input.version,
      data: data as unknown as ReportVersionRow['data'],
      summary: data.summary || null,
      pdf_path: `${d.org.id}/${site.id}/${r.report_no}_v${input.version}.pdf`,
      author: input.author,
      author_user_id: null,
      author_message_id: input.messageId,
      change_note: input.changeNote,
      created_at: input.at,
    });
    if (input.source) {
      d.sources.push({
        ...V12_ROW_DEFAULTS.report_sources,
        id: `${r.id}-s${d.sources.filter((s) => s.report_id === r.id).length + 1}`,
        report_id: r.id,
        message_id: input.source.messageId,
        kind: input.source.kind,
        caption: input.source.caption,
        taken_at: input.source.at,
      });
    }
    const wasSigned = r.status === 'signed_off';
    r.current_version = input.version;
    r.status = 'filed';
    r.signed_off_by = null;
    r.signed_off_at = null;
    r.updated_at = input.at;
    this.denormalize(r, input.version, data);
    this.audit({
      org_id: d.org.id,
      actor_type: input.author === 'reporter' ? 'reporter' : 'agent',
      actor_id: input.author === 'reporter' ? r.reporter_id : null,
      action: 'report.version_created',
      entity: 'report',
      entity_id: r.id,
      diff: { version: input.version, change_note: input.changeNote },
      created_at: input.at,
    });
    if (wasSigned) {
      this.audit({
        org_id: d.org.id,
        actor_type: 'agent',
        actor_id: null,
        action: 'report.signoff_reverted',
        entity: 'report',
        entity_id: r.id,
        diff: { version: input.version },
        created_at: input.at,
      });
    }
    this.pdfRendered(r, input.version, input.at);
    this.emit({ table: 'reports', id: r.id });
  }

  /** jobs/render_pdf.ts: one audit row per rendered version (the demo has no PDF bytes). */
  private pdfRendered(r: ReportRow, version: number, at: string): void {
    const path = this.data.versions.find(
      (v) => v.report_id === r.id && v.version === version,
    )?.pdf_path;
    this.audit({
      org_id: this.data.org.id,
      actor_type: 'agent',
      actor_id: null,
      action: 'report.pdf_rendered',
      entity: 'report',
      entity_id: r.id,
      diff: { version, path: path ?? null },
      created_at: at,
    });
  }

  /** §F10 step 4 without a no-work PDF: the site-day alone records it. */
  markFieldNoWork(siteId: string): void {
    this.setFieldDayStatus(siteId, 'no_work');
  }
}

export interface FieldDayInfo {
  siteDayId: string;
  date: string;
  status: SiteDayStatus;
  deadlineAt: string;
  reportId: string | null;
  reportNo: string | null;
  reportStatus: ReportRow['status'] | null;
  needsReview: boolean;
  receivedAt: string | null;
  remindersPaused: boolean;
  /** site_days.weather (observed hourly weather), when fetched. */
  weather: SiteDayRow['weather'];
  needsReset: boolean;
  statusAfterReset: SiteDayStatus;
  reportSeqAfterReset: number;
}

export interface FieldMessageInput {
  id: string;
  direction: 'in' | 'out';
  type: MessageRow['type'];
  body: string | null;
  at: string;
  durationS?: number | null;
  payload?: unknown;
  transcript?: {
    language: string | null;
    text: string;
    segments: Array<{ start: number; end: number; text: string }>;
  };
}

export interface FieldSourceInput {
  messageId: string;
  kind: ReportSourceRow['kind'];
  caption: string | null;
  at: string;
}

export interface FieldFileInput {
  reportId: string;
  kind: 'daily' | 'weather_day' | 'no_work';
  data: DailyReportDataV1;
  trigger: 'confirm' | 'weather_day' | 'no_work';
  reasons: string[];
  at: string;
  /** The reporter's "OK" (report.filed audit diff). */
  confirmMessageId?: string | null;
  sources: FieldSourceInput[];
  questions: Array<{
    id: string;
    field: string;
    path: string;
    prompt: string;
    buttons: Array<{ id: string; title: string }>;
    target: Record<string, unknown>;
    answer: Record<string, unknown> | null;
    askedAt: string;
    answeredAt: string | null;
  }>;
}

export interface FieldVersionInput {
  reportId: string;
  version: number;
  data: DailyReportDataV1;
  author: 'agent' | 'reporter';
  changeNote: string;
  messageId: string | null;
  source: FieldSourceInput | null;
  at: string;
}

export { DEMO_NOW, DEMO_ORG_ID, DEMO_USERS };
export type { SiteDayRow };

let instance: DemoStore | null = null;
/** One store per browser session (mutations persist until reload). */
export function getDemoStore(): DemoStore {
  if (!instance) instance = new DemoStore();
  return instance;
}
export function resetDemoStore(): void {
  instance?.dispose();
  instance = null;
}
