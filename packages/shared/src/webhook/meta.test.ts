import { describe, expect, it } from 'vitest';
import { metaSignature, normalizeWebhook, verifyChallenge, verifyMetaSignature } from './meta.ts';

const payload = {
  object: 'whatsapp_business_account',
  entry: [
    {
      id: '1234',
      changes: [
        {
          field: 'messages',
          value: {
            messaging_product: 'whatsapp',
            metadata: { display_phone_number: '15550142290', phone_number_id: '999' },
            contacts: [{ profile: { name: 'Marco Ruiz' }, wa_id: '15550143378' }],
            messages: [
              {
                from: '15550143378',
                id: 'wamid.A1',
                timestamp: '1791054000',
                type: 'audio',
                audio: { id: 'media1', mime_type: 'audio/ogg; codecs=opus', voice: true },
              },
              {
                from: '15550143378',
                id: 'wamid.A2',
                timestamp: '1791054010',
                type: 'image',
                image: { id: 'media2', mime_type: 'image/jpeg', caption: 'L4 pour' },
              },
              {
                from: '15550143378',
                id: 'wamid.A3',
                timestamp: '1791054020',
                type: 'interactive',
                interactive: {
                  type: 'button_reply',
                  button_reply: { id: 'draft:r1:ok', title: 'OK, file it' },
                },
                context: { from: '15550142290', id: 'wamid.OUT1' },
              },
              {
                from: '15550143378',
                id: 'wamid.A4',
                timestamp: '1791054030',
                type: 'button',
                button: { payload: 'rem:sd1:no_work', text: 'No work today' },
              },
              {
                from: '15550143378',
                id: 'wamid.A5',
                timestamp: '1791054040',
                type: 'reaction',
                reaction: { message_id: 'wamid.OUT2', emoji: '👍' },
              },
              {
                from: '15550143378',
                id: 'wamid.A6',
                timestamp: '1791054050',
                type: 'sticker',
                sticker: { id: 'media3', mime_type: 'image/webp' },
              },
            ],
            statuses: [
              {
                id: 'wamid.OUT1',
                status: 'delivered',
                timestamp: '1791054060',
                recipient_id: '15550143378',
              },
            ],
          },
        },
      ],
    },
  ],
};

describe('normalizeWebhook', () => {
  it('normalises messages of every type', () => {
    const { messages, statuses } = normalizeWebhook(payload);
    expect(messages).toHaveLength(6);
    expect(messages[0]).toMatchObject({
      waMessageId: 'wamid.A1',
      phoneE164: '+15550143378',
      profileName: 'Marco Ruiz',
      type: 'audio',
      mediaId: 'media1',
      phoneNumberId: '999',
    });
    expect(messages[0]!.sentAt.toISOString()).toBe('2026-10-03T19:00:00.000Z');
    expect(messages[1]).toMatchObject({ type: 'image', body: 'L4 pour', mediaId: 'media2' });
    expect(messages[2]).toMatchObject({
      type: 'interactive',
      replyId: 'draft:r1:ok',
      replyTitle: 'OK, file it',
      contextMessageId: 'wamid.OUT1',
    });
    expect(messages[3]).toMatchObject({
      type: 'interactive',
      replyId: 'rem:sd1:no_work',
      body: 'No work today',
    });
    expect(messages[4]).toMatchObject({
      type: 'reaction',
      reactionEmoji: '👍',
      reactionTo: 'wamid.OUT2',
    });
    expect(messages[5]).toMatchObject({ type: 'unsupported' });
    expect(statuses[0]).toMatchObject({
      waMessageId: 'wamid.OUT1',
      status: 'delivered',
      recipientE164: '+15550143378',
    });
  });
  it('tolerates unknown fields and empty changes', () => {
    const { messages } = normalizeWebhook({
      object: 'x',
      entry: [{ changes: [{ value: { foo: 1 } }] }],
    });
    expect(messages).toEqual([]);
  });
});

describe('signature', () => {
  it('verifies HMAC-SHA256 signatures and rejects bad ones', async () => {
    const body = JSON.stringify(payload);
    const sig = await metaSignature(body, 'app-secret');
    expect(sig).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(await verifyMetaSignature(body, sig, 'app-secret')).toBe(true);
    expect(await verifyMetaSignature(body, sig, 'other')).toBe(false);
    expect(await verifyMetaSignature(body + ' ', sig, 'app-secret')).toBe(false);
    expect(await verifyMetaSignature(body, null, 'app-secret')).toBe(false);
    expect(await verifyMetaSignature(body, 'sha1=abc', 'app-secret')).toBe(false);
  });
  it('answers the verification challenge', () => {
    const ok = verifyChallenge(
      new URLSearchParams('hub.mode=subscribe&hub.verify_token=tok&hub.challenge=123'),
      'tok',
    );
    expect(ok).toEqual({ ok: true, challenge: '123' });
    expect(
      verifyChallenge(
        new URLSearchParams('hub.mode=subscribe&hub.verify_token=bad&hub.challenge=1'),
        'tok',
      ),
    ).toEqual({ ok: false });
  });
});
