import { formatMoneyCents } from '@sitelog/shared/format.ts';
import { PRICE_PER_SITE_CENTS } from '@/data/assemble';
import type { PanelLanguage } from '@/i18n/language';

/**
 * The monthly price per site on the "Connect another site" card (P4 "with country price").
 * Billing is a known country-specific exception until M10 (spec §19 Q30): only the US price is
 * set; the TR price is open (spec §19 Q9), so a Turkish org's card shows no price line yet.
 */
const SITE_PRICE: Readonly<Record<string, { cents: number; currency: string }>> = {
  US: { cents: PRICE_PER_SITE_CENTS, currency: 'USD' },
};

/** "$399" for a US org; null where no price is set for the org's country (or it is unknown). */
export function sitePriceFor(country: string | undefined, language: PanelLanguage): string | null {
  const price = country ? SITE_PRICE[country] : undefined;
  return price ? formatMoneyCents(price.cents, price.currency, language) : null;
}
