import type {
  ConsentRow,
  ConsentType,
  CountryRow,
  FieldDeviceRow,
  FieldLinkRow,
  OrgRow,
  OrgSettingsRow,
  QuestionRow,
  ReportRow,
  ReportVersionRow,
  ReporterRow,
  SiteDayRow,
  SiteRow,
  UploadRow,
} from '@sitelog/shared';
import { deadlineInstant, jobKeys } from '@sitelog/shared';
import type { AuditEntry } from '../_shared/audit.ts';
import type { StoredObject } from './logic.ts';
import {
  FieldDbError,
  type AnswerInput,
  type AnswerResult,
  type CompleteUploadResult,
  type ConfirmResult,
  type DayStatusResult,
  type FieldStore,
  type OrgContext,
  type RateLimitResult,
  type ReportWithDate,
} from './store.ts';

/**
 * An in-memory FieldStore for the Deno tests (app_test.ts). The RPCs and the rate limiter
 * follow the SQL of 20261014000006_field_api.sql, which supabase/db-tests tests on PGlite; this
 * fake only has to agree with it on the cases the route tests use.
 */
/** A `jobs` row as the fake keeps it. */
export interface FakeJob {
  id: number;
  type: string;
  payload: Record<string, unknown>;
  dedupe_key: string;
  status: 'queued' | 'running' | 'done' | 'failed' | 'dead';
  attempts?: number;
}

export class FakeFieldStore implements FieldStore {
  links: FieldLinkRow[] = [];
  reporters: ReporterRow[] = [];
  orgs: OrgRow[] = [];
  countries: CountryRow[] = [];
  settings: OrgSettingsRow[] = [];
  sites: SiteRow[] = [];
  siteReporters: { site_id: string; reporter_id: string }[] = [];
  devices: FieldDeviceRow[] = [];
  rates = new Map<string, { start: number; count: number }>();
  consents: ConsentRow[] = [];
  siteDays: SiteDayRow[] = [];
  reports: ReportRow[] = [];
  versions: ReportVersionRow[] = [];
  questions: QuestionRow[] = [];
  uploads: UploadRow[] = [];
  transcripts: { upload_id: string }[] = [];
  sources: { report_id: string; kind: string; upload_id: string }[] = [];
  /** Storage: `{bucket}/{path}` → what Storage reports for the object. */
  objects = new Map<string, StoredObject>();
  jobs: FakeJob[] = [];
  audits: AuditEntry[] = [];
  /** field_flag_late_upload(): uploads flagged late, and the office notices (one per report). */
  lateUploads: string[] = [];
  lateNotices: { reportId: string; uploadId: string }[] = [];
  /** field_revoke_consent(): the office notices of a revoked required consent. */
  consentNotices: { orgId: string; reporterId: string; type: ConsentType }[] = [];
  /** field_device_verify_locked(): the office notices of a locked device check (one per window). */
  lockNotices: { orgId: string; reporterId: string; deviceId: string; until: string }[] = [];
  /** Store methods called, for "no write happened" checks. */
  calls: string[] = [];
  private seq = 0;

  constructor(private readonly now: () => Date) {}

  private id(prefix: string): string {
    this.seq++;
    return `${prefix}-0000-4000-8000-${this.seq.toString(16).padStart(12, '0')}`;
  }
  private iso(): string {
    return this.now().toISOString();
  }

  findLink(codeHash: string) {
    return Promise.resolve(this.links.find((l) => l.code_hash === codeHash) ?? null);
  }
  markLinkOpened(linkId: string, at: string) {
    const link = this.links.find((l) => l.id === linkId)!;
    const first = link.last_opened_at === null;
    link.last_opened_at = at;
    return Promise.resolve(first);
  }
  getReporter(id: string) {
    return Promise.resolve(this.reporters.find((r) => r.id === id) ?? null);
  }
  updateReporter(id: string, patch: Partial<ReporterRow>) {
    this.calls.push('updateReporter');
    const r = this.reporters.find((x) => x.id === id)!;
    Object.assign(r, patch);
    return Promise.resolve({ ...r });
  }
  getOrgContext(orgId: string): Promise<OrgContext | null> {
    const org = this.orgs.find((o) => o.id === orgId);
    if (!org) return Promise.resolve(null);
    const country = this.countries.find((c) => c.code === org.country)!;
    const settings = this.settings.find((s) => s.org_id === orgId) ?? null;
    return Promise.resolve({ org, country, settings });
  }
  listReporterSites(reporterId: string) {
    const r = this.reporters.find((x) => x.id === reporterId)!;
    const ids = new Set(
      this.siteReporters.filter((l) => l.reporter_id === reporterId).map((l) => l.site_id),
    );
    return Promise.resolve(
      this.sites
        .filter((s) => ids.has(s.id) && s.org_id === r.org_id)
        .sort((a, b) => a.name.localeCompare(b.name)),
    );
  }

