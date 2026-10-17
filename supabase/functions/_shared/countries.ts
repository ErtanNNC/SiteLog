import { toCountryPack, type CountryPack, type CountryRow } from '@sitelog/shared';
import type { AppClient } from './supabase.ts';

/**
 * Country packs for the edge functions (spec §4.6; W1-08): the service role reads `countries`
 * directly. Each read is fresh, so a sender id set with `pnpm countries:set` applies on the next
 * request (no cache to restart).
 */

/** A row → its pack; a missing or invalid row is a configuration error (500), never `console`. */
export function packFromRow(row: CountryRow | null, what: string): CountryPack {
  if (!row) throw new Error(`No country pack for ${what}`);
  return toCountryPack(row);
}

/** The sender id an inbound text was sent to, as `countries.sms_sender_id` stores it (trimmed). */
export function senderKey(to: string): string {
  return to.trim();
}

export async function loadPack(admin: AppClient, code: string): Promise<CountryPack> {
  const { data } = await admin
    .from('countries')
    .select('*')
    .eq('code', code)
    .maybeSingle()
    .throwOnError();
  return packFromRow(data as CountryRow | null, `country ${code}`);
}

/** The pack whose SMS sender received a text (F13; unique across packs since 20261014000007). */
export async function packBySender(admin: AppClient, to: string): Promise<CountryPack | null> {
  const { data } = await admin
    .from('countries')
    .select('*')
    .eq('sms_sender_id', senderKey(to))
    .maybeSingle()
    .throwOnError();
  return data ? toCountryPack(data as CountryRow) : null;
}

/** An org's pack (its `country`) with the org fields the messaging code needs. */
export async function loadOrgPack(
  admin: AppClient,
  orgId: string,
): Promise<{
  org: { id: string; name: string; country: string; is_demo: boolean };
  pack: CountryPack;
}> {
  const { data: org } = await admin
    .from('orgs')
    .select('id, name, country, is_demo')
    .eq('id', orgId)
    .single()
    .throwOnError();
  return { org, pack: await loadPack(admin, org.country) };
}
