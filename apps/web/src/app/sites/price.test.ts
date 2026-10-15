import { describe, expect, it } from 'vitest';
import { sitePriceFor } from './price';

describe('sitePriceFor (P4 "Connect another site", spec §19 Q9)', () => {
  it('prices a US org in dollars, in the panel’s language', () => {
    expect(sitePriceFor('US', 'en')).toBe('$399');
    expect(sitePriceFor('US', 'tr')).toMatch(/399/);
  });

  it('shows no price where none is set (TR waits for the owner, Q9) or the country is unknown', () => {
    expect(sitePriceFor('TR', 'tr')).toBeNull();
    expect(sitePriceFor(undefined, 'en')).toBeNull();
  });
});
