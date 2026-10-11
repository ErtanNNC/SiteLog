import {
  firstName as firstNameOf,
  formatDeadline,
  type Button,
  type ConversationRow,
  type ConvoState,
  type MessageRow,
  type OrgSettingsRow,
  type ReporterRow,
  type SiteRow,
} from '@sitelog/shared';
import type { Ctx } from '../context';
import { sendFreeForm, type OutboundMeta } from '../wa/send';
import { contextOf, type ConvoContext } from './context';
import { parseInbound, type InboundContent } from './inbound';

/** Per-message state shared by the router handlers. */
export interface Session {
  ctx: Ctx;
  convo: ConversationRow;
  message: MessageRow;
  inbound: InboundContent;
  /** One reporter row per org for this phone. */
  reporters: ReporterRow[];
  reporter: ReporterRow;
  firstName: string;
  /** Non-archived sites across all orgs. */
  sites: SiteRow[];
  activeSites: SiteRow[];
  pausedSites: SiteRow[];
  now: Date;
  /** Time zone used for day arithmetic: the first active site, else the reporter's org. */
  tz: string;
  readonly context: ConvoContext;
  reply(text: string, buttons?: Button[], meta?: OutboundMeta): Promise<MessageRow>;
  /** state null keeps the current state. The context patch is shallow-merged. */
  setState(state: ConvoState | null, patch?: Partial<ConvoContext>): Promise<ConversationRow>;
  siteById(id: string): SiteRow | undefined;
}

export class SessionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SessionError';
  }
}

export async function createSession(
  ctx: Ctx,
  message: MessageRow,
  convo?: ConversationRow,
): Promise<Session | null> {
  const conversation = convo ?? (await ctx.db.getConversation(message.conversation_id));
  if (!conversation) throw new SessionError(`conversation ${message.conversation_id} not found`);
  const reporters = await ctx.db.listReportersByPhone(conversation.phone_e164);
  if (reporters.length === 0) return null;
  const sitesNested = await Promise.all(reporters.map((r) => ctx.db.listSitesForReporter(r.id)));
  const sites = dedupeById(sitesNested.flat());
  const activeSites = sites.filter((s) => s.status === 'active');
  const pausedSites = sites.filter((s) => s.status === 'paused');
  const reporter = reporters[0]!;
  let tz = activeSites[0]?.timezone ?? sites[0]?.timezone ?? null;
  if (!tz) {
    const org = await ctx.db.getOrg(reporter.org_id);
    tz = org?.timezone ?? 'UTC';
  }
  const session: Session = {
    ctx,
    convo: conversation,
    message,
    inbound: parseInbound(message),
    reporters,
    reporter,
    firstName: firstNameOf(reporter.name),
    sites,
    activeSites,
    pausedSites,
    now: ctx.now(),
    tz,
    get context() {
      return contextOf(session.convo);
    },
    async reply(text, buttons, meta) {
      return sendFreeForm(ctx, session.convo, text, buttons, meta);
    },
    async setState(state, patch = {}) {
      const next: ConvoContext = { ...contextOf(session.convo), ...patch };
      session.convo = await ctx.db.updateConversation(session.convo.id, {
        ...(state ? { state } : {}),
        context: next,
      });
      return session.convo;
    },
    siteById(id) {
      return sites.find((s) => s.id === id);
    },
  };
  return session;
}

function dedupeById<T extends { id: string }>(rows: T[]): T[] {
  const seen = new Set<string>();
  return rows.filter((r) => (seen.has(r.id) ? false : (seen.add(r.id), true)));
}

/** "17:30" for the site (site override → org default). */
export function deadlineFor(
  site: Pick<SiteRow, 'deadline'>,
  settings: Pick<OrgSettingsRow, 'default_deadline'>,
): string {
  return formatDeadline(site.deadline ?? settings.default_deadline);
}

export function workingDaysOf(
  settings: Pick<OrgSettingsRow, 'working_days'> | null | undefined,
): number[] {
  return settings?.working_days?.length ? settings.working_days.map(Number) : [1, 2, 3, 4, 5];
}
