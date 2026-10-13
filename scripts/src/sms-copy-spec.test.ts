import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SMS_KEYS, smsTemplate, US_ONLY_SMS_KEYS, type SmsKey } from '@sitelog/shared';

/**
 * W1-02: the EN and TR SMS texts in `packages/shared/src/copy/sms.{en,tr}.ts` are verbatim from
 * the spec §9.2 table (the variant with the voice number), and the table and the catalog have the
 * same keys. A spec edit or a copy edit that drifts fails here.
 */

const ROOT = join(import.meta.dirname, '..', '..');
const SPEC = readFileSync(join(ROOT, 'docs', 'SITELOG_SPEC.md'), 'utf8');

/** The §9.2 table rows: key → EN and TR text (null for "—", the US-only rows). */
function specTable(): Map<string, { en: string; tr: string | null; usOnly: boolean }> {
  const section = SPEC.slice(SPEC.indexOf('### 9.2 SMS copy catalog'), SPEC.indexOf('### 9.3'));
  const rows = new Map<string, { en: string; tr: string | null; usOnly: boolean }>();
  for (const line of section.split('\n')) {
    const m = /^\| `([a-z0-9_]+)`( \(US\))? \| (.+) \| (.+) \|$/.exec(line);
    if (!m) continue;
    rows.set(m[1]!, { en: m[3]!, tr: m[4] === '—' ? null : m[4]!, usOnly: Boolean(m[2]) });
  }
  return rows;
}

describe('SMS copy vs spec §9.2', () => {
  const table = specTable();

  it('has the same keys as the spec table, with the same US-only rows', () => {
    expect([...table.keys()].sort()).toEqual([...SMS_KEYS].sort());
    const usOnly = [...table].filter(([, r]) => r.usOnly).map(([k]) => k);
    expect(usOnly.sort()).toEqual([...US_ONLY_SMS_KEYS].sort());
    for (const [key, row] of table) expect(row.tr === null, key).toBe(row.usOnly);
  });

  it('copies EN and TR verbatim', () => {
    for (const [key, row] of table) {
      expect(smsTemplate(key as SmsKey, 'en', true), key).toBe(row.en);
      if (row.tr !== null) expect(smsTemplate(key as SmsKey, 'tr', true), key).toBe(row.tr);
    }
  });
});
