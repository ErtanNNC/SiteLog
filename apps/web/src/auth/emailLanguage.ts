import type { OrgLocale } from '@sitelog/shared/locale.ts';
import type { PanelLanguage } from '@/i18n/language';

/**
 * W4-09 (spec §13, §19 Q239): the user metadata the sign-in page sends with a magic-link request
 * (`signInWithOtp`'s `options.data`): `ui_locale`, the language of the sign-in page's switch, as
 * `api-invite-office-user` writes it for an invite (`en-US` | `tr-TR`). Supabase's Auth templates
 * (`supabase/templates/*.html`) choose the EN or TR body by it. GoTrue keeps the data only when the
 * request creates the user (a new address); an existing user's emails follow the metadata their
 * invite or sign-up stored.
 */
export function signInEmailData(language: PanelLanguage): { ui_locale: OrgLocale } {
  return { ui_locale: language === 'tr' ? 'tr-TR' : 'en-US' };
}
