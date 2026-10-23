import { WHATSAPP_KEYS, type WhatsappKey } from '../channels.ts';
import { smsTemplate, type RenderSmsOptions } from '../copy/sms.ts';
import type { CountryPack } from '../countries.ts';
import { LANGUAGES, type Language } from '../locale.ts';

/**
 * WhatsApp templates (W2-15; spec §4.4, §9.2 "WhatsApp templates … reuse these keys", §19 Q39).
 *
 * A business-initiated WhatsApp message outside the 24-hour window must be a template Meta approved
 * in advance; Twilio sends one by its Content API id (`ContentSid`) with numbered variables
 * (`ContentVariables`, `{"1": "…", "2": "…"}`). Each key of `WHATSAPP_KEYS` has one template per
 * language (EN, ES, TR) whose body is the §9.2 text of the pack's variant with its `{name}`
 * placeholders numbered in order of first appearance (`whatsappTemplate`). The owner submits these
 * bodies through Twilio (`pnpm countries:set -- --code XX --print-whatsapp-templates`), and once
 * Meta approves them sets the content sids per environment
 * (`pnpm countries:set -- --code XX --whatsapp-templates <file>`): `countries.whatsapp_templates`,
 * `{<key>: {<language>: <content sid>}}`.
 *
 * Meta refuses a body that starts or ends with a variable, so such a text gets "TalkOlog: " in front
 * or " - TalkOlog" at the end (spec §19 Q110). Punctuation or spaces between the variable and the
 * edge do not help: Meta rejected "… Tap {{1}}." as ending with a variable (2026-10-23), so a
 * variable followed only by punctuation counts as the end, and likewise at the start.
 *
 * Categories (§19 Q372): every key is a Utility template but `verify_code`, an Authentication
 * template (`WHATSAPP_AUTH_KEYS`). Meta fixes an authentication template's text: the body
 * "{{1}} is your verification code." in the chosen language, with the security recommendation
 * and the code-expiry footer as options, and a copy-code button; nothing of ours goes in it but
 * the code. Twilio models it as the `whatsapp/authentication` content type; a send is the same
 * `ContentSid` and `ContentVariables` (`{"1": "<code>"}`) as any template, so the transport needs
 * nothing special. `whatsappTemplate` gives its body as Meta shows it, for the owner's reference. A template is tied to the pack's variant: a voice
 * number set or cleared later changes the "or call {number}" clause, so the templates of the keys
 * with that clause are submitted again.
 */

/** The template languages: the SMS copy's (§9.6). */
export const WHATSAPP_TEMPLATE_LANGUAGES = LANGUAGES;

/** The copy variant of WhatsApp: replies and links always work there; the pack's voice number. */
export function whatsappRenderOptions(pack: Pick<CountryPack, 'voiceNumber'>): RenderSmsOptions {
  return { hasVoiceNumber: pack.voiceNumber !== null, twoWay: true, linksAllowed: true };
}

/** Meta's template categories that TalkOlog uses. */
export type WhatsappTemplateCategory = 'utility' | 'authentication';

/** The keys sent by an Authentication template (Meta's fixed one-time-code format). */
export const WHATSAPP_AUTH_KEYS = ['verify_code'] as const satisfies readonly WhatsappKey[];

/** How long a device code lives (F4 step 2, `verify_code`: "It expires in 10 minutes."). */
export const VERIFY_CODE_EXPIRY_MINUTES = 10;

export interface WhatsappTemplate {
  /** The body to submit, with `{{1}}`, `{{2}}` … (an authentication template's: Meta's text). */
  body: string;
  /** The §9.2 variable of each number, in order: `variables[0]` is `{{1}}`. */
  variables: string[];
  category: WhatsappTemplateCategory;
  /**
   * Twilio's content type to create it with: `twilio/text` for Utility, `whatsapp/authentication`
   * (security recommendation on, code expiry `VERIFY_CODE_EXPIRY_MINUTES`, a copy-code button)
   * for Authentication.
   */
  contentType: 'twilio/text' | 'whatsapp/authentication';
  /** Authentication only: Meta's code-expiry footer, as it shows it. */
  footer?: string;
}

/**
 * Meta's fixed authentication text in each template language, with the security recommendation
 * and the expiry footer (Meta renders these; listed so the owner sees what the reporter gets).
 */
