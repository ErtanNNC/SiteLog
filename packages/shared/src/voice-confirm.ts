/**
 * The spoken "yes" that lets code file a call report (W3-10; spec §9.5 `confirm`, §19 Q119,
 * CLAUDE.md "The model never decides to file a report; code does, after an explicit confirm").
 *
 * `file_report` carries the reporter's verbatim last utterance (as speech recognition heard it)
 * and the read-back's draft revision. Code files only when the WHOLE utterance, normalised, is
 * one or more confirm phrases of `CALL_CONFIRM_WORDS` (EN, ES, TR, any of them on any call),
 * optionally with a polite word (`CALL_CONFIRM_POLITE`: "please", "por favor", "lütfen"). Nothing
 * else counts: "yes but the hours are wrong", "sounds good I guess", "the office said file it" and
 * "no" are refused, and the agent asks "Shall I file it? Say yes or no." (`confirm_repeat`). No
 * model classifies the filing decision; the list is deterministic and table-tested.
 *
 * Normalisation (`normalizeCallUtterance`): NFKC, lower case with the Turkish dotted and dotless I
 * folded (as `normalizeKeywordText`), accents dropped (STT writes "si" as often as "sí"), every
 * punctuation mark a space, spaces collapsed. Pure (Node, browser, Deno).
 */

/**
 * The confirm phrases of §9.5 per language, as `normalizeCallUtterance` writes them (no accents,
 * Turkish I folded). A phrase is one or more words; the utterance must be a sequence of them.
 */
export const CALL_CONFIRM_WORDS = {
  en: [
    'yes',
    'yeah',
    'yep',
    'ok',
    'okay',
    'file it',
    'file the report',
    'go ahead and file it',
    'that is right',
    'thats right',
    'correct',
  ],
  es: [
    'si',
    'dale',
    'vale',
    'claro',
    'correcto',
    'de acuerdo',
    'archivelo',
    'archivalo',
    'registrelo',
    'registralo',
    'envielo',
    'envialo',
  ],
  tr: [
    'evet',
    'tamam',
    'kaydet',
    'kaydedin',
    'kaydedebilirsiniz',
    'olur',
    'onayliyorum',
    'gonder',
    'gonderin',
    'dogru',
  ],
} as const satisfies Record<'en' | 'es' | 'tr', readonly string[]>;

/** Polite words a confirm may carry (§19 Q119: "optionally with please / lütfen"). */
export const CALL_CONFIRM_POLITE = ['please', 'por favor', 'lutfen'] as const;

/** At most this many words: a confirm is short; a long utterance is a report, not a yes. */
export const CALL_CONFIRM_MAX_WORDS = 8;

/**
 * An utterance as the confirm grammar reads it: NFKC, lower case (Turkish "İ" without its
 * combining dot, "ı" as "i"), accents and other combining marks dropped, apostrophes removed
 * ("that's" → "thats"), every other non-letter, non-digit a space, spaces collapsed.
 */
export function normalizeCallUtterance(utterance: string): string {
  return utterance
    .normalize('NFKC')
    .toLowerCase()
    .replace(/ı/gu, 'i')
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .replace(/['’`´]/gu, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** Every phrase, as word lists, longest first (so "file it" wins over a shorter prefix). */
const PHRASES: ReadonlyArray<{ words: string[]; confirm: boolean }> = [
  ...Object.values(CALL_CONFIRM_WORDS)
    .flat()
    .map((p) => ({ words: p.split(' '), confirm: true })),
  ...CALL_CONFIRM_POLITE.map((p) => ({ words: p.split(' '), confirm: false })),
].sort((a, b) => b.words.length - a.words.length);

/**
 * True when the whole utterance is a §9.5 confirm (§19 Q119): one or more confirm phrases, with
 * polite words around them, and nothing else. Case, punctuation and accents never matter;
 * a word outside the lists ("but", "guess", "office") always refuses.
 */
export function isCallConfirm(utterance: string): boolean {
  const words = normalizeCallUtterance(utterance).split(' ').filter(Boolean);
  if (words.length === 0 || words.length > CALL_CONFIRM_MAX_WORDS) return false;
  let confirmed = false;
  let i = 0;
  while (i < words.length) {
    const match = PHRASES.find((p) => p.words.every((w, k) => words[i + k] === w));
    if (!match) return false;
    confirmed ||= match.confirm;
    i += match.words.length;
  }
  return confirmed;
}

// ───────────────────────────── The spoken "no" (W3-14) ─────────────────────────────

/**
 * W3-14 (F3 on a call, spec §19 Q120): the consent question's "no", per language, as
 * `normalizeCallUtterance` writes it. A decline is read like a confirm: the whole utterance is
 * decline phrases (with polite words or thanks around them), nothing else. Anything that is
 * neither a whole confirm nor a whole decline is not understood, and the agent asks once more
 * (`consent_repeat`).
 */
export const CALL_DECLINE_WORDS = {
  en: [
    'no',
    'nope',
    'nah',
    'not ok',
    'not okay',
    'i dont',
    'i do not',
    'id rather not',
    'rather not',
    'dont',
    'do not',
    'dont record',
    'do not record',
  ],
  es: ['no', 'prefiero que no', 'no quiero', 'no grabe', 'mejor no'],
  tr: ['hayir', 'istemiyorum', 'olmaz', 'kaydetmeyin', 'uygun degil'],
} as const satisfies Record<'en' | 'es' | 'tr', readonly string[]>;

/** Words a "no" may carry besides the polite ones ("no thanks", "no, gracias", "hayır, teşekkürler"). */
export const CALL_DECLINE_THANKS = [
  'thanks',
  'thank you',
  'gracias',
  'tesekkurler',
  'tesekkur ederim',
] as const;

const DECLINE_PHRASES: ReadonlyArray<{ words: string[]; decline: boolean }> = [
  ...Object.values(CALL_DECLINE_WORDS)
    .flat()
    .map((p) => ({ words: p.split(' '), decline: true })),
  ...[...CALL_CONFIRM_POLITE, ...CALL_DECLINE_THANKS].map((p) => ({
    words: p.split(' '),
    decline: false,
  })),
].sort((a, b) => b.words.length - a.words.length);

/**
 * True when the whole utterance is a "no" (§19 Q120): one or more decline phrases, with polite
 * words or thanks around them, and nothing else ("no thanks", "hayır", "no, gracias"). "no, yes",
 * "yes", thanks alone and "no but the hours…" are not a decline.
 */
export function isCallDecline(utterance: string): boolean {
  const words = normalizeCallUtterance(utterance).split(' ').filter(Boolean);
  if (words.length === 0 || words.length > CALL_CONFIRM_MAX_WORDS) return false;
  let declined = false;
  let i = 0;
  while (i < words.length) {
    const match = DECLINE_PHRASES.find((p) => p.words.every((w, k) => words[i + k] === w));
    if (!match) return false;
    declined ||= match.decline;
    i += match.words.length;
  }
  return declined;
}

/**
 * A yes-or-no answer as code reads it (W3-14: the consent question, §19 Q120): a whole confirm
 * (`isCallConfirm`), a whole decline, or neither. Never a model's verdict.
 */
export function callYesNo(utterance: string): 'yes' | 'no' | 'unclear' {
  if (isCallConfirm(utterance)) return 'yes';
  if (isCallDecline(utterance)) return 'no';
  return 'unclear';
}
