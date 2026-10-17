import { describe, expect, it } from 'vitest';
import { FINAL_ERRORS, RELINK_ERRORS } from '@/queue/types';
import { sendingErrorKey } from './sendingErrors';

describe('sendingErrorKey', () => {
  it('names a refusal the copy explains, and generic otherwise', () => {
    expect(sendingErrorKey('report_filed')).toBe('sending.errors.report_filed');
    expect(sendingErrorKey('link_expired')).toBe('sending.errors.link_expired');
    expect(sendingErrorKey('wrong_state')).toBe('sending.errors.generic');
    expect(sendingErrorKey(null)).toBe('sending.errors.generic');
  });

  it('explains every refusal a new link clears, and every final one but the queue’s own', () => {
    for (const code of RELINK_ERRORS) expect(sendingErrorKey(code)).not.toMatch(/generic$/);
    for (const code of FINAL_ERRORS.filter(
      (c) => !['invalid_request', 'removed', 'kind_not_allowed'].includes(c),
    )) {
      expect(sendingErrorKey(code), code).not.toMatch(/generic$/);
    }
  });
});
