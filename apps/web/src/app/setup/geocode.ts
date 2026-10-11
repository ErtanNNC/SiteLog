/**
 * Address → lat/lng for weather data (F2). Uses Open-Meteo's geocoding endpoint (the weather
 * provider from §10.10) on the place-name part of the address; street-level geocoding comes with
 * the server-side provider in §19. Returns null when nothing matches; throws on network errors.
 */
export interface GeocodeResult {
  lat: number;
  lng: number;
  name: string;
  timezone: string | null;
}

const ENDPOINT = 'https://geocoding-api.open-meteo.com/v1/search';

/** "2101 W Fulton St, Chicago, IL 60612" → candidates ["Chicago", "Chicago IL", …]. */
export function placeCandidates(address: string): string[] {
  const parts = address
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);
  const out: string[] = [];
  // Prefer the token after the street line; strip postal codes.
  for (const p of parts.slice(1)) {
    const cleaned = p.replace(/\b\d{4,}(-\d{4})?\b/g, '').trim();
    if (cleaned && !/^\d+$/.test(cleaned)) out.push(cleaned);
  }
  if (!out.length && parts[0]) out.push(parts[0].replace(/^\d+\s+/, ''));
  return [...new Set(out)];
}

export async function geocodeAddress(
  address: string,
  signal?: AbortSignal,
): Promise<GeocodeResult | null> {
  for (const name of placeCandidates(address)) {
    const url = `${ENDPOINT}?name=${encodeURIComponent(name)}&count=1&language=en&format=json`;
    const res = await fetch(url, { signal });
    if (!res.ok) throw new Error(`geocoding failed (${res.status})`);
    const json = (await res.json()) as {
      results?: Array<{ latitude: number; longitude: number; name: string; timezone?: string }>;
    };
    const hit = json.results?.[0];
    if (hit) {
      return {
        lat: hit.latitude,
        lng: hit.longitude,
        name: hit.name,
        timezone: hit.timezone ?? null,
      };
    }
  }
  return null;
}