  findDevice(tokenHash: string) {
    return Promise.resolve(this.devices.find((d) => d.device_token_hash === tokenHash) ?? null);
  }
  insertDevice(row: { reporter_id: string; device_token_hash: string; user_agent: string | null }) {
    this.calls.push('insertDevice');
    const d: FieldDeviceRow = {
      id: this.id('dddddddd'),
      ...row,
      verified_at: null,
      last_seen_at: null,
      revoked_at: null,
      code_hash: null,
      code_expires_at: null,
    };
    this.devices.push(d);
    return Promise.resolve({ ...d });
  }
  updateDevice(id: string, patch: Partial<FieldDeviceRow>) {
    Object.assign(
      this.devices.find((d) => d.id === id)!,
      patch,
    );
    return Promise.resolve();
  }
  rateLimit(key: string, limit: number, windowSeconds: number): Promise<RateLimitResult> {
    const now = this.now().getTime();
    let w = this.rates.get(key);
    if (!w || w.start <= now - windowSeconds * 1000) {
      w = { start: now, count: 0 };
      this.rates.set(key, w);
    }
    w.count++;
    return Promise.resolve({
      allowed: w.count <= limit,
      count: w.count,
      resetAt: new Date(w.start + windowSeconds * 1000).toISOString(),
    });
  }

  deviceVerifyLocked(reporterId: string, deviceId: string, until: string) {
    this.calls.push('deviceVerifyLocked');
    const r = this.reporters.find((x) => x.id === reporterId);
    if (!r) return Promise.reject(new FieldDbError('reporter_not_found'));
    if (this.lockNotices.some((n) => n.reporterId === reporterId && n.until === until)) {
      return Promise.resolve({ locked: false });
    }
    this.lockNotices.push({ orgId: r.org_id, reporterId, deviceId, until });
    this.audits.push({
      orgId: r.org_id,
      actorType: 'reporter',
      actorId: reporterId,
      action: 'device.verify_locked',
      entity: 'field_device',
      entityId: deviceId,
      diff: { until, notified: true },
    });
    return Promise.resolve({ locked: true });
  }

  listDailyLinks(reporterId: string, siteId: string, reportDate: string) {
    return Promise.resolve(
      this.links
        .filter(
          (l) =>
            l.kind === 'daily' &&
            l.reporter_id === reporterId &&
            l.site_id === siteId &&
            l.report_date === reportDate &&
            l.revoked_at === null,
        )
        .reverse()
        .map((l) => ({ id: l.id, code_hash: l.code_hash, expires_at: l.expires_at })),
    );
  }
  insertDailyLink(row: {
    id: string;
    code_hash: string;
    reporter_id: string;
    site_id: string;
    report_date: string;
    expires_at: string;
  }) {
    this.calls.push('insertDailyLink');
    if (this.links.some((l) => l.code_hash === row.code_hash)) return Promise.resolve(false);
    this.links.push({
      ...row,
      kind: 'daily',
      revoked_at: null,
      last_opened_at: null,
      created_at: this.iso(),
    });
    return Promise.resolve(true);
  }

  listConsents(reporterId: string) {
    return Promise.resolve(this.consents.filter((c) => c.reporter_id === reporterId));
  }
  insertConsents(rows: Omit<ConsentRow, 'id' | 'given_at' | 'revoked_at'>[]) {
    const out = rows.map((r): ConsentRow => ({
      ...r,
      id: this.id('cccccccc'),
      given_at: this.iso(),
      revoked_at: null,
    }));
    this.consents.push(...out);
    return Promise.resolve(out);
  }

