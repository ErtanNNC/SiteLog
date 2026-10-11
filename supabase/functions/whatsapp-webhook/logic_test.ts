import { assertEquals } from '@std/assert';
import type { InboundMessage } from '@sitelog/shared';
import {
  conversationPatch,
  inboundDedupeKey,
  mapDeliveryStatus,
  maskPhone,
  messageRow,
  newConversationRow,
  resolveConversationTarget,
  statusesBelow,
  statusUpdate,
} from './logic.ts';

Deno.test(
  'resolveConversationTarget: one org → attached, several → candidates, none → unknown',
  () => {
    assertEquals(resolveConversationTarget([]), {
      orgId: null,
      reporterId: null,
      candidateReporterIds: [],
    });
    assertEquals(resolveConversationTarget([{ id: 'r1', org_id: 'o1', status: 'verified' }]), {
      orgId: 'o1',
      reporterId: 'r1',
      candidateReporterIds: [],
    });
    assertEquals(
      resolveConversationTarget([
        { id: 'r1', org_id: 'o1', status: 'verified' },
        { id: 'r2', org_id: 'o2', status: 'invited' },
      ]),
      { orgId: null, reporterId: null, candidateReporterIds: ['r1', 'r2'] },
    );
    // disabled reporters never route messages
    assertEquals(
      resolveConversationTarget([
        { id: 'r1', org_id: 'o1', status: 'disabled' },
        { id: 'r2', org_id: 'o2', status: 'verified' },
      ]),
      { orgId: 'o2', reporterId: 'r2', candidateReporterIds: [] },
    );
  },
);

const inbound: InboundMessage = {
  waMessageId: 'wamid.A1',
  phoneE164: '+15550143378',
  profileName: 'Marco Ruiz',
  phoneNumberId: '999',
  sentAt: new Date('2026-10-09T22:38:00Z'),
  type: 'audio',
  body: null,
  mediaId: 'media1',
  mediaMime: 'audio/ogg; codecs=opus',
  mediaSha256: null,
  filename: null,
  replyId: null,
  replyTitle: null,
  contextMessageId: null,
  reactionEmoji: null,
  reactionTo: null,
  raw: { id: 'wamid.A1', from: '15550143378', timestamp: '1791059880', type: 'audio' },
};

Deno.test('messageRow: maps a normalised message onto the messages table', () => {
  assertEquals(messageRow(inbound, 'c1'), {
    conversation_id: 'c1',
    direction: 'in',
    wa_message_id: 'wamid.A1',
    type: 'audio',
    body: null,
    payload: { id: 'wamid.A1', from: '15550143378', timestamp: '1791059880', type: 'audio' },
    media_id: 'media1',
    media_mime: 'audio/ogg; codecs=opus',
    status: 'received',
  });
  assertEquals(inboundDedupeKey('wamid.A1'), 'inbound:wamid.A1');
});

Deno.test(
  'conversationPatch: window opens forward only and attaches unassigned conversations',
  () => {
    const sentAt = new Date('2026-10-09T22:38:00Z');
    const attached = { org_id: 'o1', reporter_id: 'r1', context: {}, last_inbound_at: null };
    assertEquals(
      conversationPatch(
        attached,
        { orgId: 'o2', reporterId: 'r9', candidateReporterIds: [] },
        sentAt,
      ),
      { last_inbound_at: '2026-10-09T22:38:00.000Z' },
    );
    // older delivery does not move the window back
    assertEquals(
      conversationPatch(
        { ...attached, last_inbound_at: '2026-10-09T23:00:00.000Z' },
        { orgId: 'o1', reporterId: 'r1', candidateReporterIds: [] },
        sentAt,
      ),
      {},
    );
    // unknown sender becomes a known reporter once the office linked the number
    assertEquals(
      conversationPatch(
        {
          org_id: null,
          reporter_id: null,
          context: { candidate_reporter_ids: ['x'], foo: 1 },
          last_inbound_at: null,
        },
        { orgId: 'o1', reporterId: 'r1', candidateReporterIds: [] },
        sentAt,
      ),
      {
        last_inbound_at: '2026-10-09T22:38:00.000Z',
        org_id: 'o1',
        reporter_id: 'r1',
        context: { foo: 1 },
      },
    );
    // several orgs: remember the candidates, leave org_id null
    assertEquals(
      conversationPatch(
        { org_id: null, reporter_id: null, context: {}, last_inbound_at: null },
        { orgId: null, reporterId: null, candidateReporterIds: ['r1', 'r2'] },
        sentAt,
      ),
      {
        last_inbound_at: '2026-10-09T22:38:00.000Z',
        context: { candidate_reporter_ids: ['r1', 'r2'] },
      },
    );
  },
);

Deno.test('newConversationRow: starts in state new with the resolved org', () => {
  assertEquals(
    newConversationRow(
      '+15550143378',
      { orgId: 'o1', reporterId: 'r1', candidateReporterIds: [] },
      inbound.sentAt,
    ),
    {
      phone_e164: '+15550143378',
      org_id: 'o1',
      reporter_id: 'r1',
      state: 'new',
      context: {},
      last_inbound_at: '2026-10-09T22:38:00.000Z',
    },
  );
  assertEquals(
    newConversationRow(
      '+15550143378',
      { orgId: null, reporterId: null, candidateReporterIds: ['a', 'b'] },
      inbound.sentAt,
    ).context,
    { candidate_reporter_ids: ['a', 'b'] },
  );
});

Deno.test('delivery statuses only move forward', () => {
  assertEquals(mapDeliveryStatus('delivered'), 'delivered');
  assertEquals(mapDeliveryStatus('deleted'), null);
  assertEquals(statusesBelow('delivered'), ['received', 'queued', 'sent']);
  assertEquals(
    statusUpdate({
      waMessageId: 'w',
      status: 'read',
      at: inbound.sentAt,
      recipientE164: null,
      error: null,
    }),
    {
      waMessageId: 'w',
      patch: { status: 'read' },
      onlyIfIn: ['received', 'queued', 'sent', 'delivered'],
    },
  );
  assertEquals(
    statusUpdate({
      waMessageId: 'w',
      status: 'failed',
      at: inbound.sentAt,
      recipientE164: null,
      error: 'Re-engagement message',
    }),
    {
      waMessageId: 'w',
      patch: { status: 'failed', error: 'Re-engagement message' },
      onlyIfIn: null,
    },
  );
  assertEquals(
    statusUpdate({
      waMessageId: 'w',
      status: 'warning',
      at: inbound.sentAt,
      recipientE164: null,
      error: null,
    }),
    null,
  );
});

Deno.test('maskPhone keeps only the country code and last digits', () => {
  assertEquals(maskPhone('+15550143378'), '+1555***378');
  assertEquals(maskPhone('+1'), '***');
});
