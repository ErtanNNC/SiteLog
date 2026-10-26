import { describe, expect, it } from 'vitest';
import {
  applicationServerKey,
  isInstalled,
  pushBlocked,
  pushSupported,
  subscribeBrowser,
  type PushEnv,
} from './push';

function env(over: Partial<PushEnv> & { standalone?: boolean; permission?: string } = {}): PushEnv {
  const { standalone = true, permission = 'default', ...rest } = over;
  return {
    matchMedia: (q) => ({ matches: standalone && q === '(display-mode: standalone)' }),
    navigator: {
      serviceWorker: {
        ready: Promise.resolve({
          pushManager: {
            getSubscription: async () => null,
            subscribe: async (o) => ({
              toJSON: () => ({
                endpoint: 'https://fcm.googleapis.com/fcm/send/x',
                keys: { p256dh: 'k', auth: 'a' },
                size: o.applicationServerKey.length,
              }),
              unsubscribe: async () => true,
            }),
          },
        }),
      },
    },
    PushManager: {},
    Notification: { permission, requestPermission: async () => permission },
    ...rest,
  };
}

describe('web push in the browser (W2-14)', () => {
  it('is offered only in the installed app with the Push API and a service worker', () => {
    expect(pushSupported(env())).toBe(true);
    expect(pushSupported(env({ standalone: false }))).toBe(false);
    expect(isInstalled({ ...env({ standalone: false }), navigator: { standalone: true } })).toBe(
      true,
    );
    expect(pushSupported(env({ PushManager: undefined }))).toBe(false);
    expect(pushSupported({ ...env(), navigator: {} })).toBe(false);
    expect(pushBlocked(env({ permission: 'denied' }))).toBe(true);
  });

  it('decodes the VAPID key to its 65 bytes', () => {
    const key =
      'BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U';
    const bytes = applicationServerKey(key);
    expect(bytes).toHaveLength(65);
    expect(bytes[0]).toBe(4);
  });

  it('subscribes only after the permission is granted', async () => {
    expect(await subscribeBrowser('BAAA', env({ permission: 'denied' }))).toEqual({
      kind: 'blocked',
    });
    const ok = await subscribeBrowser('BAAA', env({ permission: 'granted' }));
    expect(ok.kind).toBe('subscribed');
  });

  it('subscribes again when the browser holds a subscription made with another key (W2-14 review)', async () => {
    const key =
      'BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U';
    const calls: string[] = [];
    const held = (bytes: Uint8Array, name: string) => ({
      options: { applicationServerKey: bytes.slice().buffer },
      toJSON: () => ({ endpoint: `https://fcm.googleapis.com/fcm/send/${name}` }),
      unsubscribe: async () => {
        calls.push(`unsubscribe ${name}`);
        return true;
      },
    });
    const withHeld = (existing: ReturnType<typeof held>): PushEnv => ({
      ...env({ permission: 'granted' }),
      navigator: {
        serviceWorker: {
          ready: Promise.resolve({
            pushManager: {
              getSubscription: async () => existing,
              subscribe: async () => {
                calls.push('subscribe');
                return held(applicationServerKey(key), 'new');
              },
            },
          }),
        },
      },
    });
    const other = new Uint8Array(65).fill(7);
    const res = await subscribeBrowser(key, withHeld(held(other, 'old')));
    expect(calls).toEqual(['unsubscribe old', 'subscribe']);
    expect(res).toMatchObject({ subscription: { endpoint: expect.stringMatching(/\/new$/) } });

    calls.length = 0;
    const same = await subscribeBrowser(key, withHeld(held(applicationServerKey(key), 'same')));
    expect(calls).toEqual([]);
    expect(same).toMatchObject({ subscription: { endpoint: expect.stringMatching(/\/same$/) } });
  });
});
