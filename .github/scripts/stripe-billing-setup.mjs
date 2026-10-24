// Stripe test mode for the preview project (deploy.yml, target billing-setup, owner-dispatched).
// Idempotent: finds or creates the TalkOlog site Product (metadata sitelog=site) and its monthly USD
// per-unit price (lookup key sitelog_site_usd_monthly, 39900), and replaces the webhook endpoint for
// WEBHOOK_URL (a signing secret cannot be read back, so the endpoint is deleted and created anew each
// run) with exactly the events stripe-webhook handles (HANDLED_EVENTS in its logic.ts). Plain
// fetch, no dependencies.
//
// In:  STRIPE_SECRET_KEY (sk_test_ only), WEBHOOK_URL, WEBHOOK_API_VERSION, OUT_ENV, OUT_JSON.
// Out: OUT_ENV (mode 600) holds STRIPE_WEBHOOK_SECRET and STRIPE_PRICE_ID_SITE_US as KEY=value lines
//      for `supabase secrets set --env-file`; OUT_JSON holds the ids for the run summary (no
//      secret). The webhook secret is masked (::add-mask::) before anything else can print it.
// `--summary <OUT_JSON>` appends the run summary (ids and names, no secret) to GITHUB_STEP_SUMMARY.
import { appendFileSync, chmodSync, readFileSync, writeFileSync } from 'node:fs';

const LOOKUP_KEY = 'sitelog_site_usd_monthly';
const AMOUNT = 39900;
const CURRENCY = 'usd';
const PRODUCT_NAME = 'TalkOlog site';

