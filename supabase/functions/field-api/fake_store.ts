import type {
  ConsentRow,
  ConsentType,
  CountryRow,
  DailyReportData,
  DraftCorrectionRow,
  FieldDeviceRow,
  FieldLinkRow,
  Json,
  OrgRow,
  OrgSettingsRow,
  QuestionRow,
  ReportRow,
  ReportVersionRow,
  ReporterRow,
  SiteDayRow,
  SiteRow,
  PushSubscriptionRow,
  TestClipRow,
  TestClipView,
  UploadRow,
} from '@sitelog/shared';
import {
  FILED_PHOTOS_MAX,
  HISTORY_DAYS,
  deadlineInstant,
  jobKeys,
  photosLinkExpiresAt,
} from '@sitelog/shared';
import type { AuditEntry } from '../_shared/audit.ts';
import { filedChangeable, type DayOffQuestion, type StoredObject } from './logic.ts';
import {
  FieldDbError,
  type AnswerInput,
  type AnswerResult,
  type VoiceAnswerResult,
  type CompleteUploadResult,
  type ConfirmResult,
  type DayStatusResult,
  type DraftWriteResult,
  type FieldStore,
  type RequestCorrectionResult,
  type FiledSaveResult,
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
  /** `sms_opt_outs` rows: `<phone>|<country>`. */
  optOuts = new Set<string>();
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
  /** field_attach_photos(): the batches attached (F9) and the versions they made. */
  attached: { batchId: string; version: number; changeNote: string; caption: string | null }[] = [];
  /** F4's test recordings (W2-13). */
  testClips: TestClipRow[] = [];
  /** W2-14: web push subscriptions. */
  pushSubscriptions: PushSubscriptionRow[] = [];
  /** F8 fixes of a draft (W2-10). */
  corrections: DraftCorrectionRow[] = [];
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

  /** field_claim_send(): key → when it was claimed (ms). */
  sendClaims = new Map<string, number>();

  claimSend(key: string, ttlSeconds: number): Promise<boolean> {
    const now = this.now().getTime();
    const at = this.sendClaims.get(key);
    if (at !== undefined && at > now - ttlSeconds * 1000) return Promise.resolve(false);
    this.sendClaims.set(key, now);
    return Promise.resolve(true);
  }

  releaseSend(key: string): Promise<void> {
    this.sendClaims.delete(key);
    return Promise.resolve();
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
  listAnsweredQuestions(reportId: string) {
    return Promise.resolve(
      this.questions
        .filter((q) => q.report_id === reportId && q.answered_at !== null)
        .sort((a, b) => (b.answered_at ?? '').localeCompare(a.answered_at ?? '')),
    );
  }
  countReportMedia(reportId: string) {
    const ups = this.uploads.filter(
      (u) => u.report_id === reportId && !u.question_id && !u.correction_report_id,
    );
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
    > &
      Partial<Pick<UploadRow, 'batch_id' | 'batch_size' | 'question_id' | 'correction_report_id'>>,
  ) {
    this.calls.push('insertUpload');
    const u: UploadRow = {
      ...row,
      batch_id: row.batch_id ?? null,
      batch_size: row.batch_size ?? null,
      question_id: row.question_id ?? null,
      correction_report_id: row.correction_report_id ?? null,
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
        ...(u.batch_id ? { batch: this.batchState(u) } : {}),
        ...(u.question_id ? { answerClip: true } : {}),
        ...(u.correction_report_id ? { correctionClip: true } : {}),
      });
    }
    const site = this.sites.find((s) => s.id === u.site_id)!;
    const date = u.storage_path.split('/')[2]!;
    if (u.question_id) {
      // W2-09 (20261016000060): a spoken answer's clip, staged on its question's report.
      const q = this.questions.find((x) => x.id === u.question_id);
      const r = q ? this.reports.find((x) => x.id === q.report_id) : undefined;
      const d = r ? this.siteDays.find((x) => x.id === r.site_day_id) : undefined;
      if (!q || !r || r.status === 'void' || r.site_id !== site.id || d?.date !== date) {
        return Promise.reject(new FieldDbError('upload_path_mismatch'));
      }
      u.report_id = r.id;
      u.bytes = bytes ?? u.bytes;
      return Promise.resolve({
        reportId: r.id,
        reportNo: r.report_no,
        reportStatus: r.status,
        created: false,
        alreadyComplete: false,
        jobId: null,
        answerClip: true,
      });
    }
    if (u.correction_report_id) {
      // W2-10 (20261016000100): a correction clip, staged on the draft it fixes.
      const r = this.reports.find((x) => x.id === u.correction_report_id);
      const d = r ? this.siteDays.find((x) => x.id === r.site_day_id) : undefined;
      if (!r || r.status === 'void' || r.site_id !== site.id || d?.date !== date) {
        return Promise.reject(new FieldDbError('upload_path_mismatch'));
      }
      u.report_id = r.id;
      u.bytes = bytes ?? u.bytes;
      return Promise.resolve({
        reportId: r.id,
        reportNo: r.report_no,
        reportStatus: r.status,
        created: false,
        alreadyComplete: false,
        jobId: null,
        correctionClip: true,
      });
    }
    const day = this.siteDay(site.id, date);
    let r = this.reports.find((x) => x.site_day_id === day.id && x.status !== 'void');
    if (u.batch_id) {
      // F9 (20261016000030): staged on the filed report until the batch is whole.
      if (!r || (r.status !== 'filed' && r.status !== 'signed_off')) {
        return Promise.reject(new FieldDbError('wrong_state'));
      }
      if (this.now().getTime() > Date.parse(photosLinkExpiresAt(date, site.timezone))) {
        return Promise.reject(new FieldDbError('photos_window_closed'));
      }
      const added = this.uploads.filter(
        (x) => x.report_id === r!.id && x.batch_id && x.kind === 'photo',
      ).length;
      if (u.kind === 'photo' && added >= FILED_PHOTOS_MAX) {
        return Promise.reject(new FieldDbError('photo_limit'));
      }
      u.report_id = r.id;
      u.bytes = bytes ?? u.bytes;
      const batch = this.batchState(u);
      let jobId: number | null = null;
      if (batch.ready && batch.captionUploadId) {
        jobId = this.jobs.length + 1;
        this.jobs.push({
          id: jobId,
          type: 'transcribe_upload',
          payload: { uploadId: batch.captionUploadId, purpose: 'caption' },
          dedupe_key: `transcribe_upload:${batch.captionUploadId}`,
          status: 'queued',
        });
      }
      return Promise.resolve({
        reportId: r.id,
        reportNo: r.report_no,
        reportStatus: r.status,
        created: false,
        alreadyComplete: false,
        jobId,
        batch,
      });
    }
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

  pushSubscribe(i: {
    reporterId: string;
    deviceId: string;
    endpoint: string;
    p256dh: string;
    auth: string;
    userAgent: string | null;
    textVersion: string;
    evidence: Json;
  }): Promise<{ subscription_id: string }> {
    this.calls.push('pushSubscribe');
    const r = this.reporters.find((x) => x.id === i.reporterId);
    if (!r) return Promise.reject(new FieldDbError('reporter_not_found'));
    const country = this.orgs.find((o) => o.id === r.org_id)?.country ?? '';
    const pack = this.countries.find((c) => c.code === country);
    if (!pack?.message_channels.includes('push')) {
      return Promise.reject(new FieldDbError('channel_not_offered'));
    }
    const live = this.pushSubscriptions.filter((p) => p.reporter_id === r.id && !p.revoked_at);
    let sub = live.find((p) => p.endpoint === i.endpoint);
    if (sub) {
      Object.assign(sub, { p256dh: i.p256dh, auth: i.auth, device_id: i.deviceId });
    } else {
      for (const p of live.filter((x) => x.device_id === i.deviceId)) {
        p.revoked_at = this.iso();
        p.revoked_reason = 'replaced';
      }
      sub = {
        id: this.id('dddddddd'),
        org_id: r.org_id,
        reporter_id: r.id,
        device_id: i.deviceId,
        endpoint: i.endpoint,
        p256dh: i.p256dh,
        auth: i.auth,
        user_agent: i.userAgent,
        created_at: this.iso(),
        revoked_at: null,
        revoked_reason: null,
      };
      this.pushSubscriptions.push(sub);
      this.audits.push({
        orgId: r.org_id,
        actorType: 'reporter',
        actorId: r.id,
        action: 'push.subscribed',
        entity: 'push_subscription',
        entityId: sub.id,
        diff: { device_id: i.deviceId },
      });
    }
    if (!this.consents.some((c) => c.reporter_id === r.id && c.type === 'push' && !c.revoked_at)) {
      const consent: ConsentRow = {
        id: this.id('cccccccc'),
        reporter_id: r.id,
        type: 'push',
        method: 'web_checkbox',
        text_version: i.textVersion,
        evidence: i.evidence,
        given_at: this.iso(),
        revoked_at: null,
      };
      this.consents.push(consent);
      this.audits.push({
        orgId: r.org_id,
        actorType: 'reporter',
        actorId: r.id,
        action: 'consent.given',
        entity: 'consent',
        entityId: consent.id,
        diff: { type: 'push', method: 'web_checkbox', via: 'settings', device_id: i.deviceId },
      });
    }
    return Promise.resolve({ subscription_id: sub.id });
  }

  pushUnsubscribe(
    reporterId: string,
    deviceId: string,
    reason: 'unsubscribed' | 'signed_out',
  ): Promise<{ revoked: number; consent_revoked: boolean }> {
    this.calls.push(`pushUnsubscribe:${reason}`);
    const r = this.reporters.find((x) => x.id === reporterId);
    if (!r) return Promise.reject(new FieldDbError('reporter_not_found'));
    const subs = this.pushSubscriptions.filter(
      (p) => p.reporter_id === reporterId && p.device_id === deviceId && !p.revoked_at,
    );
    for (const p of subs) {
      p.revoked_at = this.iso();
      p.revoked_reason = reason;
    }
    if (subs.length > 0)
      this.audits.push({
        orgId: r.org_id,
        actorType: 'reporter',
        actorId: reporterId,
        action: 'push.unsubscribed',
        entity: 'push_subscription',
        entityId: subs[0]!.id,
        diff: { reason, device_id: deviceId },
      });
    let consentRevoked = false;
    const left = this.pushSubscriptions.some((p) => p.reporter_id === reporterId && !p.revoked_at);
    if (reason === 'unsubscribed' && !left) {
      const rows = this.consents.filter(
        (c) => c.reporter_id === reporterId && c.type === 'push' && !c.revoked_at,
      );
      for (const c of rows) c.revoked_at = this.iso();
      consentRevoked = rows.length > 0;
      if (consentRevoked)
        this.audits.push({
          orgId: r.org_id,
          actorType: 'reporter',
          actorId: reporterId,
          action: 'consent.revoked',
          entity: 'consent',
          entityId: rows[0]!.id,
          diff: { type: 'push', method: 'web', device_id: deviceId, notified: false },
        });
    }
    return Promise.resolve({ revoked: subs.length, consent_revoked: consentRevoked });
  }

  devicePushSubscribed(reporterId: string, deviceId: string): Promise<boolean> {
    return Promise.resolve(
      this.pushSubscriptions.some(
        (p) => p.reporter_id === reporterId && p.device_id === deviceId && !p.revoked_at,
      ),
    );
  }

  phoneOptedOut(phone: string, country: string) {
    return Promise.resolve(this.optOuts.has(`${phone}|${country}`));
  }

  grantConsent(
    reporterId: string,
    type: 'sms',
    textVersion: string,
    deviceId: string,
    evidence: Json,
  ): Promise<{ granted: boolean }> {
    this.calls.push('grantConsent');
    const r = this.reporters.find((x) => x.id === reporterId);
    if (!r) return Promise.reject(new FieldDbError('reporter_not_found'));
    const country = this.orgs.find((o) => o.id === r.org_id)?.country ?? '';
    if (r.status === 'opted_out' || this.optOuts.has(`${r.phone_e164}|${country}`)) {
      return Promise.reject(new FieldDbError('texts_opted_out'));
    }
    if (
      this.consents.some((c) => c.reporter_id === reporterId && c.type === type && !c.revoked_at)
    ) {
      return Promise.resolve({ granted: false });
    }
    const created: ConsentRow = {
      id: this.id('cccccccc'),
      reporter_id: reporterId,
      type,
      method: 'web_checkbox',
      text_version: textVersion,
      evidence,
      given_at: this.iso(),
      revoked_at: null,
    };
    this.consents.push(created);
    this.audits.push({
      orgId: r.org_id,
      actorType: 'reporter',
      actorId: reporterId,
      action: 'consent.given',
      entity: 'consent',
      entityId: created.id,
      diff: {
        type,
        method: 'web_checkbox',
        text_version: textVersion,
        via: 'settings',
        device_id: deviceId,
      },
    });
    return Promise.resolve({ granted: true });
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

  private batchState(u: UploadRow) {
    const members = this.uploads.filter((x) => x.batch_id === u.batch_id && x.report_id);
    return {
      id: u.batch_id!,
      ready: members.length >= (u.batch_size ?? 1),
      captionUploadId: members.find((x) => x.kind === 'audio')?.id ?? null,
    };
  }

  /** field_attach_photos(): the batch as the next version (F9). */
  attachPhotos(reportId: string, batchId: string, changeNote: string, caption: string | null) {
    this.calls.push('attachPhotos');
    const r = this.reports.find((x) => x.id === reportId);
    if (!r || r.status === 'void') return Promise.reject(new FieldDbError('report_not_found'));
    const members = this.uploads.filter((x) => x.batch_id === batchId);
    if (members.length === 0) return Promise.reject(new FieldDbError('batch_not_found'));
    if (members.some((x) => x.report_id !== reportId) || members.length < members[0]!.batch_size!) {
      return Promise.reject(new FieldDbError('batch_incomplete'));
    }
    const photos = members.filter((x) => x.kind === 'photo');
    const done = this.attached.find((a) => a.batchId === batchId);
    if (done) return Promise.resolve({ version: done.version, alreadyAttached: true });
    if (r.status !== 'filed' && r.status !== 'signed_off') {
      return Promise.reject(new FieldDbError('wrong_state'));
    }
    const prev = this.versions.find((v) => v.report_id === r.id && v.version === r.current_version);
    const data = (prev?.data ?? {}) as Record<string, unknown>;
    const list = Array.isArray(data.photos) ? (data.photos as unknown[]) : [];
    r.current_version += 1;
    r.status = 'filed';
    r.signed_off_by = null;
    r.signed_off_at = null;
    this.versions.push({
      report_id: r.id,
      version: r.current_version,
      data: {
        ...data,
        photos: [
          ...list,
          ...photos.map((p) => ({ uploadId: p.id, ...(caption ? { caption } : {}) })),
        ],
      } as ReportVersionRow['data'],
      summary: prev?.summary ?? null,
      pdf_path: null,
      author: 'reporter',
      author_user_id: null,
      author_message_id: null,
      change_note: changeNote,
      created_at: this.iso(),
      via: 'web',
    });
    for (const p of photos) this.sources.push({ report_id: r.id, kind: 'photo', upload_id: p.id });
    this.attached.push({ batchId, version: r.current_version, changeNote, caption });
    this.jobs.push({
      id: this.jobs.length + 1,
      type: 'render_pdf',
      payload: { reportId: r.id, version: r.current_version, emailRecipients: true, changeNote },
      dedupe_key: jobKeys.renderPdf(r.id, r.current_version),
      status: 'queued',
    });
    return Promise.resolve({ version: r.current_version, alreadyAttached: false });
  }

  filedPhotoState(reportId: string, exceptBatch?: string) {
    const added = this.uploads.filter(
      (x) =>
        x.report_id === reportId && x.batch_id && x.kind === 'photo' && x.batch_id !== exceptBatch,
    );
    const pending = added.filter(
      (x) => !this.sources.some((s) => s.report_id === reportId && s.upload_id === x.id),
    );
    return Promise.resolve({ added: added.length, pending: pending.length });
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

  /** field_report_day_off() (20261016000050, W2-08): the site-day, and the report it makes. */
  setDayStatus(input: {
    reporterId: string;
    siteId: string;
    date: string;
    status: 'no_work' | 'weather_day';
    questions: DayOffQuestion[];
    data: DailyReportData;
  }): Promise<DayStatusResult> {
    if (!this.onSite(input.reporterId, input.siteId)) {
      return Promise.reject(new FieldDbError('site_not_found'));
    }
    const day = this.siteDay(input.siteId, input.date);
    if (day.status === input.status) {
      const made = this.reports.find((x) => x.id === day.report_id && x.kind === input.status);
      return Promise.resolve({
        siteDayId: day.id,
        status: day.status,
        changed: false,
        report: made ? { id: made.id, reportNo: made.report_no } : null,
      });
    }
    const live = this.reports.find((x) => x.site_day_id === day.id && x.status !== 'void');
    if (live) {
      return Promise.reject(
        new FieldDbError(
          live.status === 'filed' || live.status === 'signed_off'
            ? 'report_filed'
            : 'report_in_progress',
        ),
      );
    }
    if (day.status !== 'pending' && day.status !== 'reminded') {
      return Promise.reject(new FieldDbError('wrong_state'));
    }
    const site = this.sites.find((x) => x.id === input.siteId)!;
    const settings = this.settings.find((x) => x.org_id === site.org_id) as
      { no_work_pdf?: boolean } | undefined;
    let made: ReportRow | null = null;
    if (input.status === 'weather_day' || settings?.no_work_pdf) {
      site.report_seq++;
      const org = this.orgs.find((o) => o.id === site.org_id)!;
      made = {
        id: this.id('bbbbbbbb'),
        org_id: site.org_id,
        site_id: site.id,
        site_day_id: day.id,
        report_no: `${site.project_code}-${String(site.report_seq).padStart(4, '0')}`,
        status: 'processing',
        current_version: 1,
        reporter_id: input.reporterId,
        received_at: this.iso(),
        confirmed_at: null,
        filed_at: null,
        signed_off_by: null,
        signed_off_at: null,
        needs_review: false,
        review_reasons: [],
        is_late: false,
        kind: input.status,
        created_at: this.iso(),
        updated_at: this.iso(),
        channel: 'web',
        language: org.locale === 'tr-TR' ? 'tr' : 'en',
        confirmed_via: null,
      };
      this.reports.push(made);
      for (const q of input.questions) {
        this.questions.push({
          id: q.id,
          report_id: made.id,
          field: q.field,
          target: q.target,
          prompt: q.prompt,
          options: null,
          asked_message_id: null,
          answered_message_id: null,
          answer: q.answer,
          asked_at: this.iso(),
          answered_at: this.iso(),
          created_at: this.iso(),
          channel: 'web',
          call_id: null,
          answer_source: { type: 'answer', questionId: q.id },
          voice_answers: [],
        });
      }
      this.versions.push({
        report_id: made.id,
        version: 1,
        data: input.data as unknown as ReportVersionRow['data'],
        summary: input.data.summary || null,
        pdf_path: null,
        author: 'reporter',
        author_user_id: null,
        author_message_id: null,
        change_note: null,
        created_at: this.iso(),
        via: 'web',
      });
      this.jobs.push({
        id: this.jobs.length + 1,
        type: 'file_report',
        payload: { reportId: made.id, trigger: input.status },
        dedupe_key: `file:${made.id}:v1:${input.status}`,
        status: 'queued',
      });
    }
    day.status = input.status;
    if (made) day.report_id = made.id;
    return Promise.resolve({
      siteDayId: day.id,
      status: input.status,
      changed: true,
      report: made ? { id: made.id, reportNo: made.report_no } : null,
    });
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

  /** field_answer_question_voice() (20261016000060, W2-09). */
  answerQuestionVoice(input: {
    reportId: string;
    questionId: string;
    reporterId: string;
    uploadId: string;
  }): Promise<VoiceAnswerResult> {
    this.calls.push('answerQuestionVoice');
    const r = this.reports.find((x) => x.id === input.reportId);
    if (!r || r.status === 'void' || !this.onSite(input.reporterId, r.site_id)) {
      return Promise.reject(new FieldDbError('report_not_found'));
    }
    const q = this.questions.find((x) => x.id === input.questionId && x.report_id === r.id);
    if (!q) return Promise.reject(new FieldDbError('question_not_found'));
    const tries = (q.voice_answers ?? []) as Array<{ uploadId: string; status: string }>;
    if (tries.some((t) => t.uploadId === input.uploadId)) {
      return Promise.resolve({ status: 'listening', reportStatus: r.status, jobId: null });
    }
    if (q.answered_at !== null || q.channel !== 'web')
      return Promise.reject(new FieldDbError('question_closed'));
    if (r.status !== 'awaiting_answer') return Promise.reject(new FieldDbError('wrong_state'));
    if (tries.at(-1)?.status === 'listening')
      return Promise.reject(new FieldDbError('answer_pending'));
    const u = this.uploads.find((x) => x.id === input.uploadId);
    if (
      !u ||
      u.question_id !== q.id ||
      u.reporter_id !== input.reporterId ||
      u.report_id !== r.id ||
      u.kind !== 'audio'
    ) {
      return Promise.reject(new FieldDbError('upload_not_found'));
    }
    q.voice_answers = [...tries, { uploadId: u.id, at: this.iso(), status: 'listening' }];
    const key = jobKeys.parseAnswer(q.id, u.id);
    const job: FakeJob = {
      id: this.jobs.length + 1,
      type: 'parse_answer',
      payload: { reportId: r.id, questionId: q.id, uploadId: u.id },
      dedupe_key: key,
      status: 'queued',
    };
    this.jobs.push(job);
    this.audits.push({
      orgId: r.org_id,
      actorType: 'reporter',
      actorId: input.reporterId,
      action: 'report.answer_spoken',
      entity: 'report',
      entityId: r.id,
      diff: { question_id: q.id, field: q.field, channel: 'web', upload_id: u.id, job_id: job.id },
    });
    return Promise.resolve({ status: 'listening', reportStatus: r.status, jobId: job.id });
  }

  /** field_request_correction() (20261016000100, W2-10). */
  requestCorrection(input: {
    reportId: string;
    reporterId: string;
    uploadId: string | null;
    text: string | null;
  }): Promise<RequestCorrectionResult> {
    this.calls.push('requestCorrection');
    return this.newCorrection(input, false);
  }
  /** field_request_filed_correction() (20261016000110, W2-11): a change of a filed report. */
  requestFiledCorrection(input: {
    reportId: string;
    reporterId: string;
    uploadId: string | null;
    text: string | null;
  }): Promise<RequestCorrectionResult> {
    this.calls.push('requestFiledCorrection');
    return this.newCorrection(input, true);
  }
  /** field_report_changeable(): the report's date within the last 14 days, site time. */
  private changeable(r: ReportRow): boolean {
    const day = this.siteDays.find((d) => d.id === r.site_day_id)!;
    const site = this.sites.find((x) => x.id === r.site_id)!;
    return filedChangeable(day.date, this.now(), site.timezone, HISTORY_DAYS);
  }
  private newCorrection(
    input: { reportId: string; reporterId: string; uploadId: string | null; text: string | null },
    afterFiling: boolean,
  ): Promise<RequestCorrectionResult> {
    const r = this.reports.find((x) => x.id === input.reportId);
    if (!r || r.status === 'void' || !this.onSite(input.reporterId, r.site_id))
      return Promise.reject(new FieldDbError('report_not_found'));
    if (input.uploadId) {
      const seen = this.corrections.find((c) => c.upload_id === input.uploadId);
      if (seen)
        return Promise.resolve({ id: seen.id, status: seen.status, jobId: null, repeat: true });
    }
    if (afterFiling) {
      if (r.status !== 'filed' && r.status !== 'signed_off')
        return Promise.reject(new FieldDbError('wrong_state'));
      if (!this.changeable(r)) return Promise.reject(new FieldDbError('report_locked'));
    } else if (r.status !== 'awaiting_confirmation')
      return Promise.reject(new FieldDbError('wrong_state'));
    if (this.corrections.some((c) => c.report_id === r.id && c.status === 'listening'))
      return Promise.reject(new FieldDbError('correction_pending'));
    if (input.uploadId) {
      const u = this.uploads.find((x) => x.id === input.uploadId);
      if (
        !u ||
        u.correction_report_id !== r.id ||
        u.reporter_id !== input.reporterId ||
        u.report_id !== r.id ||
        u.kind !== 'audio'
      )
        return Promise.reject(new FieldDbError('upload_not_found'));
    }
    for (const c of this.corrections)
      if (c.report_id === r.id && (c.status === 'ready' || c.status === 'unclear'))
        c.status = 'discarded';
    const row: DraftCorrectionRow = {
      id: this.id('cccccccc'),
      org_id: r.org_id,
      report_id: r.id,
      reporter_id: input.reporterId,
      via: input.uploadId ? 'voice' : 'text',
      upload_id: input.uploadId,
      text: input.text,
      status: 'listening',
      base_version: null,
      base_rev: null,
      data: null,
      changes: null,
      operations: null,
      source: null,
      change_note: null,
      clarification: null,
      reason: null,
      created_at: this.iso(),
      settled_at: null,
      applied_at: null,
      after_filing: afterFiling,
      version_created: null,
      message_id: null,
    };
    this.corrections.push(row);
    const job: FakeJob = {
      id: this.jobs.length + 1,
      type: 'apply_correction',
      payload: { reportId: r.id, correctionId: row.id },
      dedupe_key: jobKeys.applyCorrection(row.id),
      status: 'queued',
    };
    this.jobs.push(job);
    this.audits.push({
      orgId: r.org_id,
      actorType: 'reporter',
      actorId: input.reporterId,
      action: 'report.correction_requested',
      entity: 'report',
      entityId: r.id,
      diff: {
        correction_id: row.id,
        via: row.via,
        upload_id: input.uploadId,
        job_id: job.id,
        ...(afterFiling ? { after_filing: true } : {}),
      },
    });
    return Promise.resolve({ id: row.id, status: 'listening', jobId: job.id });
  }
  /** field_save_filed_correction() (W2-11): Save change makes version n+1 from the preview. */
  saved: {
    correctionId: string;
    version: number;
    changeNote: string;
    message: { weekday: string; change: string } | null;
  }[] = [];
  saveFiledCorrection(input: {
    correctionId: string;
    reportId: string;
    reporterId: string;
    changeNote: string;
    message: { weekday: string; change: string } | null;
  }): Promise<FiledSaveResult> {
    this.calls.push('saveFiledCorrection');
    const r = this.reports.find((x) => x.id === input.reportId);
    if (!r || r.status === 'void' || !this.onSite(input.reporterId, r.site_id))
      return Promise.reject(new FieldDbError('report_not_found'));
    const c = this.corrections.find((x) => x.id === input.correctionId && x.report_id === r.id);
    if (!c || c.reporter_id !== input.reporterId || !c.after_filing)
      return Promise.reject(new FieldDbError('correction_not_found'));
    if (c.status === 'applied')
      return Promise.resolve({
        status: 'applied',
        reportStatus: r.status,
        version: c.version_created!,
        repeat: true,
      });
    if (c.status !== 'ready') return Promise.reject(new FieldDbError('correction_not_ready'));
    if (r.status !== 'filed' && r.status !== 'signed_off')
      return Promise.reject(new FieldDbError('wrong_state'));
    if (!this.changeable(r)) return Promise.reject(new FieldDbError('report_locked'));
    const v = this.versions.find((x) => x.report_id === r.id && x.version === r.current_version);
    if (r.current_version !== c.base_version || (v?.draft_rev ?? 1) !== c.base_rev) {
      c.status = 'stale';
      c.reason = 'version_changed';
      return Promise.resolve({
        status: 'stale',
        reportStatus: r.status,
        currentVersion: r.current_version,
        draftRev: v?.draft_rev ?? null,
      });
    }
    const next = r.current_version + 1;
    this.versions.push({
      report_id: r.id,
      version: next,
      data: c.data as Json,
      summary: null,
      pdf_path: null,
      author: 'reporter',
      author_user_id: null,
      author_message_id: null,
      author_reporter_id: input.reporterId,
      change_note: input.changeNote,
      created_at: this.iso(),
      via: 'web',
      draft_rev: 1,
    });
    r.current_version = next;
    r.status = 'filed';
    c.status = 'applied';
    c.applied_at = this.iso();
    c.version_created = next;
    this.saved.push({
      correctionId: c.id,
      version: next,
      changeNote: input.changeNote,
      message: input.message,
    });
    this.jobs.push({
      id: this.jobs.length + 1,
      type: 'render_pdf',
      payload: { reportId: r.id, version: next, emailRecipients: true },
      dedupe_key: jobKeys.renderPdf(r.id, next),
      status: 'queued',
    });
    this.audits.push({
      orgId: r.org_id,
      actorType: 'reporter',
      actorId: input.reporterId,
      action: 'report.version_created',
      entity: 'report',
      entityId: r.id,
      diff: { version: next, change_note: input.changeNote, via: 'web', correction_id: c.id },
    });
    return Promise.resolve({ status: 'applied', reportStatus: 'filed', version: next });
  }
  getCorrection(id: string) {
    return Promise.resolve(this.corrections.find((c) => c.id === id) ?? null);
  }
  latestCorrection(reportId: string, reporterId: string) {
    const rows = this.corrections.filter(
      (c) => c.report_id === reportId && c.reporter_id === reporterId,
    );
    return Promise.resolve(rows.at(-1) ?? null);
  }
  /** As the worker's field_settle_correction() `ready` (tests set a preview up with it). */
  settleCorrectionReady(id: string, data: DailyReportData, changes: unknown[]) {
    const c = this.corrections.find((x) => x.id === id)!;
    const r = this.reports.find((x) => x.id === c.report_id)!;
    const v = this.versions.find((x) => x.report_id === r.id && x.version === r.current_version)!;
    Object.assign(c, {
      status: 'ready',
      data,
      changes,
      base_version: r.current_version,
      base_rev: v.draft_rev ?? 1,
      settled_at: this.iso(),
    });
  }
  private writeDraft(r: ReportRow, data: unknown) {
    const v = this.versions.find((x) => x.report_id === r.id && x.version === r.current_version)!;
    v.data = data as Json;
    v.draft_rev = (v.draft_rev ?? 1) + 1;
    r.status = 'processing';
  }
  private staleAnswer(r: ReportRow): DraftWriteResult {
    const v = this.versions.find((x) => x.report_id === r.id && x.version === r.current_version);
    return {
      status: 'stale',
      reportStatus: r.status,
      currentVersion: r.current_version,
      draftRev: v?.draft_rev ?? null,
    };
  }
  /** field_apply_correction() (W2-10): Save change at the preview's revision only. */
  applyCorrection(
    correctionId: string,
    reportId: string,
    reporterId: string,
  ): Promise<DraftWriteResult> {
    this.calls.push('applyCorrection');
    const r = this.reports.find((x) => x.id === reportId);
    if (!r || r.status === 'void' || !this.onSite(reporterId, r.site_id))
      return Promise.reject(new FieldDbError('report_not_found'));
    const c = this.corrections.find((x) => x.id === correctionId && x.report_id === r.id);
    if (!c || c.reporter_id !== reporterId)
      return Promise.reject(new FieldDbError('correction_not_found'));
    if (c.status === 'applied')
      return Promise.resolve({ status: 'applied', reportStatus: r.status, jobId: null });
    if (c.status !== 'ready') return Promise.reject(new FieldDbError('correction_not_ready'));
    if (r.status === 'filed' || r.status === 'signed_off')
      return Promise.reject(new FieldDbError('wrong_state'));
    const v = this.versions.find((x) => x.report_id === r.id && x.version === r.current_version);
    if (
      r.status !== 'awaiting_confirmation' ||
      r.current_version !== c.base_version ||
      (v?.draft_rev ?? 1) !== c.base_rev
    ) {
      c.status = 'stale';
      c.reason = 'draft_changed';
      return Promise.resolve(this.staleAnswer(r));
    }
    this.writeDraft(r, c.data);
    c.status = 'applied';
    c.applied_at = this.iso();
    const job: FakeJob = {
      id: this.jobs.length + 1,
      type: 'decide_next',
      payload: { reportId: r.id },
      dedupe_key: jobKeys.decideCorrection(r.id, c.id),
      status: 'queued',
    };
    this.jobs.push(job);
    this.audits.push({
      orgId: r.org_id,
      actorType: 'reporter',
      actorId: reporterId,
      action: 'report.draft_corrected',
      entity: 'report',
      entityId: r.id,
      diff: { correction_id: c.id, via: c.via, changes: c.changes, job_id: job.id },
    });
    return Promise.resolve({ status: 'applied', reportStatus: 'processing', jobId: job.id });
  }
  /** field_edit_draft() (W2-10): a stepper's line on the draft the reporter saw. */
  editDraft(input: {
    reportId: string;
    reporterId: string;
    version: number;
    draftRev: number;
    base: Json;
    data: Json;
    changes: Json;
    source: Json;
  }): Promise<DraftWriteResult> {
    this.calls.push('editDraft');
    const r = this.reports.find((x) => x.id === input.reportId);
    if (!r || r.status === 'void' || !this.onSite(input.reporterId, r.site_id))
      return Promise.reject(new FieldDbError('report_not_found'));
    if (r.status === 'filed' || r.status === 'signed_off')
      return Promise.reject(new FieldDbError('wrong_state'));
    const v = this.versions.find((x) => x.report_id === r.id && x.version === r.current_version);
    if (
      r.status !== 'awaiting_confirmation' ||
      r.current_version !== input.version ||
      (v?.draft_rev ?? 1) !== input.draftRev ||
      JSON.stringify(v?.data) !== JSON.stringify(input.base)
    )
      return Promise.resolve(this.staleAnswer(r));
    this.writeDraft(r, input.data);
    const job: FakeJob = {
      id: this.jobs.length + 1,
      type: 'decide_next',
      payload: { reportId: r.id },
      dedupe_key: jobKeys.decideEdit(r.id, input.version, input.draftRev),
      status: 'queued',
    };
    this.jobs.push(job);
    this.audits.push({
      orgId: r.org_id,
      actorType: 'reporter',
      actorId: input.reporterId,
      action: 'report.draft_edited',
      entity: 'report',
      entityId: r.id,
      diff: { via: 'stepper', changes: input.changes, job_id: job.id },
    });
    return Promise.resolve({ status: 'processing', reportStatus: 'processing', jobId: job.id });
  }

  /** field_test_clip_create() (20261016000070, W2-13). */
  createTestClip(input: {
    id: string;
    reporterId: string;
    deviceId: string;
    path: string;
    mime: string;
    bytes: number;
  }): Promise<void> {
    this.calls.push('createTestClip');
    const r = this.reporters.find((x) => x.id === input.reporterId)!;
    const recording = this.consents.some(
      (c) => c.reporter_id === r.id && c.type === 'recording' && c.revoked_at === null,
    );
    if (!recording) return Promise.reject(new FieldDbError('consent_required'));
    this.testClips.push({
      id: input.id,
      org_id: r.org_id,
      reporter_id: r.id,
      device_id: input.deviceId,
      storage_path: input.path,
      mime: input.mime,
      bytes: input.bytes,
      created_at: this.iso(),
      completed_at: null,
      transcribed_at: null,
      heard: null,
      snippet: null,
      failed_at: null,
      read_at: null,
      deleted_at: null,
    });
    this.jobs.push({
      id: this.jobs.length + 1,
      type: 'delete_test_clip',
      payload: { testClipId: input.id },
      dedupe_key: `test_clip:${input.id}:delete`,
      status: 'queued',
    });
    this.audits.push({
      orgId: r.org_id,
      actorType: 'reporter',
      actorId: r.id,
      action: 'test_clip.created',
      entity: 'test_clip',
      entityId: input.id,
      diff: { device_id: input.deviceId, mime: input.mime, bytes: input.bytes },
    });
    return Promise.resolve();
  }
  getTestClip(id: string) {
    return Promise.resolve(this.testClips.find((t) => t.id === id) ?? null);
  }
  /** field_test_clip_complete(). */
  completeTestClip(id: string, reporterId: string, bytes: number | null) {
    this.calls.push('completeTestClip');
    const t = this.testClips.find((x) => x.id === id);
    if (!t || t.reporter_id !== reporterId)
      return Promise.reject(new FieldDbError('test_clip_not_found'));
    if (t.deleted_at) return Promise.resolve({ status: 'gone' as const });
    t.completed_at ??= this.iso();
    t.bytes = bytes ?? t.bytes;
    const key = `test_clip:${t.id}`;
    if (!this.jobs.some((j) => j.dedupe_key === key)) {
      this.jobs.push({
        id: this.jobs.length + 1,
        type: 'transcribe_test_clip',
        payload: { testClipId: t.id },
        dedupe_key: key,
        status: 'queued',
      });
    }
    return Promise.resolve({ status: 'pending' as const });
  }
  /** field_test_clip_read(): the snippet once, then the words go. */
  readTestClip(id: string, reporterId: string): Promise<TestClipView> {
    const t = this.testClips.find((x) => x.id === id);
    if (!t || t.reporter_id !== reporterId)
      return Promise.reject(new FieldDbError('test_clip_not_found'));
    if (t.deleted_at)
      return Promise.resolve({ status: t.failed_at ? 'failed' : 'gone', snippet: null });
    if (!t.failed_at && !t.transcribed_at)
      return Promise.resolve({ status: 'pending', snippet: null });
    const status = t.failed_at ? 'failed' : t.heard ? 'heard' : 'silent';
    const snippet = status === 'heard' ? t.snippet : null;
    Object.assign(t, { read_at: this.iso(), deleted_at: this.iso(), snippet: null });
    this.audits.push({
      orgId: t.org_id,
      actorType: 'reporter',
      actorId: t.reporter_id,
      action: 'test_clip.deleted',
      entity: 'test_clip',
      entityId: t.id,
      diff: { reason: 'read', status },
    });
    return Promise.resolve({ status, snippet });
  }

  audit(entry: AuditEntry) {
    this.audits.push(entry);
    return Promise.resolve();
  }
}
