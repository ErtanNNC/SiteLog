import { smsRenderOptions } from '@sitelog/shared/channels.ts';
import { renderSms, type SmsKey } from '@sitelog/shared/copy/sms.ts';
import { DEMO_COUNTRIES } from '@sitelog/shared/demo/countries.ts';
import { DEMO_SITELOG_NUMBER } from '@sitelog/shared/demo/kestrel.ts';
import { DEMO_LINK_BASE } from '@sitelog/shared/demo/rows.ts';
import { demoLinkCode } from '@sitelog/shared/demo/ids.ts';
import type { DemoDataset } from '@sitelog/shared/demo/types.ts';
import { toCountryPack, type CountryPack } from '@sitelog/shared/countries.ts';
import { V12_ROW_DEFAULTS } from '@sitelog/shared/db/defaults.ts';
import type { MessageRow, ReporterRow } from '@sitelog/shared/db/types.ts';
import { firstName, formatDeadline, formatPhone } from '@sitelog/shared/format.ts';
import { fieldLinkUrl, linkCodeHash } from '@sitelog/shared/links.ts';
import { languageOf } from '@sitelog/shared/locale.ts';
import { planInboundSms } from '@sitelog/shared/sms/keywords.ts';
import { localId } from '@/lib/utils';
import type { DemoPhoneData, DemoPhoneMessage } from '../types';

/**
 * The Demo phone of the panel's demo mode (§11.1, W1-08): Kestrel's console texts in memory. A
 * welcome on invite stands in for the worker's send_welcome, and a typed reply runs the same
 * keyword plan as sms-webhook (`planInboundSms`), so STOP, START, HELP, CALL and TEXT act as they
 * do against a database.
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
    channel: 'sms',
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

/** A text typed as the reporter, and what SiteLog does with it (sms-webhook's plan). */
export function demoReply(data: DemoDataset, reporterId: string, body: string, at: string): void {
  const reporter = data.reporters.find((r) => r.id === reporterId);
  if (!reporter) throw new Error('Reporter not found');
  const pack = demoOrgPack(data);
  if (!pack.twoWaySms) throw new Error('This country pack has one-way SMS');
  data.messages.push(smsRow(data, reporter, 'in', body, null, at));
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
  });
  for (const change of plan.changes) {
    Object.assign(
      data.reporters.find((r) => r.id === change.reporterId)!,
      change.patch,
    );
  }
  if (!plan.reply) return;
  const to = data.reporters.find((r) => r.id === plan.reply!.reporterId) ?? reporter;
  const locale = languageOf(to.locale) === 'es' ? 'es' : 'en';
  const text =
    plan.reply.key === 'help'
      ? renderSms(
          'help',
          locale,
          {
            company: data.org.name,
            link: personalLink(data, to, at),
            ...(sitelogNumber(data) ? { number: sitelogNumber(data)! } : {}),
          },
          renderOptions(data),
        )
      : renderSms(plan.reply.key, locale, {}, renderOptions(data));
  data.messages.push(smsRow(data, to, 'out', text, plan.reply.key, at));
}

function smsOf(data: DemoDataset, reporterId: string): MessageRow[] {
  return data.messages.filter((m) => m.channel === 'sms' && m.reporter_id === reporterId);
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
    pack: { code: pack.code, twoWaySms: pack.twoWaySms },
    reporters,
  };
}

export function demoPhoneThread(data: DemoDataset, reporterId: string): DemoPhoneMessage[] {
  return smsOf(data, reporterId)
    .map((m, i) => ({ m, i }))
    .sort((a, b) => a.m.created_at.localeCompare(b.m.created_at) || a.i - b.i)
    .map(({ m }) => ({
      id: m.id,
      direction: m.direction,
      body: m.body ?? '',
      status: m.status,
      copyKey: m.copy_key,
      provider: m.provider,
      at: m.created_at,
    }));
}
