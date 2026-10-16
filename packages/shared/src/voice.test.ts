import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  CallPeaksSchema,
  deriveCallToken,
  DialogLogSchema,
  EndCallRequestSchema,
  FileReportResponseSchema,
  GetContextResponseSchema,
  readCallPeaks,
  SetDayStatusRequestSchema,
  SetPreferenceRequestSchema,
  verifyCallToken,
  VOICE_CONTRACT,
  VOICE_TOOL_SCHEMAS,
  VOICE_TOOLS,
  VoiceCallStartRequestSchema,
  VoiceCallStartResponseSchema,
  type VoiceToolRequest,
} from './voice.ts';

const CALL = '0b8f6a4e-2c1d-4f3a-9e7b-5d6c8a9b0c1d';
const SITE = '6f1c0d2e-3b4a-4c5d-8e6f-7a8b9c0d1e2f';
const REPORT = '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
const QUESTION = '2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e';

/** A valid request (and answer) per tool: each round-trips through its schema unchanged. */
const TOOL_EXAMPLES: { [T in (typeof VOICE_TOOLS)[number]]: [VoiceToolRequest<T>, unknown] } = {
  get_context: [
    { callId: CALL },
    {
      call: { direction: 'inbound', transport: 'pstn', purpose: 'daily_report' },
      reporter: { firstName: 'Kevin', locale: 'en-US' },
      company: 'Kestrel Build Group',
      reportLanguage: 'en',
      sites: [{ id: SITE, name: 'Northgate', status: 'pending', deadline: '17:30' }],
      siteId: SITE,
      companies: [{ name: 'Apex Concrete', aliases: ['Apex'] }],
      keyterms: ['rebar', 'Apex Concrete'],
      consents: { recording: true, dataProcessing: true, sms: true, autoCall: false },
      recordingNoticeVersion: 'voice.recording_notice.v1',
      consentTextVersion: 'voice.consent.v1',
      maxQuestions: 3,
    },
  ],
  update_draft: [
    { callId: CALL, segments: [{ start: 4.2, end: 61.5, text: 'Apex had six guys today.' }] },
    {
      reportId: REPORT,
      draftRev: 2,
      missing: ['manpower.hours'],
      question: { id: QUESTION, text: 'How many hours did Apex work?', choices: ['8', '10'] },
      readBack: null,
    },
  ],
  record_answer: [
    { callId: CALL, questionId: QUESTION, utterance: 'eight', start: 70 },
    {
      status: 'applied',
      confirmation: 'Apex Concrete: 6 workers, 8 hours each, 48 hours.',
      draft: {
        reportId: REPORT,
        draftRev: 3,
        missing: [],
        question: null,
        readBack: "Here's what I've got: 6 on site from one company, 48 hours.",
      },
    },
  ],
  apply_correction: [
    { callId: CALL, utterance: 'Apex had seven', start: 90.5, end: 92 },
    {
      status: 'applied',
      lines: ['Apex Concrete 6 -> 7 workers, 48 -> 56 h'],
      readBack: 'Changed: Apex Concrete, 7 workers, 56 hours.',
      draft: null,
    },
  ],
  file_report: [
    { callId: CALL, reportId: REPORT, draftRev: 3, utterance: 'yes' },
    { status: 'filed', reportNo: 'NG-0042', pdf: 'pending' },
  ],
  set_day_status: [
    { callId: CALL, status: 'weather_day', details: { since: '11:00', workersBefore: 12 } },
    { status: 'ok', confirmation: 'Weather day from 11:00.' },
  ],
  schedule_callback: [
    { callId: CALL, minutes: 30 },
    { status: 'scheduled', at: '2026-10-16T22:15:00Z', localTime: '17:15' },
  ],
  set_preference: [
    { callId: CALL, contactPref: 'link' },
    { ok: true, confirmation: 'OK, your daily report is now set to a link by text.' },
  ],
  load_report: [
    { callId: CALL, dayReference: 'Friday' },
    {
      status: 'found',
      reportId: REPORT,
      date: '2026-10-09',
      reportNo: 'NG-0040',
      summary: 'Friday: 23 on site, 184 hours.',
    },
  ],
  start_fallback_recording: [
    { callId: CALL, reason: 'stt_low_confidence', at: 120.4 },
    { ok: true },
  ],
  end_call: [
    {
      callId: CALL,
      outcome: 'filed',
      dialogLog: [
        { t: 0.4, speaker: 'agent', text: 'SiteLog, hi Kevin.' },
        { t: 61.5, speaker: 'agent', text: 'Got it, one moment.', tool: 'update_draft' },
      ],
      metrics: {
        latencyP50Ms: 900,
        latencyP95Ms: 2100,
        interruptions: 1,
        sttConfidence: 0.91,
        turns: 9,
      },
    },
    { ok: true },
  ],
  pick_site: [
    { callId: CALL, siteId: SITE },
    { siteId: SITE, name: 'Northgate' },
  ],
};

