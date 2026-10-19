import { createECDH, randomBytes, randomUUID } from 'node:crypto';
import webpush from 'web-push';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createConsoleSmsTransport, type JobPayloads } from '@sitelog/shared';
import { runWithSignal } from './abort';
import { testConfig, type Config } from './config';
import type { Ctx } from './context';
import { notifyJob } from './jobs/notify';
import { silentLogger } from './log';
import { createWorkerNotifier, workerPushRegistration } from './messaging';
import { startPgliteDatabase, type PgliteDatabase } from './test/pglite';

/**
 * Web push on PGlite (W2-14, spec §19 Q27): the subscription functions field-api calls, the
 * worker's push channel through the `notify` job, the 410 that revokes a subscription and falls
 * back to SMS, and the Demo phone's rows (channel `push`, no phone).
 */

let pg: PgliteDatabase;
let MARCO = '';
let ORG = '';
const MARCO_PHONE = '+15550143378';
const VAPID = webpush.generateVAPIDKeys();
const KEYS: Pick<Config, 'VAPID_PUBLIC_KEY' | 'VAPID_PRIVATE_KEY' | 'VAPID_SUBJECT'> = {
  VAPID_PUBLIC_KEY: VAPID.publicKey,
  VAPID_PRIVATE_KEY: VAPID.privateKey,
  VAPID_SUBJECT: 'mailto:ops@sitelog.test',
};

/** What the mocked push service answers, and what it was asked. */
const service: { status: number; calls: Array<{ url: string; init: RequestInit }> } = {
  status: 201,
  calls: [],
};
const fakeFetch: typeof fetch = async (url, init) => {
  service.calls.push({ url: String(url), init: init ?? {} });
  return new Response(null, {
    status: service.status,
    headers:
      service.status === 201 ? { location: `https://fcm.googleapis.com/m/${randomUUID()}` } : {},
  });
};

function ctxOf(config: Config = testConfig()): Ctx {
  return {
    config,
    db: pg.db,
    notifier: createWorkerNotifier(
      config,
      pg.db,
      () => createConsoleSmsTransport(() => randomUUID()),
      () => new Date(),
      [workerPushRegistration(config, pg.db, fakeFetch)],
    ),
    log: silentLogger,
    now: () => new Date(),
  } as unknown as Ctx;
}

function browserKeys() {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  return {
    p256dh: ecdh.getPublicKey().toString('base64url'),
    auth: randomBytes(16).toString('base64url'),
  };
}

async function subscribe(endpoint = `https://fcm.googleapis.com/fcm/send/${randomUUID()}`) {
  const keys = browserKeys();
  const [row] = await pg.q<{ v: { subscription_id: string; consent_id: string | null } }>(
    `select field_push_subscribe($1, null, $2, $3, $4, 'test-agent', 'v1', '{}'::jsonb) as v`,
    [MARCO, endpoint, keys.p256dh, keys.auth],
  );
  return row!.v;
}

async function draftReady(key: string): Promise<JobPayloads['notify']> {
  return {
    reporterId: MARCO,
    key: 'draft_ready',
    vars: { link: 'https://go.talkolog.com/r/ABCDEF' },
    dedupeKey: `notify:draft_ready:${key}`,
  };
}

async function rows(dedupeKey: string) {
  return pg.q<{
    id: string;
    channel: string;
    provider: string;
    status: string;
    phone_e164: string | null;
    provider_message_id: string | null;
    body: string;
  }>(
    `select id, channel, provider, status, phone_e164, provider_message_id, body from messages
     where reporter_id = $1 and payload->>'dedupe_key' = $2 order by created_at, id`,
    [MARCO, dedupeKey],
  );
}

beforeAll(async () => {
  pg = await startPgliteDatabase({ seed: true });
  const [m] = await pg.q<{ id: string; org_id: string }>(
    `select id, org_id from reporters where phone_e164 = $1`,
    [MARCO_PHONE],
  );
  MARCO = m!.id;
  ORG = m!.org_id;
});

afterAll(async () => {
  await pg?.close();
});

beforeEach(async () => {
  service.status = 201;
  service.calls = [];
  await pg.q(
    `update push_subscriptions set revoked_at = now(), revoked_reason = 'unsubscribed'
     where reporter_id = $1 and revoked_at is null`,
    [MARCO],
  );
  await pg.q(`update orgs set is_demo = true where id = $1`, [ORG]);
  await pg.q(`update countries set sms_sender_id = null where code = 'US'`);
});

