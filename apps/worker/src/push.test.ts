import { createECDH, randomBytes, randomUUID } from 'node:crypto';
import webpush from 'web-push';
import { describe, expect, it } from 'vitest';
import { assertE164, MessageSendError, type OutboundMessage } from '@sitelog/shared';
import { createPushRegistration, vapidConfigured, webPushTransport, type PushStore } from './push';

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
    endpoint: `https://push.test/${id}`,
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

function setup(subs: ReturnType<typeof sub>[], answer: (url: string) => number | Error) {
  const gone: Array<[string, number]> = [];
  const store: PushStore = {
    listLivePushSubscriptions: async () => subs,
    pushSubscriptionGone: async (id, status) => {
      gone.push([id, status]);
      return true;
    },
  };
  const fetchImpl: typeof fetch = async (url) => {
    const a = answer(String(url));
    if (a instanceof Error) throw a;
    return new Response(null, { status: a });
  };
  const transport = webPushTransport({ config, store, fetch: fetchImpl, randomUUID });
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
      url.endsWith('/a') ? 404 : 403,
    );
    const err = await refusal(transport.send(MESSAGE, {}));
    expect(err.undeliverable).toBe(true);
    expect(err.retryable).toBe(false);
    expect(gone).toEqual([['a', 404]]);
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
