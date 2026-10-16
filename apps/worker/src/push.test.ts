import { createECDH, randomBytes, randomUUID } from 'node:crypto';
import webpush from 'web-push';
import { describe, expect, it } from 'vitest';
import { assertE164, MessageSendError, type OutboundMessage } from '@sitelog/shared';
import { runWithSignal } from './abort';
import {
  createPushRegistration,
  PUSH_MAX_ATTEMPTS,
  vapidConfigured,
  webPushTransport,
  type PushDeps,
  type PushStore,
} from './push';

const VAPID = webpush.generateVAPIDKeys();
const config = {
  VAPID_PUBLIC_KEY: VAPID.publicKey,
  VAPID_PRIVATE_KEY: VAPID.privateKey,
  VAPID_SUBJECT: 'mailto:ops@sitelog.test',
};

function sub(id: string) {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  return {
    id,
    endpoint: `https://fcm.googleapis.com/fcm/send/${id}`,
    p256dh: ecdh.getPublicKey().toString('base64url'),
    auth: randomBytes(16).toString('base64url'),
  };
}

const MESSAGE: OutboundMessage = {
  to: assertE164('+15550143378'),
  reporterId: 'r-1',
  body: 'One question about today: https://go.sitelog.app/r/ABCDEF',
  key: 'question_ready',
  language: 'en',
  vars: { link: 'https://go.sitelog.app/r/ABCDEF' },
};

function setup(
  subs: ReturnType<typeof sub>[],
  answer: (
    url: string,
    init: RequestInit | undefined,
  ) => number | { status: number; body: string } | Error | Promise<number>,
  requests: Array<{ url: string; init: RequestInit | undefined }> = [],
  extra: Partial<Pick<PushDeps, 'attempt' | 'timeoutMs'>> = {},
) {
  const gone: Array<[string, number]> = [];
  const store: PushStore = {
    listLivePushSubscriptions: async () => subs,
    pushSubscriptionGone: async (id, status) => {
      gone.push([id, status]);
      return true;
    },
  };
  const fetchImpl: typeof fetch = async (url, init) => {
    requests.push({ url: String(url), init });
    const a = await answer(String(url), init);
    if (a instanceof Error) throw a;
    if (typeof a === 'object') return new Response(a.body, { status: a.status });
    return new Response(null, { status: a });
  };
  const transport = webPushTransport({ config, store, fetch: fetchImpl, randomUUID, ...extra });
  return { transport, gone };
}

const refusal = async (p: Promise<unknown>) => {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(MessageSendError);
  return err as MessageSendError;
};