  getSiteDay(siteId: string, date: string) {
    return Promise.resolve(
      this.siteDays.find((d) => d.site_id === siteId && d.date === date) ?? null,
    );
  }
  getSiteDayById(id: string) {
    return Promise.resolve(this.siteDays.find((d) => d.id === id) ?? null);
  }
  getLiveReport(siteDayId: string) {
    return Promise.resolve(
      this.reports.find((r) => r.site_day_id === siteDayId && r.status !== 'void') ?? null,
    );
  }
  getReport(id: string) {
    return Promise.resolve(this.reports.find((r) => r.id === id) ?? null);
  }
  getVersion(reportId: string, version: number) {
    return Promise.resolve(
      this.versions.find((v) => v.report_id === reportId && v.version === version) ?? null,
    );
  }
  getOpenQuestion(reportId: string) {
    return Promise.resolve(
      this.questions.filter((q) => q.report_id === reportId && q.answered_at === null).at(-1) ??
        null,
    );
  }
  getQuestion(id: string) {
    return Promise.resolve(this.questions.find((q) => q.id === id) ?? null);
  }
  countReportMedia(reportId: string) {
    const ups = this.uploads.filter((u) => u.report_id === reportId);
    const voice = ups.filter((u) => u.kind === 'audio');
    return Promise.resolve({
      voiceNotes: voice.length,
      transcribed: voice.filter((u) => this.transcripts.some((t) => t.upload_id === u.id)).length,
      photos: ups.length - voice.length,
    });
  }
  listRecentReports(siteIds: string[], sinceDate: string): Promise<ReportWithDate[]> {
    const out: ReportWithDate[] = [];
    for (const r of this.reports) {
      const day = this.siteDays.find((d) => d.id === r.site_day_id)!;
      if (siteIds.includes(r.site_id) && day.date >= sinceDate && r.status !== 'void')
        out.push({ ...r, date: day.date });
    }
    return Promise.resolve(out);
  }

  insertUpload(
    row: Pick<
      UploadRow,
      'id' | 'reporter_id' | 'site_id' | 'kind' | 'storage_path' | 'mime' | 'bytes' | 'recorded_at'
    >,
  ) {
    this.calls.push('insertUpload');
    const u: UploadRow = {
      ...row,
      report_id: null,
      duration_s: null,
      peaks: null,
      received_at: this.iso(),
      caption: null,
      uploaded_by: null,
      purged_at: null,
    };
    this.uploads.push(u);
    return Promise.resolve({ ...u });
  }
  getUpload(id: string) {
    return Promise.resolve(this.uploads.find((u) => u.id === id) ?? null);
  }
  createSignedUploadUrl(bucket: string, path: string) {
    return Promise.resolve({
      signedUrl: `https://storage.test/storage/v1/object/upload/sign/${bucket}/${path}?token=t`,
      token: 't',
    });
  }
  /** Puts an object in storage as an upload through the signed URL would. */
  put(key: string, contentType = key.startsWith('audio/') ? 'audio/webm' : 'image/jpeg', size = 1) {
    this.objects.set(key, { contentType, size });
  }
  objectInfo(bucket: string, path: string) {
    return Promise.resolve(this.objects.get(`${bucket}/${path}`) ?? null);
  }
  removeObject(bucket: string, path: string) {
    this.calls.push('removeObject');
    this.objects.delete(`${bucket}/${path}`);
    return Promise.resolve();
  }
  createSignedUrl(bucket: string, path: string, seconds: number) {
    return Promise.resolve(`https://storage.test/${bucket}/${path}?expires=${seconds}`);
  }

  /** The site-day, created when missing (field_lock_site_day). */
  private siteDay(siteId: string, date: string): SiteDayRow {
    const existing = this.siteDays.find((d) => d.site_id === siteId && d.date === date);
    if (existing) return existing;
    const site = this.sites.find((s) => s.id === siteId)!;
    const settings = this.settings.find((s) => s.org_id === site.org_id);
    const deadline = (site.deadline ?? settings?.default_deadline ?? '17:30').slice(0, 5);
    const row: SiteDayRow = {
      id: this.id('aaaaaaaa'),
      site_id: siteId,
      date,
      status: 'pending',
      deadline_at: deadlineInstant(date, deadline, site.timezone).toISOString(),
      reminder_stage: 0,
      reminders_paused: false,
      is_late: false,
      weather: null,
      report_id: null,
      created_at: this.iso(),
      updated_at: this.iso(),
    };
    this.siteDays.push(row);
    return row;
  }

