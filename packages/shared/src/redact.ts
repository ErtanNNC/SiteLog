/**
 * Phone numbers out of text before it reaches a model (CLAUDE.md "Never send phone numbers to an
 * LLM", spec §10.12; docs/AUDIT_BACKLOG.md "Transcripts, text replies, captions and unknown-sender
 * snippets reach Claude verbatim"). The worker applies it to every text block of every Claude call
 * (`callTool`), so transcripts, answers, captions, earlier drafts and retry turns are all covered.
 *
 * The patterns are the ones `ops_redact()` uses in SQL (20261012000003_ops.sql), so both layers
 * agree, plus the Turkish grouping (0532 123 45 67). A run inside a UUID or an ISO date is left
 * alone: the lookarounds refuse a digit run next to a letter, a digit or a hyphen.
 */

export const PHONE_PLACEHOLDER = '[phone]';

const PATTERNS: readonly RegExp[] = [
  // International: +1 555 014 3378, +90 (532) 123-4567
  /\+[0-9][0-9 ().-]{5,}[0-9]/g,
  // North American: (555) 014-3378, 555.014.3378, 555 014 3378
  /(?<![0-9A-Za-z-])\(?[0-9]{3}\)?[ .-]?[0-9]{3}[ .-][0-9]{4}(?![0-9A-Za-z-])/g,
  // Turkish mobile grouping: 0532 123 45 67, 532 123 45 67
  /(?<![0-9A-Za-z-])0?[0-9]{3}[ .-]?[0-9]{3}[ .-][0-9]{2}[ .-][0-9]{2}(?![0-9A-Za-z-])/g,
  // A bare run of 10–15 digits: 5550143378, 905321234567
  /(?<![0-9A-Za-z-])[0-9]{10,15}(?![0-9A-Za-z-])/g,
];

/** `text` with every phone-number-like run replaced by `[phone]`. */
export function redactPhones(text: string): string {
  let out = text;
  for (const re of PATTERNS) out = out.replace(re, PHONE_PLACEHOLDER);
  return out;
}

/** true when `redactPhones` would change the text. */
export function containsPhone(text: string): boolean {
  return redactPhones(text) !== text;
}
