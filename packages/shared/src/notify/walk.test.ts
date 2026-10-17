import { describe, expect, it } from 'vitest';
import { deliverableChannels, type NotifierKey } from '../channels.ts';
import { toCountryPack, type CountryPack } from '../countries.ts';
import type { CountryRow } from '../db/types.ts';
import { DEMO_COUNTRIES } from '../demo/countries.ts';
import type { ConsentType, MessageChannel, MsgStatus } from '../enums.ts';
import { lateFallback, messageDedupeKey } from './fallback.ts';
import {
  attemptIsAccountFault,
  attemptIsFinal,
  attemptNumber,
  attemptWasSent,
  planAttempt,
  type MessageAttempt,
} from './walk.ts';

/**
 * The fallback walk (spec §19 Q22, W2-01) with two channels: SMS and a fake second channel
 * registered as `whatsapp` (consent `data_processing` stands in for its label, which W2-15 adds).
 */
const pack = (patch: Partial<CountryRow> = {}): CountryPack =>
  toCountryPack({ ...DEMO_COUNTRIES.find((c) => c.code === 'US')!, ...patch });
const SMS_THEN_WA = pack({ message_channels: ['sms', 'whatsapp'] });
const WA_THEN_SMS = pack({ message_channels: ['whatsapp', 'sms'] });

function order(
  p: CountryPack,
  key: NotifierKey,
  o: {
    consents?: ConsentType[];
    optedOut?: MessageChannel[];
    preferred?: MessageChannel | null;
  } = {},
): MessageChannel[] {
  return deliverableChannels({
    pack: p,
    key,
    preferred: o.preferred ?? null,
    consents: new Set(o.consents ?? ['sms', 'data_processing']),
    revoked: new Set(),
    optedOut: new Set(o.optedOut ?? []),
    implemented: ['sms', 'whatsapp'],
    consentFor: { whatsapp: 'data_processing' },
  });
}

let n = 0;
function attempt(
  channel: MessageChannel,
  status: MsgStatus,
  over: Partial<MessageAttempt> = {},
): MessageAttempt {
  n += 1;
  return {
    id: `m-${n}`,
    channel,
    status,
    provider: channel === 'sms' ? 'twilio' : 'fake',
    provider_message_id: null,
    error: null,
    error_code: null,
    attempt: 1,
    ...over,
  };
}

describe('the channel order a message walks (§4.5)', () => {
  it("follows the pack's order, the person's preference first", () => {
    expect(order(SMS_THEN_WA, 'filed')).toEqual(['sms', 'whatsapp']);
    expect(order(WA_THEN_SMS, 'filed')).toEqual(['whatsapp', 'sms']);
    expect(order(SMS_THEN_WA, 'filed', { preferred: 'whatsapp' })).toEqual(['whatsapp', 'sms']);
  });

  it('drops a channel without its consent, or opted out, and SMS for a link key on a no-link pack', () => {
    expect(order(SMS_THEN_WA, 'filed', { consents: ['sms'] })).toEqual(['sms']);
    expect(order(SMS_THEN_WA, 'filed', { consents: ['data_processing'] })).toEqual(['whatsapp']);
    expect(order(SMS_THEN_WA, 'filed', { optedOut: ['sms'] })).toEqual(['whatsapp']);
    const noLinks = pack({ message_channels: ['sms', 'whatsapp'], sms_links_allowed: false });
    expect(order(noLinks, 'draft_ready')).toEqual(['whatsapp']);
    expect(order(noLinks, 'site_paused')).toEqual(['sms', 'whatsapp']);
  });

  it('keeps the device code on SMS whatever the order', () => {
    expect(order(WA_THEN_SMS, 'verify_code')).toEqual(['sms']);
  });
});

