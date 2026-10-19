import { describe, expect, it } from 'vitest';
import { sitePriceFor } from './price';

describe('sitePriceFor (P4 "Connect another site", spec §19 Q234, Q9)', () => {
  it('prices the org from its own price, in the panel’s language', () => {
    expect(sitePriceFor({ minor: 39900, currency: 'USD' }, 'en')).toBe('$399');
    expect(sitePriceFor({ minor: 39900, currency: 'USD' }, 'tr')).toMatch(/399/);
    expect(sitePriceFor({ minor: 150000, currency: 'TRY' }, 'tr')).toBe('₺1.500');
  });

  it('shows no price where TalkOlog set none (TR waits for the owner, Q9)', () => {
    expect(sitePriceFor(null, 'tr')).toBeNull();
    expect(sitePriceFor(undefined, 'en')).toBeNull();
  });
});
