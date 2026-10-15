/**
 * Field links (§6.3 `field_links`, §9.3 `/r/:code`): the short code a reporter gets by SMS and
 * what the database keeps of it.
 *
 * - The code itself is never stored: `field_links.code_hash` is the SHA-256 of the code, as lower
 *   case hex (§6.3 "sha256 of the short code"). `field-api` (W1-07) resolves `/r/:code` by hashing
 *   the code it is given with `linkCodeHash()` and looking the hash up; the demo seed
 *   (`demo/kestrel.ts`, `demo/demir.ts`) stores its links the same way.
 * - Codes are upper case and read back from an SMS, so the hash is taken of the trimmed, upper case
 *   code: `k7q2mx` and `K7Q2MX` are the same link.
 * - The SMS link is `{FIELD_APP_URL}/r/{code}` until the `sl.link` short domain exists (GAP §8 Q7).
 * - A personal link's code is derived from its id under LINK_SIGNING_SECRET (`deriveLinkCode`,
 *   W1-08), so the service can text the same link again; demo links keep their seeded codes.
 *
 * - Expiry by kind: a personal link never expires; a daily link after `DAILY_LINK_TTL_HOURS` (§5.1,
 *   default 72); a photos link at 23:59 of the day after its report date in the site's time zone
 *   (F9), whatever the TTL.
 *
 * Pure (Node, browser, Deno). The hash is a small synchronous SHA-256 over UTF-8, so builders of
 * demo rows need no async WebCrypto; only `deriveLinkCode` (an HMAC) uses WebCrypto. Not for
 * secrets that need constant-time handling.
 */
import { fromZonedTime } from 'date-fns-tz';
import { addDays } from './format.ts';

/** Daily links expire after this many hours unless the env says otherwise (§5.1 `DAILY_LINK_TTL_HOURS`). */
export const DAILY_LINK_TTL_HOURS_DEFAULT = 72;

/**
 * F9: when a photos link (`kind='photos'`) expires: 23:59 of the day after the report's date
 * (`YYYY-MM-DD`), local time in the site's time zone, as an ISO instant.
 */
export function photosLinkExpiresAt(reportDate: string, tz: string): string {
  return fromZonedTime(`${addDays(reportDate, 1)}T23:59:00`, tz).toISOString();
}

/** The characters of a link code: no 0/O, 1/I/L or U, so a code read aloud or retyped survives. */
export const LINK_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ23456789';

/** The normalised form a code is hashed in: trimmed, upper case. */
export function normalizeLinkCode(code: string): string {
  return code.trim().toUpperCase();
}

/** `field_links.code_hash` for a code: SHA-256 (hex) of the normalised code. */
export function linkCodeHash(code: string): string {
  return sha256Hex(normalizeLinkCode(code));
}

/** The link an SMS carries: `{base}/r/{code}` (base = FIELD_APP_URL, or the short domain later). */
export function fieldLinkUrl(base: string, code: string): string {
  return `${base.replace(/\/+$/, '')}/r/${normalizeLinkCode(code)}`;
}

/**
 * The Filed-screen link of the `filed` text (§9.2 `{pdf_link}`, F8; W1-15):
 * `{base}/r/{code}/report/{id}`. The field app resolves the link, then opens the report, whose
 * view carries a freshly signed PDF URL, so the text never holds a link that expires.
 */
export function fieldReportLinkUrl(base: string, code: string, reportId: string): string {
  return `${fieldLinkUrl(base, code)}/report/${encodeURIComponent(reportId)}`;
}

/**
 * Characters of a personal link's derived code: 12 of the 30-character alphabet, about 2^59
 * (spec §19 Q42, decided by the owner 2026-10-15: "longer codes for personal links" before real
 * reporters; 6 characters were about 7 × 10^8). A personal link derived at 6 before this change
 * keeps working until it is revoked; the next invite, re-send or HELP finds no link whose code it
 * can derive and issues a 12-character one (`ensurePersonalLink`). Seeded demo codes stay 6
 * (`demoLinkCode`).
 */
export const LINK_CODE_LENGTH = 12;

/** What `messages.body` shows instead of a code (`maskFieldLinkUrl`, `MASKED_CODE`). */
export const MASKED_CODE = '••••••';