describe('web push (W2-14)', () => {
  it('the launch packs list push first, and a pack may never end with it', async () => {
    const packs = await pg.q<{ code: string; message_channels: string }>(
      `select code, message_channels::text from countries order by code`,
    );
    expect(packs.map((p) => [p.code, p.message_channels])).toEqual([
      ['TR', '{push,whatsapp,sms}'],
      ['US', '{push,sms,whatsapp}'],
    ]);
    await expect(
      pg.q(`update countries set message_channels = '{sms,push}' where code = 'US'`),
    ).rejects.toThrow(/check/);
  });

  it('a subscribed demo reporter’s draft_ready is a console push row in the Demo phone', async () => {
    const sub = await subscribe();
    expect(sub.subscription_id).toBeTruthy();
    const payload = await draftReady('push-demo');
    await notifyJob(ctxOf(), payload, {} as never);
    const [row] = await rows(payload.dedupeKey);
    expect(row).toMatchObject({
      channel: 'push',
      provider: 'console',
      status: 'delivered',
      phone_e164: null,
    });
    // The demo org's console row keeps the whole link (the Demo phone opens it).
    expect(row!.body).toContain('https://go.talkolog.com/r/ABCDEF');
    expect(service.calls).toEqual([]);
    // What the Demo phone reads (SupabaseSource.getDemoPhoneThread).
    const thread = await pg.q<{ channel: string }>(
      `select channel from messages where org_id = $1 and reporter_id = $2
         and channel in ('sms', 'push') and id = $3`,
      [ORG, MARCO, row!.id],
    );
    expect(thread).toEqual([{ channel: 'push' }]);
    const consent = await pg.q<{ method: string }>(
      `select method from consents where reporter_id = $1 and type = 'push' and revoked_at is null`,
      [MARCO],
    );
    expect(consent).toEqual([{ method: 'web_checkbox' }]);
  });

  it('a revoked subscription falls back to SMS, and turning notifications off revokes the consent', async () => {
    await subscribe();
    const [r] = await pg.q<{ v: { revoked: number; consent_revoked: boolean } }>(
      `select field_push_unsubscribe($1, null, 'unsubscribed') as v`,
      [MARCO],
    );
    expect(r!.v).toEqual({ revoked: 1, consent_revoked: true });
    const payload = await draftReady('push-revoked');
    await notifyJob(ctxOf(), payload, {} as never);
    expect((await rows(payload.dedupeKey)).map((m) => m.channel)).toEqual(['sms']);
    const audit = await pg.q<{ action: string }>(
      `select action from audit_log where actor_id = $1 and action in ('push.unsubscribed', 'consent.revoked')
       order by id desc limit 2`,
      [MARCO],
    );
    expect(audit.map((a) => a.action).sort()).toEqual(['consent.revoked', 'push.unsubscribed']);
  });

  it('a real org with a key pair: an encrypted request per subscription, the Location as id', async () => {
    await pg.q(`update orgs set is_demo = false where id = $1`, [ORG]);
    await pg.q(`update countries set sms_sender_id = '+18885550142' where code = 'US'`);
    const endpoint = `https://fcm.googleapis.com/fcm/send/${randomUUID()}`;
    await subscribe(endpoint);
    const payload = await draftReady('push-real');
    await notifyJob(ctxOf(testConfig(KEYS)), payload, {} as never);
    const [row] = await rows(payload.dedupeKey);
    expect(row).toMatchObject({
      channel: 'push',
      provider: 'webpush',
      status: 'sent',
      phone_e164: null,
    });
    expect(row!.provider_message_id).toMatch(/^https:\/\/fcm\.googleapis\.com\/m\//);
    // A real org's row is masked; the notification itself carried the link (encrypted).
    expect(row!.body).not.toContain('ABCDEF');
    expect(service.calls).toHaveLength(1);
    const call = service.calls[0]!;
    expect(call.url).toBe(endpoint);
    const headers = call.init.headers as Record<string, string>;
    expect(headers['Content-Encoding']).toBe('aes128gcm');
    expect(headers.TTL).toBe(String(4 * 60 * 60));
    expect(headers.Authorization).toMatch(new RegExp(`^vapid t=.+, k=${VAPID.publicKey}$`));
    expect(JSON.stringify(call.init.body)).not.toContain('ABCDEF');
  });

  it('a push service that keeps failing: retried, then SMS once on the third run (W2-14 review)', async () => {
    await pg.q(`update orgs set is_demo = false where id = $1`, [ORG]);
    await pg.q(`update countries set sms_sender_id = '+18885550142' where code = 'US'`);
    await subscribe();
    service.status = 503;
    const payload = await draftReady('push-503-bounded');
    const ctx = ctxOf(testConfig(KEYS));
    const run = (attempt: number) =>
      runWithSignal(
        new AbortController().signal,
        () => notifyJob(ctx, payload, {} as never),
        attempt,
      );
    for (const attempt of [1, 2]) {
      await expect(run(attempt), `run ${attempt}`).rejects.toThrow(/503/);
      expect((await rows(payload.dedupeKey)).map((m) => [m.channel, m.status])).toEqual([
        ['push', 'failed'],
      ]);
    }
    await run(3);
    expect((await rows(payload.dedupeKey)).map((m) => [m.channel, m.status])).toEqual([
      ['push', 'undeliverable'],
      ['sms', 'sent'],
    ]);
    // A later run (a redelivery) sends nothing more on any channel.
    await run(4);
    expect(await rows(payload.dedupeKey)).toHaveLength(2);
    expect(service.calls).toHaveLength(3);
  });

  it('410 Gone revokes the subscription (audited) and the message falls back to SMS', async () => {
    await pg.q(`update orgs set is_demo = false where id = $1`, [ORG]);
    await pg.q(`update countries set sms_sender_id = '+18885550142' where code = 'US'`);
    const sub = await subscribe();
    service.status = 410;
    const payload = await draftReady('push-gone');
    await notifyJob(ctxOf(testConfig(KEYS)), payload, {} as never);
    expect((await rows(payload.dedupeKey)).map((m) => [m.channel, m.status])).toEqual([
      ['push', 'undeliverable'],
      ['sms', 'sent'],
    ]);
    const [s] = await pg.q<{ revoked_reason: string }>(
      `select revoked_reason from push_subscriptions where id = $1`,
      [sub.subscription_id],
    );
    expect(s!.revoked_reason).toBe('gone');
    const gone = await pg.q(
      `select 1 from audit_log where action = 'push.subscription_gone' and entity_id = $1`,
      [sub.subscription_id],
    );
    expect(gone).toHaveLength(1);
    // The consent stays: the person did not turn notifications off.
    const consent = await pg.q(
      `select 1 from consents where reporter_id = $1 and type = 'push' and revoked_at is null`,
      [MARCO],
    );
    expect(consent).toHaveLength(1);
  });

  it('a real org without a key pair: push leaves the order, SMS carries the message', async () => {
    await pg.q(`update orgs set is_demo = false where id = $1`, [ORG]);
    await pg.q(`update countries set sms_sender_id = '+18885550142' where code = 'US'`);
    await subscribe();
    const payload = await draftReady('push-nokeys');
    await notifyJob(ctxOf(), payload, {} as never);
    expect((await rows(payload.dedupeKey)).map((m) => m.channel)).toEqual(['sms']);
    expect(service.calls).toEqual([]);
  });

  it('a 5xx retries push (the job retries); nothing falls back yet', async () => {
    await pg.q(`update orgs set is_demo = false where id = $1`, [ORG]);
    await pg.q(`update countries set sms_sender_id = '+18885550142' where code = 'US'`);
    await subscribe();
    service.status = 503;
    const payload = await draftReady('push-503');
    await expect(notifyJob(ctxOf(testConfig(KEYS)), payload, {} as never)).rejects.toThrow(/503/);
    expect((await rows(payload.dedupeKey)).map((m) => [m.channel, m.status])).toEqual([
      ['push', 'failed'],
    ]);
  });

  it('signing a phone out stops its push but keeps the consent; a subscription is per device', async () => {
    await subscribe();
    const [r] = await pg.q<{ v: { revoked: number; consent_revoked: boolean } }>(
      `select field_push_unsubscribe($1, null, 'signed_out') as v`,
      [MARCO],
    );
    expect(r!.v).toEqual({ revoked: 1, consent_revoked: false });
    await expect(pg.q(`select field_push_unsubscribe($1, null, 'gone')`, [MARCO])).rejects.toThrow(
      /invalid_status/,
    );
  });
});
