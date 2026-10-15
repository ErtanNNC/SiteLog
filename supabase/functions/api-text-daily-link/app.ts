import {
  dailyLinkExpiresAt,
  ensureDailyLink,
  fieldLinkUrl,
  formatDateInTz,
  formatPhone,
  isActiveReporterStatus,
  type DailyLinkStore,
  type MemberRole,
  type Notifier,
  type NotifyOutcome,
} from '@sitelog/shared';
import { HttpError } from '../_shared/http.ts';

/**
 * "Text today's link" (F17 step 3, P3, P5 header, P10 row menu; W1-16): the office texts a
 * site's reporter today's daily link (§6.3 `field_links` kind `daily`) through the Notifier, on
 * the reporter's channel order (§4.5) and in their language (§9.2 `daily_link`). The pure flow on
 * an injected store, so the Deno tests run it without a database.
 *
 * - Who: admin, pm and ops of the site's org, everyone who sees the Overview (spec §19 Q69).
 * - To whom: the site's primary reporter, else its first active one (F17 "Call {manager}" names
 *   the same person); a site with nobody linked is 409.
 * - Which link: today's in the site's time zone, reused while it lives (`ensureDailyLink`), so a
 *   second tap texts the same link; a new one expires after DAILY_LINK_TTL_HOURS (§5.1).
 * - Once per request: the panel sends a fresh `requestId` per tap; it is the Notifier's dedupe
 *   key, so a retried request never texts twice.
 * - Consent, opt-out and a pack with no sender here are the Notifier's (it audits a skip); the
 *   answer says what happened and never holds the link code.
 * - Audit: `field_link.created` when a link is made, and `daily_link.texted` with the outcome.
 */

export interface TextLinkSite {
  id: string;
  org_id: string;
  name: string;
  timezone: string;
  status: string;
}

export interface TextLinkReporter {
  id: string;
  name: string;
  status: string;
  is_primary: boolean;
}

export interface TextLinkAudit {
  orgId: string;
  actorId: string;
  action: 'field_link.created' | 'daily_link.texted';
  entity: 'reporter';
  entityId: string;
  diff: Record<string, string | number | boolean | null>;
}

export interface TextLinkStore extends DailyLinkStore {
  loadSite(siteId: string): Promise<TextLinkSite | null>;
  memberRole(userId: string, orgId: string): Promise<MemberRole | null>;
  siteReporters(siteId: string): Promise<TextLinkReporter[]>;
  /** The org's country pack voice number (E.164) or null (`countries.voice_number`). */
  voiceNumber(orgId: string): Promise<string | null>;
  audit(entry: TextLinkAudit): Promise<void>;
}

export interface TextLinkDeps {
  store: TextLinkStore;
  notifier: Pick<Notifier, 'send'>;
  secret: string;
  fieldAppUrl: string;
  ttlHours?: number;
  now: () => Date;
  newId: () => string;
}

export const TEXT_LINK_ROLES: readonly MemberRole[] = ['admin', 'pm', 'ops'];

export type TextLinkResult =
  | { sent: true; reporterId: string; channel: string; reportDate: string }
  | {
      sent: false;
      reporterId: string;
      reason: Extract<NotifyOutcome, { channel: null }>['reason'];
      detail: string | null;
      reportDate: string;
    };

/** The site's reporter for today's link: the primary one, else the first active one. */
export function pickReporter(reporters: readonly TextLinkReporter[]): TextLinkReporter | null {
  return (
    reporters.find((r) => r.is_primary) ??
    reporters.find((r) => isActiveReporterStatus(r.status)) ??
    null
  );
}

export async function textDailyLink(
  deps: TextLinkDeps,
  userId: string,
  input: { siteId: string; requestId: string },
): Promise<TextLinkResult> {
  const { store } = deps;
  const site = await store.loadSite(input.siteId);
  if (!site) throw new HttpError(404, 'Site not found');
  const role = await store.memberRole(userId, site.org_id);
  if (!role) throw new HttpError(403, 'You are not a member of this organisation');
  if (!TEXT_LINK_ROLES.includes(role)) {
    throw new HttpError(403, `This action needs one of these roles: ${TEXT_LINK_ROLES.join(', ')}`);
  }
  if (site.status !== 'active') throw new HttpError(409, 'This site is not active');
  const reporter = pickReporter(await store.siteReporters(site.id));
  if (!reporter) throw new HttpError(409, 'No site manager is linked to this site');

  const now = deps.now();
  const reportDate = formatDateInTz(now, site.timezone);
  const link = await ensureDailyLink(
    store,
    deps.secret,
    {
      reporterId: reporter.id,
      siteId: site.id,
      reportDate,
      expiresAt: dailyLinkExpiresAt(now, deps.ttlHours),
      now,
    },
    deps.newId,
  );
  if (link.created) {
    await store.audit({
      orgId: site.org_id,
      actorId: userId,
      action: 'field_link.created',
      entity: 'reporter',
      entityId: reporter.id,
      diff: { kind: 'daily', site_id: site.id, report_date: reportDate, link_id: link.id },
    });
  }

  const voice = await store.voiceNumber(site.org_id);
  const outcome = await deps.notifier.send(
    reporter.id,
    'daily_link',
    {
      site: site.name,
      link: fieldLinkUrl(deps.fieldAppUrl, link.code),
      ...(voice ? { number: formatPhone(voice) } : {}),
    },
    { dedupeKey: `office_daily_link:${input.requestId}` },
  );
  await store.audit({
    orgId: site.org_id,
    actorId: userId,
    action: 'daily_link.texted',
    entity: 'reporter',
    entityId: reporter.id,
    diff: {
      site_id: site.id,
      report_date: reportDate,
      link_id: link.id,
      request_id: input.requestId,
      channel: outcome.channel,
      ...(outcome.channel === null
        ? { reason: outcome.reason, detail: outcome.detail ?? null }
        : { message_id: outcome.messageId }),
    },
  });
  return outcome.channel === null
    ? {
        sent: false,
        reporterId: reporter.id,
        reason: outcome.reason,
        detail: outcome.detail ?? null,
        reportDate,
      }
    : { sent: true, reporterId: reporter.id, channel: outcome.channel, reportDate };
}
