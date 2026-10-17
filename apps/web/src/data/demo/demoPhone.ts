import { smsRenderOptions } from '@sitelog/shared/channels.ts';
import { renderSms, type SmsKey } from '@sitelog/shared/copy/sms.ts';
import { DEMO_COUNTRIES } from '@sitelog/shared/demo/countries.ts';
import { DEMO_SITELOG_NUMBER } from '@sitelog/shared/demo/kestrel.ts';
import { DEMO_LINK_BASE } from '@sitelog/shared/demo/rows.ts';
import { demoLinkCode } from '@sitelog/shared/demo/ids.ts';
import type { DemoDataset } from '@sitelog/shared/demo/types.ts';
import { toCountryPack, type CountryPack } from '@sitelog/shared/countries.ts';
import { V12_ROW_DEFAULTS } from '@sitelog/shared/db/defaults.ts';
import type { MessageRow, ReporterRow, SiteRow } from '@sitelog/shared/db/types.ts';
import { firstName, formatDeadline, formatPhone } from '@sitelog/shared/format.ts';
import { dailyLinkExpiresAt, fieldLinkUrl, linkCodeHash } from '@sitelog/shared/links.ts';
import { languageOf } from '@sitelog/shared/locale.ts';
import { optOutNotification } from '@sitelog/shared/sms/inbound.ts';
import { planInboundSms } from '@sitelog/shared/sms/keywords.ts';
import { localId } from '@/lib/utils';
import { mergeDemoPhoneCalls } from '../demoPhoneCalls';
import type { DemoPhoneData, DemoPhoneMessage } from '../types';

/**
 * The Demo phone of the panel's demo mode (§11.1, W1-08): Kestrel's console texts in memory. A
 * welcome on invite stands in for the worker's send_welcome, and a typed reply runs the same
 * keyword plan as sms-webhook (`planInboundSms`) with what `processInboundSms` writes beside it:
 * each reporter change audited as the reporter, the office's §13 `reporter_opted_out` notice of a
 * STOP, and the one reply. So STOP, START, HELP, CALL and TEXT act as they do against a database.
 */

/** The demo org's country pack (the launch packs; Kestrel is US). */
export function demoOrgPack(data: DemoDataset): CountryPack {
  const row = DEMO_COUNTRIES.find((c) => c.code === data.org.country) ?? DEMO_COUNTRIES[0]!;
  return toCountryPack(row);
}

/**
 * Kestrel's texts offer §18.1's SiteLog number as story data (spec §19 Q34), like the seeded ones.
 */
function renderOptions(data: DemoDataset) {
  const pack = demoOrgPack(data);
  return data.org.country === 'US'
    ? { ...smsRenderOptions(pack), hasVoiceNumber: true }
    : smsRenderOptions(pack);
}

function sitelogNumber(data: DemoDataset): string | undefined {
  return data.org.country === 'US' ? formatPhone(DEMO_SITELOG_NUMBER) : undefined;
}

/** The reporter's personal link: the seeded one (its demo code), else a new one. */
function personalLink(data: DemoDataset, reporter: ReporterRow, at: string): string {
  const code = demoLinkCode(`personal:${reporter.id}`);
  const hash = linkCodeHash(code);
  if (!data.fieldLinks.some((l) => l.code_hash === hash)) {
    data.fieldLinks.push({
      id: localId('link'),
      code_hash: hash,
      reporter_id: reporter.id,
      site_id: null,
      kind: 'personal',
      report_date: null,
      expires_at: null,
      revoked_at: null,
      last_opened_at: null,
      created_at: at,
    });
  }
  return fieldLinkUrl(DEMO_LINK_BASE, code);
}

function smsRow(
  data: DemoDataset,
  reporter: ReporterRow,
  direction: 'in' | 'out',
  body: string,
  copyKey: SmsKey | null,
  at: string,
  channel: 'sms' | 'whatsapp' = 'sms',
): MessageRow {
  const id = localId('sms');
  return {
    ...V12_ROW_DEFAULTS.messages,
    id,
    conversation_id: null,
    org_id: data.org.id,
    direction,
    wa_message_id: null,
    type: null,
    body,
    payload: null,
    media_id: null,
    media_mime: null,
    storage_path: null,
    duration_s: null,
    template_name: null,
    status: direction === 'in' ? 'received' : 'delivered',
    error: null,
    created_at: at,
    reporter_id: reporter.id,
    phone_e164: reporter.phone_e164,
    provider: 'console',
    provider_message_id: `console:${id}`,
    copy_key: copyKey,
    channel,
  };
}

