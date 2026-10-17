import type { BillingPrice } from '@sitelog/shared/billing.ts';
import { formatMoneyCents } from '@sitelog/shared/format.ts';
import type { PanelLanguage } from '@/i18n/language';

/**
 * The monthly price per site on the "Connect another site" card (P4 "with country price"): the
 * org's own price (W4-10, spec §19 Q234, `orgs.price_per_site_minor`), in the panel's language.
 * An org SiteLog has set no price for (a TR org until §19 Q9) shows no price line.
 */
export function sitePriceFor(
  price: BillingPrice | null | undefined,
  language: PanelLanguage,
): string | null {
  return price ? formatMoneyCents(price.minor, price.currency, language) : null;
}