describe('web push transport (W2-14)', () => {
  it('needs all three VAPID values', () => {
    expect(vapidConfigured(config)).toBe(true);
    expect(vapidConfigured({ ...config, VAPID_SUBJECT: ' ' })).toBe(false);
    expect(vapidConfigured({ ...config, VAPID_PRIVATE_KEY: '' })).toBe(false);
  });

  it('refuses a malformed key pair before any send', () => {
    expect(() =>
      webPushTransport({
        config: { ...config, VAPID_PRIVATE_KEY: 'nope' },
        store: {
          listLivePushSubscriptions: async () => [],
          pushSubscriptionGone: async () => false,
        },
        fetch,
        randomUUID,
      }),
    ).toThrow();
  });

  it('one phone of two delivered is a sent message; the gone one is revoked', async () => {
    const { transport, gone } = setup([sub('a'), sub('b')], (url) =>
      url.endsWith('/a') ? 410 : 201,
    );
    const out = await transport.send(MESSAGE, {});
    expect(out.providerId).toMatch(/^webpush-/);
    expect(gone).toEqual([['a', 410]]);
  });

  it('every subscription gone or refused: undeliverable, so the Notifier falls back', async () => {
    const { transport, gone } = setup([sub('a'), sub('b')], (url) =>
      url.endsWith('/a') ? 404 : 401,
    );
    const err = await refusal(transport.send(MESSAGE, {}));
    expect(err.undeliverable).toBe(true);
    expect(err.retryable).toBe(false);
    expect(gone).toEqual([['a', 404]]);
  });

  it('a bare 400, 403 or 413 keeps the subscription: refused for this message, the SMS fallback (W2-15/16 review)', async () => {
    // Apple and FCM answer 400 / 403 for a bad or expired VAPID JWT too (SiteLog's key or clock):
    // one configuration error must not revoke every subscription.
    for (const answer of [
      400,
      403,
      413,
      { status: 403, body: '{"reason":"BadJwtToken"}' },
      { status: 403, body: '{"reason":"ExpiredJwtToken"}' },
    ]) {
      const { transport, gone } = setup([sub('a')], () => answer);
      const err = await refusal(transport.send(MESSAGE, {}));
      expect(err.undeliverable, JSON.stringify(answer)).toBe(true);
      expect(err.retryable).toBe(false);
      expect(gone, JSON.stringify(answer)).toEqual([]);
    }
  });

  it('revokes a subscription a 400 or 403 names: another VAPID key, a bad device token', async () => {
    for (const answer of [
      {
        status: 403,
        body: 'the VAPID credentials in the authorization header do not correspond to the credentials used to create the subscriptions.',
      },
      { status: 400, body: '{"reason":"BadDeviceToken"}' },
    ]) {
      const { transport, gone } = setup([sub('a')], () => answer);
      const err = await refusal(transport.send(MESSAGE, {}));
      expect(err.undeliverable).toBe(true);
      expect(gone).toEqual([['a', answer.status]]);
    }
  });

  it('revokes a subscription whose keys web-push cannot use, without a request', async () => {
    const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
    const broken = { ...sub('a'), p256dh: 'AAAA' };
    const { transport, gone } = setup([broken, sub('b')], () => 201, requests);
    await transport.send(MESSAGE, {});
    expect(gone).toEqual([['a', 0]]);
    expect(requests.map((r) => r.url)).toEqual(['https://fcm.googleapis.com/fcm/send/b']);
  });

  it('no subscription left: undeliverable', async () => {
    const { transport } = setup([], () => 201);
    expect((await refusal(transport.send(MESSAGE, {}))).undeliverable).toBe(true);
  });

  it('a 429, a 5xx or a network failure with nothing sent: retryable on the same channel', async () => {
    for (const answer of [429, 502, new TypeError('fetch failed')]) {
      const { transport, gone } = setup([sub('a')], () => answer);
      const err = await refusal(transport.send(MESSAGE, {}));
      expect(err.retryable, String(answer)).toBe(true);
      expect(gone).toEqual([]);
    }
  });

  it('sends to every phone at once, each request with its own timeout (W2-14 review)', async () => {
    // The first phone's service answers only once the second phone's request has gone out:
    // one after the other, this would wait for ever.
    let second!: () => void;
    const secondAsked = new Promise<void>((resolve) => (second = resolve));
    const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
    const { transport } = setup(
      [sub('a'), sub('b')],
      async (url) => {
        if (url.endsWith('/a')) {
          await secondAsked;
          return 201;
        }
        second();
        return 201;
      },
      requests,
    );
    await transport.send(MESSAGE, {});
    expect(requests).toHaveLength(2);
    for (const r of requests) expect(r.init?.signal).toBeInstanceOf(AbortSignal);
  });

  it('a push service that never answers times out: retryable', async () => {
    const hang = (_url: string, init: RequestInit | undefined) =>
      new Promise<number>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
      });
    const { transport } = setup([sub('a')], hang, [], { timeoutMs: 20, attempt: () => 1 });
    const err = await refusal(transport.send(MESSAGE, {}));
    expect(err.retryable).toBe(true);
  });

  it('gives up after PUSH_MAX_ATTEMPTS runs: undeliverable, so the Notifier texts instead', async () => {
    expect(PUSH_MAX_ATTEMPTS).toBe(3);
    for (const [attempt, retryable] of [
      [1, true],
      [2, true],
      [3, false],
      [5, false],
    ] as const) {
      const { transport } = setup([sub('a')], () => 503, [], { attempt: () => attempt });
      const err = await refusal(transport.send(MESSAGE, {}));
      expect(err.retryable, `attempt ${attempt}`).toBe(retryable);
      expect(err.undeliverable, `attempt ${attempt}`).toBe(!retryable);
      if (!retryable) expect(err.opts.code).toBe('retries_exhausted');
    }
    // By default the runner's attempt (runWithSignal) is the one read.
    const { transport } = setup([sub('a')], () => 503);
    const err = await runWithSignal(
      new AbortController().signal,
      () => refusal(transport.send(MESSAGE, {})),
      PUSH_MAX_ATTEMPTS,
    );
    expect(err.undeliverable).toBe(true);
  });

  it('never follows a redirect: a 3xx is refused (W2-14 review, §19 Q115)', async () => {
    for (const status of [301, 302, 307, 308]) {
      const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
      const { transport } = setup([sub('a')], () => status, requests);
      const err = await refusal(transport.send(MESSAGE, {}));
      expect(err.undeliverable, String(status)).toBe(true);
      expect(requests).toHaveLength(1);
      expect(requests[0]!.init?.redirect).toBe('manual');
    }
  });

  it('never posts to an endpoint off the known push services (W2-14 review, §19 Q115)', async () => {
    const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
    const evil = { ...sub('x'), endpoint: 'https://169.254.169.254/latest/meta-data' };
    const { transport } = setup([evil, sub('b')], () => 201, requests);
    await transport.send(MESSAGE, {});
    expect(requests.map((r) => r.url)).toEqual(['https://fcm.googleapis.com/fcm/send/b']);
  });

  it('demo orgs reach console push without keys; real orgs need the pair and a subscription', async () => {
    const store: PushStore = {
      listLivePushSubscriptions: async () => [sub('a')],
      pushSubscriptionGone: async () => false,
    };
    const none = { VAPID_PUBLIC_KEY: '', VAPID_PRIVATE_KEY: '', VAPID_SUBJECT: '' };
    const off = createPushRegistration({ config: none, store, fetch, randomUUID });
    const on = createPushRegistration({ config, store, fetch, randomUUID });
    const r = (isDemo: boolean) =>
      ({ reporter: { id: 'r-1' }, org: { id: 'o', isDemo } }) as Parameters<
        NonNullable<typeof off.reachable>
      >[0];
    expect(await off.reachable!(r(true))).toBe(true);
    expect(await off.reachable!(r(false))).toBe(false);
    expect(await on.reachable!(r(false))).toBe(true);
    expect(off.transport('console').driver).toBe('console');
    expect(on.transport('webpush').driver).toBe('webpush');
    expect(off.spec.sender({} as never)).toBeNull();
    expect(on.spec.sender({} as never)).toBe('vapid');
  });
});