  private onSite(reporterId: string, siteId: string): boolean {
    const r = this.reporters.find((x) => x.id === reporterId);
    const s = this.sites.find((x) => x.id === siteId);
    return (
      !!r &&
      !!s &&
      r.org_id === s.org_id &&
      this.siteReporters.some((l) => l.reporter_id === reporterId && l.site_id === siteId)
    );
  }

  completeUpload(
    uploadId: string,
    reporterId: string,
    bytes: number | null,
  ): Promise<CompleteUploadResult> {
    this.calls.push('completeUpload');
    const u = this.uploads.find((x) => x.id === uploadId);
    if (!u || u.reporter_id !== reporterId || !this.onSite(reporterId, u.site_id)) {
      return Promise.reject(new FieldDbError('upload_not_found'));
    }
    if (u.report_id) {
      const r = this.reports.find((x) => x.id === u.report_id)!;
      return Promise.resolve({
        reportId: r.id,
        reportNo: r.report_no,
        reportStatus: r.status,
        created: false,
        alreadyComplete: true,
        jobId: null,
      });
    }
    const site = this.sites.find((s) => s.id === u.site_id)!;
    const date = u.storage_path.split('/')[2]!;
    const day = this.siteDay(site.id, date);
    let r = this.reports.find((x) => x.site_day_id === day.id && x.status !== 'void');
    if (r && (r.status === 'filed' || r.status === 'signed_off')) {
      return Promise.reject(new FieldDbError('report_filed'));
    }
    if (!r && ['filed', 'weather_day', 'no_work'].includes(day.status)) {
      return Promise.reject(new FieldDbError('day_closed'));
    }
    if (r && this.filingJob(r.id)) {
      return Promise.reject(new FieldDbError('report_filing'));
    }
    let created = false;
    if (!r) {
      site.report_seq++;
      const org = this.orgs.find((o) => o.id === site.org_id)!;
      r = {
        id: this.id('bbbbbbbb'),
        org_id: site.org_id,
        site_id: site.id,
        site_day_id: day.id,
        report_no: `${site.project_code}-${String(site.report_seq).padStart(4, '0')}`,
        status: u.kind === 'audio' ? 'processing' : 'collecting',
        current_version: 1,
        reporter_id: reporterId,
        received_at: this.iso(),
        confirmed_at: null,
        filed_at: null,
        signed_off_by: null,
        signed_off_at: null,
        needs_review: false,
        review_reasons: [],
        is_late: false,
        kind: 'daily',
        created_at: this.iso(),
        updated_at: this.iso(),
        channel: 'web',
        language: org.locale === 'tr-TR' ? 'tr' : 'en',
        confirmed_via: null,
      };
      this.reports.push(r);
      created = true;
    } else if (u.kind === 'audio') {
      r.status = 'processing';
    }
    u.report_id = r.id;
    u.received_at = this.iso();
    u.bytes = bytes ?? u.bytes;
    this.sources.push({
      report_id: r.id,
      kind: u.kind === 'audio' ? 'voice_note' : 'photo',
      upload_id: u.id,
    });
    let jobId: number | null = null;
    if (u.kind === 'audio') {
      if (['pending', 'reminded', 'missing'].includes(day.status)) day.status = 'processing';
      jobId = this.jobs.length + 1;
      this.jobs.push({
        id: jobId,
        type: 'transcribe_upload',
        payload: { uploadId: u.id },
        dedupe_key: `transcribe_upload:${u.id}`,
        status: 'queued',
      });
    }
    return Promise.resolve({
      reportId: r.id,
      reportNo: r.report_no,
      reportStatus: r.status,
      created,
      alreadyComplete: false,
      jobId,
    });
  }

  revokeConsent(
    reporterId: string,
    type: ConsentType,
    deviceId: string,
  ): Promise<{ revoked: boolean; notified: boolean }> {
    this.calls.push('revokeConsent');
    const r = this.reporters.find((x) => x.id === reporterId);
    if (!r) return Promise.reject(new FieldDbError('reporter_not_found'));
    const rows = this.consents.filter(
      (c) => c.reporter_id === reporterId && c.type === type && c.revoked_at === null,
    );
    if (rows.length === 0) return Promise.resolve({ revoked: false, notified: false });
    for (const c of rows) c.revoked_at = this.iso();
    const notified = type === 'recording' || type === 'data_processing';
    if (notified) this.consentNotices.push({ orgId: r.org_id, reporterId, type });
    this.audits.push({
      orgId: r.org_id,
      actorType: 'reporter',
      actorId: reporterId,
      action: 'consent.revoked',
      entity: 'consent',
      entityId: rows[0]!.id,
      diff: {
        type,
        consent_ids: rows.map((c) => c.id),
        method: 'web',
        device_id: deviceId,
        notified,
      },
    });
    return Promise.resolve({ revoked: true, notified });
  }

