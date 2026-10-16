import { Hono, type Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { z } from 'zod';
import {
  AnswerRequestSchema,
  ConfirmRequestSchema,
  ConsentRequestSchema,
  ConsentGrantRequestSchema,
  ConsentRevokeRequestSchema,
  CorrectionRequestSchema,
  DayStatusRequestSchema,
  EditRequestSchema,
  ExpiredLinkRequestSchema,
  FIELD_LINK_HEADER,
  FILED_PHOTOS_MAX,
  fieldReportKind,
  FIELD_RATE_LIMITS,
  HISTORY_DAYS,
  PreferencesRequestSchema,
  PushSubscribeRequestSchema,
  QUESTION_FIELDS,
  REQUIRED_CONSENTS,
  ResolveRequestSchema,
  SIGNED_URL_SECONDS,
  TEST_CLIP_MAX_BYTES,
  TestClipRequestSchema,
  UploadRequestSchema,
  VERIFY_CODE_TTL_S,
  VerifyRequestSchema,
  answerConfirmation,
  applyAnswer,
  applyCrewEdit,
  correctionNote,
  deviceCookieName,
  firstName,
  linkCodeHash,
  numberAnswer,
  optionAnswer,
  photosAddedNote,
  readReportData,
  settingsMessageChannels,
  sha256Hex,
  toCountryPack,
  uploadBucket,
  uploadMediaType,
  uploadStoragePath,
  deadlineInstant,
  dailyLinkExpiresAt,
  ensureDailyLink,
  fieldLinkUrl,
  formatDate,
  formatDateInTz,
  formatPhone,
  isWorkingDay,
  languageOf,
  type AnswerResponse,
  type AnswerValue,
  type ApplyCorrectionResponse,
  type CorrectionChange,
  type CorrectionView,
  type EditResponse,
  type FixTo,
  type Json,
  type Source,
  type CompleteResponse,
  type ConfirmResponse,
  type ConsentResponse,
  type ConsentType,
  type CountryPack,
  type DayStatusResponse,
  type ExpiredLinkResponse,
  type FieldDeviceRow,
  type FieldLinkRow,
  type HistoryResponse,
  type LinkExpiredBody,
  type NotifyOutcome,
  type PreferencesResponse,
  type PushKeyResponse,
  type QuestionField,
  type QuestionSpec,
  type ReportView,
  type ReporterRow,
  type ResolveResponse,
  type SendCodeResponse,
  type SignOutResponse,
  type SiteRow,
  type TestClipResponse,
  type TestClipView,
  type TodayResponse,
  type AnswerTo,
  type UploadRequest,
  type UploadResponse,
  type VerifyResponse,
} from '@sitelog/shared';
import { EnvError } from '../_shared/env.ts';
import { formatIssues, timingSafeEqual } from '../_shared/http.ts';
import { errorMessage, logError } from '../_shared/log.ts';
import {
  DEVICE_COOKIE_OPTIONS,
  FieldError,
  allowedReportDates,
  clientIp,
  consentState,
  dayOffPlan,
  deviceVerified,
  fieldCountryView,
  fieldSite,
  filedChangeable,
  filedPhotosUntil,
  historyStart,
  lateClipAllowed,
  linkMayAddPhotos,
  nearestDeadlineSite,
  needsConsent,
  numberAnswerLabel,
  newDeviceToken,
  newVerifyCode,
  originAllowed,
  questionManpowerIndex,
  questionOptions,
  retryAfterSeconds,
  scopeSites,
  settingsView,
  siteDeadline,
  textsOptedOut,
  storedObjectProblem,
  storedQuestionOptions,
  verifyCodeHash,
  voiceAnswerView,
  lastVoiceAnswerView,
  correctionView,
  openCorrectionView,
} from './logic.ts';
import { FieldDbError, type FieldStore, type OrgContext } from './store.ts';

/**
 * field-api (W1-07; spec §6.5, Appendix B, F4, F5, F12): the field app's only backend. Hono
 * (D6), mounted under /field-api; the field host proxies /api/<route> here (D39). A request is
 * authenticated by its link code (`resolve`'s body, else the X-Link-Code header → field_links) and
 * the reporter's device cookie (`sl_dev_<8 hex>` → field_devices.verified_at, 180 days), then
 * served with the service role, scoped to that link's reporter and sites. Every answer is
 * `Cache-Control: no-store`.
 */

/** What `device/send-code` hands the sender (`notifierCodeSender`, the Notifier). */
export interface VerifyCodeMessage {
  org: OrgContext['org'];
  pack: CountryPack;
  reporter: ReporterRow;
  consents: { held: ReadonlySet<ConsentType>; revoked: ReadonlySet<ConsentType> };
  code: string;
}

/** Sends `verify_code` by SMS (SMS_ONLY_KEYS, spec §19 Q25); the Notifier's outcome. */
export type SendVerifyCode = (message: VerifyCodeMessage) => Promise<NotifyOutcome>;

/** What `expired/daily-link` hands the Notifier (F16 "Send me today's link"). */
export interface DailyLinkMessage {
  reporterId: string;
  vars: { site: string; link: string; number?: string };
  dedupeKey: string;
}

/** Sends `daily_link` on the reporter's channel order (`Notifier.send`); the Notifier's outcome. */
export type SendDailyLink = (message: DailyLinkMessage) => Promise<NotifyOutcome>;

export interface FieldApiDeps {
  store: FieldStore;
  sendVerifyCode: SendVerifyCode;
  /** F16 "Send me today's link" (W2-03): `daily_link` through the Notifier. */
  sendDailyLink: SendDailyLink;
  /** FIELD_APP_URL, the base of the link texted (throws EnvError when unset). */
  fieldAppUrl: () => string;
  /** DAILY_LINK_TTL_HOURS (§5.1, default 72): how long a new daily link lives. */
  dailyLinkTtlHours?: () => number | undefined;
  /** LINK_SIGNING_SECRET, read when a code is sent or checked (throws EnvError when unset). */
  linkSigningSecret: () => string;
  /** FIELD_APP_URL and CORS_EXTRA_ORIGINS (`fieldOrigins`). */
  allowedOrigins: () => readonly string[];
  /**
   * STORAGE_PUBLIC_URL: the project URL as the phone reaches it, when it differs from the
   * functions' SUPABASE_URL (a local stack, where that is the gateway's internal `http://kong:8000`).
   * A signed upload URL is re-based on it, so the browser can PUT the clip (W1-09). Unset on hosted
   * projects, whose SUPABASE_URL is already public. Not `SUPABASE_*`: the Supabase CLI skips env
   * names with that prefix in `supabase/functions/.env` and refuses them in `secrets set`.
   */
  publicUrl?: () => string | undefined;
  /**
   * VAPID_PUBLIC_KEY (W2-14): the key the browser subscribes with (`GET push/key`); unset = no
   * push in this environment (the Settings toggle stays hidden). Public by design: the private key
   * is the worker's only.
   */
  vapidPublicKey?: () => string | undefined;
  now?: () => Date;
  /** Waiting between polls of a send claim (tests pass a fake). */
  sleep?: (ms: number) => Promise<void>;
  randomBytes?: (n: number) => Uint8Array;
  randomUUID?: () => string;
}

interface LinkContext {
  link: FieldLinkRow;
  reporter: ReporterRow;
  org: OrgContext;
  pack: CountryPack;
}

interface DeviceContext extends LinkContext {
  device: FieldDeviceRow;
  /** The link's sites (all statuses); routes that write check `status = 'active'`. */
  sites: SiteRow[];
  consents: { held: Set<ConsentType>; revoked: Set<ConsentType> };
}

type Env = { Variables: { field: DeviceContext } };
type Ctx = Context<Env>;

/** A send claim lives at most this long (a crashed request frees the key then). */
const SEND_CLAIM_TTL_S = 30;
const SEND_CLAIM_POLL_MS = 200;
const SEND_CLAIM_WAIT_MS = 10_000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createFieldApp(deps: FieldApiDeps): Hono<Env> {
  const store = deps.store;
  const now = deps.now ?? (() => new Date());
  const randomBytes =
    deps.randomBytes ?? ((n: number) => crypto.getRandomValues(new Uint8Array(n)));
  const randomUUID = deps.randomUUID ?? (() => crypto.randomUUID());

  const app = new Hono<Env>().basePath('/field-api');

  // ── Every answer: no-store (registered first, so it wraps everything, errors included) ───────
  app.use('*', async (c, next) => {
    await next();
    c.header('Cache-Control', 'no-store');
  });
  // Only from the field app's origin when the browser names one.
  app.use('*', async (c, next) => {
    if (!originAllowed(c.req.header('origin'), deps.allowedOrigins())) {
      throw new FieldError(
        403,
        'origin_not_allowed',
        'Origin not allowed: field-api takes FIELD_APP_URL and CORS_EXTRA_ORIGINS',
      );
    }
    await next();
  });

  app.onError((err, c) => errorResponse(c, err, now()));
  app.notFound((c) => c.json({ error: 'not_found' }, 404, { 'Cache-Control': 'no-store' }));

  /**
   * Waits for the one claim on a Notifier key (field_claim_send()): a request sending under the
   * key holds it until the Notifier answers. Still held after `SEND_CLAIM_WAIT_MS` (a slow
   * provider), the caller is asked to try again shortly (429 with Retry-After).
   */
  async function claimSendKey(key: string): Promise<void> {
    const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
    for (let waited = 0; ; waited += SEND_CLAIM_POLL_MS) {
      if (await store.claimSend(key, SEND_CLAIM_TTL_S)) return;
      if (waited >= SEND_CLAIM_WAIT_MS)
        throw rateLimited(new Date(now().getTime() + SEND_CLAIM_TTL_S * 1000).toISOString(), now());
      await sleep(SEND_CLAIM_POLL_MS);
    }
  }

  // ── Authentication helpers ───────────────────────────────────────────────────────────────────
  /** The link, its reporter, org and pack; refuses a revoked or expired link, a disabled reporter. */
  async function linkContext(link: FieldLinkRow | null): Promise<LinkContext> {
    if (!link) throw new FieldError(404, 'link_not_found');
    const reporter = await store.getReporter(link.reporter_id);
    if (!reporter) throw new FieldError(404, 'link_not_found');
    const org = await store.getOrgContext(reporter.org_id);
    if (!org) throw new FieldError(404, 'link_not_found');
    const pack = toCountryPack(org.country);
    if (link.revoked_at !== null) throw new FieldError(410, 'link_revoked');
    if (link.expires_at !== null && new Date(link.expires_at).getTime() <= now().getTime()) {
      throw new FieldError(410, 'link_expired', undefined, {
        locale: reporter.locale,
        country: fieldCountryView(pack),
      });
    }
    if (reporter.status === 'disabled') throw new FieldError(403, 'reporter_disabled');
    return { link, reporter, org, pack };
  }

  async function loadLink(code: string): Promise<LinkContext> {
    return linkContext(await store.findLink(linkCodeHash(code)));
  }

  function headerCode(c: Ctx): string {
    const code = c.req.header(FIELD_LINK_HEADER)?.trim();
    if (!code) throw new FieldError(401, 'link_required');
    return code;
  }

  function linkFromHeader(c: Ctx): Promise<LinkContext> {
    return loadLink(headerCode(c));
  }

  /** The reporter's cookie's device, if it is that reporter's and not revoked (verified or not). */
  async function cookieDevice(c: Ctx, reporterId: string): Promise<FieldDeviceRow | null> {
    const token = getCookie(c, deviceCookieName(reporterId));
    if (!token) return null;
    const device = await store.findDevice(sha256Hex(token));
    if (!device || device.reporter_id !== reporterId || device.revoked_at !== null) return null;
    return device;
  }

  const setDeviceCookie = (c: Ctx, reporterId: string, token: string) =>
    setCookie(c, deviceCookieName(reporterId), token, DEVICE_COOKIE_OPTIONS);

  /** 30 requests a minute per device (spec §6.5), and last_seen_at on each call. */
  async function seeDevice(device: FieldDeviceRow): Promise<void> {
    const { limit, windowSeconds } = FIELD_RATE_LIMITS.device;
    const rl = await store.rateLimit(`dev:${device.id}`, limit, windowSeconds);
    if (!rl.allowed) throw rateLimited(rl.resetAt, now());
    await store.updateDevice(device.id, { last_seen_at: now().toISOString() });
  }

  /**
   * Link + verified device + the link's sites + consents; `consent` false for the consent route.
   * Without a device of the link's reporter verified in the last 180 days, every code answers the
   * same 401 (unknown, revoked or expired alike), so these routes tell a caller nothing about a
   * code it guesses (`resolve` and `device/*` still do: spec §19 Q42).
   */
  async function authenticate(c: Ctx, opts: { consent: boolean }): Promise<DeviceContext> {
    const link = await store.findLink(linkCodeHash(headerCode(c)));
    const device = link ? await cookieDevice(c, link.reporter_id) : null;
    if (!device || !deviceVerified(device, now())) throw new FieldError(401, 'device_unverified');
    const linkCtx = await linkContext(link);
    await seeDevice(device);
    const [reporterSites, consentRows] = await Promise.all([
      store.listReporterSites(linkCtx.reporter.id),
      store.listConsents(linkCtx.reporter.id),
    ]);
    const consents = consentState(consentRows);
    if (opts.consent && needsConsent(consents.held)) {
      throw new FieldError(403, 'consent_required');
    }
    const ctx: DeviceContext = {
      ...linkCtx,
      device,
      sites: scopeSites(linkCtx.link, reporterSites),
      consents,
    };
    c.set('field', ctx);
    return ctx;
  }

  const audit = (ctx: LinkContext, action: string, entity: string, entityId: string, diff = {}) =>
    store.audit({
      orgId: ctx.reporter.org_id,
      actorType: 'reporter',
      actorId: ctx.reporter.id,
      action,
      entity,
      entityId,
      diff,
    });

  function siteInScope(ctx: DeviceContext, siteId: string | undefined | null): SiteRow {
    const site = siteId ? ctx.sites.find((s) => s.id === siteId) : undefined;
    if (!site) throw new FieldError(404, 'not_found', 'Site not found');
    return site;
  }

  function activeSites(ctx: DeviceContext): SiteRow[] {
    return ctx.sites.filter((s) => s.status === 'active');
  }

  /** The site a write is for: the body's, the link's, or the reporter's only active one. */
  function writeSite(ctx: DeviceContext, siteId: string | undefined): SiteRow {
    const id =
      siteId ??
      ctx.link.site_id ??
      (activeSites(ctx).length === 1 ? activeSites(ctx)[0]!.id : null);
    if (!id) throw new FieldError(400, 'invalid_request', 'siteId is required');
    const site = siteInScope(ctx, id);
    if (site.status !== 'active') throw new FieldError(409, 'site_inactive');
    return site;
  }

  function reportDate(ctx: DeviceContext, site: SiteRow, requested: string | undefined): string {
    const allowed = allowedReportDates(ctx.link, site, now(), ctx.org.settings?.working_days);
    const date = requested ?? allowed[0]!;
    if (!allowed.includes(date))
      throw new FieldError(400, 'date_not_allowed', undefined, { allowed });
    return date;
  }

  /**
   * An upload's report date: as `reportDate`, and also a day whose window has closed when the
   * phone recorded the file inside it and it arrives within the grace period (spec §19 Q53,
   * `lateClipAllowed`); `late` then says so.
   */
  function uploadDate(
    ctx: DeviceContext,
    site: SiteRow,
    requested: string | undefined,
    recordedAt: string | undefined,
  ): { date: string; late: boolean } {
    const workingDays = ctx.org.settings?.working_days;
    const allowed = allowedReportDates(ctx.link, site, now(), workingDays);
    const date = requested ?? allowed[0]!;
    if (allowed.includes(date)) return { date, late: false };
    if (requested && lateClipAllowed(ctx.link, site, date, recordedAt, now(), workingDays)) {
      return { date, late: true };
    }
    throw new FieldError(400, 'date_not_allowed', undefined, { allowed });
  }

  async function reportInScope(ctx: DeviceContext, id: string) {
    if (!UUID.test(id)) throw new FieldError(404, 'not_found');
    const report = await store.getReport(id);
    if (!report || report.status === 'void' || !ctx.sites.some((s) => s.id === report.site_id)) {
      throw new FieldError(404, 'not_found');
    }
    return report;
  }

  // ── resolve (F4 step 1) ──────────────────────────────────────────────────────────────────────
  app.post('/resolve', async (c) => {
    const { code } = await parseBody(c, ResolveRequestSchema);
    const ctx = await loadLink(code);
    const device = await cookieDevice(c, ctx.reporter.id);
    if (device) await seeDevice(device);
    const verified = device !== null && deviceVerified(device, now());
    if (await store.markLinkOpened(ctx.link.id, now().toISOString())) {
      await audit(ctx, 'link.opened', 'field_link', ctx.link.id, { kind: ctx.link.kind });
    }
    const [sites, consentRows] = await Promise.all([
      verified ? store.listReporterSites(ctx.reporter.id) : Promise.resolve([]),
      store.listConsents(ctx.reporter.id),
    ]);
    const body: ResolveResponse = {
      reporter: {
        name: ctx.reporter.name,
        firstName: firstName(ctx.reporter.name),
        locale: ctx.reporter.locale as ResolveResponse['reporter']['locale'],
        contactPref: ctx.reporter.contact_pref,
        status: ctx.reporter.status,
      },
      org: { name: ctx.org.org.name },
      link: {
        kind: ctx.link.kind,
        siteId: ctx.link.site_id,
        reportDate: ctx.link.report_date,
        expiresAt: ctx.link.expires_at,
      },
      needsDeviceCheck: !verified,
      needsConsent: needsConsent(consentState(consentRows).held),
      sites: scopeSites(ctx.link, sites)
        .filter((s) => s.status !== 'archived')
        .map(fieldSite),
      country: fieldCountryView(ctx.pack),
    };
    return c.json(body);
  });

  // ── device/send-code (F4 step 2) ─────────────────────────────────────────────────────────────
  app.post('/device/send-code', async (c) => {
    const ctx = await linkFromHeader(c);
    let device = await cookieDevice(c, ctx.reporter.id);
    if (device && deviceVerified(device, now())) {
      await seeDevice(device);
      return c.json({ alreadyVerified: true } satisfies SendCodeResponse);
    }
    // A device past its 180 days gets a new code like a new one (verify re-stamps it).
    const secret = deps.linkSigningSecret();
    const { limit, windowSeconds } = FIELD_RATE_LIMITS.codeSend;
    const rl = await store.rateLimit(`code_send:${ctx.reporter.phone_e164}`, limit, windowSeconds);
    if (!rl.allowed) throw rateLimited(rl.resetAt, now());

    const userAgent = c.req.header('user-agent')?.slice(0, 500) ?? null;
    if (!device) {
      const token = newDeviceToken(randomBytes);
      device = await store.insertDevice({
        reporter_id: ctx.reporter.id,
        device_token_hash: sha256Hex(token),
        user_agent: userAgent,
      });
      setDeviceCookie(c, ctx.reporter.id, token);
      await audit(ctx, 'device.created', 'field_device', device.id);
    }
    const code = newVerifyCode(randomBytes);
    const expiresAt = new Date(now().getTime() + VERIFY_CODE_TTL_S * 1000).toISOString();
    await store.updateDevice(device.id, {
      code_hash: await verifyCodeHash(secret, device.id, code),
      code_expires_at: expiresAt,
      user_agent: userAgent,
    });
    const consents = consentState(await store.listConsents(ctx.reporter.id));
    const outcome = await deps.sendVerifyCode({
      org: ctx.org.org,
      pack: ctx.pack,
      reporter: ctx.reporter,
      consents,
      code,
    });
    if (outcome.channel === null) {
      await audit(ctx, 'device.code_skipped', 'field_device', device.id, {
        reason: outcome.reason,
      });
      throw new FieldError(409, 'code_undeliverable', undefined, { reason: outcome.reason });
    }
    await audit(ctx, 'device.code_sent', 'field_device', device.id, {
      channel: outcome.channel,
      message_id: outcome.messageId,
      expires_at: expiresAt,
    });
    return c.json({ sent: true, expiresAt } satisfies SendCodeResponse, 202);
  });

  // ── device/verify (F4 step 2) ────────────────────────────────────────────────────────────────
  app.post('/device/verify', async (c) => {
    const ctx = await linkFromHeader(c);
    const { code } = await parseBody(c, VerifyRequestSchema);
    const device = await cookieDevice(c, ctx.reporter.id);
    if (!device) throw new FieldError(409, 'device_required', 'Send a code first');
    const consentNeeded = async () =>
      needsConsent(consentState(await store.listConsents(ctx.reporter.id)).held);
    if (deviceVerified(device, now())) {
      await seeDevice(device);
      return c.json({
        verified: true,
        needsConsent: await consentNeeded(),
      } satisfies VerifyResponse);
    }
    const secret = deps.linkSigningSecret();
    const { limit, windowSeconds } = FIELD_RATE_LIMITS.codeVerify;
    const rl = await store.rateLimit(`code:${ctx.reporter.phone_e164}`, limit, windowSeconds);
    if (!rl.allowed) {
      // F16: the first refused attempt of a window locks the check until the window ends;
      // field_device_verify_locked() audits it and tells the office once per window.
      if (rl.count === limit + 1) {
        await store.deviceVerifyLocked(ctx.reporter.id, device.id, rl.resetAt);
      }
      throw rateLimited(rl.resetAt, now());
    }
    if (!device.code_hash || !device.code_expires_at) throw new FieldError(409, 'no_code');
    if (new Date(device.code_expires_at).getTime() <= now().getTime()) {
      throw new FieldError(400, 'code_expired');
    }
    if (!timingSafeEqual(await verifyCodeHash(secret, device.id, code), device.code_hash)) {
      await audit(ctx, 'device.code_failed', 'field_device', device.id, { attempt: rl.count });
      throw new FieldError(400, 'code_invalid', undefined, { attemptsLeft: limit - rl.count });
    }
    const at = now().toISOString();
    await store.updateDevice(device.id, {
      verified_at: at,
      last_seen_at: at,
      code_hash: null,
      code_expires_at: null,
      user_agent: c.req.header('user-agent')?.slice(0, 500) ?? device.user_agent,
    });
    await audit(ctx, 'device.verified', 'field_device', device.id);
    // The 180 days count from verification.
    const token = getCookie(c, deviceCookieName(ctx.reporter.id));
    if (token) setDeviceCookie(c, ctx.reporter.id, token);
    return c.json({ verified: true, needsConsent: await consentNeeded() } satisfies VerifyResponse);
  });

  // ── consent (F4 step 3, Field-02) ────────────────────────────────────────────────────────────
  app.post('/consent', async (c) => {
    const ctx = await authenticate(c, { consent: false });
    const body = await parseBody(c, ConsentRequestSchema);
    if (!REQUIRED_CONSENTS.every((t) => body.types.includes(t))) {
      throw new FieldError(400, 'consent_required', 'Recording and processing consent is required');
    }
    const required = ctx.pack.legalKeys.consent;
    if (required !== undefined && body.textVersion !== required) {
      throw new FieldError(409, 'text_version_mismatch', undefined, { textVersion: required });
    }
    if (!ctx.pack.fieldLocales.includes(body.locale)) {
      throw new FieldError(400, 'locale_not_offered', undefined, {
        offered: ctx.pack.fieldLocales,
      });
    }
    // W2-15 (spec §19 Q25): *Message me on WhatsApp* only where the pack lists WhatsApp; push is
    // given by its own toggle (W2-14), never here.
    if (body.types.includes('whatsapp') && !ctx.pack.messageChannels.includes('whatsapp')) {
      throw new FieldError(400, 'channel_not_offered', undefined, {
        offered: settingsMessageChannels(ctx.pack),
      });
    }
    const fresh = [...new Set(body.types)].filter((t) => !ctx.consents.held.has(t));
    const evidence = {
      device_id: ctx.device.id,
      user_agent: c.req.header('user-agent')?.slice(0, 500) ?? null,
      ip: clientIp(c.req.raw.headers),
    };
    const inserted = await store.insertConsents(
      fresh.map((type) => ({
        reporter_id: ctx.reporter.id,
        type,
        method: 'web_checkbox',
        text_version: body.textVersion,
        evidence,
      })),
    );
    for (const row of inserted) {
      await audit(ctx, 'consent.given', 'consent', row.id, {
        type: row.type,
        method: row.method,
        text_version: row.text_version,
      });
    }
    // F3 step 3: the first consent makes the reporter active. Opted-out stays opted-out (STOP is
    // undone by START only); a disabled reporter never gets here.
    const activate = ctx.reporter.status === 'invited';
    const changed = {
      ...(body.contactPref !== ctx.reporter.contact_pref ? { contact_pref: body.contactPref } : {}),
      ...(body.locale !== ctx.reporter.locale ? { locale: body.locale } : {}),
    };
    let reporter = ctx.reporter;
    if (activate || Object.keys(changed).length > 0) {
      reporter = await store.updateReporter(ctx.reporter.id, {
        ...changed,
        ...(activate ? { status: 'active', activated_at: now().toISOString() } : {}),
      });
    }
    if (Object.keys(changed).length > 0) {
      await audit(ctx, 'reporter.preferences_changed', 'reporter', reporter.id, {
        from: { contact_pref: ctx.reporter.contact_pref, locale: ctx.reporter.locale },
        to: changed,
        channel: 'web',
      });
    }
    if (activate) {
      await audit(ctx, 'reporter.activated', 'reporter', reporter.id, {
        from: 'invited',
        via: 'web',
      });
    }
    const held = new Set([...ctx.consents.held, ...inserted.map((r) => r.type)]);
    const response: ConsentResponse = {
      consents: [...held].sort(),
      status: reporter.status,
      contactPref: reporter.contact_pref,
      locale: reporter.locale as ConsentResponse['locale'],
    };
    return c.json(response);
  });

  // ── today (F5 step 1, F14) ───────────────────────────────────────────────────────────────────
  app.get('/today', async (c) => {
    const ctx = await authenticate(c, { consent: true });
    const active = activeSites(ctx);
    // The asked site, else a daily link's own, else the nearest deadline (F14).
    const named = c.req.query('site') || ctx.link.site_id;
    const site = named
      ? siteInScope(ctx, named)
      : nearestDeadlineSite(active, ctx.org.settings, now());
    if (!site) throw new FieldError(404, 'not_found', 'No active site');
    const allowedDates = allowedReportDates(ctx.link, site, now(), ctx.org.settings?.working_days);
    const date = allowedDates[0]!;
    const day = await store.getSiteDay(site.id, date);
    const report = day ? await store.getLiveReport(day.id) : null;
    const deadlineAt =
      day?.deadline_at ??
      deadlineInstant(date, siteDeadline(site, ctx.org.settings), site.timezone).toISOString();
    const body: TodayResponse = {
      site: fieldSite(site),
      sites: active.map(fieldSite),
      date,
      allowedDates,
      deadlineAt: new Date(deadlineAt).toISOString(),
      dayStatus: day?.status ?? 'pending',
      report: report
        ? {
            id: report.id,
            reportNo: report.report_no,
            status: report.status,
            kind: fieldReportKind(report.kind),
          }
        : null,
    };
    return c.json(body);
  });

  // ── uploads (F5 step 3) ──────────────────────────────────────────────────────────────────────
  app.post('/uploads', async (c) => {
    const ctx = await authenticate(c, { consent: true });
    const body = await parseBody(c, UploadRequestSchema);
    const media = uploadMediaType(body.mime);
    if (!media || media.kind !== body.kind) throw new FieldError(400, 'media_type_not_allowed');
    if (body.addTo) return c.json(await uploadToFiled(ctx, body, body.addTo, media.ext), 201);
    if (body.answerTo) {
      return c.json(await uploadAnswerClip(ctx, body, body.answerTo, media.ext), 201);
    }
    if (body.fixTo) return c.json(await uploadFixClip(ctx, body, body.fixTo, media.ext), 201);
    if (ctx.link.kind === 'photos' && body.kind !== 'photo') {
      throw new FieldError(400, 'kind_not_allowed', 'A photos link takes photos only (F9)');
    }
    const site = writeSite(ctx, body.siteId);
    const { date, late } = uploadDate(ctx, site, body.date, body.recordedAt);
    // The RPC checks again when the upload completes; this spares an upload that cannot attach.
    const day = await store.getSiteDay(site.id, date);
    const live = day ? await store.getLiveReport(day.id) : null;
    if (live && (live.status === 'filed' || live.status === 'signed_off')) {
      throw new FieldError(409, 'report_filed');
    }
    if (!live && day && ['filed', 'weather_day', 'no_work'].includes(day.status)) {
      throw new FieldError(409, 'day_closed');
    }
    const id = randomUUID();
    const bucket = uploadBucket(body.kind);
    const path = uploadStoragePath(ctx.reporter.org_id, site.id, date, id, media.ext);
    await store.insertUpload({
      id,
      reporter_id: ctx.reporter.id,
      site_id: site.id,
      kind: body.kind,
      storage_path: path,
      mime: media.mime,
      bytes: body.bytes,
      recorded_at: body.recordedAt ?? null,
    });
    const signed = await store.createSignedUploadUrl(bucket, path);
    await audit(ctx, 'upload.created', 'upload', id, {
      kind: body.kind,
      site_id: site.id,
      date,
      ...(late ? { late: true, recorded_at: body.recordedAt } : {}),
    });
    const res: UploadResponse = {
      uploadId: id,
      bucket,
      path,
      ...signed,
      signedUrl: publicSignedUrl(signed.signedUrl, deps.publicUrl?.()),
    };
    return c.json(res, 201);
  });

  /**
   * F9 (W2-04): the Filed screen's *Add more photos*. The filed (or signed-off) report in the
   * link's scope, a link that may add photos to it (`linkMayAddPhotos`, spec §19 Q89), inside F9's
   * window (until 23:59 the next day, site time) and under FILED_PHOTOS_MAX photos after filing
   * (this batch's own completed photos not counted twice); the upload goes in the report's day and
   * joins the batch. field_complete_upload() checks the window, the limit and the batch again.
   */
  async function filedTarget(ctx: DeviceContext, reportId: string) {
    const report = await reportInScope(ctx, reportId);
    if (report.status !== 'filed' && report.status !== 'signed_off') {
      throw new FieldError(409, 'wrong_state', undefined, { status: report.status });
    }
    const day = await store.getSiteDayById(report.site_day_id);
    const site = ctx.sites.find((s) => s.id === report.site_id)!;
    if (!day) throw new FieldError(409, 'wrong_state', undefined, { status: report.status });
    return { report, day, site, until: filedPhotosUntil(day.date, site) };
  }

  async function uploadToFiled(
    ctx: DeviceContext,
    body: UploadRequest,
    addTo: NonNullable<UploadRequest['addTo']>,
    ext: string,
  ): Promise<UploadResponse> {
    const { report, day, site, until } = await filedTarget(ctx, addTo.reportId);
    if (!linkMayAddPhotos(ctx.link, site.id, day.date)) {
      throw new FieldError(403, 'kind_not_allowed', 'This link cannot add photos after filing');
    }
    if (site.status !== 'active') throw new FieldError(409, 'site_inactive');
    if (now().getTime() > new Date(until).getTime()) {
      throw new FieldError(409, 'photos_window_closed', undefined, { until });
    }
    const state = await store.filedPhotoState(report.id, addTo.batchId);
    if (state.added + addTo.photos > FILED_PHOTOS_MAX) {
      throw new FieldError(409, 'photo_limit', undefined, {
        remaining: Math.max(0, FILED_PHOTOS_MAX - state.added),
      });
    }
    const id = randomUUID();
    const bucket = uploadBucket(body.kind);
    const path = uploadStoragePath(ctx.reporter.org_id, site.id, day.date, id, ext);
    await store.insertUpload({
      id,
      reporter_id: ctx.reporter.id,
      site_id: site.id,
      kind: body.kind,
      storage_path: path,
      mime: uploadMediaType(body.mime)!.mime,
      bytes: body.bytes,
      recorded_at: body.recordedAt ?? null,
      batch_id: addTo.batchId,
      batch_size: addTo.photos + (addTo.caption ? 1 : 0),
    });
    const signed = await store.createSignedUploadUrl(bucket, path);
    await audit(ctx, 'upload.created', 'upload', id, {
      kind: body.kind,
      site_id: site.id,
      date: day.date,
      report_id: report.id,
      batch_id: addTo.batchId,
      after_filing: true,
    });
    return {
      uploadId: id,
      bucket,
      path,
      ...signed,
      signedUrl: publicSignedUrl(signed.signedUrl, deps.publicUrl?.()),
    };
  }

  /**
   * F7 *Other…* (W2-09): a spoken answer's clip for the open web question of a report in the
   * link's scope, awaiting that answer. The clip goes in the report's site and day and names the
   * question (`uploads.question_id`): field_complete_upload() stages it on the report without
   * making it report material; `reports/:id/answer {uploadId}` then hands it to the worker.
   */
  async function uploadAnswerClip(
    ctx: DeviceContext,
    body: UploadRequest,
    answerTo: AnswerTo,
    ext: string,
  ): Promise<UploadResponse> {
    const report = await reportInScope(ctx, answerTo.reportId);
    const question = await store.getQuestion(answerTo.questionId);
    if (!question || question.report_id !== report.id) {
      throw new FieldError(404, 'not_found', 'Question not found');
    }
    if (question.channel !== 'web' || question.answered_at !== null) {
      throw new FieldError(409, 'question_closed');
    }
    if (report.status !== 'awaiting_answer') {
      throw new FieldError(409, 'wrong_state', undefined, { status: report.status });
    }
    const site = ctx.sites.find((s) => s.id === report.site_id)!;
    if (site.status !== 'active') throw new FieldError(409, 'site_inactive');
    const day = await store.getSiteDayById(report.site_day_id);
    if (!day) throw new FieldError(409, 'wrong_state', undefined, { status: report.status });
    const id = randomUUID();
    const bucket = uploadBucket(body.kind);
    const path = uploadStoragePath(ctx.reporter.org_id, site.id, day.date, id, ext);
    await store.insertUpload({
      id,
      reporter_id: ctx.reporter.id,
      site_id: site.id,
      kind: body.kind,
      storage_path: path,
      mime: uploadMediaType(body.mime)!.mime,
      bytes: body.bytes,
      recorded_at: body.recordedAt ?? null,
      question_id: question.id,
    });
    const signed = await store.createSignedUploadUrl(bucket, path);
    await audit(ctx, 'upload.created', 'upload', id, {
      kind: body.kind,
      site_id: site.id,
      date: day.date,
      report_id: report.id,
      question_id: question.id,
      answer_clip: true,
    });
    return {
      uploadId: id,
      bucket,
      path,
      ...signed,
      signedUrl: publicSignedUrl(signed.signedUrl, deps.publicUrl?.()),
    };
  }

  /**
   * A draft in the link's scope that the reporter may fix (W2-10, F8): awaiting confirmation, on
   * an active site. Else 409 `wrong_state` (the screen shows the latest view).
   */
  async function draftInScope(ctx: DeviceContext, reportId: string) {
    const report = await reportInScope(ctx, reportId);
    if (report.status !== 'awaiting_confirmation') {
      throw new FieldError(409, 'wrong_state', undefined, { status: report.status });
    }
    const site = ctx.sites.find((s) => s.id === report.site_id)!;
    if (site.status !== 'active') throw new FieldError(409, 'site_inactive');
    return { report, site };
  }

  /**
   * F10 *Change something* (W2-11, spec §19 Q81): a filed (or signed-off) report in the link's
   * scope (a site the reporter covers), of the last HISTORY_DAYS days in its site's time zone
   * (409 `report_locked` older: "That report is locked. Ask the office to change it."), on an
   * active site. Else 409 `wrong_state`.
   */
  async function changeTarget(ctx: DeviceContext, reportId: string) {
    const report = await reportInScope(ctx, reportId);
    if (report.status !== 'filed' && report.status !== 'signed_off') {
      throw new FieldError(409, 'wrong_state', undefined, { status: report.status });
    }
    const site = ctx.sites.find((s) => s.id === report.site_id)!;
    const day = await store.getSiteDayById(report.site_day_id);
    if (!day) throw new FieldError(409, 'wrong_state', undefined, { status: report.status });
    if (!filedChangeable(day.date, now(), site.timezone, HISTORY_DAYS)) {
      throw new FieldError(409, 'report_locked');
    }
    if (site.status !== 'active') throw new FieldError(409, 'site_inactive');
    return { report, site, day };
  }

  /** A correction clip's report: a draft awaiting confirmation (W2-10) or a filed one (W2-11). */
  async function fixTarget(ctx: DeviceContext, reportId: string) {
    const report = await reportInScope(ctx, reportId);
    return report.status === 'filed' || report.status === 'signed_off'
      ? changeTarget(ctx, reportId)
      : draftInScope(ctx, reportId);
  }

  /**
   * F8 *Fix by voice* (W2-10): a correction clip for a draft awaiting confirmation (W2-11: or a
   * filed report the reporter may still change, F10 *Change something*). The clip goes
   * in the report's site and day and names the draft (`uploads.correction_report_id`):
   * field_complete_upload() stages it on the report without making it report material;
   * `reports/:id/correction {uploadId}` then hands it to the worker.
   */
  async function uploadFixClip(
    ctx: DeviceContext,
    body: UploadRequest,
    fixTo: FixTo,
    ext: string,
  ): Promise<UploadResponse> {
    const { report, site } = await fixTarget(ctx, fixTo.reportId);
    const day = await store.getSiteDayById(report.site_day_id);
    if (!day) throw new FieldError(409, 'wrong_state', undefined, { status: report.status });
    const id = randomUUID();
    const bucket = uploadBucket(body.kind);
    const path = uploadStoragePath(ctx.reporter.org_id, site.id, day.date, id, ext);
    await store.insertUpload({
      id,
      reporter_id: ctx.reporter.id,
      site_id: site.id,
      kind: body.kind,
      storage_path: path,
      mime: uploadMediaType(body.mime)!.mime,
      bytes: body.bytes,
      recorded_at: body.recordedAt ?? null,
      correction_report_id: report.id,
    });
    const signed = await store.createSignedUploadUrl(bucket, path);
    await audit(ctx, 'upload.created', 'upload', id, {
      kind: body.kind,
      site_id: site.id,
      date: day.date,
      report_id: report.id,
      correction_clip: true,
    });
    return {
      uploadId: id,
      bucket,
      path,
      ...signed,
      signedUrl: publicSignedUrl(signed.signedUrl, deps.publicUrl?.()),
    };
  }

  // ── uploads/:id/complete ─────────────────────────────────────────────────────────────────────
  app.post('/uploads/:id/complete', async (c) => {
    const ctx = await authenticate(c, { consent: true });
    const id = c.req.param('id');
    if (!UUID.test(id)) throw new FieldError(404, 'not_found');
    const upload = await store.getUpload(id);
    if (
      !upload ||
      upload.reporter_id !== ctx.reporter.id ||
      !ctx.sites.some((s) => s.id === upload.site_id)
    ) {
      throw new FieldError(404, 'not_found');
    }
    // A signed upload URL fixes neither the type nor the size: check what Storage holds, keep
    // its real size, and drop an object that is not what the upload named.
    let bytes = upload.bytes;
    if (upload.report_id === null) {
      const bucket = uploadBucket(upload.kind);
      const object = await store.objectInfo(bucket, upload.storage_path);
      const problem = storedObjectProblem(upload.mime, object);
      if (problem === 'upload_missing') {
        throw new FieldError(409, problem, 'The file has not reached storage yet');
      }
      if (problem) {
        await store.removeObject(bucket, upload.storage_path);
        await audit(ctx, 'upload.rejected', 'upload', upload.id, {
          reason: problem,
          content_type: object?.contentType ?? null,
          bytes: object?.size ?? null,
        });
        throw new FieldError(409, problem);
      }
      bytes = object!.size;
    }
    const result = await store.completeUpload(upload.id, ctx.reporter.id, bytes);
    if (result.batch) {
      // F9 (W2-04): a batch added to the filed report. Whole and without a caption: its version
      // now (also on a retried complete, whose first answer was lost: field_attach_photos()
      // answers the version a batch made before). With a caption the worker attaches it after
      // the transcription field_complete_upload() enqueued.
      let version: number | null = null;
      if (result.batch.ready && !result.batch.captionUploadId) {
        const report = await store.getReport(result.reportId);
        const photos = upload.batch_size ?? 1;
        const attached = await store.attachPhotos(
          result.reportId,
          result.batch.id,
          photosAddedNote(report?.language ?? 'en', photos),
          null,
        );
        version = attached.version;
      }
      const res: CompleteResponse = {
        reportId: result.reportId,
        reportNo: result.reportNo,
        reportStatus: version !== null ? 'filed' : result.reportStatus,
        created: false,
        alreadyComplete: result.alreadyComplete,
        batch: { id: result.batch.id, ready: result.batch.ready, version },
      };
      return c.json(res);
    }
    // Spec §19 Q53: a file that reaches its report after its day's window closed (a late clip
    // `uploads` accepted, or one created just before the window closed) is flagged late to the
    // office, once per upload (a retried complete flags nothing twice). Judged at the moment the
    // file reached its report: a retried complete (its first answer lost) of an upload that
    // arrived on time is not late, however much later the retry comes.
    const site = ctx.sites.find((s) => s.id === upload.site_id)!;
    const date = upload.storage_path.split('/')[2] ?? '';
    const arrivedAt =
      result.alreadyComplete && upload.report_id !== null && upload.received_at
        ? new Date(upload.received_at)
        : now();
    const workingDays = ctx.org.settings?.working_days;
    if (!allowedReportDates(ctx.link, site, arrivedAt, workingDays).includes(date)) {
      await store.flagLateUpload(upload.id, ctx.reporter.id);
    }
    const res: CompleteResponse = {
      reportId: result.reportId,
      reportNo: result.reportNo,
      reportStatus: result.reportStatus,
      created: result.created,
      alreadyComplete: result.alreadyComplete,
    };
    return c.json(res);
  });

  // ── test-clip (F4 step 3, Field-02; W2-13, spec §19 Q52) ──────────────────────────────────────
  // The optional 20-second test after the consents: a signed upload under `test/` in the audio
  // bucket, outside any report and never a source. field_test_clip_create() refuses it without
  // the recording consent (which covers the clip), audits it and queues its deletion 10 minutes
  // on; `complete` queues the transcription; the snippet is answered once, then deleted.
  app.post('/test-clip', async (c) => {
    const ctx = await authenticate(c, { consent: true });
    const body = await parseBody(c, TestClipRequestSchema);
    const media = uploadMediaType(body.mime);
    if (!media || media.kind !== 'audio') throw new FieldError(400, 'media_type_not_allowed');
    const { limit, windowSeconds } = FIELD_RATE_LIMITS.testClip;
    const rl = await store.rateLimit(`test_clip:${ctx.device.id}`, limit, windowSeconds);
    if (!rl.allowed) throw rateLimited(rl.resetAt, now());
    const id = randomUUID();
    const path = `test/${ctx.reporter.org_id}/${id}.${media.ext}`;
    await store.createTestClip({
      id,
      reporterId: ctx.reporter.id,
      deviceId: ctx.device.id,
      path,
      mime: media.mime,
      bytes: body.bytes,
    });
    const signed = await store.createSignedUploadUrl('audio', path);
    const res: TestClipResponse = {
      testClipId: id,
      bucket: 'audio',
      path,
      ...signed,
      signedUrl: publicSignedUrl(signed.signedUrl, deps.publicUrl?.()),
    };
    return c.json(res, 201);
  });

  /** The reporter's own test recording, else 404. */
  async function ownTestClip(ctx: DeviceContext, id: string) {
    if (!UUID.test(id)) throw new FieldError(404, 'not_found');
    const clip = await store.getTestClip(id);
    if (!clip || clip.reporter_id !== ctx.reporter.id) throw new FieldError(404, 'not_found');
    return clip;
  }

  app.post('/test-clip/:id/complete', async (c) => {
    const ctx = await authenticate(c, { consent: true });
    const clip = await ownTestClip(ctx, c.req.param('id'));
    let bytes: number | null = clip.bytes;
    if (!clip.completed_at && !clip.deleted_at) {
      const object = await store.objectInfo('audio', clip.storage_path);
      const problem = storedObjectProblem(clip.mime, object);
      if (problem === 'upload_missing') throw new FieldError(409, problem);
      if (problem || (object!.size ?? 0) > TEST_CLIP_MAX_BYTES) {
        await store.removeObject('audio', clip.storage_path);
        throw new FieldError(409, problem ?? 'upload_too_large');
      }
      bytes = object!.size;
    }
    const res = await store.completeTestClip(clip.id, ctx.reporter.id, bytes);
    const view: TestClipView = { status: res.status, snippet: null };
    return c.json(view, 202);
  });

  app.get('/test-clip/:id', async (c) => {
    const ctx = await authenticate(c, { consent: true });
    const clip = await ownTestClip(ctx, c.req.param('id'));
    return c.json(await store.readTestClip(clip.id, ctx.reporter.id));
  });

  // ── reports/:id (question, draft, filed; processing poll) ────────────────────────────────────
  app.get('/reports/:id', async (c) => {
    const ctx = await authenticate(c, { consent: true });
    const report = await reportInScope(ctx, c.req.param('id'));
    const site = ctx.sites.find((s) => s.id === report.site_id)!;
    const [day, version, question, progress, answered] = await Promise.all([
      store.getSiteDayById(report.site_day_id),
      store.getVersion(report.id, report.current_version),
      store.getOpenQuestion(report.id),
      store.countReportMedia(report.id),
      store.listAnsweredQuestions(report.id),
    ]);
    const filed = report.status === 'filed' || report.status === 'signed_off';
    const pdfUrl =
      filed && version?.pdf_path
        ? await store.createSignedUrl('pdfs', version.pdf_path, SIGNED_URL_SECONDS)
        : null;
    const view: ReportView = {
      id: report.id,
      reportNo: report.report_no,
      status: report.status,
      kind: fieldReportKind(report.kind),
      siteId: site.id,
      siteName: site.name,
      date: day?.date ?? '',
      channel: report.channel,
      currentVersion: report.current_version,
      needsReview: report.needs_review,
      filedAt: report.filed_at,
      confirmedAt: report.confirmed_at,
      question: question
        ? {
            id: question.id,
            field: question.field,
            prompt: question.prompt,
            options: questionOptions(question.options),
            manpowerIndex: questionManpowerIndex(question.target),
            voice: voiceAnswerView(question),
          }
        : null,
      lastVoiceAnswer: lastVoiceAnswerView(answered),
      data: version ? readReportData(version.data as Parameters<typeof readReportData>[0]) : null,
      draftRev: version ? (version.draft_rev ?? 1) : null,
      progress,
      pdfUrl,
      addPhotos: filed && day ? await addPhotosView(ctx, report.id, site, day.date) : null,
      changeNote: version?.change_note ?? null,
      // W2-10: the draft's latest fix while it matters (a reload shows the preview again);
      // W2-11: on a filed report, its latest change not saved yet.
      correction:
        report.status === 'awaiting_confirmation' || filed
          ? openCorrectionView(
              // W2-10 review: this reporter's own fix; another reporter's on the site is theirs.
              await store
                .latestCorrection(report.id, ctx.reporter.id)
                .then((row) => (row && row.after_filing === filed ? row : null)),
              now(),
            )
          : null,
      change:
        filed && day
          ? (() => {
              const locked = !filedChangeable(day.date, now(), site.timezone, HISTORY_DAYS);
              return { canChange: !locked && site.status === 'active', locked };
            })()
          : null,
    };
    return c.json(view);
  });

  /** F9 on a filed report's view: whether this link may add photos now, and what is pending. */
  async function addPhotosView(
    ctx: DeviceContext,
    reportId: string,
    site: SiteRow,
    date: string,
  ): Promise<NonNullable<ReportView['addPhotos']>> {
    const state = await store.filedPhotoState(reportId);
    const until = filedPhotosUntil(date, site);
    const remaining = Math.max(0, FILED_PHOTOS_MAX - state.added);
    const canAdd =
      remaining > 0 &&
      site.status === 'active' &&
      now().getTime() <= new Date(until).getTime() &&
      linkMayAddPhotos(ctx.link, site.id, date);
    return { canAdd, remaining, until, pending: state.pending };
  }

  // ── reports/:id/confirm (F8: Confirm & send) ─────────────────────────────────────────────────
  app.post('/reports/:id/confirm', async (c) => {
    const ctx = await authenticate(c, { consent: true });
    const report = await reportInScope(ctx, c.req.param('id'));
    const body = await parseBody(c, ConfirmRequestSchema);
    if (report.status === 'filed' || report.status === 'signed_off') {
      return c.json({ status: 'filed' } satisfies ConfirmResponse);
    }
    if (report.status !== 'awaiting_confirmation') {
      throw new FieldError(409, 'wrong_state', undefined, { status: report.status });
    }
    const version = body.version ?? report.current_version;
    // Drafts are overwritten in place: the revision tells the draft shown from a newer one at the
    // same version (a late photo's re-extraction while the Draft screen was open).
    const current = await store.getVersion(report.id, report.current_version);
    const currentRev = current ? (current.draft_rev ?? 1) : null;
    if (version !== report.current_version || body.draftRev !== currentRev) {
      throw new FieldError(409, 'draft_changed', undefined, {
        currentVersion: report.current_version,
        draftRev: currentRev,
      });
    }
    // field_confirm_report() checks all three again under the site-day lock that completing an
    // upload takes, returns a filing already queued or running for this draft, else enqueues
    // file_report for this version and revision under a key per confirm occurrence (GAP D16) and
    // audits report.confirm_requested; the worker files only that version at that revision
    // (apps/worker/src/pipeline/file.ts).
    const res = await store.confirmReport(report.id, ctx.reporter.id, version, body.draftRev);
    return res.status === 'filed'
      ? c.json({ status: 'filed' } satisfies ConfirmResponse)
      : c.json({ status: 'queued' } satisfies ConfirmResponse, 202);
  });

  // ── reports/:id/answer (F7, Field-05; W1-12) ─────────────────────────────────────────────────
  app.post('/reports/:id/answer', async (c) => {
    const ctx = await authenticate(c, { consent: true });
    const report = await reportInScope(ctx, c.req.param('id'));
    const body = await parseBody(c, AnswerRequestSchema);
    const question = await store.getQuestion(body.questionId);
    if (!question || question.report_id !== report.id) {
      throw new FieldError(404, 'not_found', 'Question not found');
    }
    // A WhatsApp question (no channel) or one code cannot read is not the web's to answer.
    if (
      question.channel !== 'web' ||
      !(QUESTION_FIELDS as readonly string[]).includes(question.field)
    ) {
      throw new FieldError(409, 'question_closed');
    }
    const field = question.field as QuestionField;
    const target = (question.target ?? {}) as QuestionSpec['target'];

    // W2-09 (F7 *Other…*, §10.7): a spoken answer. The clip must be a completed answer clip of
    // this question; the worker transcribes it and parses it (parse_answer), then applies the
    // value in code or asks once more. The report stays awaiting the answer meanwhile.
    if (body.uploadId !== undefined) {
      const upload = await store.getUpload(body.uploadId);
      if (
        !upload ||
        upload.reporter_id !== ctx.reporter.id ||
        upload.question_id !== question.id ||
        upload.kind !== 'audio'
      ) {
        throw new FieldError(404, 'not_found', 'Upload not found');
      }
      if (upload.report_id !== report.id) {
        throw new FieldError(409, 'upload_missing', 'The clip has not been completed yet');
      }
      const res = await store.answerQuestionVoice({
        reportId: report.id,
        questionId: question.id,
        reporterId: ctx.reporter.id,
        uploadId: upload.id,
      });
      const out: AnswerResponse = {
        status: 'listening',
        reportStatus: res.reportStatus,
        confirmation: null,
      };
      return c.json(out, 202);
    }

    // The answer in code (§10.5): the option's value (a fallback option) or its label parsed (the
    // model's option); D28, a typed number for the field it answers. Never a model call here.
    let value: AnswerValue | null;
    let label: string;
    if (body.optionId !== undefined) {
      const option = storedQuestionOptions(question.options).find((o) => o.id === body.optionId);
      if (!option) throw new FieldError(400, 'answer_not_accepted', 'Unknown option');
      value = optionAnswer(field, option);
      label = option.label;
    } else {
      value = numberAnswer(field, body.value!, body.hours);
      label = numberAnswerLabel(body.value!, body.hours);
    }
    // A headcount question is only answered by a headcount.
    if (!value || (field === 'manpower.workers' && value.workers == null)) {
      throw new FieldError(400, 'answer_not_accepted');
    }
    const answer = {
      ...(body.optionId !== undefined
        ? { optionId: body.optionId }
        : { value: body.value, ...(body.hours !== undefined ? { hours: body.hours } : {}) }),
      text: label,
      parsed: value,
      via: 'web',
    };

    const version = await store.getVersion(report.id, report.current_version);
    if (!version) throw new FieldError(409, 'wrong_state', undefined, { status: report.status });
    const draft = readReportData(version.data as Parameters<typeof readReportData>[0]);
    const settings = ctx.org.settings;
    if (!settings) throw new Error(`org ${ctx.org.org.id} has no settings`);
    const site = ctx.sites.find((s) => s.id === report.site_id)!;

    let newCompany: { name: string; manpowerIndex: number } | null = null;
    if (field === 'company.unknown' && value.companyAction === 'add') {
      const index = target.manpowerIndex;
      const entry = index !== undefined ? draft.manpower[index] : undefined;
      const name = (value.companyName ?? entry?.companyName ?? target.companyName ?? '').trim();
      if (index === undefined || !entry || !name) throw new FieldError(400, 'answer_not_accepted');
      newCompany = { name, manpowerIndex: index };
    }
    const applied = applyAnswer(draft, { field, target }, value, {
      defaultShiftHours: Number(settings.default_shift_hours),
      workingHours: site.working_hours,
      source: { type: 'answer', questionId: question.id },
    });
    // field_answer_question() checks the question is the open one, the report awaits an answer
    // and the draft is still `version.data`, under the site-day lock; it stores the draft and the
    // answer, audits report.question_answered and enqueues decide_next (decide:<report>:answer:<q>).
    const res = await store.answerQuestion({
      reportId: report.id,
      questionId: question.id,
      reporterId: ctx.reporter.id,
      base: version.data,
      data: applied.data,
      answer,
      answerSource: { type: 'answer', questionId: question.id },
      newCompany,
    });
    const out: AnswerResponse = {
      status: res.status,
      reportStatus: res.reportStatus,
      // F7's confirmation line from the draft the answer made (W1-13): code's numbers.
      confirmation: answerConfirmation(field, target, applied.data, value),
    };
    return c.json(out, res.status === 'processing' ? 202 : 200);
  });

  // ── reports/:id/correction (F8 Fix by voice, §10.6; W2-10) ───────────────────────────────────
  // A fix of the draft, said (a completed correction clip) or typed: field_request_correction()
  // queues apply_correction; the worker makes the preview in code. Nothing changes until the
  // reporter saves it (`…/apply`), and then only on the draft the preview was made from.
  // W2-11 (F10 *Change something*): on a filed (or signed-off) report of the last 14 days the
  // same route takes a change of it: field_request_filed_correction(), the preview made from the
  // current version, and Save change makes version n+1.
  app.post('/reports/:id/correction', async (c) => {
    const ctx = await authenticate(c, { consent: true });
    const { report } = await fixTarget(ctx, c.req.param('id'));
    const afterFiling = report.status === 'filed' || report.status === 'signed_off';
    const body = await parseBody(c, CorrectionRequestSchema);
    if (body.uploadId !== undefined) {
      const upload = await store.getUpload(body.uploadId);
      if (
        !upload ||
        upload.reporter_id !== ctx.reporter.id ||
        upload.correction_report_id !== report.id ||
        upload.kind !== 'audio'
      ) {
        throw new FieldError(404, 'not_found', 'Upload not found');
      }
      if (upload.report_id !== report.id) {
        throw new FieldError(409, 'upload_missing', 'The clip has not been completed yet');
      }
    }
    const input = {
      reportId: report.id,
      reporterId: ctx.reporter.id,
      uploadId: body.uploadId ?? null,
      text: body.text ?? null,
    };
    const res = afterFiling
      ? await store.requestFiledCorrection(input)
      : await store.requestCorrection(input);
    const row = await store.getCorrection(res.id);
    if (!row) throw new Error(`correction ${res.id} not found`);
    return c.json(correctionView(row, now()) satisfies CorrectionView, 202);
  });

  /** A fix of a report in the link's scope (W2-10), else 404. */
  async function ownCorrection(ctx: DeviceContext, reportId: string, cid: string) {
    const report = await reportInScope(ctx, reportId);
    if (!UUID.test(cid)) throw new FieldError(404, 'not_found');
    const row = await store.getCorrection(cid);
    if (!row || row.report_id !== report.id || row.reporter_id !== ctx.reporter.id) {
      throw new FieldError(404, 'not_found');
    }
    return { report, row };
  }

  app.get('/reports/:id/correction/:cid', async (c) => {
    const ctx = await authenticate(c, { consent: true });
    const { row } = await ownCorrection(ctx, c.req.param('id'), c.req.param('cid'));
    return c.json(correctionView(row, now()) satisfies CorrectionView);
  });

  // Save change: field_apply_correction() writes the preview at the version and draft revision it
  // was made from (409 `draft_changed` otherwise), moves the report to processing (§7.2 "fix
  // requested") and queues decide_next, which shows the draft again with its new revision.
  app.post('/reports/:id/correction/:cid/apply', async (c) => {
    const ctx = await authenticate(c, { consent: true });
    const { report, row } = await ownCorrection(ctx, c.req.param('id'), c.req.param('cid'));
    if (row.after_filing) return c.json(await saveFiledChange(ctx, report, row));
    const res = await store.applyCorrection(row.id, report.id, ctx.reporter.id);
    if (res.status === 'stale') {
      throw new FieldError(409, 'draft_changed', undefined, {
        currentVersion: res.currentVersion,
        draftRev: res.draftRev,
      });
    }
    return c.json({
      status: 'applied',
      reportStatus: res.reportStatus,
    } satisfies ApplyCorrectionResponse);
  });

  /**
   * F10 Save change (W2-11): field_save_filed_correction() makes version n+1 from the preview at
   * the version it was made from (409 `draft_changed` otherwise; `report_locked` after the 14
   * days), with the change note in the report's language and the `edit_applied` text's weekday and
   * change in the reporter's, both from the preview's lines (code's numbers, never the model's note).
   */
  async function saveFiledChange(
    ctx: DeviceContext,
    report: Awaited<ReturnType<typeof reportInScope>>,
    row: NonNullable<Awaited<ReturnType<FieldStore['getCorrection']>>>,
  ): Promise<ApplyCorrectionResponse> {
    if (row.status === 'ready' || row.status === 'applied') {
      const { day } = row.status === 'ready' ? await changeTarget(ctx, report.id) : { day: null };
      const changes = (Array.isArray(row.changes)
        ? row.changes
        : []) as unknown as CorrectionChange[];
      const reportLanguage = report.language === 'tr' ? 'tr' : 'en';
      // §19 Q100: the note is code's lines, never the model's; a preview with no line saves nothing.
      const note = correctionNote(changes, reportLanguage);
      if (!note && row.status === 'ready') throw new FieldError(409, 'correction_not_ready');
      const reporterLanguage = languageOf(ctx.reporter.locale);
      const change = correctionNote(changes, reporterLanguage, { sms: true });
      const res = await store.saveFiledCorrection({
        correctionId: row.id,
        reportId: report.id,
        reporterId: ctx.reporter.id,
        // A retry of a save (applied) answers the version it made; its note is not read then.
        changeNote: note ?? '',
        message:
          day && change
            ? { weekday: formatDate(day.date, 'weekday', reporterLanguage), change }
            : null,
      });
      if (res.status === 'stale') {
        throw new FieldError(409, 'draft_changed', undefined, {
          currentVersion: res.currentVersion,
          draftRev: res.draftRev,
        });
      }
      return { status: 'applied', reportStatus: res.reportStatus, version: res.version };
    }
    throw new FieldError(409, 'correction_not_ready');
  }

  // ── reports/:id/edit (F8 steppers; W2-10, spec §19 Q80) ──────────────────────────────────────
  // One crew line's workers and hours as the reporter set them, on the draft they saw: applied in
  // code (`applyCrewEdit`: totals recomputed, the line citing `reporter_edit`), then
  // field_edit_draft() writes it only on that draft (409 `draft_changed` otherwise).
  app.post('/reports/:id/edit', async (c) => {
    const ctx = await authenticate(c, { consent: true });
    const { report } = await draftInScope(ctx, c.req.param('id'));
    const body = await parseBody(c, EditRequestSchema);
    const version = await store.getVersion(report.id, report.current_version);
    const currentRev = version ? (version.draft_rev ?? 1) : null;
    if (!version || body.version !== report.current_version || body.draftRev !== currentRev) {
      throw new FieldError(409, 'draft_changed', undefined, {
        currentVersion: report.current_version,
        draftRev: currentRev,
      });
    }
    const settings = ctx.org.settings;
    if (!settings) throw new Error(`org ${ctx.org.org.id} has no settings`);
    const source: Source = {
      type: 'reporter_edit',
      reporterId: ctx.reporter.id,
      at: now().toISOString(),
      via: 'web',
    };
    const draft = readReportData(version.data as Parameters<typeof readReportData>[0]);
    const edited = applyCrewEdit(
      draft,
      { index: body.index, workers: body.workers, hoursPerWorker: body.hoursPerWorker },
      { source, defaultShiftHours: Number(settings.default_shift_hours) },
    );
    if (!edited.ok) throw new FieldError(400, 'edit_not_accepted', edited.reason);
    const res = await store.editDraft({
      reportId: report.id,
      reporterId: ctx.reporter.id,
      version: body.version,
      draftRev: body.draftRev,
      base: version.data,
      data: edited.data as unknown as Json,
      changes: edited.changes as unknown as Json,
      source: source as unknown as Json,
    });
    if (res.status === 'stale') {
      throw new FieldError(409, 'draft_changed', undefined, {
        currentVersion: res.currentVersion,
        draftRev: res.draftRev,
      });
    }
    return c.json(
      { status: 'processing', reportStatus: res.reportStatus } satisfies EditResponse,
      202,
    );
  });

  // ── day-status (F12 buttons) ─────────────────────────────────────────────────────────────────
  app.post('/day-status', async (c) => {
    const ctx = await authenticate(c, { consent: true });
    const body = await parseBody(c, DayStatusRequestSchema);
    const site = writeSite(ctx, body.siteId);
    const date = reportDate(ctx, site, body.date);
    const details = body.details ?? {};
    const settings = ctx.org.settings;
    if (!settings) throw new Error(`org ${ctx.org.org.id} has no settings`);
    // W2-08 (spec §19 Q41): the details as answered questions and a version built in code; the
    // RPC makes the report (a weather day, or no work with no_work_pdf) and queues its filing.
    // A day with a live report is refused there (§19 Q79's default, DAY_OFF_POLICY).
    const plan = dayOffPlan({
      status: body.status,
      date,
      site,
      org: { locale: ctx.org.org.locale, units: ctx.org.org.units },
      defaultShiftHours: Number(settings.default_shift_hours),
      reporterLocale: ctx.reporter.locale,
      details,
      newId: () => crypto.randomUUID(),
    });
    const res = await store.setDayStatus({
      reporterId: ctx.reporter.id,
      siteId: site.id,
      date,
      status: body.status,
      details,
      questions: plan.questions,
      data: plan.data,
    });
    return c.json(res satisfies DayStatusResponse);
  });

  // ── history (F10 Past reports, last 14 days) ─────────────────────────────────────────────────
  app.get('/history', async (c) => {
    const ctx = await authenticate(c, { consent: true });
    const starts = new Map(
      ctx.sites.map((s) => [s.id, historyStart(now(), s.timezone, HISTORY_DAYS)]),
    );
    const since = [...starts.values()].sort()[0];
    const rows = since
      ? await store.listRecentReports(
          ctx.sites.map((s) => s.id),
          since,
        )
      : [];
    const body: HistoryResponse = {
      reports: rows
        .filter((r) => r.date >= (starts.get(r.site_id) ?? r.date))
        .sort((a, b) =>
          a.date === b.date ? b.report_no.localeCompare(a.report_no) : b.date.localeCompare(a.date),
        )
        .map((r) => ({
          id: r.id,
          reportNo: r.report_no,
          status: r.status,
          siteId: r.site_id,
          siteName: ctx.sites.find((s) => s.id === r.site_id)?.name ?? '',
          date: r.date,
          filedAt: r.filed_at,
          currentVersion: r.current_version,
          isLate: r.is_late,
        })),
    };
    return c.json(body);
  });

  // ── Settings (F15, §9.3; W2-02) ──────────────────────────────────────────────────────────────
  // The Settings routes need a verified device but not the required consents: a reporter who
  // turned recording off can still read and change their settings, turn texts off and sign out.

  const vapidKey = (): string | null => deps.vapidPublicKey?.()?.trim() || null;

  async function settingsBody(ctx: DeviceContext, reporter: ReporterRow = ctx.reporter) {
    const [consents, phoneOptedOut, deviceSubscribed] = await Promise.all([
      store.listConsents(ctx.reporter.id),
      store.phoneOptedOut(reporter.phone_e164, ctx.pack.code),
      store.devicePushSubscribed(ctx.reporter.id, ctx.device.id),
    ]);
    return settingsView(reporter, ctx.pack, consents, textsOptedOut(reporter, phoneOptedOut), {
      keySet: vapidKey() !== null,
      deviceSubscribed,
    });
  }

  app.get('/preferences', async (c) => {
    const ctx = await authenticate(c, { consent: false });
    return c.json((await settingsBody(ctx)) satisfies PreferencesResponse);
  });

  app.patch('/preferences', async (c) => {
    const ctx = await authenticate(c, { consent: false });
    const body = await parseBody(c, PreferencesRequestSchema);
    if (body.locale !== undefined && !ctx.pack.fieldLocales.includes(body.locale)) {
      throw new FieldError(400, 'locale_not_offered', undefined, {
        offered: ctx.pack.fieldLocales,
      });
    }
    // Spec §19 Q21: the pack is the allow-list, and only a built channel can be chosen.
    const offered = settingsMessageChannels(ctx.pack);
    if (
      body.messageChannel !== undefined &&
      body.messageChannel !== null &&
      !offered.includes(body.messageChannel)
    ) {
      throw new FieldError(400, 'channel_not_offered', undefined, { offered });
    }
    const before = ctx.reporter;
    const changed = {
      ...(body.contactPref !== undefined && body.contactPref !== before.contact_pref
        ? { contact_pref: body.contactPref }
        : {}),
      ...(body.locale !== undefined && body.locale !== before.locale
        ? { locale: body.locale }
        : {}),
      ...(body.messageChannel !== undefined && body.messageChannel !== before.message_channel
        ? { message_channel: body.messageChannel }
        : {}),
    };
    let reporter = before;
    if (Object.keys(changed).length > 0) {
      const from = Object.fromEntries(
        Object.keys(changed).map((k) => [k, before[k as keyof typeof changed]]),
      );
      reporter = await store.updateReporter(before.id, changed);
      await audit(ctx, 'reporter.preferences_changed', 'reporter', reporter.id, {
        from,
        to: changed,
        channel: 'web',
        device_id: ctx.device.id,
      });
    }
    return c.json((await settingsBody(ctx, reporter)) satisfies PreferencesResponse);
  });

  // ── consent/revoke (F15: Turn off) ───────────────────────────────────────────────────────────
  app.post('/consent/revoke', async (c) => {
    const ctx = await authenticate(c, { consent: false });
    const { type } = await parseBody(c, ConsentRevokeRequestSchema);
    // One transaction: revoked_at, the `consent.revoked` audit and, for recording or processing,
    // the office notice (F15 "office notified"). Nothing held: nothing changes.
    await store.revokeConsent(ctx.reporter.id, type, ctx.device.id);
    return c.json((await settingsBody(ctx)) satisfies PreferencesResponse);
  });

  // ── consent/grant (F15: Turn on texts; spec §19 Q86; WhatsApp W2-15) ─────────────────────────
  // A fresh `sms` or `whatsapp` consent (the pack must list the channel) with the wording shown
  // again (its version checked as `consent` does), audited like the revoke. A phone that opted out
  // of texts stays opted out: 409 `texts_opted_out` (START undoes STOP, §9.5), checked in the same
  // transaction; that never blocks WhatsApp (§19 Q40, the first option).
  app.post('/consent/grant', async (c) => {
    const ctx = await authenticate(c, { consent: false });
    const body = await parseBody(c, ConsentGrantRequestSchema);
    if (!ctx.pack.messageChannels.includes(body.type)) {
      throw new FieldError(400, 'channel_not_offered', undefined, {
        offered: settingsMessageChannels(ctx.pack),
      });
    }
    const required = ctx.pack.legalKeys.consent;
    if (required !== undefined && body.textVersion !== required) {
      throw new FieldError(409, 'text_version_mismatch', undefined, { textVersion: required });
    }
    await store.grantConsent(ctx.reporter.id, body.type, body.textVersion, ctx.device.id, {
      device_id: ctx.device.id,
      user_agent: c.req.header('user-agent')?.slice(0, 500) ?? null,
      ip: clientIp(c.req.raw.headers),
    });
    return c.json((await settingsBody(ctx)) satisfies PreferencesResponse);
  });

  // ── push (F15 Settings *Notifications*; W2-14, spec §19 Q27, Q40) ────────────────────────────
  // The VAPID public key, then the browser's subscription stored with the `push` consent, or this
  // device's subscriptions revoked with it (the per-channel opt-out of §19 Q40). Each audited by
  // the database functions. The field app asks for permission only when the toggle is turned on.
  app.get('/push/key', async (c) => {
    const ctx = await authenticate(c, { consent: false });
    const offered = ctx.pack.messageChannels.includes('push');
    return c.json({ publicKey: offered ? vapidKey() : null } satisfies PushKeyResponse);
  });

  app.post('/push/subscribe', async (c) => {
    const ctx = await authenticate(c, { consent: false });
    const body = await parseBody(c, PushSubscribeRequestSchema);
    if (!ctx.pack.messageChannels.includes('push') || vapidKey() === null) {
      throw new FieldError(400, 'channel_not_offered', undefined, {
        offered: settingsMessageChannels(ctx.pack),
      });
    }
    const required = ctx.pack.legalKeys.consent;
    if (required !== undefined && body.textVersion !== required) {
      throw new FieldError(409, 'text_version_mismatch', undefined, { textVersion: required });
    }
    const userAgent = c.req.header('user-agent')?.slice(0, 500) ?? null;
    await store.pushSubscribe({
      reporterId: ctx.reporter.id,
      deviceId: ctx.device.id,
      endpoint: body.subscription.endpoint,
      p256dh: body.subscription.keys.p256dh,
      auth: body.subscription.keys.auth,
      userAgent,
      textVersion: body.textVersion,
      evidence: {
        device_id: ctx.device.id,
        user_agent: userAgent,
        ip: clientIp(c.req.raw.headers),
      },
    });
    return c.json((await settingsBody(ctx)) satisfies PreferencesResponse);
  });

  app.post('/push/unsubscribe', async (c) => {
    const ctx = await authenticate(c, { consent: false });
    await store.pushUnsubscribe(ctx.reporter.id, ctx.device.id, 'unsubscribed');
    return c.json((await settingsBody(ctx)) satisfies PreferencesResponse);
  });

  // ── expired/daily-link (F16: Send me today's link; W2-03) ────────────────────────────────────
  // The expired link authenticates nothing: it only names the reporter and the site. The answer
  // tells no more than `resolve` already does about the code (unknown 404, revoked 410, live or
  // personal 409), and never holds the new link: the Notifier texts it to the phone on file.
  app.post('/expired/daily-link', async (c) => {
    const { code } = await parseBody(c, ExpiredLinkRequestSchema);
    const link = await store.findLink(linkCodeHash(code));
    if (!link) throw new FieldError(404, 'link_not_found');
    const reporter = await store.getReporter(link.reporter_id);
    const org = reporter ? await store.getOrgContext(reporter.org_id) : null;
    if (!reporter || !org) throw new FieldError(404, 'link_not_found');
    if (link.revoked_at !== null) throw new FieldError(410, 'link_revoked');
    const expired =
      link.expires_at !== null && new Date(link.expires_at).getTime() <= now().getTime();
    if (link.kind !== 'daily' || !expired || !link.site_id) {
      throw new FieldError(409, 'link_not_expired');
    }
    if (reporter.status === 'disabled') throw new FieldError(403, 'reporter_disabled');
    // The device's 30 a minute when the phone sends a cookie of this reporter, and 3 a day per link.
    const device = await cookieDevice(c, reporter.id);
    if (device) await seeDevice(device);
    const { limit, windowSeconds } = FIELD_RATE_LIMITS.expiredLink;
    const rl = await store.rateLimit(`expired_link:${link.id}`, limit, windowSeconds);
    if (!rl.allowed) throw rateLimited(rl.resetAt, now());

    const pack = toCountryPack(org.country);
    const ctx: LinkContext = { link, reporter, org, pack };
    const site = (await store.listReporterSites(reporter.id)).find((s) => s.id === link.site_id);
    const reportDate = site ? formatDateInTz(now(), site.timezone) : null;
    const base = {
      expired_link_id: link.id,
      site_id: link.site_id,
      report_date: reportDate,
      device_id: device?.id ?? null,
    };
    const notSent = async (reason: Extract<ExpiredLinkResponse, { sent: false }>['reason']) => {
      await audit(ctx, 'daily_link.requested', 'field_link', link.id, {
        ...base,
        sent: false,
        reason,
      });
      return c.json({ sent: false, reason } satisfies ExpiredLinkResponse);
    };
    if (!site || site.status === 'archived') return notSent('site_inactive');
    if (site.status === 'paused') return notSent('site_paused');
    const workingDays = org.settings?.working_days;
    if (workingDays && !isWorkingDay(reportDate!, workingDays)) return notSent('not_working_day');

    const secret = deps.linkSigningSecret();
    const fieldAppUrl = deps.fieldAppUrl();
    const today = await ensureDailyLink(
      store,
      secret,
      {
        reporterId: reporter.id,
        siteId: site.id,
        reportDate: reportDate!,
        expiresAt: dailyLinkExpiresAt(now(), deps.dailyLinkTtlHours?.()),
        now: now(),
      },
      randomUUID,
    );
    if (today.created) {
      await audit(ctx, 'field_link.created', 'field_link', today.id, {
        kind: 'daily',
        site_id: site.id,
        report_date: reportDate,
        via: 'expired_link',
      });
    }
    // One message per expired link and day, however often the button is tapped. The Notifier
    // dedupes by the messages already written under the key, so two taps at once take turns: the
    // second waits for the first to finish and then gets the Notifier's answer for that message.
    const sendKey = `expired_daily_link:${link.id}:${reportDate}`;
    await claimSendKey(sendKey);
    let outcome: NotifyOutcome;
    try {
      outcome = await deps.sendDailyLink({
        reporterId: reporter.id,
        vars: {
          site: site.name,
          link: fieldLinkUrl(fieldAppUrl, today.code),
          ...(pack.voiceNumber ? { number: formatPhone(pack.voiceNumber) } : {}),
        },
        dedupeKey: sendKey,
      });
    } finally {
      await store.releaseSend(sendKey);
    }
    if (outcome.channel === null) return notSent(outcome.reason);
    await audit(ctx, 'daily_link.requested', 'field_link', link.id, {
      ...base,
      sent: true,
      link_id: today.id,
      channel: outcome.channel,
      message_id: outcome.messageId,
    });
    return c.json({ sent: true, channel: outcome.channel } satisfies ExpiredLinkResponse);
  });

  // ── device/sign-out (F15: Sign out this device) ──────────────────────────────────────────────
  app.post('/device/sign-out', async (c) => {
    const ctx = await authenticate(c, { consent: false });
    await store.updateDevice(ctx.device.id, { revoked_at: now().toISOString() });
    await audit(ctx, 'device.signed_out', 'field_device', ctx.device.id, { via: 'settings' });
    // No notifications to a phone that is signed out (W2-14); the push consent stays.
    await store.pushUnsubscribe(ctx.reporter.id, ctx.device.id, 'signed_out');
    const { maxAge: _maxAge, ...cookie } = DEVICE_COOKIE_OPTIONS;
    deleteCookie(c, deviceCookieName(ctx.reporter.id), cookie);
    return c.json({ signedOut: true } satisfies SignOutResponse);
  });

  return app;
}

// ── Request and error helpers ──────────────────────────────────────────────────────────────────

/**
 * A signed upload URL as the phone can reach it: its origin (and any path prefix of a self-hosted
 * gateway) replaced by STORAGE_PUBLIC_URL when that is set and parses; otherwise as Storage
 * built it. The `/storage/v1/object/upload/sign/...` path and the token are kept as they are.
 */
export function publicSignedUrl(signedUrl: string, publicUrl: string | undefined): string {
  if (!publicUrl) return signedUrl;
  let base: URL;
  let signed: URL;
  try {
    base = new URL(publicUrl);
    signed = new URL(signedUrl);
  } catch {
    return signedUrl;
  }
  if (base.protocol !== 'http:' && base.protocol !== 'https:') return signedUrl;
  const marker = '/storage/v1/';
  const at = signed.pathname.indexOf(marker);
  if (at < 0) return signedUrl;
  const prefix = base.pathname.replace(/\/+$/, '');
  return `${base.origin}${prefix}${signed.pathname.slice(at)}${signed.search}`;
}

async function parseBody<S extends z.ZodType>(c: Ctx, schema: S): Promise<z.output<S>> {
  const text = await c.req.text();
  let raw: unknown = {};
  if (text.trim()) {
    try {
      raw = JSON.parse(text);
    } catch {
      throw new FieldError(400, 'invalid_request', 'Body must be valid JSON');
    }
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new FieldError(400, 'invalid_request', 'Invalid request', {
      details: formatIssues(parsed.error),
    });
  }
  return parsed.data as z.output<S>;
}

function rateLimited(resetAt: string, now: Date): FieldError {
  return new FieldError(429, 'rate_limited', undefined, {
    retryAfter: retryAfterSeconds(resetAt, now),
  });
}

/** The RPC refusals as answers. */
const DB_ERROR_ANSWERS: Record<string, [FieldError['status'], FieldError['code']]> = {
  upload_not_found: [404, 'not_found'],
  site_not_found: [404, 'not_found'],
  upload_path_mismatch: [409, 'wrong_state'],
  report_not_found: [404, 'not_found'],
  report_filed: [409, 'report_filed'],
  report_filing: [409, 'report_filing'],
  draft_changed: [409, 'draft_changed'],
  report_in_progress: [409, 'report_in_progress'],
  day_closed: [409, 'day_closed'],
  wrong_state: [409, 'wrong_state'],
  invalid_status: [400, 'invalid_request'],
  question_not_found: [404, 'not_found'],
  question_closed: [409, 'question_closed'],
  photos_window_closed: [409, 'photos_window_closed'],
  photo_limit: [409, 'photo_limit'],
  invalid_batch: [400, 'invalid_request'],
  batch_not_found: [404, 'not_found'],
  batch_incomplete: [409, 'wrong_state'],
  answer_pending: [409, 'answer_pending'],
  correction_pending: [409, 'correction_pending'],
  correction_not_ready: [409, 'correction_not_ready'],
  correction_not_found: [404, 'not_found'],
  report_locked: [409, 'report_locked'],
  invalid_request: [400, 'invalid_request'],
  invalid_edit: [400, 'edit_not_accepted'],
  test_clip_not_found: [404, 'not_found'],
  consent_required: [403, 'consent_required'],
  consent_not_offered: [400, 'invalid_request'],
  texts_opted_out: [409, 'texts_opted_out'],
  channel_not_offered: [400, 'channel_not_offered'],
};

function errorResponse(c: Context, err: unknown, now: Date): Response {
  let fe: FieldError;
  if (err instanceof FieldError) fe = err;
  else if (err instanceof FieldDbError && DB_ERROR_ANSWERS[err.code]) {
    const [status, code] = DB_ERROR_ANSWERS[err.code]!;
    fe = new FieldError(status, code);
  } else if (err instanceof EnvError) {
    logError('field-api.config', err, { variable: err.variable });
    fe = new FieldError(500, 'internal', 'Function is not configured');
  } else {
    logError('field-api.unhandled', err, { message: errorMessage(err), at: now.toISOString() });
    fe = new FieldError(500, 'internal', 'Internal error');
  }
  const headers: Record<string, string> = { 'Cache-Control': 'no-store' };
  if (fe.status === 429 && typeof fe.extra.retryAfter === 'number') {
    headers['Retry-After'] = String(fe.extra.retryAfter);
  }
  const body = {
    error: fe.code,
    ...(fe.message !== fe.code ? { message: fe.message } : {}),
    ...fe.extra,
  };
  return c.json(body as LinkExpiredBody | Record<string, unknown>, fe.status, headers);
}
