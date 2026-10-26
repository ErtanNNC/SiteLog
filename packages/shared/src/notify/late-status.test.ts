import { describe, expect, it } from 'vitest';
import type { MsgStatus } from '../enums.ts';
import { jobKeys, type JobPayloads } from '../schemas/jobs.ts';
import {
  PROVIDER_FAULT_NOTICE_MS,
  applyLateStatus,
  type LateStatusAudit,
  type LateStatusInput,
  type LateStatusMessage,
  type LateStatusNotice,
  type LateStatusStore,
} from './late-status.ts';

/**
 * W4-11: the late status of a text, shared by sms-webhook's `/status` (Twilio) and the worker's
 * İletimerkezi report poll (`sms_status`), on an in-memory store.
 */

const REPORTER = '11111111-1111-4000-8000-000000000001';
const ORG = '22222222-2222-4000-8000-000000000002';
const MESSAGE = '33333333-3333-4000-8000-000000000003';
const NOW = new Date('2026-10-17T15:00:00Z');

function memoryStore(opts: { sentBy?: JobPayloads['notify'] | null; status?: string } = {}) {
  const s = {
    updates: [] as Array<[string, MsgStatus, string | null]>,
    audit: [] as LateStatusAudit[],
    notices: [] as LateStatusNotice[],
    enqueued: [] as Array<[JobPayloads['notify'], string]>,
    inviteErrors: [] as Array<[string, string]>,
    faultNotifiedAt: null as string | null,
  };
  const store: LateStatusStore = {
    updateMessageStatus: async (id, status, error) => void s.updates.push([id, status, error]),
    audit: async (e) => {
      s.audit.push(e);
      if (e.action === 'sms.provider_fault' && e.diff.notified === true)
        s.faultNotifiedAt = String(e.diff.at);
    },
    notifyJobByDedupeKey: async () => opts.sentBy ?? null,
    enqueueNotify: async (payload, key) => {
      s.enqueued.push([payload, key]);
      return 42;
    },
    reporterForInvite: async (id) => ({
      id,
      org_id: ORG,
      name: 'Emre Yıldız',
      status: (opts.status ?? 'invited') as 'invited',
    }),
    setInviteError: async (id, error) => void s.inviteErrors.push([id, error]),
    providerFaultNotifiedSince: async (_org, since) =>
      s.faultNotifiedAt !== null && s.faultNotifiedAt >= since,
    notifyOrg: async (n) => void s.notices.push(n),
  };
  return { s, store };
}

const message = (over: Partial<LateStatusMessage> = {}): LateStatusMessage => ({
  id: MESSAGE,
  status: 'sent',
  org_id: ORG,
  reporter_id: REPORTER,
  copy_key: 'filed',
  payload: { dedupe_key: 'notify:filed:r1', attempt: 1 },
  channel: 'sms',
  ...over,
});

const poll = (over: Partial<LateStatusInput> = {}): LateStatusInput => ({
  message: message(),
  incoming: 'delivered',
  error: null,
  errorCode: null,
  accountFault: false,
  via: 'report_poll',
  ...over,
});

const sentBy: JobPayloads['notify'] = {
  reporterId: REPORTER,
  key: 'filed',
  vars: { report_no: 'DY-0001', pdf_link: 'https://sl.link/r/X/report/1' },
  dedupeKey: 'notify:filed:r1',
};