  flagLateUpload(uploadId: string, reporterId: string): Promise<{ flagged: boolean }> {
    this.calls.push('flagLateUpload');
    const u = this.uploads.find((x) => x.id === uploadId);
    if (!u || u.reporter_id !== reporterId || !u.report_id) {
      return Promise.reject(new FieldDbError('upload_not_found'));
    }
    if (this.lateUploads.includes(uploadId)) return Promise.resolve({ flagged: false });
    const r = this.reports.find((x) => x.id === u.report_id)!;
    const day = this.siteDays.find((d) => d.id === r.site_day_id)!;
    const notified = this.lateNotices.some((n) => n.reportId === r.id);
    r.is_late = true;
    day.is_late = true;
    this.lateUploads.push(uploadId);
    if (!notified) this.lateNotices.push({ reportId: r.id, uploadId });
    this.audits.push({
      orgId: r.org_id,
      actorType: 'reporter',
      actorId: reporterId,
      action: 'upload.accepted_late',
      entity: 'upload',
      entityId: uploadId,
      diff: { report_id: r.id, date: day.date, recorded_at: u.recorded_at, notified: !notified },
    });
    return Promise.resolve({ flagged: true });
  }

  setDayStatus(input: {
    reporterId: string;
    siteId: string;
    date: string;
    status: 'no_work' | 'weather_day';
  }): Promise<DayStatusResult> {
    if (!this.onSite(input.reporterId, input.siteId)) {
      return Promise.reject(new FieldDbError('site_not_found'));
    }
    const day = this.siteDay(input.siteId, input.date);
    if (day.status === input.status) {
      return Promise.resolve({ siteDayId: day.id, status: day.status, changed: false });
    }
    const r = this.reports.find((x) => x.site_day_id === day.id && x.status !== 'void');
    if (r) {
      return Promise.reject(
        new FieldDbError(
          r.status === 'filed' || r.status === 'signed_off' ? 'report_filed' : 'report_in_progress',
        ),
      );
    }
    if (day.status !== 'pending' && day.status !== 'reminded') {
      return Promise.reject(new FieldDbError('wrong_state'));
    }
    day.status = input.status;
    return Promise.resolve({ siteDayId: day.id, status: input.status, changed: true });
  }

  /**
   * A queued or running file_report job of the report, whatever its key (20261015000001); for a
   * confirm of `draft`, not a web confirm of another draft (20261015000070).
   */
  private filingJob(reportId: string, draft?: { version: number; draftRev: number }) {
    return this.jobs.find(
      (j) =>
        j.type === 'file_report' &&
        j.payload.reportId === reportId &&
        (j.status === 'queued' || j.status === 'running') &&
        !(
          draft &&
          j.payload.draftRev !== undefined &&
          (j.payload.version !== draft.version || j.payload.draftRev !== draft.draftRev)
        ),
    );
  }