const AUTH_BODY: Readonly<Record<Language, { body: string; footer: string }>> = {
  en: {
    body: '{{1}} is your verification code. For your security, do not share this code.',
    footer: `This code expires in ${VERIFY_CODE_EXPIRY_MINUTES} minutes.`,
  },
  es: {
    body: 'Tu código de verificación es {{1}}. Por tu seguridad, no lo compartas.',
    footer: `Este código caduca en ${VERIFY_CODE_EXPIRY_MINUTES} minutos.`,
  },
  tr: {
    body: 'Doğrulama kodunuz {{1}}. Güvenliğiniz için bu kodu kimseyle paylaşmayın.',
    footer: `Bu kodun süresi ${VERIFY_CODE_EXPIRY_MINUTES} dakika içinde dolar.`,
  },
};

/** Whether a key goes by an Authentication template. */
export function isWhatsappAuthKey(key: string): boolean {
  return (WHATSAPP_AUTH_KEYS as readonly string[]).includes(key);
}

const PREFIX = 'TalkOlog: ';
const SUFFIX = ' - TalkOlog';

/**
 * Template texts that differ from the SMS copy. The SMS copy of these keys is unchanged; each text
 * has the same variables in the same order and meaning as the SMS one, never starts or ends with a
 * variable, and has no "or call {number}" clause, so the template is the same with or without a
 * voice number.
 *
 * - `welcome` (§19 Q373, owner 2026-10-21): Meta classed the welcome built from the SMS text
 *   ("Hi {first}, I'm TalkOlog, …") as Marketing, so its template is a notice of the invite.
 * - `daily_link`, `reminder_1`, `missed_call`, `finish_report`, `edit_applied` (§19 Q377, owner
 *   2026-10-23): Meta recategorised the first four as Marketing (persuasive wording: "A one-minute
 *   voice note is plenty", "Finish in one tap"), rejected `missed_call.en` for ending with a
 *   variable ("Tap {{1}}.") and `edit_applied` for too many variables for its length. Their
 *   templates are plain, informational notices, submitted under new names (`_v2`).
 */
const WHATSAPP_TEXT: Partial<Record<WhatsappKey, Readonly<Record<Language, string>>>> = {
  welcome: {
    en: 'TalkOlog: {first}, {company} added you as the daily reporter for {site}. Each workday before {deadline}, send your report from this link: {link} Reply STOP to opt out.',
    es: 'TalkOlog: {first}, {company} le agregó como responsable del reporte diario de {site}. Cada día de trabajo antes de las {deadline}, envíe su reporte desde este enlace: {link} Responda STOP para darse de baja.',
    tr: 'TalkOlog: {first}, {company} sizi {site} için günlük raporcu olarak ekledi. Her iş günü {deadline} öncesi raporunuzu bu linkten verin: {link} Durdurmak için STOP yazın.',
  },
  daily_link: {
    en: 'TalkOlog: the daily report for {site} is open. Your personal report link for today: {link} (please do not share it).',
    es: 'TalkOlog: el reporte diario de {site} está abierto. Su enlace personal de reporte para hoy: {link} (por favor, no lo comparta).',
    tr: 'TalkOlog: {site} için bugünkü günlük rapor açıldı. Bugünkü kişisel rapor linkiniz: {link} (lütfen paylaşmayın).',
  },
  reminder_1: {
    en: 'TalkOlog: the daily report for {site} has not been received yet today. Your report link: {link} (please do not share it).',
    es: 'TalkOlog: el reporte diario de {site} de hoy todavía no se ha recibido. Su enlace de reporte: {link} (por favor, no lo comparta).',
    tr: 'TalkOlog: {site} için bugünkü günlük rapor henüz alınmadı. Rapor linkiniz: {link} (lütfen paylaşmayın).',
  },
  missed_call: {
    en: "TalkOlog: we could not reach you by phone for today's daily report. Your report link: {link} (please do not share it).",
    es: 'TalkOlog: no pudimos comunicarnos con usted por teléfono para el reporte diario de hoy. Su enlace de reporte: {link} (por favor, no lo comparta).',
    tr: 'TalkOlog: bugünkü günlük rapor için size telefonla ulaşamadık. Rapor linkiniz: {link} (lütfen paylaşmayın).',
  },
  finish_report: {
    en: "TalkOlog: your call ended before today's report was filed, so the report is not filed yet. Your report link: {link} (please do not share it).",
    es: 'TalkOlog: su llamada terminó antes de registrar el reporte de hoy, así que el reporte todavía no está registrado. Su enlace de reporte: {link} (por favor, no lo comparta).',
    tr: 'TalkOlog: görüşme bugünkü rapor kaydedilmeden bitti, rapor henüz kaydedilmedi. Rapor linkiniz: {link} (lütfen paylaşmayın).',
  },
  edit_applied: {
    en: 'TalkOlog: your daily report for {weekday} was updated with this change: {change}. Version {v} of the report has been sent to the office.',
    es: 'TalkOlog: su reporte diario del {weekday} se actualizó con este cambio: {change}. La versión {v} del reporte se envió a la oficina.',
    tr: 'TalkOlog: {weekday} günlük raporunuz şu değişiklikle güncellendi: {change}. Raporun {v}. sürümü ofise gönderildi.',
  },
};