/**
 * A field link with its code masked: `https://go.sitelog.app/r/K7Q2MX` → `…/r/••••••`, also a
 * Filed-screen link (`/r/{code}/report/{id}`). A text without `/r/` is returned unchanged.
 * The Notifier stores texts this way unless the console transport writes them for a demo org
 * (spec §4.5; docs/AUDIT_BACKLOG.md "Office users can read reporters' device codes and personal
 * links"), so an office user who reads `messages` cannot open a reporter's link.
 */
export function maskFieldLinkUrl(url: string): string {
  return url.replace(/\/r\/[^/?#\s]+/g, `/r/${MASKED_CODE}`);
}

/**
 * A personal link's code, derived from its row id (W1-08): HMAC-SHA-256 of
 * `sitelog/field_link/v1/<id>` under LINK_SIGNING_SECRET, mapped to LINK_CODE_ALPHABET by
 * rejection sampling (a byte under 240 picks `byte % 30`, so every character is equally likely).
 * The code is still never stored (`field_links.code_hash` is its SHA-256), but whoever holds the
 * secret (field-api, sms-webhook, api-invite-reporter, the worker) can text the same link again:
 * the welcome, its re-send and the HELP reply all carry it. A link whose hash does not match its
 * derived code (a seeded link, or a rotated secret) is never re-sent; `ensurePersonalLink` issues
 * a new one. WebCrypto, so Node, Deno and browsers share it.
 */
export async function deriveLinkCode(
  secret: string,
  linkId: string,
  length: number = LINK_CODE_LENGTH,
): Promise<string> {
  if (!secret) throw new Error('deriveLinkCode needs LINK_SIGNING_SECRET');
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const limit = Math.floor(256 / LINK_CODE_ALPHABET.length) * LINK_CODE_ALPHABET.length;
  let code = '';
  for (let round = 0; code.length < length; round++) {
    const label =
      round === 0 ? `sitelog/field_link/v1/${linkId}` : `sitelog/field_link/v1/${linkId}/${round}`;
    const bytes = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(label)));
    for (const b of bytes) {
      if (b >= limit) continue;
      code += LINK_CODE_ALPHABET[b % LINK_CODE_ALPHABET.length];
      if (code.length === length) break;
    }
  }
  return code;
}

/** What `ensurePersonalLink` reads and writes (field-api, api-invite-reporter, sms-webhook, worker). */
export interface PersonalLinkStore {
  /** The reporter's personal links that are not revoked, newest first. */
  listPersonalLinks(reporterId: string): Promise<Array<{ id: string; code_hash: string }>>;
  /** Inserts a `kind 'personal'` row; false when its code_hash is taken (unique), nothing written. */
  insertPersonalLink(row: { id: string; code_hash: string; reporter_id: string }): Promise<boolean>;
}

/**
 * The reporter's personal link (F2, F3, §6.3 `field_links`), and its code: the newest live personal
 * link whose code can be derived again (`deriveLinkCode`), else a new row. One link serves every
 * text that carries "your link" (welcome, re-send, HELP), so the reporter's home-screen link keeps
 * working; revoking stays an office action (F16).
 */
export async function ensurePersonalLink(
  store: PersonalLinkStore,
  secret: string,
  reporterId: string,
  newId: () => string,
): Promise<{ id: string; code: string; created: boolean }> {
  for (const link of await store.listPersonalLinks(reporterId)) {
    const code = await deriveLinkCode(secret, link.id);
    if (linkCodeHash(code) === link.code_hash) return { id: link.id, code, created: false };
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    const id = newId();
    const code = await deriveLinkCode(secret, id);
    if (
      await store.insertPersonalLink({ id, code_hash: linkCodeHash(code), reporter_id: reporterId })
    )
      return { id, code, created: true };
  }
  throw new Error(`Could not issue a personal link for reporter ${reporterId}`);
}

/** When a daily link made at `now` expires: `ttlHours` later (§5.1 `DAILY_LINK_TTL_HOURS`). */
export function dailyLinkExpiresAt(
  now: Date,
  ttlHours: number = DAILY_LINK_TTL_HOURS_DEFAULT,
): string {
  const hours = Number.isFinite(ttlHours) && ttlHours > 0 ? ttlHours : DAILY_LINK_TTL_HOURS_DEFAULT;
  return new Date(now.getTime() + hours * 3_600_000).toISOString();
}

/** A daily link row as `ensureDailyLink` reads it. */
export interface DailyLinkRow {
  id: string;
  code_hash: string;
  expires_at: string | null;
}

