import type { CallRow, ConsentType, Json, ReporterLocale } from '@sitelog/shared';
import { unknownCallRecordingPath } from '@sitelog/shared';
import { endOfDayIn, type FakeFieldStore } from './fake_store.ts';
import { FieldDbError } from './store.ts';
import type { VoiceConsentResult, VoiceSaveResult, VoiceSpecialStore } from './voice_special.ts';

/**
 * W3-14's store on FakeFieldStore's rows, for the Deno tests: what
 * 20261016000370_voice_special_intents.sql does (the SQL itself is tested on PGlite,
 * `voice-special-intents.test.ts`). The day off and the filed change reuse the fake's W2-08 and
 * W2-11 paths and then mark what the call RPCs mark differently (channel and via `voice`, the call).
 */
export class FakeVoiceSpecialStore implements VoiceSpecialStore {
  /** `voice_unknown_caller()` rows (F13). */
  unknownContacts: {
    id: string;
    org_id: string | null;
    phone_e164: string;
    channel: 'voice';
    call_id: string;
    snippet: string | null;
    status: 'pending' | 'linked' | 'ignored';
  }[] = [];

  constructor(
    private readonly store: FakeFieldStore,
    private readonly now: () => Date,
  ) {}

  /** The call as the RPCs check it: started, not ended, of a known caller. */
  private known(callId: string): CallRow & { reporter_id: string; org_id: string } {
    const c = this.store.callRows.find((x) => x.id === callId);
    if (!c) throw new FieldDbError('call_not_found');
    if (c.ended_at) throw new FieldDbError('call_ended');
    if (!c.reporter_id || !c.org_id) throw new FieldDbError('unknown_caller');
    return c as CallRow & { reporter_id: string; org_id: string };
  }

  async reportDayOff(input: {
    callId: string;
    status: 'no_work' | 'weather_day';
    details: Json;
    data: Json | null;
    utterance: string;
  }) {
    const c = this.known(input.callId);
    if (!c.site_id) throw new FieldDbError('site_required');
    const site = this.store.sites.find((s) => s.id === c.site_id)!;
    if (site.status !== 'active') throw new FieldDbError('site_inactive');
    const date = new Intl.DateTimeFormat('en-CA', { timeZone: site.timezone }).format(
      new Date(c.started_at ?? this.now().toISOString()),
    );
    const res = await this.store.setDayStatus({
      reporterId: c.reporter_id,
      siteId: site.id,
      date,
      status: input.status,
      questions: [],
      data: input.data as never,
    });
    if (res.changed && res.report) {
      const r = this.store.reports.find((x) => x.id === res.report!.id)!;
      r.channel = 'voice';
      const v = this.store.versions.find((x) => x.report_id === r.id && x.version === 1)!;
      v.via = 'voice';
      c.report_id = r.id;
    }
    this.store.audits.push({
      orgId: c.org_id,
      actorType: 'reporter',
      actorId: c.reporter_id,
      action: `site_day.${input.status}`,
      entity: 'site_day',
      entityId: res.siteDayId,
      diff: { channel: 'voice', call_id: c.id, utterance: input.utterance.slice(0, 200) },
    });
    return res;
  }

  async requestFiledCorrection(input: {
    callId: string;
    reportId: string;
    text: string;
    start: number;
    end: number | null;
  }) {
    const c = this.known(input.callId);
    const text = input.text.trim().slice(0, 1000);
    const r = this.store.reports.find((x) => x.id === input.reportId);
    const onSite = this.store.siteReporters.some(
      (l) => l.site_id === r?.site_id && l.reporter_id === c.reporter_id,
    );
    if (!r || r.status === 'void' || !onSite) throw new FieldDbError('out_of_scope');
    const seen = this.store.corrections.find(
      (x) =>
        x.call_id === c.id && x.report_id === r.id && x.text === text && x.status !== 'discarded',
    );
    if (seen) return { id: seen.id, status: seen.status, jobId: null, repeat: true };
    const site = this.store.sites.find((s) => s.id === r.site_id)!;
    if ((r.status === 'filed' || r.status === 'signed_off') && site.status !== 'active') {
      throw new FieldDbError('site_inactive');
    }
    const res = await this.store.requestFiledCorrection({
      reportId: r.id,
      reporterId: c.reporter_id,
      uploadId: null,
      text,
    });
    const row = this.store.corrections.find((x) => x.id === res.id)!;
    Object.assign(row, {
      via: 'voice',
      call_id: c.id,
      source: {
        type: 'call',
        callId: c.id,
        start: input.start,
        ...(input.end !== null && input.end > input.start ? { end: input.end } : {}),
      },
    });
    return res;
  }