/**
 * Whether a body starts or ends with a variable for Meta: only spaces or punctuation between the
 * variable and the edge (§19 Q110; "… Tap {{1}}." ends with one).
 */
const STARTS_WITH_VARIABLE = /^[^\p{L}\p{N}]*\{\{\d+\}\}/u;
const ENDS_WITH_VARIABLE = /\{\{\d+\}\}[^\p{L}\p{N}]*$/u;

/** Whether a template body starts or ends with a variable, as Meta reads it (§19 Q110). */
export function hasEdgeVariable(body: string): boolean {
  return STARTS_WITH_VARIABLE.test(body) || ENDS_WITH_VARIABLE.test(body);
}

/** The template of a key in a language for the pack's variant. */
export function whatsappTemplate(
  key: WhatsappKey,
  language: Language,
  options: RenderSmsOptions,
): WhatsappTemplate {
  if (isWhatsappAuthKey(key)) {
    const auth = AUTH_BODY[language];
    return {
      body: auth.body,
      variables: ['code'],
      category: 'authentication',
      contentType: 'whatsapp/authentication',
      footer: auth.footer,
    };
  }
  const text = WHATSAPP_TEXT[key]?.[language] ?? smsTemplate(key, language, options);
  const variables: string[] = [];
  let body = text.replace(/\{([a-z0-9_]+)\}/g, (_m, name: string) => {
    let n = variables.indexOf(name);
    if (n < 0) n = variables.push(name) - 1;
    return `{{${n + 1}}}`;
  });
  if (STARTS_WITH_VARIABLE.test(body)) body = PREFIX + body;
  if (ENDS_WITH_VARIABLE.test(body)) body = body + SUFFIX;
  return { body, variables, category: 'utility', contentType: 'twilio/text' };
}

/** Every template of a pack (its field languages), for the owner to submit. */
export function whatsappTemplatesFor(
  pack: Pick<CountryPack, 'voiceNumber' | 'fieldLocales'>,
): Array<{ key: WhatsappKey; language: Language } & WhatsappTemplate> {
  const languages = [...new Set(pack.fieldLocales.map((l) => l.slice(0, 2) as Language))];
  const options = whatsappRenderOptions(pack);
  return WHATSAPP_KEYS.flatMap((key) =>
    languages.map((language) => ({ key, language, ...whatsappTemplate(key, language, options) })),
  );
}

/**
 * The `ContentVariables` of a template send: each number's value from the message's variables.
 * Throws on a variable the message lacks (as `renderSms` does).
 */
export function whatsappContentVariables(
  template: WhatsappTemplate,
  vars: Readonly<Record<string, unknown>>,
): Record<string, string> {
  const out: Record<string, string> = {};
  template.variables.forEach((name, i) => {
    const value = vars[name];
    if (value === undefined || value === null || String(value).trim() === '') {
      throw new Error(`WhatsApp template needs {${name}}`);
    }
    out[String(i + 1)] = String(value);
  });
  return out;
}

/** The approved template's content sid of a key in a language, in this environment, or null. */
export function whatsappContentSid(
  pack: Pick<CountryPack, 'whatsappTemplates'>,
  key: string,
  language: string,
): string | null {
  const byLanguage = Object.hasOwn(pack.whatsappTemplates, key)
    ? pack.whatsappTemplates[key]
    : undefined;
  const sid =
    byLanguage && Object.hasOwn(byLanguage, language)
      ? byLanguage[language as Language]
      : undefined;
  return typeof sid === 'string' && sid !== '' ? sid : null;
}

/** Whether `key` is a key WhatsApp carries (and so may have a template). */
export function isWhatsappKey(key: string): key is WhatsappKey {
  return (WHATSAPP_KEYS as readonly string[]).includes(key);
}
