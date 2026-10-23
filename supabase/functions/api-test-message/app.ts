import {
  type CountryPack,
  type Language,
  type MemberRole,
  pickMessageTransport,
  renderTestMessage,
  type SmsDriver,
  smsSendOptionsFor,
  type SmsTransport,
} from '@sitelog/shared';
import { parsePhoneIn } from '@sitelog/shared/phone-regions.ts';
import { HttpError } from '../_shared/http.ts';

/**
 * Settings → Field channels, _Send me a test message_ (spec P12; §19 Q232, recommended default as
 * built in W4-05). The pure flow on an injected store, so the Deno tests run it without a database.
 *
 * - Who: an admin of the org (Settings is the admin's page).
 * - To whom: a number the admin types each time and attests is their own; never stored (the audit
 *   row has it masked, `maskPhone`).
 * - What: the fixed `test_message` text (`SMS_TEST_MESSAGE`, EN/ES/TR) in the language asked, with
 *   the company's name; no link, no reply instruction.
 * - How: the pack's own SMS transport (`pickMessageTransport`): `console` for a demo org and for a
 *   pack with no sender id in this environment, where nothing leaves TalkOlog and the answer says so.
 *   §19 Q374: a pack that lists no SMS in its channels (every pack since 2026-10-23) sends no text
 *   either: `console`, answered `sms_off` (a demo org's answer stays `demo`).
 * - How often: at most 5 an hour per org (`settings_test_message_claim()`, audited
 *   `settings.test_message` with the masked number, the driver and the language); the sixth is
 *   429 `rate_limited` with the time the next one is allowed.
 * - A refusal by the provider is audited `settings.test_message_failed` and answered `failed`.
 */

export const TEST_MESSAGE_ROLES: readonly MemberRole[] = ['admin'];

export interface TestMessageOrg {
  id: string;
  name: string;
  is_demo: boolean;
  pack: CountryPack;
}

export interface TestMessageStore {
  memberRole(userId: string, orgId: string): Promise<MemberRole | null>;
  loadOrg(orgId: string): Promise<TestMessageOrg | null>;
  claim(input: {
    orgId: string;
    userId: string;
    phoneMasked: string;
    driver: SmsDriver;
    language: Language;
  }): Promise<{ allowed: boolean; retryAt?: string }>;
  auditFailure(input: {
    orgId: string;
    userId: string;
    phoneMasked: string;
    driver: SmsDriver;
    detail: string;
  }): Promise<void>;
}

export interface TestMessageDeps {
  store: TestMessageStore;
  transport: (driver: SmsDriver) => SmsTransport;
}

export type TestMessageResult =
  | { outcome: 'sent'; driver: Exclude<SmsDriver, 'console'> }
  /**
   * Nothing left TalkOlog: a demo org, a pack with no sender id in this environment, or a pack
   * whose channels list no SMS (§19 Q374).
   */
  | { outcome: 'console'; reason: 'demo' | 'no_sender' | 'sms_off' }
  | { outcome: 'failed'; driver: SmsDriver };

/** "+15550143378" → "+1555***378": the audit's form of a number (§15, never stored whole). */
export function maskPhone(e164: string): string {
  const digits = e164.replace(/\D/g, '');
  if (digits.length < 7) return '***';
  return `+${digits.slice(0, 4)}***${digits.slice(-3)}`;
}

export async function sendTestMessage(
  deps: TestMessageDeps,
  userId: string,
  input: { orgId: string; phone: string; language: Language; attested: true },
): Promise<TestMessageResult> {
  const { store } = deps;
  const role = await store.memberRole(userId, input.orgId);
  if (!role) throw new HttpError(403, 'You are not a member of this organisation');
  if (!TEST_MESSAGE_ROLES.includes(role)) {
    throw new HttpError(403, 'Only an admin can send a test message');
  }
  const org = await store.loadOrg(input.orgId);
  if (!org) throw new HttpError(404, 'Organisation not found');
  // E.164 from the panel's number field; a national number is read in the pack's country.
  const to = parsePhoneIn(input.phone, org.pack.code);
  if (!to) throw new HttpError(400, 'Enter a valid mobile number', { code: 'invalid_phone' });

  // §19 Q374: SMS passive in the pack: nothing is texted, whatever its sender.
  const smsOff = !org.pack.messageChannels.includes('sms');
  const driver = smsOff
    ? 'console'
    : pickMessageTransport({ isDemo: org.is_demo }, org.pack, 'sms');
  const phoneMasked = maskPhone(to);
  const claim = await store.claim({
    orgId: org.id,
    userId,
    phoneMasked,
    driver,
    language: input.language,
  });
  if (!claim.allowed) {
    throw new HttpError(429, 'Five test messages an hour: try again later', {
      code: 'rate_limited',
      retryAt: claim.retryAt ?? null,
    });
  }
  if (driver === 'console') {
    return { outcome: 'console', reason: org.is_demo ? 'demo' : smsOff ? 'sms_off' : 'no_sender' };
  }
  try {
    await deps
      .transport(driver)
      .send(to, renderTestMessage(input.language, org.name), smsSendOptionsFor(org.pack));
    return { outcome: 'sent', driver };
  } catch (err) {
    await store.auditFailure({
      orgId: org.id,
      userId,
      phoneMasked,
      driver,
      detail: err instanceof Error ? err.message.slice(0, 200) : 'send failed',
    });
    return { outcome: 'failed', driver };
  }
}