  async saveFiledCorrection(input: {
    callId: string;
    correctionId: string;
    utterance: string;
    confirmed: boolean;
    changeNote: string;
    message: { weekday: string; change: string } | null;
  }): Promise<VoiceSaveResult> {
    const c = this.known(input.callId);
    const row = this.store.corrections.find((x) => x.id === input.correctionId);
    if (!row || row.call_id !== c.id || !row.after_filing) {
      throw new FieldDbError('correction_not_found');
    }
    if (row.status === 'applied') {
      return { status: 'applied', version: row.version_created!, repeat: true };
    }
    if (row.status !== 'ready') throw new FieldDbError('correction_not_ready');
    if (!input.confirmed) {
      this.store.audits.push({
        orgId: c.org_id,
        actorType: 'reporter',
        actorId: c.reporter_id,
        action: 'call.save_refused',
        entity: 'call',
        entityId: c.id,
        diff: { correction_id: row.id, utterance: input.utterance.slice(0, 200) },
      });
      return { status: 'not_confirmed' };
    }
    const res = await this.store.saveFiledCorrection({
      correctionId: row.id,
      reportId: row.report_id,
      reporterId: c.reporter_id,
      changeNote: input.changeNote,
      message: input.message,
    });
    if (res.status === 'stale') {
      return { status: 'stale', currentVersion: res.currentVersion, draftRev: res.draftRev };
    }
    const v = this.store.versions.find(
      (x) => x.report_id === row.report_id && x.version === res.version,
    );
    if (v) v.via = 'voice';
    return { status: 'applied', version: res.version };
  }

  recordConsent(input: {
    callId: string;
    answer: 'yes' | 'no';
    at: number;
    textVersion: string;
  }): Promise<VoiceConsentResult> {
    const c = this.known(input.callId);
    const held = (t: ConsentType) =>
      this.store.consents.some(
        (x) => x.reporter_id === c.reporter_id && x.type === t && !x.revoked_at,
      );
    const smsBefore = held('sms');
    const messagesBefore = smsBefore || held('whatsapp');
    if (input.answer === 'no') {
      if (!c.consent_declined_at) {
        c.consent_declined_at = this.now().toISOString();
        this.store.audits.push({
          orgId: c.org_id,
          actorType: 'reporter',
          actorId: c.reporter_id,
          action: 'consent.declined',
          entity: 'reporter',
          entityId: c.reporter_id,
          diff: { via: 'voice', call_id: c.id, at: input.at },
        });
      }
      return Promise.resolve({
        status: 'declined',
        smsBefore,
        messagesBefore,
        recordingPath: c.recording_path,
        given: [],
      });
    }
    if (c.consent_declined_at) return Promise.reject(new FieldDbError('wrong_state'));
    const given: string[] = [];
    for (const type of ['recording', 'data_processing', 'whatsapp'] as const) {
      if (held(type)) continue;
      this.store.consents.push({
        id: crypto.randomUUID(),
        reporter_id: c.reporter_id,
        type,
        method: 'voice_yes',
        text_version: input.textVersion,
        evidence: { call_id: c.id, at: input.at },
        given_at: this.now().toISOString(),
        revoked_at: null,
      });
      given.push(type);
      this.store.audits.push({
        orgId: c.org_id,
        actorType: 'reporter',
        actorId: c.reporter_id,
        action: 'consent.given',
        entity: 'consent',
        entityId: null,
        diff: { type, method: 'voice_yes', via: 'voice', call_id: c.id, at: input.at },
      });
    }
    const rep = this.store.reporters.find((r) => r.id === c.reporter_id)!;
    if (rep.status === 'invited') {
      rep.status = 'active';
      rep.activated_at ??= this.now().toISOString();
    }
    return Promise.resolve({
      status: 'given',
      smsBefore,
      messagesBefore,
      recordingPath: null,
      given,
    });
  }

  noCallsToday(callId: string) {
    const c = this.known(callId);
    const rep = this.store.reporters.find((r) => r.id === c.reporter_id)!;
    const org = this.store.orgs.find((o) => o.id === rep.org_id)!;
    const day = new Intl.DateTimeFormat('en-CA', { timeZone: org.timezone }).format(this.now());
    // The end of that day in the org's time zone (the tests' orgs are on Chicago time).
    const until = endOfDayIn(day, org.timezone);
    if (rep.no_calls_until && rep.no_calls_until >= until) {
      return Promise.resolve({ until: rep.no_calls_until, changed: false });
    }
    const before = rep.no_calls_until;
    rep.no_calls_until = until;
    this.store.audits.push({
      orgId: rep.org_id,
      actorType: 'reporter',
      actorId: rep.id,
      action: 'reporter.preferences_changed',
      entity: 'reporter',
      entityId: rep.id,
      diff: {
        from: { no_calls_until: before },
        to: { no_calls_until: until },
        channel: 'voice',
        call_id: c.id,
      },
    });
    return Promise.resolve({ until, changed: true });
  }

