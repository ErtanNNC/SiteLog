import {
  isActiveReporterStatus,
  languageOf,
  parseE164,
  reporterDefaultsFor,
  reporterLocaleFor,
  type ContactPref,
  type CountryPack,
  type E164,
  type ParsePhoneOptions,
  type ReporterLocale,
} from '@sitelog/shared';
import {
  inviteLineCheck,
  reachableByPhone,
  type LineCheckProblem,
} from '@sitelog/shared/line-check.ts';

/** Pure rules of the reporter invite flow (§F3). */

export const RESEND_AFTER_HOURS = 48;
export const MAX_RESENDS = 1;

export type ResendCheck = { ok: true } | { ok: false; reason: string; retryAt?: string };

/**
 * §F3 edge case: a reporter who never replied may get one re-send, 48 h after the first invite.
 * `invited_at` is set by the worker when the welcome text was actually sent; while it is null the
 * first send has not happened (or failed: "Can't reach this number"), so a re-send is allowed.
 */
export function canResend(
  reporter: { status: string; invited_at: string | null },
  previousResends: number,
  now: Date,
): ResendCheck {
  if (reporter.status === 'disabled') return { ok: false, reason: 'This reporter is disabled.' };
  if (isActiveReporterStatus(reporter.status)) {
    return { ok: false, reason: 'This reporter already replied; no welcome re-send is needed.' };
  }
  if (previousResends >= MAX_RESENDS) {
    return { ok: false, reason: 'The welcome was already re-sent once. Check the number instead.' };
  }
  if (reporter.invited_at) {
    const retryAt = new Date(
      new Date(reporter.invited_at).getTime() + RESEND_AFTER_HOURS * 3_600_000,
    );
    if (now.getTime() < retryAt.getTime()) {
      return {
        ok: false,
        reason: `A re-send is allowed ${RESEND_AFTER_HOURS} h after the first invite.`,
        retryAt: retryAt.toISOString(),
      };
    }
  }
  return { ok: true };
}

export interface LinkRow {
  site_id: string;
  reporter_id: string;
  is_primary: boolean;
}

/** site_reporters rows: the reporter becomes primary on every site that has no primary yet. */
export function linkRows(
  reporterId: string,
  siteIds: readonly string[],
  sitesWithPrimary: ReadonlySet<string>,
): LinkRow[] {
  return [...new Set(siteIds)].map((siteId) => ({
    site_id: siteId,
    reporter_id: reporterId,
    is_primary: !sitesWithPrimary.has(siteId),
  }));
}

/**
 * The phone of an invite, read with the org's country as the default region (spec §4.6: the pack
 * code is also the default phone region): "0532 123 45 67" in a TR org, "555 014 3378" in a US
 * org, and any number with its country code anywhere.
 */
export function invitePhone(input: string, orgCountry: string): E164 | null {
  return parseE164(input, {
    defaultCountry: orgCountry as NonNullable<ParsePhoneOptions['defaultCountry']>,
  });
}

/**
 * A new reporter's language and report mode (F2, F3): the request's `locale`, else the first of
 * the pack's field locales whose language the office ticked under "Speaks" (`reporterLocaleFor`:
 * a US reporter who speaks Spanish gets es-US and a Spanish welcome, F3 "in the reporter's
 * language"), else the pack's default (`reporterDefaultsFor`: its first field locale); and
 * `link` (the column default; a pack has no report-mode default). A locale the pack does not
 * offer is refused. The request contract stays compatible: `languages`, `locale` and
 * `contactPref` are all optional.
 */
export function inviteProfile(
  pack: CountryPack,
  body: { locale?: ReporterLocale; contactPref?: ContactPref; languages?: string[] },
):
  | { ok: true; locale: ReporterLocale; languages: string[]; contactPref: ContactPref }
  | { ok: false; reason: string } {
  const defaults = reporterDefaultsFor(pack);
  const locale = body.locale ?? reporterLocaleFor(pack, body.languages) ?? defaults.locale;
  if (!pack.fieldLocales.includes(locale)) {
    return {
      ok: false,
      reason: `Locale ${locale} is not offered in ${pack.code} (${pack.fieldLocales.join(', ')})`,
    };
  }
  return {
    ok: true,
    locale,
    languages: body.languages ?? (body.locale ? [languageOf(locale)] : defaults.languages),
    contactPref: body.contactPref ?? 'link',
  };
}

/** The refusals of F2's line check (W4-02, §19 Q229), in English (the panel words its own). */
export const LINE_CHECK_MESSAGES: Record<LineCheckProblem, string> = {
  landline_text:
    'This number is a landline, which cannot get texts. Choose Phone call, or enter a mobile number.',
  landline_unreachable:
    'This number is a landline. SiteLog cannot text it, and Talk now needs the personal link and a code sent by text. Enter a mobile number.',
};

/**
 * F2's line check on the server (W4-02, §19 Q229 `delivery`): a fixed line is refused for a text
 * link, and for a call where SiteLog cannot reach it by phone (no voice number, no calls placed).
 * The panel checks the same before it sends; this keeps the rule for every client. `contactPref`
 * is the preference the reporter ends up with (a reused reporter keeps theirs unless the office
 * sets it).
 */
export function lineCheckRefusal(
  phone: E164,
  contactPref: ContactPref,
  org: { is_demo: boolean },
  pack: CountryPack,
): { problem: LineCheckProblem; message: string } | null {
  const check = inviteLineCheck(phone, contactPref, {
    reachable: reachableByPhone({ isDemo: org.is_demo }, pack),
  });
  return check.ok ? null : { problem: check.problem, message: LINE_CHECK_MESSAGES[check.problem] };
}