describe('planAttempt (§19 Q22)', () => {
  it('starts with the first channel as attempt 1; nothing to do without a channel', () => {
    expect(planAttempt(['sms', 'whatsapp'], [])).toEqual({
      kind: 'send',
      channel: 'sms',
      attempt: 1,
      retry: null,
      after: null,
    });
    expect(planAttempt([], [])).toEqual({ kind: 'none' });
  });

  it('a sent attempt is a dedupe hit on every channel', () => {
    const sent = attempt('sms', 'delivered');
    expect(planAttempt(['sms', 'whatsapp'], [sent])).toEqual({ kind: 'done', attempt: sent });
    const second = attempt('whatsapp', 'sent', { attempt: 2 });
    const first = attempt('sms', 'undeliverable');
    expect(planAttempt(['sms', 'whatsapp'], [second, first])).toEqual({
      kind: 'done',
      attempt: second,
    });
  });

  it('a first channel refused for good at send hands the message to the next one', () => {
    const refused = attempt('sms', 'undeliverable', { error_code: '21614' });
    expect(planAttempt(['sms', 'whatsapp'], [refused])).toEqual({
      kind: 'send',
      channel: 'whatsapp',
      attempt: 2,
      retry: null,
      after: refused,
    });
  });

  it('a late failed callback (the provider took it) is final too', () => {
    const late = attempt('sms', 'failed', { provider_message_id: 'SM1', error: 'twilio 30007' });
    expect(attemptIsFinal(late)).toBe(true);
    expect(planAttempt(['sms', 'whatsapp'], [late])).toMatchObject({
      kind: 'send',
      channel: 'whatsapp',
      attempt: 2,
      after: late,
    });
  });

  it('a retryable failure retries the same channel on its row first', () => {
    const busy = attempt('sms', 'failed', { error: 'twilio 503' });
    expect(attemptIsFinal(busy)).toBe(false);
    expect(planAttempt(['sms', 'whatsapp'], [busy])).toEqual({
      kind: 'send',
      channel: 'sms',
      attempt: 1,
      retry: busy,
      after: null,
    });
    // A row written but never confirmed (a crash mid-send) too, wherever its channel now is.
    const queued = attempt('whatsapp', 'queued', { attempt: 2 });
    const refused = attempt('sms', 'undeliverable');
    expect(planAttempt(['whatsapp', 'sms'], [refused, queued])).toMatchObject({
      kind: 'send',
      channel: 'whatsapp',
      retry: queued,
    });
  });

  it('a pending attempt whose channel left the order (consent revoked) is passed over', () => {
    const busy = attempt('sms', 'failed', { error: 'twilio 503' });
    expect(planAttempt(['whatsapp'], [busy])).toEqual({
      kind: 'send',
      channel: 'whatsapp',
      attempt: 2,
      retry: null,
      after: busy,
    });
  });

  it('every channel failed: exhausted, with the latest final attempt', () => {
    const a = attempt('sms', 'undeliverable');
    const b = attempt('whatsapp', 'failed', { provider_message_id: 'WA1', attempt: 2 });
    expect(planAttempt(['sms', 'whatsapp'], [b, a])).toEqual({ kind: 'exhausted', last: b });
    // A single-channel order (SMS only, week 1): the refusal comes back, as before W2-01.
    expect(planAttempt(['sms'], [a])).toEqual({ kind: 'exhausted', last: a });
  });

  it('reads statuses and attempt numbers', () => {
    expect(attemptWasSent({ status: 'queued' })).toBe(false);
    expect(attemptWasSent({ status: 'read' })).toBe(true);
    expect(attemptNumber({ dedupe_key: 'k' })).toBe(1);
    expect(attemptNumber(null)).toBe(1);
    expect(attemptNumber({ attempt: 3 })).toBe(3);
    expect(attemptNumber({ attempt: 0 })).toBe(1);
  });
});

