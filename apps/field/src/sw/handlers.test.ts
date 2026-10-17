// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  clickTarget,
  NOTIFICATION_ICON,
  openFromNotification,
  pushEventData,
  showPush,
  type NotificationOptionsLike,
  type SwScope,
  type WindowClientLike,
} from './handlers';

const ORIGIN = 'https://go.sitelog.app';

function scope(windows: string[] = []) {
  const shown: Array<[string, NotificationOptionsLike]> = [];
  const opened: string[] = [];
  const clients: Array<WindowClientLike & { navigated: string[]; focused: number }> = windows.map(
    (url) => {
      const c = {
        url,
        navigated: [] as string[],
        focused: 0,
        focus: async () => void c.focused++,
        navigate: async (to: string) => void c.navigated.push(to),
      };
      return c;
    },
  );
  const s: SwScope = {
    location: { origin: ORIGIN },
    registration: { showNotification: async (title, options) => void shown.push([title, options]) },
    clients: {
      matchAll: async () => clients,
      openWindow: async (url) => void opened.push(url),
    },
  };
  return { s, shown, opened, clients };
}

const data = (value: unknown) => ({
  json: () => (typeof value === 'string' ? JSON.parse(value) : value),
  text: () => (typeof value === 'string' ? value : JSON.stringify(value)),
});

describe('service worker push handlers (W2-14)', () => {
  it('shows the §9.2 text with its key as tag and the link to open', async () => {
    const { s, shown } = scope();
    await showPush(
      s,
      data({
        title: 'SiteLog',
        body: 'Un dato sobre su reporte: https://go.sitelog.app/r/K7Q2MX',
        tag: 'question_ready',
        lang: 'es',
        url: 'https://go.sitelog.app/r/K7Q2MX',
      }),
    );
    expect(shown).toEqual([
      [
        'SiteLog',
        {
          body: 'Un dato sobre su reporte: https://go.sitelog.app/r/K7Q2MX',
          tag: 'question_ready',
          lang: 'es',
          icon: NOTIFICATION_ICON,
          badge: NOTIFICATION_ICON,
          data: { url: 'https://go.sitelog.app/r/K7Q2MX' },
        },
      ],
    ]);
  });

  it('shows a plain-text or empty push as a notification that opens the app', async () => {
    expect(pushEventData(data('not json'))).toMatchObject({ body: 'not json', url: null });
    expect(pushEventData(null)).toMatchObject({ title: 'SiteLog', body: '', url: null });
    const { s, shown } = scope();
    await showPush(s, null);
    expect(shown[0]![1].data).toEqual({ url: null });
  });

  it('a tap navigates an open window of the app to the link and focuses it', async () => {
    const { s, opened, clients } = scope(['https://go.sitelog.app/today']);
    let closed = false;
    await openFromNotification(s, {
      data: { url: 'https://go.sitelog.app/r/K7Q2MX' },
      close: () => (closed = true),
    });
    expect(closed).toBe(true);
    expect(clients[0]!.navigated).toEqual(['https://go.sitelog.app/r/K7Q2MX']);
    expect(clients[0]!.focused).toBe(1);
    expect(opened).toEqual([]);
  });

  it('opens a new window when none is open, or for a link outside the app', async () => {
    const none = scope();
    await openFromNotification(none.s, { data: { url: null }, close: () => {} });
    expect(none.opened).toEqual([`${ORIGIN}/`]);
    const other = scope(['https://go.sitelog.app/today']);
    await openFromNotification(other.s, {
      data: { url: 'https://files.example/report.pdf' },
      close: () => {},
    });
    expect(other.opened).toEqual(['https://files.example/report.pdf']);
    expect(other.clients[0]!.navigated).toEqual([]);
    expect(clickTarget(none.s, { url: 'javascript:alert(1)' })).toBe(`${ORIGIN}/`);
  });

  it('a window that refuses to navigate: the link opens in a new window (W2-14 review)', async () => {
    const { s, opened, clients } = scope(['https://go.sitelog.app/today']);
    clients[0]!.navigate = () =>
      Promise.reject(
        new TypeError('This service worker is not the client’s active service worker.'),
      );
    await openFromNotification(s, {
      data: { url: 'https://go.sitelog.app/r/K7Q2MX' },
      close: () => {},
    });
    expect(opened).toEqual(['https://go.sitelog.app/r/K7Q2MX']);
  });
});