describe('voice contract schemas', () => {
  it('round-trips a request and an answer of every tool', () => {
    for (const tool of VOICE_TOOLS) {
      const [req, res] = TOOL_EXAMPLES[tool];
      expect(VOICE_TOOL_SCHEMAS[tool].request.parse(req), tool).toEqual(req);
      expect(VOICE_TOOL_SCHEMAS[tool].response.parse(res), tool).toEqual(res);
      expect(JSON.parse(JSON.stringify(req))).toEqual(req);
    }
  });

  it('refuses unknown fields and requests without the call', () => {
    for (const tool of VOICE_TOOLS) {
      const [req] = TOOL_EXAMPLES[tool];
      expect(VOICE_TOOL_SCHEMAS[tool].request.safeParse({ ...req, extra: 1 }).success, tool).toBe(
        false,
      );
      const { callId: _callId, ...rest } = req as { callId: string };
      expect(VOICE_TOOL_SCHEMAS[tool].request.safeParse(rest).success, tool).toBe(false);
    }
  });

  it('starts a SIP call by number and a web call by its id', () => {
    const room = `call-${CALL}`;
    expect(
      VoiceCallStartRequestSchema.safeParse({
        room,
        from: '+15550143378',
        to: '+15550142290',
        transport: 'pstn',
      }).success,
    ).toBe(true);
    // W3-03: a SIP call names the number it called (the pack is found by it, §4.6).
    expect(
      VoiceCallStartRequestSchema.safeParse({ room, from: '+15550143378', transport: 'pstn' })
        .success,
    ).toBe(false);
    expect(
      VoiceCallStartRequestSchema.safeParse({ room, callId: CALL, transport: 'web' }).success,
    ).toBe(true);
    // A web call names its call; any call names a caller or a call; the room is call-{uuid}.
    expect(
      VoiceCallStartRequestSchema.safeParse({ room, from: '+15550143378', transport: 'web' })
        .success,
    ).toBe(false);
    expect(VoiceCallStartRequestSchema.safeParse({ room, transport: 'pstn' }).success).toBe(false);
    expect(
      VoiceCallStartRequestSchema.safeParse({ room: 'call-1', callId: CALL, transport: 'web' })
        .success,
    ).toBe(false);
    expect(
      VoiceCallStartRequestSchema.safeParse({ room, from: '5550143378', transport: 'pstn' })
        .success,
    ).toBe(false);
  });

  it('answers a reporter or unknown, never a phone number', () => {
    const token = 'QkocLsdEKu7geypc5_PsLhSodAGexD9IddDLNYJc_9A';
    const known = {
      callId: CALL,
      callToken: token,
      reporter: { firstName: 'Kevin', locale: 'en-US' },
    };
    expect(VoiceCallStartResponseSchema.parse(known)).toEqual(known);
    expect(
      VoiceCallStartResponseSchema.safeParse({ callId: CALL, callToken: token, unknown: true })
        .success,
    ).toBe(true);
    expect(VoiceCallStartResponseSchema.safeParse({ callId: CALL, callToken: token }).success).toBe(
      false,
    );
    expect(
      VoiceCallStartResponseSchema.safeParse({
        ...known,
        reporter: { ...known.reporter, phone: '+15550143378' },
      }).success,
    ).toBe(false);
    // No contract schema has a field that could carry a phone number back to the agent.
    const fields = JSON.stringify(
      Object.fromEntries(Object.entries(VOICE_CONTRACT).map(([k, s]) => [k, z.toJSONSchema(s)])),
    );
    expect(fields).not.toMatch(/"(phone|e164|fromE164|from_e164|toE164|mobile)"/i);
  });

  it('files only with an utterance and the read-back revision (Q119)', () => {
    expect(FileReportResponseSchema.safeParse({ status: 'not_confirmed' }).success).toBe(true);
    expect(FileReportResponseSchema.safeParse({ status: 'filed', reportNo: 'NG-1' }).success).toBe(
      false,
    );
    const { utterance: _u, ...noUtterance } = TOOL_EXAMPLES.file_report[0];
    expect(VOICE_TOOL_SCHEMAS.file_report.request.safeParse(noUtterance).success).toBe(false);
  });

  it('needs "since" for a weather day and something to change for a preference', () => {
    expect(
      SetDayStatusRequestSchema.safeParse({ callId: CALL, status: 'weather_day' }).success,
    ).toBe(false);
    expect(SetDayStatusRequestSchema.safeParse({ callId: CALL, status: 'no_work' }).success).toBe(
      true,
    );
    expect(SetPreferenceRequestSchema.safeParse({ callId: CALL }).success).toBe(false);
    expect(SetPreferenceRequestSchema.safeParse({ callId: CALL, noCallsToday: true }).success).toBe(
      true,
    );
  });

  it('keeps the dialog log and metrics of §6.3', () => {
    expect(DialogLogSchema.safeParse([{ t: 1, speaker: 'caller', text: 'x' }]).success).toBe(false);
    expect(
      EndCallRequestSchema.safeParse({ ...TOOL_EXAMPLES.end_call[0], outcome: 'hung_up' }).success,
    ).toBe(false);
    expect(GetContextResponseSchema.safeParse(TOOL_EXAMPLES.get_context[1]).success).toBe(true);
  });
});