describe('lateFallback (a status callback after the send)', () => {
  const REPORTER = '00000000-0000-4000-8000-000000000001';
  const MESSAGE = '00000000-0000-4000-8000-0000000000aa';
  const sentBy = {
    reporterId: REPORTER,
    key: 'filed' as const,
    vars: { report_no: 'RL-2041-0187', pdf_link: 'https://go.sitelog.app/r/K7Q2MX/report/x' },
    dedupeKey: 'notify:filed:r1',
  };
  const message = {
    id: MESSAGE,
    reporter_id: REPORTER,
    copy_key: 'filed',
    payload: { dedupe_key: 'notify:filed:r1', attempt: 1 },
  };

  it('queues the same message after the failed attempt, keyed per attempt', () => {
    expect(lateFallback(message, 'undeliverable', sentBy)).toEqual({
      kind: 'enqueue',
      payload: { ...sentBy, afterMessageId: MESSAGE },
      dedupeKey: `notify:filed:r1:after:${MESSAGE}`,
    });
    expect(lateFallback(message, 'failed', sentBy).kind).toBe('enqueue');
  });

  it('carries the reminder ladder’s guard, so the fallback re-checks the site-day (W2-06)', () => {
    const guard = {
      siteDayId: '00000000-0000-4000-8000-0000000000dd',
      statuses: ['pending' as const, 'reminded' as const],
      notAfter: '2026-10-13T01:00:00+00:00',
    };
    const fallback = lateFallback(
      { ...message, copy_key: 'reminder_1', payload: { dedupe_key: 'notify:reminder_1:sd:r' } },
      'undeliverable',
      { ...sentBy, key: 'reminder_1', dedupeKey: 'notify:reminder_1:sd:r', guard },
    );
    expect(fallback.kind === 'enqueue' && fallback.payload.guard).toEqual(guard);
  });

  it('carries a web report’s guard, so the fallback re-checks the question or draft (W2-07)', () => {
    const reportGuard = {
      reportId: '00000000-0000-4000-8000-0000000000ee',
      status: 'awaiting_confirmation' as const,
      version: 1,
      draftRev: 3,
    };
    const fallback = lateFallback(
      { ...message, copy_key: 'draft_ready', payload: { dedupe_key: 'notify:draft_ready:r:9' } },
      'undeliverable',
      { ...sentBy, key: 'draft_ready', dedupeKey: 'notify:draft_ready:r:9', reportGuard },
    );
    expect(fallback.kind === 'enqueue' && fallback.payload.reportGuard).toEqual(reportGuard);
  });

  it('nothing for a delivery, a row outside the Notifier, or one no notify job sent', () => {
    expect(lateFallback(message, 'delivered', sentBy)).toEqual({
      kind: 'none',
      reason: 'not_final',
    });
    expect(lateFallback({ ...message, payload: null }, 'failed', sentBy)).toEqual({
      kind: 'none',
      reason: 'not_notifier',
    });
    expect(lateFallback({ ...message, reporter_id: null }, 'failed', sentBy).kind).toBe('none');
    expect(lateFallback(message, 'failed', null)).toEqual({ kind: 'none', reason: 'no_job' });
    expect(lateFallback(message, 'failed', { ...sentBy, key: 'draft_ready' })).toEqual({
      kind: 'none',
      reason: 'no_job',
    });
    expect(messageDedupeKey({ dedupe_key: '' })).toBeNull();
  });
});

describe('attemptIsAccountFault: late failures the provider-fault notice covers', () => {
  const late = (status: MsgStatus, error: string | null, patch: Partial<MessageAttempt> = {}) => ({
    status,
    error,
    provider: 'twilio',
    provider_message_id: 'SM1',
    ...patch,
  });

  it('a Twilio failed, or undelivered with an account code, is the account', () => {
    expect(attemptIsAccountFault(late('failed', null))).toBe(true);
    expect(attemptIsAccountFault(late('failed', 'twilio 30002'))).toBe(true);
    for (const code of ['30032', '30034', '30002', '30007', '30008']) {
      expect(attemptIsAccountFault(late('undeliverable', `twilio ${code}`))).toBe(true);
    }
  });

  it('the number codes, no code, a send-time refusal and other providers are the person', () => {
    for (const code of ['30003', '30004', '30005', '30006']) {
      expect(attemptIsAccountFault(late('undeliverable', `twilio ${code}`))).toBe(false);
    }
    expect(attemptIsAccountFault(late('undeliverable', null))).toBe(false);
    // Refused at send (Twilio 21211): never taken, so no provider message id.
    expect(
      attemptIsAccountFault(late('undeliverable', 'twilio 21211', { provider_message_id: null })),
    ).toBe(false);
    expect(attemptIsAccountFault(late('failed', null, { provider: 'console' }))).toBe(false);
    expect(attemptIsAccountFault(late('delivered', null))).toBe(false);
  });
});