/** The welcome text of an invite (F3), as the worker's send_welcome writes it for a demo org. */
export function demoWelcome(
  data: DemoDataset,
  reporter: ReporterRow,
  siteId: string | undefined,
  at: string,
): MessageRow {
  const site = data.sites.find((s) => s.id === siteId) ?? data.sites[0]!;
  const body = renderSms(
    'welcome',
    languageOf(reporter.locale),
    {
      first: firstName(reporter.name),
      company: data.org.name,
      site: site.name,
      deadline: formatDeadline(site.deadline ?? data.settings.default_deadline),
      link: personalLink(data, reporter, at),
      ...(sitelogNumber(data) ? { number: sitelogNumber(data)! } : {}),
    },
    renderOptions(data),
  );
  const row = smsRow(data, reporter, 'out', body, 'welcome', at);
  data.messages.push(row);
  return row;
}

/**
 * "Text today's link" (F17, W1-16) as api-text-daily-link does it for a demo org: the reporter's
 * daily link for the site and date (the seeded one when it exists: same key, same code), and the
 * `daily_link` text on the console driver.
 */
export function demoDailyLink(
  data: DemoDataset,
  reporter: ReporterRow,
  site: SiteRow,
  date: string,
  at: string,
): MessageRow {
  const code = demoLinkCode(`daily:${reporter.id}:${date}`);
  const hash = linkCodeHash(code);
  if (!data.fieldLinks.some((l) => l.code_hash === hash)) {
    data.fieldLinks.push({
      id: localId('link'),
      code_hash: hash,
      reporter_id: reporter.id,
      site_id: site.id,
      kind: 'daily',
      report_date: date,
      expires_at: dailyLinkExpiresAt(new Date(at)),
      revoked_at: null,
      last_opened_at: null,
      created_at: at,
    });
  }
  const body = renderSms(
    'daily_link',
    languageOf(reporter.locale),
    {
      site: site.name,
      link: fieldLinkUrl(DEMO_LINK_BASE, code),
      ...(sitelogNumber(data) ? { number: sitelogNumber(data)! } : {}),
    },
    renderOptions(data),
  );
  const row = smsRow(data, reporter, 'out', body, 'daily_link', at);
  data.messages.push(row);
  return row;
}

/**
 * A text (or, W2-16, a WhatsApp message) typed as the reporter, and what SiteLog does with it
 * (sms-webhook's plan). WhatsApp is two-way on every pack that lists it (spec §19 Q26).
 */