describe('call peaks', () => {
  it('reads two lanes, a v1 single array as the reporter lane, and nothing else', () => {
    expect(readCallPeaks({ reporter: [0.2, 0.9], agent: [0, 0.4] })).toEqual({
      reporter: [0.2, 0.9],
      agent: [0, 0.4],
    });
    expect(readCallPeaks([0.1, 0.5, 1])).toEqual({ reporter: [0.1, 0.5, 1], agent: null });
    expect(readCallPeaks(null)).toBeNull();
    expect(readCallPeaks({ reporter: [0.1] })).toBeNull();
    expect(readCallPeaks([2])).toBeNull();
    expect(CallPeaksSchema.safeParse({ reporter: [], agent: [], extra: [] }).success).toBe(false);
  });
});

describe('deriveCallToken', () => {
  // Vectors: HMAC-SHA-256(secret, "sitelog/call_token/v1/<callId>"), base64url without padding
  // (Node: createHmac('sha256', secret).update(label).digest('base64url')).
  const VECTORS = [
    ['test-secret', CALL, 'QkocLsdEKu7geypc5_PsLhSodAGexD9IddDLNYJc_9A'],
    [
      'another secret',
      '00000000-0000-4000-8000-000000000001',
      'hOZcao-JzSbhNOk7-wNcpl_Wn0BnEmAPYQOpmArqVk4',
    ],
  ] as const;

  it('matches the vectors', async () => {
    for (const [secret, callId, token] of VECTORS) {
      expect(await deriveCallToken(secret, callId)).toBe(token);
      expect(await deriveCallToken(secret, callId.toUpperCase())).toBe(token);
    }
  });

  it('is bound to the call and the secret', async () => {
    const token = await deriveCallToken('test-secret', CALL);
    expect(await deriveCallToken('test-secret2', CALL)).not.toBe(token);
    expect(await deriveCallToken('test-secret', REPORT)).not.toBe(token);
    await expect(deriveCallToken('', CALL)).rejects.toThrow(/secret/);
    await expect(deriveCallToken('test-secret', 'call-1')).rejects.toThrow(/uuid/);
  });

  it('verifies only the call’s own token', async () => {
    const token = await deriveCallToken('test-secret', CALL);
    expect(await verifyCallToken('test-secret', CALL, token)).toBe(true);
    expect(await verifyCallToken('test-secret', REPORT, token)).toBe(false);
    expect(await verifyCallToken('other', CALL, token)).toBe(false);
    const tampered = `${token.slice(0, -1)}${token.endsWith('A') ? 'B' : 'A'}`;
    expect(await verifyCallToken('test-secret', CALL, tampered)).toBe(false);
    expect(await verifyCallToken('test-secret', CALL, null)).toBe(false);
    expect(await verifyCallToken('test-secret', CALL, token.slice(1))).toBe(false);
    expect(await verifyCallToken('test-secret', 'not-a-uuid', token)).toBe(false);
  });
});

describe('VOICE_CONTRACT', () => {
  it('converts every schema to JSON Schema', () => {
    expect(Object.keys(VOICE_CONTRACT).length).toBe(8 + VOICE_TOOLS.length * 2);
    for (const [name, schema] of Object.entries(VOICE_CONTRACT)) {
      expect(() => z.toJSONSchema(schema), name).not.toThrow();
    }
  });
});
