import { randomUUID } from 'node:crypto';
import type {
  NoticeData,
  CompanyRow,
  ConsentRow,
  ConsoleEmailRow,
  ConversationRow,
  CountryRow,
  EvidencePackRow,
  GlossaryTermRow,
  JobRow,
  JobType,
  MessageRow,
  OrgRow,
  OrgSettingsRow,
  QuestionRow,
  ReportCostRow,
  ReportRow,
  ReportSourceRow,
  ReportVersionRow,
  ReporterRow,
  SiteDayRow,
  SiteRow,
  SmsOptOutRow,
  TranscriptRow,
  UnknownContactRow,
  UploadRow,
  WeatherEventRow,
} from '@sitelog/shared';
import { backoffSeconds, formatReportNo, reportLanguageFor } from '@sitelog/shared';
import { V12_ROW_DEFAULTS } from '@sitelog/shared';
import { DEMO_COUNTRIES } from '@sitelog/shared/demo/countries.ts';
import { median } from '../cost';
import type { AuditInput, Db, ExpiredMedia, Json, ReportSourceWithMessage } from '../db';

/**
 * In-memory Db for the router/pipeline tests. Mirrors the SQL semantics the jobs rely on
 * (dedupe keys, open-report lookups, version upserts, state_changed_at tracking).
 */

export interface FakeDbData {
  orgs: Map<string, OrgRow>;
  settings: Map<string, OrgSettingsRow>;
  sites: Map<string, SiteRow>;
  reporters: Map<string, ReporterRow>;
  siteReporters: Array<{ site_id: string; reporter_id: string; is_primary: boolean }>;
  recipients: Array<{ site_id: string; email: string }>;
  members: Array<{
    org_id: string;
    user_id: string;
    role: string;
    email: string;
    display_name: string | null;
  }>;
  companies: Map<string, CompanyRow>;
  glossary: Map<string, GlossaryTermRow>;
  conversations: Map<string, ConversationRow>;
  messages: Map<string, MessageRow>;
  transcripts: Map<string, TranscriptRow>;
  unknownContacts: Map<string, UnknownContactRow>;
  siteDays: Map<string, SiteDayRow>;
  reports: Map<string, ReportRow>;
  versions: Map<string, ReportVersionRow>;
  sources: ReportSourceRow[];
  questions: Map<string, QuestionRow>;
  jobs: Map<number, JobRow>;
  /** field_devices.last_seen_at per reporter (D25), set by tests. */
  deviceSeen: Map<string, string>;
  audit: AuditInput[];
  notifications: Array<{
    org_id: string;
    kind: string;
    title: string;
    body: string | null;
    target_path: string | null;
    user_id: string | null;
    data: NoticeData | null;
  }>;
  packs: Map<string, EvidencePackRow>;
  weatherEvents: WeatherEventRow[];
  denormalized: Array<{ report_id: string; version: number }>;
  purged: string[];
  /** storage.objects of the `photos` bucket, as list_orphan_office_photos() reads them. */
  photoObjects: Array<{ name: string; created_at: string }>;
  /** report_costs (§15 cost guardrail). */
  reportCosts: Map<string, ReportCostRow>;
  /** countries (the launch packs by default; tests set sender ids). */
  countries: CountryRow[];
  consents: ConsentRow[];
  /** sms_opt_outs (W1-08): a phone's STOP on a pack's sender, or the provider's opt-out list. */
  smsOptOuts: SmsOptOutRow[];
  fieldLinks: Array<{
    id: string;
    code_hash: string;
    reporter_id: string;
    kind: 'personal';
    revoked_at: string | null;
    created_at: string;
  }>;
  consoleEmails: ConsoleEmailRow[];
  /** uploads: whose they are (the dead-job notice, W1-10), and full rows for W1-11. */
  uploads: Map<
    string,
    Pick<UploadRow, 'id' | 'report_id' | 'reporter_id' | 'site_id'> & Partial<UploadRow>
  >;
  /** field_attach_photos() calls (F9, W2-04): the batches attached and the versions they made. */
  photoBatches: Array<{
    reportId: string;
    batchId: string;
    changeNote: string;
    caption: string | null;
    version: number;
  }>;
}

export interface FakeDb extends Db {
  data: FakeDbData;
  now: () => Date;
  /** Jobs enqueued since the last call. */
  takeJobs(): JobRow[];
  jobsOfType(type: JobType): JobRow[];
}

