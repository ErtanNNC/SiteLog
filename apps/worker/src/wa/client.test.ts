import { describe, expect, it } from 'vitest';
import { ButtonSets } from '@sitelog/shared';
import {
  buildButtonsPayload,
  buildDocumentPayload,
  buildListPayload,
  buildTextPayload,
  createWaClient,
  WaApiError,
} from './client';
import { silentLogger } from '../log';

describe('WhatsApp payload builders', () => {
  it('builds a text payload with digits-only recipient', () => {
    const p = buildTextPayload('+1 555 014 3378', 'Got it, Marco.');
    expect(p.to).toBe('15550143378');
    expect(p.type).toBe('text');
    expect((p.text as { body: string }).body).toBe('Got it, Marco.');
  });

  it('rejects more than 3 buttons and truncates titles to 20 chars', () => {
    expect(() =>
      buildButtonsPayload('+15550143378', 'x', [
        { id: 'a', title: 'A' },
        { id: 'b', title: 'B' },
        { id: 'c', title: 'C' },
        { id: 'd', title: 'D' },
      ]),
    ).toThrow(/at most 3/);
    const p = buildButtonsPayload('+15550143378', 'Pick', [
      { id: 'site:1', title: 'Northgate Parking Structure Level 3' },
    ]);
    const btn = (p.interactive as { action: { buttons: Array<{ reply: { title: string } }> } })
      .action.buttons[0]!;
    expect(btn.reply.title.length).toBeLessThanOrEqual(20);
    expect(btn.reply.title.endsWith('…')).toBe(true);
  });

  it('standard button sets fit the limits', () => {
    for (const set of [
      ButtonSets.draft('r'),
      ButtonSets.reminder1('sd'),
      ButtonSets.question('q', ['4 · full day', '5 · full day']),
      ButtonSets.weatherFollowup('r'),
    ]) {
      expect(set.length).toBeLessThanOrEqual(3);
      for (const b of set) expect(b.title.length).toBeLessThanOrEqual(20);
      expect(() => buildButtonsPayload('+15550143378', 'body', set)).not.toThrow();
    }
  });

  it('builds list messages for 4–10 options and clips row titles to 24', () => {
    const options = Array.from({ length: 5 }, (_, i) => ({
      id: `site:${i}`,
      title: `Site number ${i} with a very long name`,
      description: 'XX-0000',
    }));
    const p = buildListPayload('+15550143378', 'Which site is this for?', options);
    const rows = (
      p.interactive as { action: { sections: Array<{ rows: Array<{ title: string }> }> } }
    ).action.sections[0]!.rows;
    expect(rows).toHaveLength(5);
    for (const r of rows) expect(r.title.length).toBeLessThanOrEqual(24);
    expect(() => buildListPayload('+15550143378', 'x', [])).toThrow();
  });

  it('builds a document payload', () => {
    const p = buildDocumentPayload(
      '+15550143378',
      'media-1',
      'RL-2041-0187_2026-10-09_v1.pdf',
      'Daily Report RL-2041-0187',
    );
    expect(p.type).toBe('document');
    expect((p.document as { id: string }).id).toBe('media-1');
  });
});

describe('WhatsApp client (mock fetch)', () => {
  const cfg = {
    graphBase: 'https://graph.example',
    graphVersion: 'v21.0',
    phoneNumberId: '111',
    accessToken: 'tok',
  };

  it('posts messages and returns the message id', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({ messages: [{ id: 'wamid.1' }] }), { status: 200 });
    }) as typeof fetch;
    const client = createWaClient(cfg, silentLogger, fetchImpl);
    const res = await client.sendText('+15550143378', 'hello');
    expect(res.waMessageId).toBe('wamid.1');
    expect(calls[0]!.url).toBe('https://graph.example/v21.0/111/messages');
    expect((calls[0]!.init!.headers as Record<string, string>).Authorization).toBe('Bearer tok');
  });

  it('downloads media in two steps and retries once', async () => {
    let n = 0;
    const fetchImpl = (async (url: string | URL | Request) => {
      n++;
      const u = String(url);
      if (u.endsWith('/media-9'))
        return new Response(
          JSON.stringify({ url: 'https://cdn.example/file', mime_type: 'audio/ogg' }),
          { status: 200 },
        );
      if (n === 2) return new Response('nope', { status: 500 });
      return new Response(Buffer.from('OGGDATA'), { status: 200 });
    }) as typeof fetch;
    const client = createWaClient(cfg, silentLogger, fetchImpl);
    const media = await client.downloadMedia('media-9');
    expect(media.buffer.toString()).toBe('OGGDATA');
    expect(media.mime).toBe('audio/ogg');
    expect(n).toBe(4);
  });

  it('throws WaApiError with the Graph error message', async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ error: { message: 'Re-engagement message' } }), {
        status: 400,
      })) as typeof fetch;
    const client = createWaClient(cfg, silentLogger, fetchImpl);
    await expect(client.sendText('+15550143378', 'x')).rejects.toBeInstanceOf(WaApiError);
  });
});
