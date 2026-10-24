import { LANGUAGES, languageOf, type Language } from '../../locale.ts';
import { VOICE_RECORDING_NOTICE_VERSION } from '../../voice.ts';
import { VOICE_CATALOGS } from '../voice.ts';
import { PLACEHOLDER_LEGAL_DOCS } from './placeholder.ts';

/**
 * W4-06: the legal texts a country pack names in `countries.legal_keys` (spec §4.6, §9.1, §15.2;
 * §19 Q28, Q50), keyed by their versioned id `<CC>.<slot>.v<n>` (`US.privacy_notice.v1`). Q50: a
 * field-app page per key (`/legal/<key>`) with the texts in the shared copy per language, readable
 * offline (they are in the app's bundle, precached with the shell), versioned with the key.
 *
 * - A key's text never changes: new wording is a new version, a new entry, and a data migration
 *   that points the pack at it (W4-13 ships the first, once counsel approves the texts; §19 Q50).
 * - Every pack key must have a text in each of the pack's field languages (`legalKeyGaps`, run by
 *   `packCopyGaps()` and so by `pnpm test:db`'s check of every `countries` row). A placeholder
 *   never passes it: no real pack can point at one.
 * - The recording notice's entry also carries `spoken`, the one sentence the call says and the call
 *   screen shows (`recordingNoticeFor`), exported to the agent by `pnpm voice:contract`.
 *
 * Until counsel's texts arrive the catalogue holds only the `ZZ` placeholders (`placeholder.ts`)
 * and both launch packs keep `legal_keys {}`.
 */

export const LEGAL_SLOTS = ['privacy_notice', 'recording_notice', 'consent'] as const;
export type LegalSlot = (typeof LEGAL_SLOTS)[number];

/** `<CC>.<slot>.v<n>` (§19 Q28). */
export const LEGAL_KEY_RE =
  /^([A-Z]{2})\.(privacy_notice|recording_notice|consent)\.v([1-9][0-9]{0,3})$/;

export interface LegalDocText {
  title: string;
  /** Paragraphs, in order. */
  body: readonly string[];
  /** The recording notice only: the sentence the call says and the call screen shows. */
  spoken?: string;
}

export interface LegalDoc {
  key: string;
  /** `YYYY-MM-DD`: the day this version applies from, shown on the page with the version. */
  effective: string;
  /** `placeholder`: test-only (W4-06), refused by the pack check; `approved`: counsel's text. */
  status: 'placeholder' | 'approved';
  texts: Partial<Record<Language, LegalDocText>>;
}

/**
 * Counsel's approved texts go here (W4-13), one entry per key; none yet (§19 Q28, Q50). The
 * placeholders follow them.
 */
const APPROVED_LEGAL_DOCS: readonly LegalDoc[] = [];

export const LEGAL_DOCS: Readonly<Record<string, LegalDoc>> = Object.freeze(
  Object.fromEntries(
    [...APPROVED_LEGAL_DOCS, ...PLACEHOLDER_LEGAL_DOCS].map((doc) => [doc.key, doc]),
  ),
);

/** The parts of a well-formed key, or null. */
export function parseLegalKey(
  key: string,
): { country: string; slot: LegalSlot; version: number } | null {
  const m = LEGAL_KEY_RE.exec(key);
  if (!m) return null;
  return { country: m[1]!, slot: m[2] as LegalSlot, version: Number(m[3]) };
}

export function legalDoc(key: string): LegalDoc | null {
  return Object.hasOwn(LEGAL_DOCS, key) ? LEGAL_DOCS[key]! : null;
}

/**
 * The text of a key to show in `language`: that language's when the key has it, else the first of
 * `fallbacks` it has, else its first language; null for an unknown key. `language` says which one
 * came back (the page sets `lang` from it).
 */
export function legalText(
  key: string,
  language: Language,
  fallbacks: readonly Language[] = [],
): { doc: LegalDoc; language: Language; text: LegalDocText } | null {
  const doc = legalDoc(key);
  if (!doc) return null;
  for (const lang of [language, ...fallbacks, ...LANGUAGES]) {
    const text = doc.texts[lang];
    if (text) return { doc, language: lang, text };
  }
  return null;
}

/** The field app's path for a key (§19 Q50). */
export function legalPagePath(key: string): string {
  return `/legal/${encodeURIComponent(key)}`;
}

