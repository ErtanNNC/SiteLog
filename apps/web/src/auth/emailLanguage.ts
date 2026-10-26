import type { OrgLocale } from '@sitelog/shared/locale.ts';
import type { DataSource } from '@/data/source';
import type { PanelLanguage } from '@/i18n/language';
import { captureError } from '@/lib/sentry';

/**
 * W4-09 (spec §13, §19 Q239): the user metadata the sign-in page sends with a magic-link request
 * (`signInWithOtp`'s `options.data`): `ui_locale`, the language of the sign-in page's switch, as
 * `api-invite-office-user` writes it for an invite (`en-US` | `tr-TR`). Supabase's Auth templates
 * (`supabase/templates/*.html`) choose the EN or TR body by it. GoTrue keeps the data only when the
 * request creates the user (a new address); for an existing user the panel writes the language
 * they choose while signed in (`saveEmailLanguage`, §19 Q340).
 */
export function signInEmailData(language: PanelLanguage): { ui_locale: OrgLocale } {
  return { ui_locale: language === 'tr' ? 'tr-TR' : 'en-US' };
}

/**
 * §19 Q340: a signed-in viewer chose `language` on this device; their next sign-in email follows
 * it. Best effort: the switch has already applied, so a failure is reported, never thrown. The
 * demo (no Auth) and a viewer without a source write nothing.
 */
export function saveEmailLanguage(source: DataSource | null, language: PanelLanguage): void {
  if (!source || source.mode === 'demo') return;
  let pending: Promise<unknown>;
  try {
    pending = source.saveEmailLanguage(language);
  } catch (err) {
    captureError(err, { where: 'saveEmailLanguage' });
    return;
  }
  pending.catch((err: unknown) => captureError(err, { where: 'saveEmailLanguage' }));
}