  /** field_confirm_report() (20261015000070: the version and the draft revision). */
  confirmReport(
    reportId: string,
    reporterId: string,
    version: number,
    draftRev: number,
  ): Promise<ConfirmResult> {
    const r = this.reports.find((x) => x.id === reportId);
    if (!r || r.status === 'void' || !this.onSite(reporterId, r.site_id)) {
      return Promise.reject(new FieldDbError('report_not_found'));
    }
    if (r.status === 'filed' || r.status === 'signed_off') {
      return Promise.resolve({ status: 'filed', jobId: null, version: r.current_version });
    }
    if (r.status !== 'awaiting_confirmation')
      return Promise.reject(new FieldDbError('wrong_state'));
    if (r.current_version !== version) return Promise.reject(new FieldDbError('draft_changed'));
    const v = this.versions.find((x) => x.report_id === r.id && x.version === version);
    if (!v || (v.draft_rev ?? 1) !== draftRev)
      return Promise.reject(new FieldDbError('draft_changed'));
    const existing = this.filingJob(reportId, { version, draftRev });
    if (existing) return Promise.resolve({ status: 'queued', jobId: existing.id, version });
    // D16: the version's first confirm, then one key per occurrence after a finished job; a dead
    // one runs again (requeue_dead_job()).
    const confirms = this.audits.filter(
      (a) => a.action === 'report.confirm_requested' && a.entityId === reportId,
    ).length;
    let job: FakeJob | undefined;
    let requeued = false;
    for (let n = confirms; ; n++) {
      const key =
        n === confirms
          ? jobKeys.fileReportOn(reportId, version, `r${draftRev}`)
          : jobKeys.fileReportOn(reportId, version, `r${draftRev}:c${n}`);
      job = this.jobs.find((j) => j.dedupe_key === key);
      if (!job) {
        job = {
          id: this.jobs.length + 1,
          type: 'file_report',
          payload: { reportId, trigger: 'confirm', version, draftRev, via: 'web' },
          dedupe_key: key,
          status: 'queued',
        };
        this.jobs.push(job);
        break;
      }
      if (job.status === 'dead') {
        Object.assign(job, { status: 'queued', attempts: 0 });
        requeued = true;
        break;
      }
      if (job.status === 'queued' || job.status === 'running') break;
    }
    this.audits.push({
      orgId: r.org_id,
      actorType: 'reporter',
      actorId: reporterId,
      action: 'report.confirm_requested',
      entity: 'report',
      entityId: reportId,
      diff: {
        job_id: job.id,
        version,
        draft_rev: draftRev,
        channel: 'web',
        ...(requeued ? { requeued: true } : {}),
      },
    });
    return Promise.resolve({ status: 'queued', jobId: job.id, version });
  }

  /** field_answer_question() (20261015000002). */
  answerQuestion(input: AnswerInput): Promise<AnswerResult> {
    this.calls.push('answerQuestion');
    const r = this.reports.find((x) => x.id === input.reportId);
    if (!r || r.status === 'void' || !this.onSite(input.reporterId, r.site_id)) {
      return Promise.reject(new FieldDbError('report_not_found'));
    }
    const q = this.questions.find((x) => x.id === input.questionId && x.report_id === r.id);
    if (!q) return Promise.reject(new FieldDbError('question_not_found'));
    if (q.answered_at !== null) {
      if (JSON.stringify(q.answer) === JSON.stringify(input.answer))
        return Promise.resolve({ status: 'already_answered', reportStatus: r.status, jobId: null });
      return Promise.reject(new FieldDbError('question_closed'));
    }
    if (q.channel !== 'web') return Promise.reject(new FieldDbError('question_closed'));
    if (r.status !== 'awaiting_answer') return Promise.reject(new FieldDbError('wrong_state'));
    const v = this.versions.find((x) => x.report_id === r.id && x.version === r.current_version);
    if (!v || JSON.stringify(v.data) !== JSON.stringify(input.base))
      return Promise.reject(new FieldDbError('draft_changed'));
    v.data = input.data as ReportVersionRow['data'];
    v.draft_rev = (v.draft_rev ?? 1) + 1;
    Object.assign(q, {
      answer: input.answer,
      answer_source: input.answerSource,
      answered_at: this.iso(),
    });
    r.status = 'processing';
    if (input.newCompany) r.review_reasons = [`unknown_company:${input.newCompany.name}`];
    const key = jobKeys.decideAnswer(r.id, q.id);
    let job = this.jobs.find((j) => j.dedupe_key === key);
    if (!job) {
      job = {
        id: this.jobs.length + 1,
        type: 'decide_next',
        payload: { reportId: r.id },
        dedupe_key: key,
        status: 'queued',
      };
      this.jobs.push(job);
    }
    this.audits.push({
      orgId: r.org_id,
      actorType: 'reporter',
      actorId: input.reporterId,
      action: 'report.question_answered',
      entity: 'report',
      entityId: r.id,
      diff: { question_id: q.id, field: q.field, channel: 'web', job_id: job.id },
    });
    return Promise.resolve({ status: 'processing', reportStatus: 'processing', jobId: job.id });
  }

  audit(entry: AuditEntry) {
    this.audits.push(entry);
    return Promise.resolve();
  }
}
