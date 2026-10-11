import { describe, expect, it } from 'vitest';
import { substitute } from './replay-webhook.ts';

describe('replay-webhook substitute', () => {
  it('fills phone, timestamp and fresh ids', () => {
    const out = substitute('{"from":"{{phone}}","ts":"{{ts}}","a":"{{id}}","b":"{{id}}"}', {
      phone: '15550143378',
    });
    const parsed = JSON.parse(out) as { from: string; ts: string; a: string; b: string };
    expect(parsed.from).toBe('15550143378');
    expect(Number(parsed.ts)).toBeGreaterThan(1_700_000_000);
    expect(parsed.a).toMatch(/^wamid\.replay\./);
    expect(parsed.a).not.toBe(parsed.b);
  });
});
