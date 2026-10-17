import type { CallOutcome, CallStatus, VoiceEvent, VoiceEventResult } from '@sitelog/shared';
import type { VoiceEventsStore } from './store.ts';

/**
 * In-memory voice-events store for the Deno tests: the same rules as `voice_call_event()`
 * (20261016000320_voice_events.sql), whose PGlite tests check the SQL itself
 * (`supabase/db-tests/src/voice-events.test.ts`).
 */

export interface FakeReport {
  status: 'collecting' | 'processing' | 'awaiting_answer' | 'awaiting_confirmation' | 'filed';
  confirmedVia: 'voice' | 'web' | null;
  confirmedAt: Date | null;
  hasVersion: boolean;
}

export interface FakeCall {
  id: string;
  room: string | null;
  reporterId: string | null;
  status: CallStatus;
  answeredAt: Date | null;
  startedAt: Date | null;
  endedAt: Date | null;
  outcome: CallOutcome | null;
  report: FakeReport | null;
  metrics: Record<string, unknown> | null;
}

export interface FakeAudit {
  callId: string;
  action: string;
  actor: 'system';
  diff: Record<string, unknown>;
}

const RANK: Record<CallStatus, number> = {
  queued: 0,
  ringing: 1,
  in_progress: 2,
  completed: 3,
  no_answer: 3,
  busy: 3,
  failed: 3,
  voicemail: 3,
};

export function fakeVoiceEventsStore() {
  const calls = new Map<string, FakeCall>();
  const events = new Map<string, string | null>();
  const jobs = new Map<string, number>();
  const audits: FakeAudit[] = [];
  let failNext = false;

  function find(room: string): FakeCall | undefined {
    const byRoom = [...calls.values()].find((c) => c.room === room);
    if (byRoom) return byRoom;
    const c = calls.get(room.slice(5));
    return c && c.room === null ? c : undefined;
  }

  const store: VoiceEventsStore = {
    // deno-lint-ignore require-await
    async applyEvent(ev: VoiceEvent): Promise<VoiceEventResult> {
      if (failNext) {
        failNext = false;
        throw new Error('voice-events rpc: connection reset');
      }
      if (events.has(ev.eventId)) {
        return {
          duplicate: true,
          callId: events.get(ev.eventId) ?? null,
          changed: false,
          ended: false,
          outcome: null,
          jobId: null,
        };
      }
      const at = new Date(ev.at);
      const c = find(ev.room);
      events.set(ev.eventId, c?.id ?? null);
      if (!c) {
        return {
          duplicate: false,
          callId: null,
          changed: false,
          ended: false,
          outcome: null,
          jobId: null,
        };
      }
      let changed = false;
      let status = ev.status;
      if (status === 'completed' && !c.answeredAt) status = 'failed';
      if (status) {
        const diff: Record<string, unknown> = {};
        if (status === 'in_progress' && RANK[c.status] <= 2 && !c.answeredAt) {
          c.answeredAt = at;
          diff.answered_at = at.toISOString();
        }
        if (RANK[c.status] < 3 && RANK[status] > RANK[c.status]) {
          diff.status = { from: c.status, to: status };
          c.status = status;
        }
        c.startedAt ??= status !== 'queued' ? at : null;
        if (Object.keys(diff).length > 0) {
          changed = true;
          audits.push({
            callId: c.id,
            action: 'call.updated',
            actor: 'system',
            diff: { ...diff, event: ev.event, event_id: ev.eventId, ...ev.detail },
          });
        }
      }
      if (ev.event !== 'room_finished' || c.endedAt) {
        return {
          duplicate: false,
          callId: c.id,
          changed,
          ended: false,
          outcome: null,
          jobId: null,
        };
      }
      const r = c.report;
      const outcome: CallOutcome = !c.answeredAt
        ? 'not_reached'
        : !r
          ? 'abandoned'
          : r.status === 'filed' &&
              r.confirmedVia === 'voice' &&
              r.confirmedAt !== null &&
              r.confirmedAt >= c.answeredAt
            ? 'filed'
            : r.status !== 'filed' && r.hasVersion
              ? 'draft_saved'
              : 'abandoned';
      c.outcome = outcome;
      c.endedAt = at;
      if (RANK[c.status] < 3) c.status = c.answeredAt ? 'completed' : 'failed';
      c.metrics = {
        ...(c.metrics ?? {}),
        backstop: { event: ev.event, eventId: ev.eventId, at: ev.at, outcome },
      };
      let jobId: number | null = null;
      if (c.reporterId) {
        const key = `post_call:${c.id}`;
        jobId = jobs.get(key) ?? jobs.size + 1;
        jobs.set(key, jobId);
      }
      audits.push({
        callId: c.id,
        action: 'call.ended',
        actor: 'system',
        diff: { outcome, status: c.status, backstop: true, event_id: ev.eventId, job_id: jobId },
      });
      return { duplicate: false, callId: c.id, changed, ended: true, outcome, jobId };
    },
  };

  return {
    store,
    calls,
    events,
    jobs,
    audits,
    /** The next applyEvent throws (a database error: LiveKit delivers again). */
    failOnce() {
      failNext = true;
    },
    /** voice_call_end() as the agent: once, with its post_call job. */
    agentEnd(callId: string, outcome: CallOutcome, at: Date) {
      const c = calls.get(callId)!;
      if (c.endedAt) return false;
      c.endedAt = at;
      c.outcome = outcome;
      if (RANK[c.status] < 3) c.status = 'completed';
      if (c.reporterId) {
        const key = `post_call:${c.id}`;
        jobs.set(key, jobs.get(key) ?? jobs.size + 1);
      }
      return true;
    },
    addCall(partial: Partial<FakeCall> & { id: string }): FakeCall {
      const c: FakeCall = {
        room: null,
        reporterId: null,
        status: 'queued',
        answeredAt: null,
        startedAt: null,
        endedAt: null,
        outcome: null,
        report: null,
        metrics: null,
        ...partial,
      };
      calls.set(c.id, c);
      return c;
    },
  };
}
