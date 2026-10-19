import { describe, expect, it } from 'vitest';
import {
  FIELD_CHANNELS,
  FieldChannelSchema,
  MESSAGE_CHANNELS,
  MessageChannelSchema,
  MSG_STATUSES,
  PG_ENUM_SCHEMAS,
  PG_ENUMS,
  REPORT_STATUSES,
  REPORTER_STATUSES,
  SourceKindSchema,
} from './enums.ts';

describe('Postgres enum mirrors (§6.2)', () => {
  it('has one Zod schema per enum, built from the same labels in the same order', () => {
    expect(Object.keys(PG_ENUM_SCHEMAS).sort()).toEqual(Object.keys(PG_ENUMS).sort());
    for (const [name, values] of Object.entries(PG_ENUMS)) {
      const schema = PG_ENUM_SCHEMAS[name as keyof typeof PG_ENUM_SCHEMAS];
      expect(schema.options, name).toEqual([...values]);
    }
  });

  it('places the v1.2 labels where §6.2 puts them', () => {
    expect(REPORT_STATUSES.slice(0, 3)).toEqual(['collecting', 'processing', 'awaiting_answer']);
    expect(REPORTER_STATUSES.slice(-2)).toEqual(['opted_out', 'disabled']);
    expect(MSG_STATUSES.at(-1)).toBe('undeliverable');
    // §6.2 web/voice/sms, plus `office` for typed reports (D13) and `whatsapp` (W2-16, §19 Q26).
    expect(FIELD_CHANNELS).toEqual(['web', 'voice', 'sms', 'office', 'whatsapp']);
  });

  it('parses only known labels', () => {
    expect(FieldChannelSchema.parse('office')).toBe('office');
    // W2-16 (§19 Q26): answers and keywords reach TalkOlog over WhatsApp too.
    expect(FieldChannelSchema.safeParse('whatsapp').success).toBe(true);
    expect(FieldChannelSchema.safeParse('push').success).toBe(false);
    expect(SourceKindSchema.safeParse('voice_note').success).toBe(true);
    expect(SourceKindSchema.safeParse('audio').success).toBe(false);
  });

  it('keeps message channels apart from field channels (D48)', () => {
    expect(MESSAGE_CHANNELS).toEqual(['sms', 'whatsapp', 'push']);
    expect(MessageChannelSchema.parse('whatsapp')).toBe('whatsapp');
    expect(MessageChannelSchema.safeParse('web').success).toBe(false);
    expect(MessageChannelSchema.safeParse('office').success).toBe(false);
    expect(PG_ENUMS.message_channel).toBe(MESSAGE_CHANNELS);
  });
});
