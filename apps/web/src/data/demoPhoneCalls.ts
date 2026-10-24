import type { DemoPhoneMessage } from './types';

/**
 * W3-17: a thread's texts and the reporter's outbound calls (newest 100) in time order; a call is
 * an incoming entry with channel `call` and its state, which the Demo phone words (§19 Q132).
 */
export function mergeDemoPhoneCalls(
  texts: DemoPhoneMessage[],
  calls: ReadonlyArray<{
    id: string;
    status: string;
    outcome: string | null;
    purpose: string | null;
    attempt: number | null;
    created_at: string;
  }>,
): DemoPhoneMessage[] {
  if (calls.length === 0) return texts;
  const entries: DemoPhoneMessage[] = calls.map((c) => ({
    id: c.id,
    direction: 'out',
    body: '',
    status: c.status,
    copyKey: null,
    provider: null,
    channel: 'call',
    at: c.created_at,
    call: { status: c.status, outcome: c.outcome, purpose: c.purpose, attempt: c.attempt },
  }));
  return [...texts, ...entries]
    .map((m, i) => ({ m, i }))
    .sort((a, b) => a.m.at.localeCompare(b.m.at) || a.i - b.i)
    .map(({ m }) => m);
}
