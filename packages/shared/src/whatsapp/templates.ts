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
 * Meta refuses a body that starts or ends with a variable, so such a text gets "SiteLog: " in front
 * or " - SiteLog" at the end (spec §19 Q110). A template is tied to the pack's variant: a voice
 * number set or cleared later changes the "or call {number}" clause, so the templates of the keys
 * with that clause are submitted again.
 */

/** The template languages: the SMS copy's (§9.6). */
export const WHATSAPP_TEMPLATE_LANGUAGES = LANGUAGES;

/** The copy variant of WhatsApp: replies and links always work there; the pack's voice number. */
export function whatsappRenderOptions(pack: Pick<CountryPack, 'voiceNumber'>): RenderSmsOptions {
  return { hasVoiceNumber: pack.voiceNumber !== null, twoWay: true, linksAllowed: true };
}

export interface WhatsappTemplate {
  /** The body to submit, with `{{1}}`, `{{2}}` … */
  body: string;
  /** The §9.2 variable of each number, in order: `variables[0]` is `{{1}}`. */
  variables: string[];
}

const PREFIX = 'SiteLog: ';
const SUFFIX = ' - SiteLog';

/** The template of a key in a language for the pack's variant. */
export function whatsappTemplate(
  key: WhatsappKey,
  language: Language,
  options: RenderSmsOptions,
): WhatsappTemplate {
  const text = smsTemplate(key, language, options);
  const variables: string[] = [];
  let body = text.replace(/\{([a-z0-9_]+)\}/g, (_m, name: string) => {
    let n = variables.indexOf(name);
    if (n < 0) n = variables.push(name) - 1;
    return `{{${n + 1}}}`;
  });
  if (/^\{\{\d+\}\}/.test(body)) body = PREFIX + body;
  if (/\{\{\d+\}\}$/.test(body)) body = body + SUFFIX;
  return { body, variables };
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
