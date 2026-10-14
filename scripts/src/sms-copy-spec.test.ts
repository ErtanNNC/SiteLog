import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  SMS_KEYS,
  SMS_REPLY_HINT,
  smsTemplate,
  TWO_WAY_SMS_KEYS,
  type SmsKey,
} from '@sitelog/shared';

/**
 * W1-02, W1-06a: the EN and TR SMS texts in `packages/shared/src/copy/sms.{en,tr}.ts` are verbatim
 * from the spec §9.2 table, and the table and the catalog have the same keys. The EN column is
 * the US pack's variant (a voice number, two-way SMS: the welcome with its reply clause); the TR
 * column the TR pack's (one-way) with a voice number. The rows marked "(two-way)" are the keys
 * sent only on packs with two-way SMS. A spec edit or a copy edit that drifts fails here.
 */

const ROOT = join(import.meta.dirname, '..', '..');
const SPEC = readFileSync(join(ROOT, 'docs', 'SITELOG_SPEC.md'), 'utf8');

/** The §9.2 table rows: key → EN and TR text (null for "—", the two-way rows). */
function specTable(): Map<string, { en: string; tr: string | null; twoWay: boolean }> {
  const section = SPEC.slice(SPEC.indexOf('### 9.2 SMS copy catalog'), SPEC.indexOf('### 9.3'));
  const rows = new Map<string, { en: string; tr: string | null; twoWay: boolean }>();
  for (const line of section.split('\n')) {
    const m = /^\| `([a-z0-9_]+)`( \(two-way\))? \| (.+) \| (.+) \|$/.exec(line);
    if (!m) continue;
    rows.set(m[1]!, { en: m[3]!, tr: m[4] === '—' ? null : m[4]!, twoWay: Boolean(m[2]) });
  }
  return rows;
}

describe('SMS copy vs spec §9.2', () => {
  const table = specTable();

  it('has the same keys as the spec table, with the same two-way rows', () => {
    expect([...table.keys()].sort()).toEqual([...SMS_KEYS].sort());
    const twoWay = [...table].filter(([, r]) => r.twoWay).map(([k]) => k);
    expect(twoWay.sort()).toEqual([...TWO_WAY_SMS_KEYS].sort());
    for (const [key, row] of table) expect(row.tr === null, key).toBe(row.twoWay);
  });

  it('copies EN (two-way) and TR (one-way) verbatim', () => {
    for (const [key, row] of table) {
      const variant = { hasVoiceNumber: true, linksAllowed: true };
      expect(smsTemplate(key as SmsKey, 'en', { ...variant, twoWay: true }), key).toBe(row.en);
      if (row.tr !== null)
        expect(smsTemplate(key as SmsKey, 'tr', { ...variant, twoWay: false }), key).toBe(row.tr);
    }
  });

  it('describes the pack variants it renders', () => {
    const section = SPEC.slice(SPEC.indexOf('### 9.2 SMS copy catalog'), SPEC.indexOf('### 9.3'));
    expect(section).toContain('Packs without two-way SMS never get reply instructions');
    // The welcome's reply clause, as the catalogue appends it on two-way packs.
    expect(section).toContain(`'${SMS_REPLY_HINT.en}'`);
    expect(section).not.toMatch(/\(US\)|VOICE_NUMBER_/);
  });
});
