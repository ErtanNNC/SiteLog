import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { renderVoice, VOICE_CATALOGS, VOICE_SPEC_VERBATIM_KEYS } from '@sitelog/shared';

/**
 * W3-01: the EN voice lines the spec quotes (§9.4 openings, dialog policy and F6, F3, F12, F13,
 * F14, §7.3, §19 Q119) are verbatim, and the Turkish disclosure is F6's and §9.4's. A spec edit or
 * a copy edit that drifts fails here.
 */

const ROOT = join(import.meta.dirname, '..', '..');
const SPEC = readFileSync(join(ROOT, 'docs', 'SITELOG_SPEC.md'), 'utf8');

describe('voice copy vs the spec', () => {
  it('quotes the spec verbatim for the EN lines it gives', () => {
    const notice = VOICE_CATALOGS.en.recording_notice;
    for (const key of VOICE_SPEC_VERBATIM_KEYS) {
      const raw = VOICE_CATALOGS.en[key];
      const text = raw.includes('{recording_notice}')
        ? raw.replace('{recording_notice}', notice)
        : raw;
      const found = SPEC.includes(text) || SPEC.includes(text.replace(/\.$/, ''));
      expect(found, `${key}: ${text}`).toBe(true);
    }
  });

  it('uses the spec’s Turkish disclosure and outbound opening', () => {
    const notice = renderVoice('recording_notice', 'tr');
    expect(SPEC).toContain(notice);
    const opening = VOICE_CATALOGS.tr.opening_outbound.replace('{recording_notice}', notice);
    expect(SPEC).toContain(opening);
  });
});
