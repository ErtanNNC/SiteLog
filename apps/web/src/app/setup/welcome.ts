import { smsRenderOptions } from '@sitelog/shared/channels.ts';
import type { CountryPack } from '@sitelog/shared/countries.ts';
import { renderSms, type SmsLocale } from '@sitelog/shared/copy/sms.ts';
import { DEMO_LINK_BASE } from '@sitelog/shared/demo/rows.ts';
import { formatDeadline, formatPhone } from '@sitelog/shared/format.ts';
import { fieldLinkUrl } from '@sitelog/shared/links.ts';
import { languageOf, type ReporterLocale } from '@sitelog/shared/locale.ts';

/**
 * F2's welcome preview (W4-02): the §9.2 `welcome` text exactly as the worker's `send_welcome`
 * renders it (`renderSms` with the pack's variant: the reply clause only on a two-way pack, "or
 * call {number}" only with a voice number), in the language TalkOlog will use with the person, by
 * SMS (§19 Q25), with a sample personal link (the real one is made by the invite).
 */

/** The sample link of the preview: the Field-01-SMS artboard's code on the demo's link base. */
export const SAMPLE_WELCOME_LINK = fieldLinkUrl(DEMO_LINK_BASE, 'MRZ4K7');

export interface WelcomePreview {
  /** The text the person receives (with the sample link). */
  text: string;
  /** Its language, for the bubble's `lang` (WCAG 3.1.2). */
  language: SmsLocale;
  /** The pack's voice number, formatted, when it has one ("They can also call … any time"). */
  number: string | null;
}

/**
 * The preview, or null when the pack forbids links in SMS (§19 Q24: then no welcome can be texted,
 * so there is nothing to show) or has no copy for the language.
 */
export function welcomePreview(
  pack: CountryPack,
  locale: ReporterLocale,
  vars: { first: string; company: string; site: string; deadline: string },
): WelcomePreview | null {
  const language = languageOf(locale);
  const number = pack.voiceNumber ? formatPhone(pack.voiceNumber) : null;
  try {
    const text = renderSms(
      'welcome',
      language,
      {
        first: vars.first,
        company: vars.company,
        site: vars.site,
        deadline: formatDeadline(vars.deadline),
        link: SAMPLE_WELCOME_LINK,
        ...(number ? { number } : {}),
      },
      smsRenderOptions(pack),
    );
    return { text, language, number };
  } catch {
    return null;
  }
}