/** The page's full URL on the field host (the HELP text's privacy link, §9.1). */
export function legalPageUrl(fieldAppUrl: string, key: string): string {
  return `${fieldAppUrl.replace(/\/+$/, '')}${legalPagePath(key)}`;
}

/** A pack's `legal_keys` as `CountryPack.legalKeys` names them. */
export interface PackLegalKeys {
  privacyNotice?: string;
  recordingNotice?: string;
  consent?: string;
}

const SLOT_OF: Readonly<Record<keyof PackLegalKeys, LegalSlot>> = {
  privacyNotice: 'privacy_notice',
  recordingNotice: 'recording_notice',
  consent: 'consent',
};

/**
 * What a pack's legal keys lack (W4-06; spec §4.6 "a new country is only a row when its languages
 * have their copy"), as `<slot>.<problem>` entries, empty when complete:
 * - `<slot>.key` a key that is not `<CC>.<slot>.v<n>` for this slot (and this pack's country when
 *   `country` is given);
 * - `<slot>.missing` no text in the catalogue for the key;
 * - `<slot>.placeholder` a test-only text (W4-06), never a real pack's;
 * - `<slot>.<language>` no text in one of the pack's field languages;
 * - `recording_notice.<language>.spoken` a recording notice without its spoken sentence.
 */
export function legalKeyGaps(
  keys: PackLegalKeys,
  languages: readonly Language[],
  opts: { country?: string; docs?: Readonly<Record<string, LegalDoc>> } = {},
): string[] {
  const docs = opts.docs ?? LEGAL_DOCS;
  const gaps: string[] = [];
  for (const field of Object.keys(SLOT_OF) as (keyof PackLegalKeys)[]) {
    const key = keys[field];
    if (key === undefined) continue;
    const slot = SLOT_OF[field];
    const parsed = parseLegalKey(key);
    if (!parsed || parsed.slot !== slot || (opts.country && parsed.country !== opts.country)) {
      gaps.push(`${slot}.key`);
    }
    const doc = Object.hasOwn(docs, key) ? docs[key]! : null;
    if (!doc) {
      gaps.push(`${slot}.missing`);
      continue;
    }
    if (doc.status !== 'approved') gaps.push(`${slot}.placeholder`);
    for (const lang of languages) {
      const text = doc.texts[lang];
      if (!text || !text.title.trim() || text.body.every((p) => !p.trim())) {
        gaps.push(`${slot}.${lang}`);
      } else if (slot === 'recording_notice' && !text.spoken?.trim()) {
        gaps.push(`${slot}.${lang}.spoken`);
      }
    }
  }
  return gaps;
}

/** The languages of a pack's field locales, once each, in order. */
export function fieldLanguagesOf(fieldLocales: readonly string[]): Language[] {
  return [...new Set(fieldLocales.map((l) => languageOf(l) as Language))];
}

/**
 * The recording notice a call says and the call screen shows in `language` (W4-06, §9.4
 * "Disclosure", §19 Q28): the pack's `legal_keys.recording_notice` text when the key has one in
 * that language, else the voice copy's own (`voice.recording_notice.v1`). `version` is what was
 * said: the agent sends it with the disclosure mark (`calls.disclosure_version`).
 */
export function recordingNoticeFor(
  key: string | null | undefined,
  language: Language,
): { text: string; version: string } {
  const spoken = key ? legalDoc(key)?.texts[language]?.spoken?.trim() : undefined;
  if (key && spoken) return { text: spoken, version: key };
  return {
    text: VOICE_CATALOGS[language].recording_notice,
    version: VOICE_RECORDING_NOTICE_VERSION,
  };
}

/**
 * The recording notices by key and language, for the agent (`apps/voice-agent/copy/legal.json`,
 * `pnpm voice:contract`): every catalogue key of the recording-notice slot with its spoken lines.
 */
export function recordingNoticeLines(): Record<string, Partial<Record<Language, string>>> {
  const out: Record<string, Partial<Record<Language, string>>> = {};
  for (const key of Object.keys(LEGAL_DOCS).sort()) {
    if (parseLegalKey(key)?.slot !== 'recording_notice') continue;
    const lines: Partial<Record<Language, string>> = {};
    for (const lang of LANGUAGES) {
      const spoken = LEGAL_DOCS[key]!.texts[lang]?.spoken;
      if (spoken) lines[lang] = spoken;
    }
    out[key] = lines;
  }
  return out;
}