if (process.argv[2] === '--summary') {
  const j = JSON.parse(readFileSync(process.argv[3], 'utf8'));
  const ref = process.env.SUPABASE_PROJECT_REF;
  const lines = [
    '### Billing (Stripe test mode) on the preview project',
    '',
    `- Product \`${j.productId}\` (${j.productCreated ? 'created' : 'kept'}); price \`${j.priceId}\` (USD 399.00 a site a month, ${j.priceCreated ? 'created' : 'kept'}).`,
    `- Webhook endpoint \`${j.endpointId}\` for \`https://${ref}.supabase.co/functions/v1/stripe-webhook\` (API version ${j.endpointApiVersion ?? 'the account default'}), events: ${j.events.join(', ')}.` +
      (j.deletedEndpoints.length ? ` It replaces ${j.deletedEndpoints.join(', ')}.` : ''),
    `- Function secrets set on \`${ref}\` (names only): ${process.env.BILLING_FUNCTION_SECRETS}.`,
    '- The worker of the preview-worker target gets STRIPE_SECRET_KEY from the preview Environment (its billing_sync job).',
    '',
    j.portalConfigured
      ? 'Customer portal: a default configuration exists.'
      : "**Left for you in the Stripe Dashboard** (test mode), once: Settings → Billing → Customer portal → Save (payment method updates and invoice history on, quantity changes off). Until then Billing's Update payment method fails.",
    '',
    'Then send a test event to the endpoint from the Dashboard: 200 means the signature passed.',
  ];
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${lines.join('\n')}\n`);
  process.exit(0);
}

const key = process.env.STRIPE_SECRET_KEY ?? '';
const webhookUrl = process.env.WEBHOOK_URL ?? '';
const apiVersion = process.env.WEBHOOK_API_VERSION ?? '';
const outEnv = process.env.OUT_ENV ?? '';
const outJson = process.env.OUT_JSON ?? '';

function fail(message) {
  console.log(`::error::${message}`);
  process.exit(1);
}

if (!key.startsWith('sk_test_'))
  fail('STRIPE_SECRET_KEY is not a test-mode secret key (sk_test_…); refusing.');
if (!/^https:\/\/[a-z0-9]+\.supabase\.co\/functions\/v1\/stripe-webhook$/.test(webhookUrl))
  fail('WEBHOOK_URL is not a Supabase stripe-webhook URL.');
if (!outEnv || !outJson) fail('OUT_ENV and OUT_JSON are required.');

/** The events stripe-webhook handles, read from its source so the endpoint never drifts from it. */
function handledEvents(source) {
  const block = /export const HANDLED_EVENTS = \[([\s\S]*?)\]/.exec(source)?.[1] ?? '';
  return [...block.matchAll(/'([a-z_.]+)'/g)].map((m) => m[1]);
}
const events = handledEvents(
  readFileSync(
    new URL('../../supabase/functions/stripe-webhook/logic.ts', import.meta.url),
    'utf8',
  ),
);
if (events.length === 0)
  fail('No HANDLED_EVENTS found in supabase/functions/stripe-webhook/logic.ts.');

/** Stripe's form encoding: nested objects and arrays as a[b]=… and a[]=…. */
function form(params, prefix = '', out = new URLSearchParams()) {
  for (const [k, v] of Object.entries(params)) {
    const name = prefix ? `${prefix}[${k}]` : k;
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) for (const item of v) out.append(`${name}[]`, String(item));
    else if (typeof v === 'object') form(v, name, out);
    else out.append(name, String(v));
  }
  return out;
}

async function stripe(method, path, params = {}, extraHeaders = {}) {
  const body = form(params);
  const url = `https://api.stripe.com/v1/${path}${method === 'GET' && body.size ? `?${body}` : ''}`;
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${key}`,
      ...(method === 'GET' ? {} : { 'Content-Type': 'application/x-www-form-urlencoded' }),
      ...extraHeaders,
    },
    body: method === 'GET' ? undefined : body,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    // Stripe's error message names the parameter, never the key.
    fail(
      `Stripe ${method} /v1/${path.split('?')[0]} answered ${res.status}: ${json?.error?.message ?? 'no message'}`,
    );
  }
  return json;
}

// ── Product ──
const products = await stripe('GET', 'products', { active: true, limit: 100 });
let product = products.data.find((p) => p.metadata?.sitelog === 'site');
let productCreated = false;
if (!product) {
  product = await stripe('POST', 'products', {
    name: PRODUCT_NAME,
    metadata: { sitelog: 'site' },
  });
  productCreated = true;
}

// ── Price ──
const prices = await stripe('GET', 'prices', {
  lookup_keys: [LOOKUP_KEY],
  active: true,
  limit: 10,
});
const fits = (p) =>
  p.unit_amount === AMOUNT &&
  p.currency === CURRENCY &&
  p.type === 'recurring' &&
  p.recurring?.interval === 'month' &&
  p.recurring?.interval_count === 1 &&
  p.recurring?.usage_type === 'licensed' &&
  p.billing_scheme === 'per_unit' &&
  p.product === product.id;
let price = prices.data.find(fits);
let priceCreated = false;
if (!price) {
  // A price under the lookup key with another amount (or product) loses the key to the new one.
  price = await stripe('POST', 'prices', {
    product: product.id,
    currency: CURRENCY,
    unit_amount: AMOUNT,
    billing_scheme: 'per_unit',
    recurring: { interval: 'month', interval_count: 1, usage_type: 'licensed' },
    lookup_key: LOOKUP_KEY,
    transfer_lookup_key: true,
    nickname: 'TalkOlog site, monthly, per active site',
  });
  priceCreated = true;
}

// ── Webhook endpoint: a new one on this URL, then the older ones on it deleted ──
const endpoints = await stripe('GET', 'webhook_endpoints', { limit: 100 });
const endpoint = await stripe('POST', 'webhook_endpoints', {
  url: webhookUrl,
  enabled_events: events,
  description: 'TalkOlog preview: stripe-webhook (deploy.yml billing-setup)',
  metadata: { sitelog: 'preview' },
  ...(apiVersion ? { api_version: apiVersion } : {}),
});
if (!endpoint.secret) fail('Stripe returned no signing secret for the new webhook endpoint.');
console.log(`::add-mask::${endpoint.secret}`);
const deleted = [];
for (const e of endpoints.data.filter((e) => e.url === webhookUrl && e.id !== endpoint.id)) {
  await stripe('DELETE', `webhook_endpoints/${e.id}`);
  deleted.push(e.id);
}

// ── Customer portal: a default configuration exists once it is saved in the Dashboard ──
const portal = await stripe('GET', 'billing_portal/configurations', {
  is_default: true,
  active: true,
  limit: 1,
});

writeFileSync(
  outEnv,
  `STRIPE_WEBHOOK_SECRET=${endpoint.secret}\nSTRIPE_PRICE_ID_SITE_US=${price.id}\n`,
  { mode: 0o600 },
);
chmodSync(outEnv, 0o600);
writeFileSync(
  outJson,
  JSON.stringify({
    productId: product.id,
    productCreated,
    priceId: price.id,
    priceCreated,
    endpointId: endpoint.id,
    endpointApiVersion: endpoint.api_version ?? null,
    events,
    deletedEndpoints: deleted,
    portalConfigured: portal.data.length > 0,
  }),
);
console.log(
  `Product ${product.id} (${productCreated ? 'created' : 'kept'}), price ${price.id} (${priceCreated ? 'created' : 'kept'}), webhook endpoint ${endpoint.id} (replaced ${deleted.length}), portal ${portal.data.length > 0 ? 'configured' : 'not configured'}.`,
);
