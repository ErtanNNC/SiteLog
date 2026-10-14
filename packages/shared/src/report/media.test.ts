import { describe, expect, it } from 'vitest';
import { isActiveReporterStatus, isReporterAuthor } from '../enums.ts';
import {
  isAnswerSourceKind,
  isVoiceSourceKind,
  mediaOf,
  sourceKindV12,
  sourceMediaId,
  transcriptMediaId,
  voiceMediaIdOf,
} from './media.ts';

describe('report media across the move to uploads (W1-05 step 10)', () => {
  it('accepts the WhatsApp and the v1.2 source kinds', () => {
    expect(['audio', 'voice_note', 'photo', 'call'].filter(isVoiceSourceKind)).toEqual([
      'audio',
      'voice_note',
    ]);
    expect(['reply', 'answer', 'text'].filter(isAnswerSourceKind)).toEqual(['reply', 'answer']);
    expect(sourceKindV12('audio')).toBe('voice_note');
    expect(sourceKindV12('reply')).toBe('reply');
    expect(sourceKindV12('photo')).toBe('photo');
  });

  it('keys a source and a transcript by the upload, else the message', () => {
    expect(sourceMediaId({ upload_id: 'u', message_id: 'm' })).toBe('u');
    expect(sourceMediaId({ upload_id: null, message_id: 'm' })).toBe('m');
    expect(sourceMediaId({ message_id: null })).toBeNull();
    expect(transcriptMediaId({ upload_id: null, message_id: 'm' })).toBe('m');
    expect(transcriptMediaId({ upload_id: 'u', message_id: 'u' })).toBe('u');
  });

  it('reads the voice note a v1 or v2 data source cites', () => {
    expect(voiceMediaIdOf({ type: 'audio', messageId: 'm', start: 1 })).toBe('m');
    expect(voiceMediaIdOf({ type: 'voice_note', uploadId: 'u', start: 1 })).toBe('u');
    expect(voiceMediaIdOf({ type: 'answer', questionId: 'q' })).toBeNull();
    expect(voiceMediaIdOf(null)).toBeNull();
  });

  it('takes a file from its upload first and from the message otherwise', () => {
    const uploads = new Map([
      [
        'u1',
        {
          id: 'u1',
          storage_path: 'org/site/office/u1.jpg',
          mime: 'image/jpeg',
          duration_s: null,
          peaks: null,
          received_at: '2026-10-09T17:00:00.000Z',
          recorded_at: '2026-10-09T16:00:00.000Z',
          caption: 'Deck',
        },
      ],
      [
        'm2',
        {
          id: 'm2',
          storage_path: 'org/site/2026-10-09/m2.ogg',
          mime: 'audio/ogg',
          duration_s: 42,
          peaks: [0.1, 0.5],
          received_at: '2026-10-09T18:00:00.000Z',
          recorded_at: null,
          caption: null,
        },
      ],
    ]);
    const messages = new Map([
      [
        'm2',
        {
          id: 'm2',
          storage_path: null, // the upload is the file now
          media_mime: 'audio/ogg',
          duration_s: 42,
          payload: { peaks: [0.9] },
          created_at: '2026-10-09T18:00:00.000Z',
          body: null,
          conversation_id: 'c1',
        },
      ],
      [
        'm3',
        {
          id: 'm3',
          storage_path: 'org/site/2026-10-09/m3.jpg',
          media_mime: 'image/jpeg',
          duration_s: null,
          payload: null,
          created_at: '2026-10-09T19:00:00.000Z',
          body: 'Rebar',
          conversation_id: 'c1',
        },
      ],
    ]);
    expect(mediaOf({ upload_id: 'u1', message_id: null }, uploads, messages)).toEqual({
      id: 'u1',
      storagePath: 'org/site/office/u1.jpg',
      mime: 'image/jpeg',
      durationS: null,
      peaks: null,
      receivedAt: '2026-10-09T17:00:00.000Z',
      text: 'Deck',
      conversationId: null,
    });
    // Backfilled: the upload's file and waveform, the message's conversation.
    expect(mediaOf({ upload_id: 'm2', message_id: 'm2' }, uploads, messages)).toMatchObject({
      id: 'm2',
      storagePath: 'org/site/2026-10-09/m2.ogg',
      durationS: 42,
      peaks: [0.1, 0.5],
      conversationId: 'c1',
    });
    // A message key alone still finds the upload of the same id.
    expect(mediaOf({ message_id: 'm2' }, uploads, messages)?.storagePath).toBe(
      'org/site/2026-10-09/m2.ogg',
    );
    // WhatsApp media without an upload: the message.
    expect(mediaOf({ upload_id: null, message_id: 'm3' }, uploads, messages)).toEqual({
      id: 'm3',
      storagePath: 'org/site/2026-10-09/m3.jpg',
      mime: 'image/jpeg',
      durationS: null,
      peaks: null,
      receivedAt: '2026-10-09T19:00:00.000Z',
      text: 'Rebar',
      conversationId: 'c1',
    });
    expect(mediaOf({ upload_id: null, message_id: null }, uploads, messages)).toBeUndefined();
  });

  it('reads an upload retention purged as a photo without a file', () => {
    const purged = new Map([
      [
        'u4',
        {
          id: 'u4',
          storage_path: 'org/site/office/u4.jpg', // the deleted object's name stays on the row
          purged_at: '2028-10-10T02:00:00.000Z',
          mime: 'image/jpeg',
          duration_s: null,
          peaks: null,
          received_at: '2026-10-09T17:00:00.000Z',
          recorded_at: null,
          caption: 'Deck',
        },
      ],
    ]);
    expect(mediaOf({ upload_id: 'u4', message_id: null }, purged, new Map())).toEqual({
      id: 'u4',
      storagePath: null,
      mime: 'image/jpeg',
      durationS: null,
      peaks: null,
      receivedAt: '2026-10-09T17:00:00.000Z',
      text: 'Deck',
      conversationId: null,
    });
  });
});

describe('labels renamed in step 11', () => {
  it('reads the old and the new label alike', () => {
    expect(
      ['invited', 'verified', 'active', 'opted_out', 'disabled'].filter(isActiveReporterStatus),
    ).toEqual(['verified', 'active']);
    expect(['agent', 'reporter_reply', 'reporter', 'office_user'].filter(isReporterAuthor)).toEqual(
      ['reporter_reply', 'reporter'],
    );
  });
});
