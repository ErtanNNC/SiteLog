import type { ContactPref, MessageChannel } from '@sitelog/shared/enums.ts';
import type { CopyT } from '@/i18n/useCopy';

/** Languages a reporter may speak: TalkOlog's field languages (EN, ES, TR) first, then others. */
export const LANGUAGES = ['en', 'es', 'tr', 'pl', 'pt', 'hi', 'fr'] as const;
export type SpokenLanguage = (typeof LANGUAGES)[number];

export function isSpokenLanguage(code: string): code is SpokenLanguage {
  return (LANGUAGES as readonly string[]).includes(code);
}

/** A spoken language by name in the panel's language; an unlisted code in capitals. */
export function languageLabel(t: CopyT, code: string): string {
  return isSpokenLanguage(code) ? t(`team.invite.languageNames.${code}`) : code.toUpperCase();
}

/** P10 "Prefers": "Text link", or "Text link · WhatsApp" with a message channel (§19 Q21). */
export function contactLabel(t: CopyT, pref: ContactPref, channel: MessageChannel | null): string {
  const label = t(`team.prefers.${pref}`);
  return channel
    ? t('team.prefers.withChannel', { pref: label, channel: t(`team.channels.${channel}`) })
    : label;
}
