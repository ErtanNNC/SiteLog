import { describe, expect, it } from 'vitest';
import { containsPhone, redactPhones } from './redact.ts';

describe('redactPhones (CLAUDE.md: never send phone numbers to an LLM)', () => {
  it('replaces US, international, Turkish and bare-digit numbers', () => {
    expect(redactPhones('Pump truck driver Mike 555-014-3378 arrived 9:10')).toBe(
      'Pump truck driver Mike [phone] arrived 9:10',
    );
    expect(redactPhones('call me on +1 555 014 3378, at Riverside')).toBe(
      'call me on [phone], at Riverside',
    );
    expect(redactPhones('(555) 014-3378')).toBe('[phone]');
    expect(redactPhones('Ahmet bey 0532 123 45 67 aradı')).toBe('Ahmet bey [phone] aradı');
    expect(redactPhones('number 905321234567 please')).toBe('number [phone] please');
  });

  it('leaves UUIDs, ISO dates, times, quantities and segment times alone', () => {
    const text =
      'VOICE NOTE uploadId=11111111-0000-4000-8000-000000000101\n[18.9–26.1] sixty-eight yards, 68 yd³ at 2026-10-09T22:31:40Z, 07:00–15:30, 3.5 h, 1200 m²';
    expect(redactPhones(text)).toBe(text);
    expect(containsPhone(text)).toBe(false);
    expect(containsPhone('ring 555 014 3378')).toBe(true);
  });
});