export function createFakeDb(now: () => Date = () => new Date()): FakeDb {
  const d: FakeDbData = {
    orgs: new Map(),
    settings: new Map(),
    sites: new Map(),
    reporters: new Map(),
    siteReporters: [],
    recipients: [],
    members: [],
    companies: new Map(),
    glossary: new Map(),
    conversations: new Map(),
    messages: new Map(),
    transcripts: new Map(),
    unknownContacts: new Map(),
    siteDays: new Map(),
    reports: new Map(),
    versions: new Map(),
    sources: [],
    questions: new Map(),
    jobs: new Map(),
    deviceSeen: new Map(),
    audit: [],
    notifications: [],
    packs: new Map(),
    weatherEvents: [],
    denormalized: [],
    purged: [],
    photoObjects: [],
    reportCosts: new Map(),
    countries: DEMO_COUNTRIES.map((c) => structuredClone(c)),
    consents: [],
    smsOptOuts: [],
    fieldLinks: [],
    consoleEmails: [],
    uploads: new Map(),
    photoBatches: [],
  };
  let jobSeq = 0;
  let taken = 0;
  const iso = () => now().toISOString();
  const toIso = (v: string | Date | null | undefined): string | null =>
    v == null ? null : v instanceof Date ? v.toISOString() : v;
  const vkey = (r: string, v: number) => `${r}:${v}`;

  const db: FakeDb = {
    data: d,
    now,
    takeJobs() {
      const all = Array.from(d.jobs.values());
      const out = all.slice(taken);
      taken = all.length;
      return out;
    },
    jobsOfType(type) {
      return Array.from(d.jobs.values()).filter((j) => j.type === type);
    },

    async getConversation(id) {
      return (id && d.conversations.get(id)) || null;
    },
    async getConversationByPhone(phone) {
      return Array.from(d.conversations.values()).find((c) => c.phone_e164 === phone) ?? null;
    },
    async ensureConversation(phone, patch) {
      const existing = await db.getConversationByPhone(phone);
      if (existing) {
        const hasPatch = Object.values(patch).some((v) => v !== undefined);
        return hasPatch ? db.updateConversation(existing.id, patch) : existing;
      }
      const row: ConversationRow = {
        id: randomUUID(),
        org_id: patch.org_id ?? null,
        reporter_id: patch.reporter_id ?? null,
        phone_e164: phone,
        state: patch.state ?? 'new',
        context: (patch.context ?? {}) as ConversationRow['context'],
        last_inbound_at: patch.last_inbound_at ? toIso(patch.last_inbound_at) : null,
        last_outbound_at: patch.last_outbound_at ? toIso(patch.last_outbound_at) : null,
        state_changed_at: iso(),
        updated_at: iso(),
      };
      d.conversations.set(row.id, row);
      return row;
    },
    async updateConversation(id, patch) {
      const row = d.conversations.get(id);
      if (!row) throw new Error(`conversation ${id} not found`);
      const next: ConversationRow = { ...row, updated_at: iso() };
      if (patch.org_id !== undefined) next.org_id = patch.org_id;
      if (patch.reporter_id !== undefined) next.reporter_id = patch.reporter_id;
      if (patch.context !== undefined) next.context = patch.context as ConversationRow['context'];
      if (patch.last_outbound_at !== undefined)
        next.last_outbound_at = toIso(patch.last_outbound_at);
      if (patch.last_inbound_at !== undefined) next.last_inbound_at = toIso(patch.last_inbound_at);
      if (patch.state !== undefined && patch.state !== row.state) {
        next.state = patch.state;
        next.state_changed_at = iso();
      }
      d.conversations.set(id, next);
      return next;
    },
    async listConversationsByState(states, changedBefore) {
      return Array.from(d.conversations.values()).filter(
        (c) =>
          states.includes(c.state) &&
          (!changedBefore || new Date(c.state_changed_at) < changedBefore),
      );
    },

    async getMessage(id) {
      return d.messages.get(id) ?? null;
    },
    async getMessageByWaId(waId) {
      return Array.from(d.messages.values()).find((m) => m.wa_message_id === waId) ?? null;
    },
    async insertOutboundMessage(input) {
      const row: MessageRow = {
        ...V12_ROW_DEFAULTS.messages,
        id: randomUUID(),
        conversation_id: input.conversation_id,
        org_id: null,
        direction: 'out',
        wa_message_id: input.wa_message_id ?? null,
        type: input.type,
        body: input.body,
        payload: (input.payload ?? null) as MessageRow['payload'],
        media_id: input.media_id ?? null,
        media_mime: input.media_mime ?? null,
        storage_path: input.storage_path ?? null,
        duration_s: null,
        template_name: input.template_name ?? null,
        status: input.status === 'queued' ? 'queued' : input.status,
        error: input.error ?? null,
        created_at: iso(),
      };
      d.messages.set(row.id, row);
      return row;
    },
    async updateMessage(id, patch) {
      const row = d.messages.get(id);
      if (!row) throw new Error(`message ${id} not found`);
      d.messages.set(id, { ...row, ...(patch as Partial<MessageRow>) });
    },
    async listMessagesBetween(conversationId, from, to, types) {
      return Array.from(d.messages.values()).filter(
        (m) =>
          m.conversation_id === conversationId &&
          m.direction === 'in' &&
          new Date(m.created_at) >= from &&
          new Date(m.created_at) <= to &&
          (!types || (m.type !== null && types.includes(m.type))),
      );
    },

    async getTranscript(messageId) {
      return d.transcripts.get(messageId) ?? null;
    },
    async listTranscripts(ids) {
      // Transcripts are keyed by message id here (the fake has no uploads).
      return ids.map((id) => d.transcripts.get(id)).filter((t): t is TranscriptRow => !!t);
    },
    async upsertTranscript(input) {
      const row: TranscriptRow = {
        ...V12_ROW_DEFAULTS.transcripts,
        id: d.transcripts.get(input.message_id)?.id ?? randomUUID(),
        message_id: input.message_id,
        language: input.language,
        text: input.text,
        segments: input.segments as TranscriptRow['segments'],
        model: input.model,
        created_at: iso(),
      };
      d.transcripts.set(input.message_id, row);
      return row;
    },

    async getUploadTranscript(uploadId) {
      // Upload transcripts share the map, keyed by the upload id (their media id).
      const t = d.transcripts.get(uploadId);
      return t && t.upload_id === uploadId ? t : null;
    },
    async saveUploadTranscript(input) {
      const existing = d.transcripts.get(input.uploadId);
      const transcript: TranscriptRow = existing ?? {
        ...V12_ROW_DEFAULTS.transcripts,
        id: randomUUID(),
        message_id: null,
        upload_id: input.uploadId,
        language: input.language,
        text: input.text,
        segments: input.segments as TranscriptRow['segments'],
        model: input.model,
        created_at: iso(),
      };
      d.transcripts.set(input.uploadId, transcript);
      const u = d.uploads.get(input.uploadId);
      if (u) {
        if (input.durationS !== null) u.duration_s = input.durationS;
        if (input.peaks !== null) u.peaks = input.peaks;
      }
      if (!existing) {
        const site = u ? d.sites.get(u.site_id) : undefined;
        d.audit.push({
          org_id: site?.org_id ?? '',
          actor_type: 'agent',
          action: 'transcript.created',
          entity: 'upload',
          entity_id: input.uploadId,
          diff: input.audit as Json,
        });
      }
      return { transcript, created: !existing };
    },
    async getUpload(id) {
      const u = d.uploads.get(id);
      if (!u) return null;
      return {
        kind: 'audio',
        storage_path: '',
        mime: null,
        bytes: null,
        duration_s: null,
        peaks: null,
        recorded_at: null,
        received_at: null,
        caption: null,
        uploaded_by: null,
        purged_at: null,
        batch_id: null,
        batch_size: null,
        ...u,
      };
    },
    async countBatchPhotos(batchId) {
      return Array.from(d.uploads.values()).filter(
        (u) => u.batch_id === batchId && u.kind === 'photo',
      ).length;
    },
    async attachPhotos(reportId, batchId, changeNote, caption) {
      const done = d.photoBatches.find((b) => b.batchId === batchId);
      if (done) return { version: done.version, alreadyAttached: true };
      const report = d.reports.get(reportId);
      if (!report) throw new Error('report_not_found');
      report.current_version += 1;
      report.status = 'filed';
      d.photoBatches.push({
        reportId,
        batchId,
        changeNote,
        caption,
        version: report.current_version,
      });
      return { version: report.current_version, alreadyAttached: false };
    },
    async listReportVoiceUploads(reportId) {
      return Array.from(d.uploads.values())
        .filter(
          (u) =>
            u.report_id === reportId &&
            (u.kind ?? 'audio') === 'audio' &&
            !u.purged_at &&
            !u.batch_id,
        )
        .sort(
          (a, b) =>
            (a.received_at ?? '').localeCompare(b.received_at ?? '') || a.id.localeCompare(b.id),
        )
        .map((u) => ({
          id: u.id,
          received_at: u.received_at ?? null,
          transcribed: d.transcripts.get(u.id)?.upload_id === u.id,
        }));
    },

    async listReportersByPhone(phone) {
      return Array.from(d.reporters.values()).filter(
        (r) => r.phone_e164 === phone && r.status !== 'disabled',
      );
    },
    async getReporter(id) {
      return d.reporters.get(id) ?? null;
    },
    async optOutReporter(reporterId, at) {
      const r = d.reporters.get(reporterId);
      if (!r) return;
      if (r.status !== 'disabled') r.status = 'opted_out';
      r.opted_out_at = r.opted_out_at ?? at;
    },
    async listInboundReporters(phone, country, scope) {
      return [...d.reporters.values()]
        .filter((r) => r.phone_e164 === phone)
        .map((r) => ({ r, org: d.orgs.get(r.org_id) }))
        .filter(
          ({ org }) =>
            org !== undefined &&
            org.country === country &&
            ('realOnly' in scope ? !org.is_demo : org.id === scope.orgId),
        )
        .sort((a, b) => a.r.created_at.localeCompare(b.r.created_at))
        .map(({ r, org }) => ({
          id: r.id,
          orgId: r.org_id,
          status: r.status,
          contactPref: r.contact_pref,
          activatedAt: r.activated_at,
          optedOutAt: r.opted_out_at,
          createdAt: r.created_at,
          name: r.name,
          phone: r.phone_e164,
          locale: r.locale,
          orgName: org!.name,
          orgIsDemo: org!.is_demo,
        }));
    },
    async updateReporter(id, patch) {
      const row = d.reporters.get(id);
      if (row) d.reporters.set(id, { ...row, ...patch });
    },
    async listSitesForReporter(reporterId) {
      return d.siteReporters
        .filter((sr) => sr.reporter_id === reporterId)
        .map((sr) => d.sites.get(sr.site_id))
        .filter((s): s is SiteRow => !!s && s.status !== 'archived');
    },
    async listReportersForSite(siteId) {
      return d.siteReporters
        .filter((sr) => sr.site_id === siteId)
        .map((sr) => d.reporters.get(sr.reporter_id))
        .filter((r): r is ReporterRow => !!r);
    },
    async getSite(id) {
      return d.sites.get(id) ?? null;
    },
    async listSitesByOrg(orgId) {
      return Array.from(d.sites.values()).filter((s) => s.org_id === orgId);
    },
    async listActiveSites() {
      return Array.from(d.sites.values())
        .filter((s) => s.status === 'active')
        .map((s) => ({
          id: s.id,
          org_id: s.org_id,
          name: s.name,
          project_code: s.project_code,
          address: s.address,
        }));
    },
    async getOrg(id) {
      return d.orgs.get(id) ?? null;
    },
    async listOrgs() {
      return Array.from(d.orgs.values());
    },
    async getOrgSettings(orgId) {
      return d.settings.get(orgId) ?? null;
    },
    async listCompanies(orgId) {
      return Array.from(d.companies.values()).filter((c) => c.org_id === orgId);
    },
    async getCompany(id) {
      return d.companies.get(id) ?? null;
    },
    async insertCompany(orgId, name, status, trade = null) {
      const existing = Array.from(d.companies.values()).find(
        (c) => c.org_id === orgId && c.name === name,
      );
      if (existing) return existing;
      const row: CompanyRow = {
        id: randomUUID(),
        org_id: orgId,
        name,
        trade,
        aliases: [],
        is_self_perform: false,
        status,
        created_at: iso(),
      };
      d.companies.set(row.id, row);
      return row;
    },
    async listGlossary(orgId, siteId = null, reporterId = null) {
      return Array.from(d.glossary.values()).filter(
        (g) =>
          (g.org_id === orgId || g.org_id === null) &&
          (!g.scope_site_id || g.scope_site_id === siteId) &&
          (!g.scope_reporter_id || g.scope_reporter_id === reporterId),
      );
    },
    async upsertGlossaryTerm(input) {
      const existing = Array.from(d.glossary.values()).find(
        (g) =>
          g.org_id === input.org_id &&
          g.heard.toLowerCase() === input.heard.toLowerCase() &&
          g.kind === input.kind,
      );
      if (existing) {
        const next = {
          ...existing,
          times_heard: existing.times_heard + 1,
          last_seen_at: iso(),
          official: existing.official ?? input.official,
        };
        d.glossary.set(existing.id, next);
        return next;
      }
      const row: GlossaryTermRow = {
        id: randomUUID(),
        org_id: input.org_id,
        scope_site_id: input.scope_site_id ?? null,
        scope_reporter_id: input.scope_reporter_id ?? null,
        heard: input.heard,
        official: input.official,
        language: input.language ?? 'en',
        kind: input.kind,
        company_id: input.company_id ?? null,
        status: input.status,
        times_heard: 1,
        first_seen_at: iso(),
        last_seen_at: iso(),
      };
      d.glossary.set(row.id, row);
      return row;
    },
    async listSiteRecipients(siteId) {
      return d.recipients.filter((r) => r.site_id === siteId).map((r) => r.email);
    },
    async listMemberEmails(orgId, roles) {
      return d.members
        .filter((m) => m.org_id === orgId && roles.includes(m.role))
        .map((m) => ({ email: m.email, user_id: m.user_id, display_name: m.display_name }));
    },
    async getUserContact(userId) {
      const m = d.members.find((x) => x.user_id === userId);
      return m ? { email: m.email, display_name: m.display_name } : null;
    },
    async siteContext(siteId) {
      const site = d.sites.get(siteId);
      if (!site) return null;
      const org = d.orgs.get(site.org_id);
      const settings = d.settings.get(site.org_id);
      if (!org || !settings) return null;
      return {
        site,
        org,
        settings,
        companies: await db.listCompanies(org.id),
        glossary: await db.listGlossary(org.id, site.id),
        recipients: await db.listSiteRecipients(site.id),
        reporters: await db.listReportersForSite(site.id),
      };
    },

    async getSiteDay(id) {
      return d.siteDays.get(id) ?? null;
    },
    async findSiteDay(siteId, date) {
      return (
        Array.from(d.siteDays.values()).find((s) => s.site_id === siteId && s.date === date) ?? null
      );
    },
    async getOrCreateSiteDay(siteId, date, deadlineAt) {
      const existing = await db.findSiteDay(siteId, date);
      if (existing) return existing;
      const row: SiteDayRow = {
        id: randomUUID(),
        site_id: siteId,
        date,
        status: 'pending',
        deadline_at: deadlineAt.toISOString(),
        reminder_stage: 0,
        reminders_paused: false,
        is_late: false,
        weather: null,
        report_id: null,
        created_at: iso(),
        updated_at: iso(),
      };
      d.siteDays.set(row.id, row);
      return row;
    },
    async updateSiteDay(id, patch) {
      const row = d.siteDays.get(id);
      if (!row) throw new Error(`site_day ${id} not found`);
      const next: SiteDayRow = {
        ...row,
        ...(patch as Partial<SiteDayRow>),
        deadline_at: patch.deadline_at ? toIso(patch.deadline_at)! : row.deadline_at,
        updated_at: iso(),
      };
      d.siteDays.set(id, next);
      return next;
    },

    async getReport(id) {
      return d.reports.get(id) ?? null;
    },
    async insertReport(input) {
      const org = d.orgs.get(input.org_id);
      const row: ReportRow = {
        ...V12_ROW_DEFAULTS.reports,
        language: input.language ?? reportLanguageFor(org?.locale ?? 'en-US'),
        id: randomUUID(),
        org_id: input.org_id,
        site_id: input.site_id,
        site_day_id: input.site_day_id,
        report_no: input.report_no,
        status: input.status ?? 'collecting',
        current_version: 1,
        reporter_id: input.reporter_id,
        received_at: toIso(input.received_at),
        confirmed_at: null,
        filed_at: null,
        signed_off_by: null,
        signed_off_at: null,
        needs_review: false,
        review_reasons: [],
        is_late: false,
        kind: input.kind,
        created_at: iso(),
        updated_at: iso(),
      };
      d.reports.set(row.id, row);
      return row;
    },
    async updateReport(id, patch) {
      const row = d.reports.get(id);
      if (!row) throw new Error(`report ${id} not found`);
      const next: ReportRow = { ...row, ...(patch as Partial<ReportRow>), updated_at: iso() };
      for (const k of ['confirmed_at', 'filed_at', 'signed_off_at', 'received_at'] as const)
        if (patch[k] !== undefined) next[k] = toIso(patch[k]);
      d.reports.set(id, next);
      return next;
    },
    async findOpenReportForSiteDay(siteDayId) {
      return (
        Array.from(d.reports.values()).find(
          (r) =>
            r.site_day_id === siteDayId &&
            ['collecting', 'awaiting_answer', 'awaiting_confirmation'].includes(r.status),
        ) ?? null
      );
    },
    async findReportForSiteDay(siteDayId) {
      return (
        Array.from(d.reports.values())
          .reverse()
          .find((r) => r.site_day_id === siteDayId && r.status !== 'void') ?? null
      );
    },
    async findReportsByDate(siteIds, date) {
      return Array.from(d.reports.values()).filter(
        (r) =>
          siteIds.includes(r.site_id) &&
          ['filed', 'signed_off'].includes(r.status) &&
          d.siteDays.get(r.site_day_id)?.date === date,
      );
    },
    async listReportsForSitePeriod(siteId, start, end) {
      return Array.from(d.reports.values()).filter(
        (r) =>
          r.site_id === siteId &&
          ['filed', 'signed_off'].includes(r.status) &&
          (d.siteDays.get(r.site_day_id)?.date ?? '') >= start &&
          (d.siteDays.get(r.site_day_id)?.date ?? '') <= end,
      );
    },
    async nextReportNo(siteId) {
      const site = d.sites.get(siteId);
      if (!site) throw new Error('site not found');
      site.report_seq += 1;
      return formatReportNo(site.project_code, site.report_seq);
    },
    async getVersion(reportId, version) {
      return d.versions.get(vkey(reportId, version)) ?? null;
    },
    async listVersions(reportId) {
      return Array.from(d.versions.values())
        .filter((v) => v.report_id === reportId)
        .sort((a, b) => a.version - b.version);
    },
    async insertVersion(input) {
      const existing = d.versions.get(vkey(input.report_id, input.version));
      const report = d.reports.get(input.report_id);
      const isDraft =
        !report ||
        ['collecting', 'processing', 'awaiting_answer', 'awaiting_confirmation'].includes(
          report.status,
        );
      if (existing && report && !isDraft && input.version <= report.current_version) {
        // Same rule as the SQL: a current version of a filed report is immutable.
        throw new Error(
          `report ${input.report_id} version ${input.version} already exists and is immutable`,
        );
      }
      const row: ReportVersionRow = {
        ...V12_ROW_DEFAULTS.report_versions,
        report_id: input.report_id,
        version: input.version,
        data: input.data as ReportVersionRow['data'],
        summary: input.summary,
        pdf_path: existing?.pdf_path ?? null,
        author: existing?.author ?? input.author,
        author_user_id: input.author_user_id ?? null,
        author_message_id: input.author_message_id ?? existing?.author_message_id ?? null,
        change_note: input.change_note ?? null,
        created_at: existing?.created_at ?? iso(),
        // As the trigger of 20261015000070: a new version starts at 1, a change of data bumps it.
        draft_rev: existing ? nextDraftRev(existing, input.data, report) : 1,
      };
      d.versions.set(vkey(input.report_id, input.version), row);
      return row;
    },
    async updateVersion(reportId, version, patch) {
      const row = d.versions.get(vkey(reportId, version));
      if (!row) throw new Error('version not found');
      const { draft_rev: _ignored, ...rest } = patch as Partial<ReportVersionRow>;
      d.versions.set(vkey(reportId, version), {
        ...row,
        ...rest,
        draft_rev:
          'data' in rest
            ? nextDraftRev(row, rest.data, d.reports.get(reportId))
            : (row.draft_rev ?? 1),
      });
    },
    async storeDraftVersion(input) {
      const report = d.reports.get(input.report_id);
      if (
        !report ||
        !FAKE_DRAFT_STATUSES.includes(report.status) ||
        (report.current_version || 1) !== input.version
      )
        return null;
      return db.insertVersion(input);
    },
    async fileVersion(input) {
      // As the SQL: everything or nothing, after checking what the filing was computed from.
      const report = d.reports.get(input.reportId);
      const version = d.versions.get(vkey(input.reportId, input.version));
      if (
        !report ||
        !version ||
        report.status !== input.expect.status ||
        (report.current_version || 1) !== input.version ||
        (version.draft_rev ?? 1) !== input.expect.draftRev
      )
        return { filed: false };
      const updated = await db.updateReport(input.reportId, input.report);
      await db.updateVersion(input.reportId, input.version, {
        data: input.data,
        summary: input.summary,
      });
      await db.denormalizeVersion(input.reportId, input.version);
      await db.updateSiteDay(input.siteDayId, input.siteDay);
      await db.logAudit(input.audit);
      return { filed: true, report: updated };
    },
    async denormalizeVersion(reportId, version) {
      d.denormalized.push({ report_id: reportId, version });
    },
    async insertReportSource(input) {
      if (
        d.sources.some((s) => s.report_id === input.report_id && s.message_id === input.message_id)
      )
        return;
      d.sources.push({
        ...V12_ROW_DEFAULTS.report_sources,
        id: randomUUID(),
        report_id: input.report_id,
        message_id: input.message_id,
        kind: input.kind,
        caption: input.caption ?? null,
        taken_at: toIso(input.taken_at),
      });
    },
    async listReportSources(reportId) {
      return d.sources
        .filter((s) => s.report_id === reportId)
        .map((s): ReportSourceWithMessage | null => {
          const m = s.message_id ? d.messages.get(s.message_id) : undefined;
          if (!m) return null;
          return {
            ...s,
            media_id: s.upload_id ?? s.message_id,
            message_type: m.type,
            storage_path: m.storage_path,
            duration_s: m.duration_s,
            message_created_at: m.created_at,
            media_mime: m.media_mime,
            body: m.body,
          };
        })
        .filter((x): x is ReportSourceWithMessage => !!x)
        .sort((a, b) => a.message_created_at.localeCompare(b.message_created_at));
    },

    async insertQuestion(input) {
      const row: QuestionRow = {
        ...V12_ROW_DEFAULTS.questions,
        id: randomUUID(),
        report_id: input.report_id,
        field: input.field,
        target: input.target as QuestionRow['target'],
        prompt: input.prompt,
        options: input.options as QuestionRow['options'],
        asked_message_id: input.asked_message_id ?? null,
        answered_message_id: null,
        answer: null,
        asked_at: toIso(input.asked_at),
        answered_at: null,
        created_at: iso(),
        channel: input.channel ?? null,
      };
      d.questions.set(row.id, row);
      return row;
    },
    async setReportStatus(id, to, from) {
      const row = d.reports.get(id);
      if (!row || !from.includes(row.status)) return false;
      d.reports.set(id, { ...row, status: to, updated_at: iso() });
      return true;
    },
    async reporterDeviceLastSeen(reporterId) {
      return d.deviceSeen.get(reporterId) ?? null;
    },
    async hasActiveReportJob(type, reportId, exceptJobId) {
      return Array.from(d.jobs.values()).some(
        (j) =>
          j.type === type &&
          j.id !== exceptJobId &&
          (j.status === 'queued' || j.status === 'running') &&
          (j.payload as { reportId?: string } | null)?.reportId === reportId,
      );
    },
    async getQuestion(id) {
      return d.questions.get(id) ?? null;
    },
    async listQuestions(reportId) {
      return Array.from(d.questions.values()).filter((q) => q.report_id === reportId);
    },
    async updateQuestion(id, patch) {
      const row = d.questions.get(id);
      if (!row) throw new Error('question not found');
      const next = { ...row, ...(patch as Partial<QuestionRow>) };
      if (patch.asked_at !== undefined) next.asked_at = toIso(patch.asked_at);
      if (patch.answered_at !== undefined) next.answered_at = toIso(patch.answered_at);
      d.questions.set(id, next);
    },

    async findPendingUnknownContact(phone) {
      return (
        Array.from(d.unknownContacts.values()).find(
          (u) => u.phone_e164 === phone && u.status === 'pending',
        ) ?? null
      );
    },
    async getUnknownContact(id) {
      return d.unknownContacts.get(id) ?? null;
    },
    async insertUnknownContact(input) {
      const row: UnknownContactRow = {
        id: randomUUID(),
        org_id: input.org_id,
        phone_e164: input.phone_e164,
        message_id: input.message_id,
        snippet: input.snippet,
        guessed_site_id: input.guessed_site_id ?? null,
        status: 'pending',
        created_at: iso(),
        channel: input.channel,
        call_id: null,
      };
      d.unknownContacts.set(row.id, row);
      return row;
    },
    async updateUnknownContact(id, patch) {
      const row = d.unknownContacts.get(id);
      if (row) d.unknownContacts.set(id, { ...row, ...patch });
    },

    async getCountry(code) {
      return d.countries.find((c) => c.code === code) ?? null;
    },
    async listCountries() {
      return [...d.countries].sort((a, b) => a.code.localeCompare(b.code));
    },
    async listConsents(reporterId) {
      return d.consents
        .filter((c) => c.reporter_id === reporterId)
        .map((c) => ({ type: c.type, revoked_at: c.revoked_at }));
    },
    async insertSmsMessage(row) {
      if (
        row.provider_message_id &&
        [...d.messages.values()].some((m) => m.provider_message_id === row.provider_message_id)
      )
        throw Object.assign(new Error('duplicate provider_message_id'), { code: '23505' });
      d.messages.set(row.id, {
        ...V12_ROW_DEFAULTS.messages,
        id: row.id,
        conversation_id: null,
        org_id: row.org_id,
        direction: row.direction,
        wa_message_id: null,
        type: null,
        body: row.body,
        payload: (row.payload ?? null) as MessageRow['payload'],
        media_id: null,
        media_mime: null,
        storage_path: null,
        duration_s: null,
        template_name: null,
        status: row.status,
        error: row.error,
        created_at: iso(),
        reporter_id: row.reporter_id,
        phone_e164: row.phone_e164,
        provider: row.provider,
        provider_message_id: row.provider_message_id,
        copy_key: row.copy_key,
        channel: row.channel,
      });
    },
    async updateSmsMessage(id, patch) {
      Object.assign(d.messages.get(id)!, patch);
    },
    async listMessagesByDedupeKey(reporterId, dedupeKey) {
      return [...d.messages.values()]
        .filter(
          (x) =>
            x.reporter_id === reporterId &&
            (x.payload as { dedupe_key?: string } | null)?.dedupe_key === dedupeKey,
        )
        .map((m) => {
          const payload = m.payload as { error_code?: string; attempt?: number } | null;
          return {
            id: m.id,
            channel: m.channel,
            status: m.status,
            provider: m.provider,
            provider_message_id: m.provider_message_id,
            error: m.error,
            error_code: payload?.error_code ?? null,
            attempt: payload?.attempt ?? null,
          };
        });
    },
    async markSmsHandled(messageId, at) {
      const m = d.messages.get(messageId);
      if (!m) return;
      m.payload = { ...((m.payload as Record<string, Json> | null) ?? {}), handled_at: at };
    },
    async hasPendingUnknownContact(phone, channel, excludeMessageId = null) {
      return [...d.unknownContacts.values()].some(
        (u) =>
          u.phone_e164 === phone &&
          u.channel === channel &&
          u.status === 'pending' &&
          (excludeMessageId === null || u.message_id !== excludeMessageId),
      );
    },
    async linkedContactOrgs(phone, country) {
      const orgs = new Set<string>();
      for (const u of d.unknownContacts.values()) {
        if (u.phone_e164 !== phone || u.status !== 'linked' || !u.org_id) continue;
        const org = d.orgs.get(u.org_id);
        if (org && org.country === country && !org.is_demo) orgs.add(u.org_id);
      }
      return [...orgs];
    },
    async insertSmsUnknownContact(row) {
      const existing = [...d.unknownContacts.values()].find((u) => u.message_id === row.message_id);
      if (existing) return { id: existing.id, created: false };
      const contact = await db.insertUnknownContact({
        org_id: row.org_id,
        phone_e164: row.phone_e164,
        channel: 'sms',
        message_id: row.message_id,
        snippet: row.snippet,
      });
      return { id: contact.id, created: true };
    },
    async applyInboundChange(input) {
      // One transaction: called through `db` (a test may make one of them throw), rolled back
      // to the state before on any failure.
      const before = d.reporters.get(input.reporterId);
      const audited = d.audit.length;
      const notified = d.notifications.length;
      try {
        await db.updateReporter(input.reporterId, input.patch);
        await db.logAudit(input.audit);
        const n = input.notification;
        if (n) await db.notifyOrg(n.orgId, n.kind, n.title, n.body, n.targetPath, null, n.data);
      } catch (err) {
        if (before) d.reporters.set(input.reporterId, before);
        d.audit.length = audited;
        d.notifications.length = notified;
        throw err;
      }
    },
    async isSmsOptedOut(phone, country) {
      return d.smsOptOuts.some((o) => o.phone_e164 === phone && o.country === country);
    },
    async recordSmsOptOut(row) {
      if (d.smsOptOuts.some((o) => o.phone_e164 === row.phone_e164 && o.country === row.country))
        return;
      d.smsOptOuts.push({ ...row, opted_out_at: iso() });
    },
    async clearSmsOptOut(phone, country) {
      d.smsOptOuts = d.smsOptOuts.filter((o) => !(o.phone_e164 === phone && o.country === country));
    },
    async listPersonalLinks(reporterId) {
      return d.fieldLinks
        .filter((l) => l.reporter_id === reporterId && l.kind === 'personal' && !l.revoked_at)
        .reverse()
        .map(({ id, code_hash }) => ({ id, code_hash }));
    },
    async insertPersonalLink(row) {
      if (d.fieldLinks.some((l) => l.code_hash === row.code_hash)) return false;
      d.fieldLinks.push({ ...row, kind: 'personal', revoked_at: null, created_at: iso() });
      return true;
    },
    async insertConsoleEmail(row) {
      const key = row.dedupe_key ?? null;
      const taken = key ? d.consoleEmails.find((e) => e.dedupe_key === key) : undefined;
      if (taken) return taken.id;
      const id = randomUUID();
      d.consoleEmails.push({ ...row, dedupe_key: key, id, created_at: iso() });
      return id;
    },

    async notifyOrg(
      orgId,
      kind,
      title,
      body = null,
      targetPath = null,
      userId = null,
      data = null,
    ) {
      d.notifications.push({
        org_id: orgId,
        kind,
        title,
        body,
        target_path: targetPath,
        user_id: userId,
        data,
      });
      return randomUUID();
    },
    async logAudit(input) {
      d.audit.push(input);
    },

    async claimJobs(worker, limit) {
      const out: JobRow[] = [];
      for (const j of d.jobs.values()) {
        if (out.length >= limit) break;
        if (j.status === 'queued' && new Date(j.run_after) <= now()) {
          Object.assign(j, {
            status: 'running',
            locked_at: iso(),
            locked_by: worker,
            attempts: j.attempts + 1,
          });
          out.push({ ...j });
        }
      }
      return out;
    },
    async completeJob(id) {
      const j = d.jobs.get(id);
      if (j) Object.assign(j, { status: 'done', finished_at: iso() });
    },
    async failJob(id, error) {
      const j = d.jobs.get(id);
      if (!j) return;
      // fail_job() (20261015000001, GAP D17): 30 s · 2 min · 10 min · 30 min · 2 h, dead after the 6th.
      const wait = backoffSeconds(j.attempts);
      if (wait === null)
        Object.assign(j, {
          status: 'dead',
          last_error: error,
          finished_at: iso(),
          locked_at: null,
          locked_by: null,
        });
      else
        Object.assign(j, {
          status: 'queued',
          last_error: error,
          run_after: new Date(now().getTime() + wait * 1000).toISOString(),
          locked_at: null,
          locked_by: null,
        });
    },
    async heartbeatJob(id, worker) {
      const j = d.jobs.get(id);
      if (!j || j.status !== 'running' || j.locked_by !== worker) return false;
      j.locked_at = iso();
      return true;
    },
    async getJob(id) {
      return d.jobs.get(id) ?? null;
    },
    async getUploadOwner(id) {
      const u = d.uploads.get(id);
      return u
        ? { id: u.id, report_id: u.report_id, reporter_id: u.reporter_id, site_id: u.site_id }
        : null;
    },
    async enqueueJob(type, payload, opts = {}) {
      if (opts.dedupeKey) {
        // D16 (20261015000001): a key names one job for good, whatever its status.
        const existing = Array.from(d.jobs.values()).find((j) => j.dedupe_key === opts.dedupeKey);
        if (existing) return existing.id;
      }
      const id = ++jobSeq;
      d.jobs.set(id, {
        id,
        type,
        payload: payload as JobRow['payload'],
        status: 'queued',
        attempts: 0,
        run_after: toIso(opts.runAfter) ?? iso(),
        locked_at: null,
        locked_by: null,
        last_error: null,
        dedupe_key: opts.dedupeKey ?? null,
        lock_key: null,
        created_at: iso(),
        finished_at: null,
      });
      return id;
    },
    async updateJobMetrics(id, metrics) {
      const j = d.jobs.get(id);
      if (j)
        j.payload = {
          ...(j.payload as Record<string, Json>),
          metrics: metrics as Json,
        } as JobRow['payload'];
    },
    async queueStats() {
      const all = Array.from(d.jobs.values());
      return {
        queued: all.filter((j) => j.status === 'queued').length,
        running: all.filter((j) => j.status === 'running').length,
        dead: all.filter((j) => j.status === 'dead').length,
      };
    },

    // Mirrors report_cost_inputs() / report_cost_baseline() (20261012000003_ops.sql).
    async reportCostInputs(reportId) {
      const obj = (v: unknown): Record<string, unknown> =>
        v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
      const report = d.reports.get(reportId);
      const sourceIds = new Set(
        d.sources.filter((s) => s.report_id === reportId).map((s) => s.message_id),
      );
      let aiUsd = 0;
      let jobCount = 0;
      for (const j of d.jobs.values()) {
        const p = obj(j.payload);
        const refs =
          p.reportId === reportId ||
          (typeof p.messageId === 'string' && sourceIds.has(p.messageId));
        if (!refs) continue;
        const m = obj(p.metrics);
        jobCount++;
        aiUsd +=
          typeof m.costUsdTotal === 'number'
            ? m.costUsdTotal
            : typeof m.estCostUsd === 'number'
              ? m.estCostUsd
              : 0;
      }
      const waTemplates = Array.from(d.messages.values()).filter((m) => {
        if (m.direction !== 'out' || m.type !== 'template' || m.status === 'failed') return false;
        const p = obj(m.payload);
        return p.reportId === reportId || (!!report && p.siteDayId === report.site_day_id);
      }).length;
      return { aiUsd, jobCount, waTemplates };
    },
    async reportCostBaseline({ kind, before, excludeReportId, days }) {
      const end = new Date(before).getTime();
      const start = end - days * 86_400_000;
      const costs = Array.from(d.reportCosts.values())
        .filter((c) => {
          const t = new Date(c.filed_at).getTime();
          return c.kind === kind && t < end && t >= start && c.report_id !== excludeReportId;
        })
        .map((c) => c.cost_cents);
      return { medianCents: median(costs), sample: costs.length };
    },
    async getReportCost(reportId) {
      return d.reportCosts.get(reportId) ?? null;
    },
    async upsertReportCost(input) {
      const prev = d.reportCosts.get(input.report_id);
      const row: ReportCostRow = {
        ...input,
        kind: prev?.kind ?? input.kind,
        filed_at: prev?.filed_at ?? toIso(input.filed_at)!,
        computed_at: iso(),
      };
      d.reportCosts.set(row.report_id, row);
      return row;
    },

    async getEvidencePack(id) {
      return d.packs.get(id) ?? null;
    },
    async updateEvidencePack(id, patch) {
      const row = d.packs.get(id);
      if (row) d.packs.set(id, { ...row, ...patch });
    },
    async listWeatherEvents(siteId, start, end) {
      return d.weatherEvents.filter(
        (w) => w.site_id === siteId && w.date >= start && w.date <= end,
      );
    },
    async listExpiredMedia(before, limit) {
      return Array.from(d.messages.values())
        .filter(
          (m) =>
            m.direction === 'in' &&
            m.storage_path &&
            (m.type === 'audio' || m.type === 'image' || m.type === 'document') &&
            new Date(m.created_at) < before &&
            !d.purged.includes(m.id),
        )
        .sort((a, b) => a.created_at.localeCompare(b.created_at))
        .slice(0, limit)
        .map((m): ExpiredMedia => ({
          id: m.id,
          storage_path: m.storage_path!,
          bucket: m.type === 'audio' ? 'audio' : 'photos',
          created_at: m.created_at,
        }));
    },
    async getInvoiceSummary() {
      return null;
    },
    async listOrphanOfficePhotos(before, limit) {
      const stored = new Set(
        [...d.messages.values()].filter((m) => m.org_id).map((m) => m.storage_path),
      );
      return d.photoObjects
        .filter(
          (o) =>
            /^[^/]+\/[^/]+\/office\/[^/]+$/.test(o.name) &&
            new Date(o.created_at) < before &&
            !stored.has(o.name),
        )
        .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.name.localeCompare(b.name))
        .slice(0, limit)
        .map((o) => o.name);
    },
    async purgeFinishedJobs(before, limit) {
      const cutoff = before.toISOString();
      const ids = [...d.jobs.values()]
        .filter((j) => j.status === 'done' && j.finished_at !== null && j.finished_at < cutoff)
        .map((j) => j.id)
        .slice(0, limit);
      for (const id of ids) d.jobs.delete(id);
      return ids.length;
    },
    async purgeMedia(messageId, purgedAt) {
      const m = d.messages.get(messageId);
      if (m) {
        d.messages.set(messageId, {
          ...m,
          storage_path: null,
          payload: {
            ...((m.payload as Record<string, Json>) ?? {}),
            purged_at: purgedAt.toISOString(),
          } as MessageRow['payload'],
        });
        d.transcripts.delete(messageId);
        d.purged.push(messageId);
      }
    },
    async digestStats() {
      return {
        siteDays: 0,
        filed: 0,
        onTime: 0,
        weatherHoursBySite: [],
        unsigned: [],
        invoiceGaps: [],
      };
    },
    async close() {},
  };
  return db;
}

const FAKE_DRAFT_STATUSES: readonly ReportRow['status'][] = [
  'collecting',
  'processing',
  'awaiting_answer',
  'awaiting_confirmation',
];

/**
 * report_versions_draft_rev() (20261015000070, 20261015000090): the revision after a write of
 * `data`; a version whose report is no longer a draft keeps its revision.
 */
function nextDraftRev(
  row: ReportVersionRow,
  data: unknown,
  report: Pick<ReportRow, 'status'> | undefined,
): number {
  const rev = row.draft_rev ?? 1;
  if (!report || !FAKE_DRAFT_STATUSES.includes(report.status)) return rev;
  return JSON.stringify(row.data) === JSON.stringify(data) ? rev : rev + 1;
}