export function demoReply(
  data: DemoDataset,
  reporterId: string,
  body: string,
  at: string,
  channel: 'sms' | 'whatsapp' = 'sms',
): void {
  const reporter = data.reporters.find((r) => r.id === reporterId);
  if (!reporter) throw new Error('Reporter not found');
  const pack = demoOrgPack(data);
  const whatsapp = channel === 'whatsapp';
  if (whatsapp && !pack.messageChannels.includes('whatsapp'))
    throw new Error('This country pack lists no WhatsApp');
  if (!whatsapp && !pack.twoWaySms) throw new Error('This country pack has one-way SMS');
  data.messages.push(smsRow(data, reporter, 'in', body, null, at, channel));
  // Every reporter with the number, disabled ones included: a STOP sticks to them too.
  const others = data.reporters.filter((r) => r.phone_e164 === reporter.phone_e164);
  const plan = planInboundSms({
    pack,
    body,
    optOutType: null,
    reporters: others.map((r) => ({
      id: r.id,
      orgId: r.org_id,
      status: r.status,
      contactPref: r.contact_pref,
      activatedAt: r.activated_at,
      optedOutAt: r.opted_out_at,
      createdAt: r.created_at,
    })),
    pendingUnknown: false,
    now: new Date(at),
    channel,
  });
  // W2-16 (spec §19 Q40, Q112): STOP / START on WhatsApp, the whatsapp consent only.
  for (const change of plan.consentChanges) {
    const rows = data.consents.filter(
      (c) => c.reporter_id === change.reporterId && c.type === 'whatsapp',
    );
    const held = rows.filter((c) => c.revoked_at === null);
    if (!change.grant) for (const c of held) c.revoked_at = at;
    else if (held.length === 0 && rows.length > 0)
      data.consents.push({
        ...rows.at(-1)!,
        id: localId('consent'),
        method: 'whatsapp_keyword',
        given_at: at,
        revoked_at: null,
      });
  }
  for (const change of plan.changes) {
    const row = data.reporters.find((r) => r.id === change.reporterId)!;
    Object.assign(row, change.patch);
    data.audit.push({
      id: (data.audit.at(-1)?.id ?? 0) + 1,
      org_id: row.org_id,
      actor_type: 'reporter',
      actor_id: row.id,
      action: change.action,
      entity: 'reporter',
      entity_id: row.id,
      diff: { ...change.patch, method: 'sms_keyword', keyword: plan.keyword },
      created_at: at,
    });
    if (change.patch.status === 'opted_out') {
      // §13 "Message undeliverable / opted out": admin and ops see it (notification_audience).
      const n = optOutNotification({ orgId: row.org_id, name: row.name, phone: row.phone_e164 });
      data.notifications.unshift({
        id: localId('notif'),
        org_id: n.orgId,
        user_id: null,
        kind: n.kind,
        title: n.title,
        body: n.body,
        target_path: n.targetPath,
        read_at: null,
        created_at: at,
        data: n.data,
      });
    }
  }
  if (!plan.reply && !plan.mediaReply) return;
  const to =
    data.reporters.find((r) => r.id === (plan.reply?.reporterId ?? plan.reporterId)) ?? reporter;
  const locale = languageOf(to.locale);
  // WhatsApp's variant: replies and links always (W2-16).
  const options = whatsapp
    ? { ...renderOptions(data), twoWay: true, linksAllowed: true }
    : renderOptions(data);
  const key = plan.reply?.key ?? 'whatsapp_use_link';
  const text =
    key === 'help'
      ? renderSms(
          'help',
          locale,
          {
            company: data.org.name,
            link: personalLink(data, to, at),
            ...(sitelogNumber(data) ? { number: sitelogNumber(data)! } : {}),
          },
          options,
        )
      : key === 'whatsapp_use_link'
        ? renderSms(key, locale, { link: personalLink(data, to, at) }, options)
        : renderSms(key as 'stop_confirm', locale, {}, options);
  data.messages.push(smsRow(data, to, 'out', text, key, at, channel));
}

/** A reporter's thread: texts and, since W2-14 / W2-15, pushes and WhatsApp messages. */
function smsOf(data: DemoDataset, reporterId: string): MessageRow[] {
  return data.messages.filter(
    (m) =>
      (m.channel === 'sms' || m.channel === 'push' || m.channel === 'whatsapp') &&
      m.reporter_id === reporterId,
  );
}

export function demoPhoneData(data: DemoDataset): DemoPhoneData {
  const pack = demoOrgPack(data);
  const reporters = data.reporters
    .map((r) => {
      const thread = smsOf(data, r.id);
      const last = thread.reduce<MessageRow | null>(
        (a, m) => (!a || m.created_at >= a.created_at ? m : a),
        null,
      );
      return {
        id: r.id,
        name: r.name,
        phone: r.phone_e164,
        status: r.status,
        count: thread.length,
        lastAt: last?.created_at ?? null,
        lastBody: last?.body ?? null,
      };
    })
    .sort((a, b) => (b.lastAt ?? '').localeCompare(a.lastAt ?? '') || a.name.localeCompare(b.name));
  return {
    orgIsDemo: data.org.is_demo,
    pack: {
      code: pack.code,
      twoWaySms: pack.twoWaySms,
      whatsapp: pack.messageChannels.includes('whatsapp'),
    },
    reporters,
  };
}

export function demoPhoneThread(data: DemoDataset, reporterId: string): DemoPhoneMessage[] {
  const texts = smsOf(data, reporterId)
    .map((m, i) => ({ m, i }))
    .sort((a, b) => a.m.created_at.localeCompare(b.m.created_at) || a.i - b.i)
    .map(({ m }) => ({
      id: m.id,
      direction: m.direction,
      body: m.body ?? '',
      status: m.status,
      copyKey: m.copy_key,
      provider: m.provider,
      channel: m.channel === 'push' || m.channel === 'whatsapp' ? m.channel : ('sms' as const),
      at: m.created_at,
    }));
  // W3-17 (§19 Q132): the reporter's outbound calls ring in the Demo phone too.
  const calls = data.calls
    .filter((c) => c.reporter_id === reporterId && c.direction === 'outbound')
    .map((c) => ({
      id: c.id,
      status: c.status,
      outcome: c.outcome,
      purpose: c.purpose,
      attempt: c.attempt ?? null,
      created_at: c.created_at ?? '',
    }));
  return mergeDemoPhoneCalls(texts, calls);
}
