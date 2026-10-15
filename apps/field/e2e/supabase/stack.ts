import { LINK_CODE_ALPHABET, linkCodeHash } from '@sitelog/shared/links.ts';
import { FIELD_PREVIEW_PORT } from '../../config/server.ts';

/**
 * The local Supabase stack for the field app's `e2e:supabase` (W1-09): names as `supabase status
 * -o env` prints them, so locally
 *   set -a; eval "$(supabase status -o env)"; set +a
 *   pnpm --filter @sitelog/field e2e:supabase
 * Rows are arranged and checked through PostgREST with the service role (no extra client library);
 * the app itself only ever calls field-api.
 */
export const API_URL = (process.env.API_URL ?? 'http://127.0.0.1:54321').replace(/\/+$/, '');
const SERVICE_ROLE_KEY = process.env.SERVICE_ROLE_KEY ?? '';

/**
 * The preview server's own port (4176), next to the smoke test's 4175: field-api accepts its
 * origin only when `supabase/functions/.env` lists it (CI: CORS_EXTRA_ORIGINS).
 */
export const FIELD_E2E_PORT = FIELD_PREVIEW_PORT + 2;
export const FIELD_E2E_URL = `http://localhost:${FIELD_E2E_PORT}`;

/** A PostgREST call as the service role; throws with the answer's text on a non-2xx status. */
export async function rest<T = unknown>(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  path: string,
  body?: unknown,
): Promise<T> {
  if (!SERVICE_ROLE_KEY) {
    throw new Error('SERVICE_ROLE_KEY is not set: export the output of `supabase status -o env`');
  }
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

/** A PostgREST `in.(…)` list, each value quoted (phone numbers carry `+`). */
export function inList(values: readonly string[]): string {
  return `in.(${values.map((v) => `"${v}"`).join(',')})`;
}

function randomCode(length = 8): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, (b) => LINK_CODE_ALPHABET[b % LINK_CODE_ALPHABET.length]).join('');
}

export interface FieldFixture {
  orgId: string;
  site: { id: string; name: string; projectCode: string };
  reporter: { id: string; name: string; firstName: string; phone: string };
  /** The personal link's code (`/r/{code}`); only its hash is stored, as for real links. */
  code: string;
}

/**
 * A demo org of its own (field-api writes a demo org's device code as a console text, which the
 * spec reads like the Demo phone does), one site and an invited reporter with a personal link,
 * so the run never touches the §18 seed the panel specs read.
 */
export async function createFieldFixture(): Promise<FieldFixture> {
  const stamp = Date.now();
  const [org] = await rest<{ id: string }[]>('POST', 'orgs', {
    name: `e2e:field ${stamp}`,
    is_demo: true,
  });
  const projectCode = 'FE-1';
  const [site] = await rest<{ id: string; name: string }[]>('POST', 'sites', {
    org_id: org!.id,
    name: 'Riverside Lofts — Block B',
    project_code: projectCode,
    timezone: 'America/Chicago',
    deadline: '17:30',
  });
  const phone = `+1555${String(Math.floor(Math.random() * 9_000_000) + 1_000_000)}`;
  const [reporter] = await rest<{ id: string }[]>('POST', 'reporters', {
    org_id: org!.id,
    name: 'Marco Ruiz',
    phone_e164: phone,
    locale: 'en-US',
    contact_pref: 'link',
  });
  await rest('POST', 'site_reporters', {
    site_id: site!.id,
    reporter_id: reporter!.id,
    is_primary: true,
  });
  const code = randomCode();
  await rest('POST', 'field_links', {
    code_hash: linkCodeHash(code),
    reporter_id: reporter!.id,
    kind: 'personal',
  });
  return {
    orgId: org!.id,
    site: { id: site!.id, name: site!.name, projectCode },
    reporter: { id: reporter!.id, name: 'Marco Ruiz', firstName: 'Marco', phone },
    code,
  };
}

/**
 * Removes the fixture's rows (as `supabase/db-tests/stack/field-api.test.ts` does): the rows
 * without ON DELETE first (jobs, report sources, uploads, links), then the org with the rest.
 * Every step runs even when one fails; the first error is thrown at the end.
 */
export async function dropFieldFixture(f: FieldFixture | undefined): Promise<void> {
  if (!f) return;
  const uploads = await rest<{ id: string; report_id: string | null }[]>(
    'GET',
    `uploads?select=id,report_id&site_id=eq.${f.site.id}`,
  ).catch(() => []);
  const uploadIds = uploads.map((u) => u.id);
  const reportIds = [...new Set(uploads.map((u) => u.report_id).filter((r): r is string => !!r))];
  const devices = await rest<{ id: string }[]>(
    'GET',
    `field_devices?select=id&reporter_id=eq.${f.reporter.id}`,
  ).catch(() => []);
  const steps: (() => Promise<unknown>)[] = [];
  if (uploadIds.length)
    steps.push(() => rest('DELETE', `jobs?payload->>uploadId=${inList(uploadIds)}`));
  if (reportIds.length)
    steps.push(() => rest('DELETE', `jobs?payload->>reportId=${inList(reportIds)}`));
  steps.push(() =>
    rest(
      'DELETE',
      `rate_limits?key=${inList([
        `code_send:${f.reporter.phone}`,
        `code:${f.reporter.phone}`,
        ...devices.map((d) => `dev:${d.id}`),
      ])}`,
    ),
  );
  if (uploadIds.length) {
    steps.push(() => rest('DELETE', `report_sources?upload_id=${inList(uploadIds)}`));
    steps.push(() => rest('DELETE', `uploads?id=${inList(uploadIds)}`));
  }
  steps.push(() => rest('DELETE', `field_links?reporter_id=eq.${f.reporter.id}`));
  steps.push(() => rest('DELETE', `orgs?id=eq.${f.orgId}`));
  let first: unknown = null;
  for (const step of steps) {
    try {
      await step();
    } catch (err) {
      first ??= err;
    }
  }
  if (first) throw first;
}
