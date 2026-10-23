/**
 * Playwright global setup of the `e2e:supabase` suites (the panel's config and this one): the SMS
 * order on the local stack's country packs for the run, then the packs as they were.
 *
 * §19 Q374 (2026-10-23, 20261023000100_whatsapp_only.sql): SMS is passive in every pack, which
 * orders push and WhatsApp only. SMS stays built for the forward migration that switches it back
 * on, and these suites drive its paths end to end (the welcome and the device code through the SMS
 * stand-in, the Demo phone's texts, HELP / STOP / START, the reminder ladder's texts), so for the
 * run every pack gets its order before Q374, `{push, whatsapp, sms}`. A local stack only (the
 * API URL on this machine or the runner); the teardown puts each pack's order back.
 */
const API_URL = (process.env.API_URL ?? 'http://127.0.0.1:54321').replace(/\/+$/, '');
const SERVICE_ROLE_KEY = process.env.SERVICE_ROLE_KEY ?? '';

/** The packs' order before §19 Q374 (20261020000100_whatsapp_first.sql). */
export const E2E_SMS_ORDER = ['push', 'whatsapp', 'sms'] as const;

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]', 'host.docker.internal']);

async function rest<T>(method: 'GET' | 'PATCH', path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API_URL}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: SERVICE_ROLE_KEY,
      authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      'content-type': 'application/json',
      prefer: 'return=representation',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path}: HTTP ${res.status} ${text}`);
  return (text ? JSON.parse(text) : null) as T;
}

type PackOrder = { code: string; message_channels: string[] };

export default async function globalSetup(): Promise<(() => Promise<void>) | undefined> {
  if (!LOCAL_HOSTS.has(new URL(API_URL).hostname)) {
    throw new Error(`e2e:supabase changes the country packs of a local stack only, not ${API_URL}`);
  }
  // Without the key the specs fail on their own with the hint to export `supabase status -o env`.
  if (!SERVICE_ROLE_KEY) return undefined;
  const before = await rest<PackOrder[]>('GET', 'countries?select=code,message_channels');
  const toChange = before.filter((p) => !p.message_channels.includes('sms'));
  for (const p of toChange) {
    await rest('PATCH', `countries?code=eq.${p.code}`, { message_channels: [...E2E_SMS_ORDER] });
  }
  return async () => {
    for (const p of toChange) {
      await rest('PATCH', `countries?code=eq.${p.code}`, { message_channels: p.message_channels });
    }
  };
}