describe('applyLateStatus', () => {
  it('sent → delivered: one update and its audit (via the report poll)', async () => {
    const { s, store } = memoryStore();
    expect(await applyLateStatus({ store, now: () => NOW }, poll())).toBe('delivered');
    expect(s.updates).toEqual([[MESSAGE, 'delivered', null]]);
    expect(s.audit).toEqual([
      {
        orgId: ORG,
        actorType: 'system',
        action: 'sms.status',
        entity: 'message',
        entityId: MESSAGE,
        diff: { from: 'sent', to: 'delivered', error_code: null, via: 'report_poll' },
      },
    ]);
    expect([s.notices, s.enqueued]).toEqual([[], []]);
  });

  it('never moves backwards nor over a delivery', async () => {
    for (const [from, incoming] of [
      ['delivered', 'sent'],
      ['delivered', 'undeliverable'],
      ['undeliverable', 'failed'],
      ['sent', 'sent'],
    ] as const) {
      const { s, store } = memoryStore();
      const out = await applyLateStatus(
        { store, now: () => NOW },
        poll({ message: message({ status: from }), incoming }),
      );
      expect(out, `${from} → ${incoming}`).toBeNull();
      expect(s.updates).toEqual([]);
      expect(s.audit).toEqual([]);
    }
  });

  it('undeliverable Notifier message: the fallback on the next channel, keyed per attempt', async () => {
    const { s, store } = memoryStore({ sentBy });
    await applyLateStatus(
      { store, now: () => NOW },
      poll({ incoming: 'undeliverable', error: 'iletimerkezi report x', errorCode: 'x' }),
    );
    expect(s.updates).toEqual([[MESSAGE, 'undeliverable', 'iletimerkezi report x']]);
    expect(s.enqueued).toEqual([
      [{ ...sentBy, afterMessageId: MESSAGE }, jobKeys.notifyAfter('notify:filed:r1', MESSAGE)],
    ]);
    expect(s.audit.map((a) => a.action)).toEqual(['sms.status', 'notify.fallback_queued']);
    // The number's failure on a non-welcome text: no account notice, no invite flag.
    expect([s.notices, s.inviteErrors]).toEqual([[], []]);
  });

  it('an undelivered welcome flags "Can\'t reach this number" once, while invited', async () => {
    const { s, store } = memoryStore();
    await applyLateStatus(
      { store, now: () => NOW },
      poll({
        message: message({ copy_key: 'welcome', payload: null }),
        incoming: 'undeliverable',
        error: 'iletimerkezi report x',
      }),
    );
    expect(s.inviteErrors).toEqual([[REPORTER, 'iletimerkezi report x']]);
    expect(s.notices.map((n) => [n.kind, n.data.key])).toEqual([
      ['reporter_invite_failed', 'welcome_carrier_undelivered'],
    ]);
    expect(s.audit.at(-1)).toMatchObject({
      action: 'reporter.invite_failed',
      diff: { via: 'report_poll', message_id: MESSAGE },
    });

    const active = memoryStore({ status: 'active' });
    await applyLateStatus(
      { store: active.store, now: () => NOW },
      poll({ message: message({ copy_key: 'welcome' }), incoming: 'undeliverable' }),
    );
    expect(active.s.notices).toEqual([]);
  });

  it('an account fault tells the office once an hour, never blames the number', async () => {
    const { s, store } = memoryStore({ sentBy });
    const callback = (id: string) =>
      poll({
        message: message({ id }),
        incoming: 'failed',
        error: 'twilio 30032',
        errorCode: '30032',
        accountFault: true,
        via: 'status_callback',
      });
    await applyLateStatus({ store, now: () => NOW }, callback(MESSAGE));
    await applyLateStatus(
      { store, now: () => new Date(NOW.getTime() + PROVIDER_FAULT_NOTICE_MS / 2) },
      callback('44444444-4444-4000-8000-000000000004'),
    );
    expect(s.notices.map((n) => n.data.key)).toEqual(['message_account_fault']);
    const faults = s.audit.filter((a) => a.action === 'sms.provider_fault');
    expect(faults.map((a) => a.diff.notified)).toEqual([true, false]);
    expect(faults[0]!.diff).toMatchObject({ via: 'status_callback', code: '30032' });
    // The Twilio callback's audit keeps its W1-08 shape (no `via`).
    expect(s.audit[0]!.diff).toEqual({ from: 'sent', to: 'failed', error_code: '30032' });
    expect(s.inviteErrors).toEqual([]);
    // Still the fallback, for each failed attempt.
    expect(s.enqueued).toHaveLength(2);
  });

  it('WhatsApp: only the fallback, never a texts notice', async () => {
    const { s, store } = memoryStore({ sentBy });
    await applyLateStatus(
      { store, now: () => NOW },
      poll({
        message: message({ channel: 'whatsapp', copy_key: 'filed' }),
        incoming: 'undeliverable',
        accountFault: true,
        via: 'status_callback',
      }),
    );
    expect(s.audit.map((a) => a.action)).toEqual(['whatsapp.status', 'notify.fallback_queued']);
    expect(s.notices).toEqual([]);
  });
});