  /** W3-17: the fake's callbacks (`voice_schedule_callback()`), one per site-day and reporter. */
  callbacks: { callId: string; siteDayId: string; reporterId: string; at: string }[] = [];

  callbackContext(callId: string) {
    const c = this.store.callRows.find((x) => x.id === callId);
    if (!c?.site_id) return Promise.resolve(null);
    const site = this.store.sites.find((s) => s.id === c.site_id)!;
    const date = new Intl.DateTimeFormat('en-CA', { timeZone: site.timezone }).format(
      new Date(c.started_at ?? this.now().toISOString()),
    );
    const day = this.store.siteDays.find((d) => d.site_id === site.id && d.date === date);
    return Promise.resolve({
      siteDayId: day?.id ?? `${site.id}:${date}`,
      timezone: site.timezone,
      window: { start: '07:00', end: '20:00' },
      // The tests' deadline 17:30 + 90 min.
      missingAt: day ? new Date(Date.parse(day.deadline_at) + 90 * 60_000).toISOString() : null,
    });
  }

  async scheduleCallback(input: { callId: string; at: string; minutes: number }) {
    const c = this.known(input.callId);
    const org = this.store.orgs.find((o) => o.id === c.org_id)!;
    const pack = this.store.countries.find((k) => k.code === org.country);
    const autoCall = this.store.consents.some(
      (k) => k.reporter_id === c.reporter_id && k.type === 'auto_call' && !k.revoked_at,
    );
    if ((!org.is_demo && !pack?.outbound_trunk_id) || !autoCall) {
      throw new FieldDbError('not_available');
    }
    const cb = await this.callbackContext(c.id);
    if (!cb) throw new FieldDbError('site_required');
    if (
      this.callbacks.some((x) => x.siteDayId === cb.siteDayId && x.reporterId === c.reporter_id)
    ) {
      return { status: 'limit_reached' as const };
    }
    this.callbacks.push({
      callId: c.id,
      siteDayId: cb.siteDayId,
      reporterId: c.reporter_id,
      at: input.at,
    });
    this.store.audits.push({
      orgId: c.org_id,
      actorType: 'agent',
      action: 'call.callback_requested',
      entity: 'call',
      entityId: c.id,
      diff: { at: input.at, minutes: input.minutes, site_day_id: cb.siteDayId },
    });
    return { status: 'scheduled' as const };
  }

  unknownCaller(callId: string, snippet: string) {
    const c = this.store.callRows.find((x) => x.id === callId);
    if (!c) return Promise.reject(new FieldDbError('call_not_found'));
    if (c.ended_at) return Promise.reject(new FieldDbError('call_ended'));
    if (c.reporter_id || !c.from_e164) return Promise.reject(new FieldDbError('out_of_scope'));
    const seen = this.unknownContacts.find((u) => u.call_id === c.id);
    if (seen) {
      seen.snippet = snippet || seen.snippet;
      return Promise.resolve({ id: seen.id, orgId: seen.org_id, created: false });
    }
    const pack = this.store.countries.find((k) => k.voice_number === c.to_e164)?.code;
    const orgs = new Set(
      this.store.reporters
        .filter((r) => r.phone_e164 === c.from_e164)
        .map((r) => r.org_id)
        .filter((o) => {
          const org = this.store.orgs.find((x) => x.id === o);
          return org && org.country === pack && !org.is_demo;
        }),
    );
    const orgId = orgs.size === 1 ? [...orgs][0]! : null;
    const row = {
      id: crypto.randomUUID(),
      org_id: orgId,
      phone_e164: c.from_e164,
      channel: 'voice' as const,
      call_id: c.id,
      snippet: snippet.slice(0, 160) || null,
      status: 'pending' as const,
    };
    this.unknownContacts.push(row);
    this.store.audits.push({
      orgId,
      actorType: 'system',
      action: 'unknown_contact.created',
      entity: 'unknown_contact',
      entityId: row.id,
      diff: { channel: 'voice', pack: pack ?? null, call_id: c.id, org_guessed: orgId !== null },
    });
    return Promise.resolve({ id: row.id, orgId, created: true });
  }

  unknownRecording(callId: string) {
    const c = this.store.callRows.find((x) => x.id === callId);
    if (!c) return Promise.reject(new FieldDbError('call_not_found'));
    if (c.reporter_id) return Promise.reject(new FieldDbError('out_of_scope'));
    c.recording_path = unknownCallRecordingPath(c.id);
    return Promise.resolve({ path: c.recording_path });
  }

  callPackLocale(callId: string) {
    const c = this.store.callRows.find((x) => x.id === callId);
    const pack = this.store.countries.find((k) => k.voice_number && k.voice_number === c?.to_e164);
    return Promise.resolve((pack?.field_locales[0] as ReporterLocale | undefined) ?? null);
  }
}