/** What `ensureDailyLink` reads and writes (api-text-daily-link; the M6 ladder later). */
export interface DailyLinkStore {
  /** The reporter's daily links for that site and report date that are not revoked, newest first. */
  listDailyLinks(reporterId: string, siteId: string, reportDate: string): Promise<DailyLinkRow[]>;
  /** Inserts a `kind 'daily'` row; false when its code_hash is taken (unique), nothing written. */
  insertDailyLink(row: {
    id: string;
    code_hash: string;
    reporter_id: string;
    site_id: string;
    report_date: string;
    expires_at: string;
  }): Promise<boolean>;
}

/**
 * The reporter's daily link for one site and report date (§6.3 `field_links` kind `daily`, F11,
 * F17 "Text today's link"), and its code: the newest live one (not expired at `now`) whose code can
 * be derived again (`deriveLinkCode`, as personal links), else a new row expiring at `expiresAt`.
 * So texting today's link twice sends the same link, and a link the ladder sends later is the one
 * the office already texted.
 */
export async function ensureDailyLink(
  store: DailyLinkStore,
  secret: string,
  input: { reporterId: string; siteId: string; reportDate: string; expiresAt: string; now: Date },
  newId: () => string,
): Promise<{ id: string; code: string; created: boolean; expiresAt: string }> {
  const live = (
    await store.listDailyLinks(input.reporterId, input.siteId, input.reportDate)
  ).filter((l) => l.expires_at === null || Date.parse(l.expires_at) > input.now.getTime());
  for (const link of live) {
    const code = await deriveLinkCode(secret, link.id);
    if (linkCodeHash(code) === link.code_hash)
      return { id: link.id, code, created: false, expiresAt: link.expires_at ?? input.expiresAt };
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    const id = newId();
    const code = await deriveLinkCode(secret, id);
    const inserted = await store.insertDailyLink({
      id,
      code_hash: linkCodeHash(code),
      reporter_id: input.reporterId,
      site_id: input.siteId,
      report_date: input.reportDate,
      expires_at: input.expiresAt,
    });
    if (inserted) return { id, code, created: true, expiresAt: input.expiresAt };
  }
  throw new Error(`Could not issue a daily link for reporter ${input.reporterId}`);
}

// ───────────────────────────── SHA-256 (FIPS 180-4) ─────────────────────────────

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));

/** SHA-256 of a string's UTF-8 bytes, as 64 lower case hex characters. */
export function sha256Hex(text: string): string {
  const bytes = new TextEncoder().encode(text);
  const bitLength = bytes.length * 8;
  // Message + 0x80 + zero padding + 64-bit big-endian length, to a multiple of 64 bytes.
  const total = Math.ceil((bytes.length + 9) / 64) * 64;
  const msg = new Uint8Array(total);
  msg.set(bytes);
  msg[bytes.length] = 0x80;
  const view = new DataView(msg.buffer);
  view.setUint32(total - 8, Math.floor(bitLength / 0x1_0000_0000));
  view.setUint32(total - 4, bitLength >>> 0);

  const h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const w = new Uint32Array(64);
  for (let off = 0; off < total; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4);
    for (let i = 16; i < 64; i++) {
      const w15 = w[i - 15]!;
      const w2 = w[i - 2]!;
      const s0 = rotr(w15, 7) ^ rotr(w15, 18) ^ (w15 >>> 3);
      const s1 = rotr(w2, 17) ^ rotr(w2, 19) ^ (w2 >>> 10);
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, hh] = [h[0]!, h[1]!, h[2]!, h[3]!, h[4]!, h[5]!, h[6]!, h[7]!];
    for (let i = 0; i < 64; i++) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + s1 + ch + K[i]! + w[i]!) >>> 0;
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (s0 + maj) >>> 0;
      hh = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    h[0] = (h[0]! + a) >>> 0;
    h[1] = (h[1]! + b) >>> 0;
    h[2] = (h[2]! + c) >>> 0;
    h[3] = (h[3]! + d) >>> 0;
    h[4] = (h[4]! + e) >>> 0;
    h[5] = (h[5]! + f) >>> 0;
    h[6] = (h[6]! + g) >>> 0;
    h[7] = (h[7]! + hh) >>> 0;
  }
  return Array.from(h, (x) => x.toString(16).padStart(8, '0')).join('');
}
