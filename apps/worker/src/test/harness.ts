import { randomUUID } from 'node:crypto';
import type Anthropic from '@anthropic-ai/sdk';
import { PAYROLL_COLUMNS } from '@sitelog/shared';
import type {
  CompanyRow,
  ConversationRow,
  ConvoState,
  JobRow,
  JobTypeKey,
  MessageRow,
  MsgType,
  OrgRow,
  OrgSettingsRow,
  ReporterRow,
  SiteRow,
} from '@sitelog/shared';
import type { MessagesClient } from '../ai/claude';
import { testConfig } from '../config';
import { createMetrics, type Ctx } from '../context';
import { createMemoryProvider } from '../email/provider';
import { registry } from '../jobs/registry';
import { silentLogger } from '../log';
import type { FfmpegRunner } from '../media/ffmpeg';
import { createMemoryStorage } from '../storage';
import { createFakeWaClient, type FakeWaClient } from '../wa/client';
import { createFakeDb, type FakeDb } from './fake-db';

/** A complete Ctx on fakes plus the Kestrel demo org (§18) as seed data. */

export const ORG_ID = '00000000-0000-4000-8000-00000000a001';
export const SITE_RIVERSIDE = '00000000-0000-4000-8000-00000000b001';
export const SITE_OAKMONT = '00000000-0000-4000-8000-00000000b002';
export const REPORTER_MARCO = '00000000-0000-4000-8000-00000000c001';
export const REPORTER_JORGE = '00000000-0000-4000-8000-00000000c002';
export const PHONE_MARCO = '+15550143378';
export const PHONE_JORGE = '+15550143390';
export const PHONE_UNKNOWN = '+15550194410';
export const COMPANIES: Array<
  Pick<CompanyRow, 'id' | 'name' | 'trade' | 'aliases' | 'is_self_perform' | 'status'>
> = [
  {
    id: '00000000-0000-4000-8000-00000000d001',
    name: 'Apex Concrete',
    trade: 'Concrete',
    aliases: ['Apex', 'the Apex guys'],
    is_self_perform: false,
    status: 'confirmed',
  },
  {
    id: '00000000-0000-4000-8000-00000000d002',
    name: 'BrightLine Electric',
    trade: 'Electrical',
    aliases: ['BrightLine'],
    is_self_perform: false,
    status: 'confirmed',
  },
  {
    id: '00000000-0000-4000-8000-00000000d003',
    name: 'Delta Mechanical',
    trade: 'HVAC',
    aliases: ['the Delta guys', 'Delta'],
    is_self_perform: false,
    status: 'confirmed',
  },
  {
    id: '00000000-0000-4000-8000-00000000d004',
    name: 'Ironclad Steel',
    trade: 'Rebar',
    aliases: ['Ironclad'],
    is_self_perform: false,
    status: 'confirmed',
  },
  {
    id: '00000000-0000-4000-8000-00000000d005',
    name: 'ClearView Glazing',
    trade: 'Glazing',
    aliases: ['ClearView'],
    is_self_perform: false,
    status: 'confirmed',
  },
  {
    id: '00000000-0000-4000-8000-00000000d006',
    name: 'Summit Drywall',
    trade: 'Drywall',
    aliases: ['Summit'],
    is_self_perform: false,
    status: 'confirmed',
  },
  {
    id: '00000000-0000-4000-8000-00000000d007',
    name: 'Kestrel self-perform',
    trade: 'General labor',
    aliases: ['our guys', 'Kestrel'],
    is_self_perform: true,
    status: 'confirmed',
  },
];

/** A fake ffmpeg: PCM decode returns 2 s of a 8 kHz sine so duration/peaks are deterministic. */
export const fakeFfmpeg: FfmpegRunner = async (args) => {
  if (args.includes('s16le')) {
    const samples = 16000;
    const pcm = Buffer.alloc(samples * 2);
    for (let i = 0; i < samples; i++) pcm.writeInt16LE(Math.round(Math.sin(i / 20) * 12000), i * 2);
    return { stdout: pcm, stderr: '' };
  }
  return { stdout: Buffer.alloc(0), stderr: '' };
};

export interface Harness {
  ctx: Ctx;
  db: FakeDb;
  wa: FakeWaClient;
  email: ReturnType<typeof createMemoryProvider>;
  storage: ReturnType<typeof createMemoryStorage>;
  now: Date;
  setNow(d: Date): void;
  org: OrgRow;
  settings: OrgSettingsRow;
  riverside: SiteRow;
  oakmont: SiteRow;
  marco: ReporterRow;
  jorge: ReporterRow;
  /** A conversation for Marco in the given state (upserted). */
  conversation(
    state: ConvoState,
    context?: Record<string, unknown>,
    phone?: string,
  ): Promise<ConversationRow>;
  inbound(
    convo: ConversationRow,
    input: Partial<MessageRow> & { type: MsgType },
  ): Promise<MessageRow>;
  /** Insert + route an inbound message through the inbound_message job. */
  send(convo: ConversationRow, input: Partial<MessageRow> & { type: MsgType }): Promise<MessageRow>;
  runJob<K extends JobTypeKey>(type: K, payload: unknown): Promise<void>;
  /** Run every queued job of the given types until none remain. */
  drain(types?: JobTypeKey[]): Promise<JobRow[]>;
  claude(client: MessagesClient | null): void;
  sentTexts(): string[];
}

/** Fri Oct 9 2026 17:31 America/Chicago (CDT, UTC-5). */
export const FRIDAY_EVENING = new Date('2026-10-09T22:31:00Z');

export function createHarness(
  opts: {
    now?: Date;
    claude?: MessagesClient | null;
    multiSiteForMarco?: boolean;
    settings?: Partial<OrgSettingsRow>;
  } = {},
): Harness {
  let now = opts.now ?? FRIDAY_EVENING;
  const db = createFakeDb(() => now);
  const wa = createFakeWaClient();
  const email = createMemoryProvider();
  const storage = createMemoryStorage();
  const ctx: Ctx = {
    config: testConfig(),
    db,
    wa,
    storage,
    ai: { claude: opts.claude ?? null, openai: null },
    email,
    ffmpeg: fakeFfmpeg,
    log: silentLogger,
    now: () => now,
    metrics: createMetrics(),
  };

  const org: OrgRow = {
    id: ORG_ID,
    name: 'Kestrel Build Group',
    address: '1200 Industrial Pkwy, Austin, TX',
    license_no: 'TX-GC-20481',
    logo_path: null,
    timezone: 'America/Chicago',
    stripe_customer_id: null,
    stripe_subscription_id: null,
    billing_status: 'active',
    trial_ends_at: null,
    created_at: '2026-03-01T00:00:00Z',
  };
  const settings: OrgSettingsRow = {
    org_id: ORG_ID,
    default_deadline: '17:30:00',
    working_days: [1, 2, 3, 4, 5],
    default_shift_hours: 8,
    heads_up_enabled: true,
    heads_up_offset_min: -35,
    reminder1_enabled: true,
    reminder1_offset_min: 15,
    reminder2_enabled: true,
    reminder2_offset_min: 60,
    missing_enabled: true,
    missing_offset_min: 90,
    required_fields: ['manpower', 'hours', 'weather', 'work_performed', 'safety', 'photo'],
    filing_mode: 'confirm',
    signoff_required: true,
    email_pdf_on_file: true,
    max_questions_per_report: 3,
    payroll_csv_format: 'generic',
    pdf_paper: 'letter',
    pdf_footer_enabled: true,
    pdf_max_photos: 4,
    letterhead_lines: [],
    no_work_pdf: false,
    include_unconfirmed_in_payroll: true,
    payroll_columns: [...PAYROLL_COLUMNS],
    past_due_grace_days: 14,
    updated_at: '2026-03-01T00:00:00Z',
    ...opts.settings,
  };
  const site = (id: string, name: string, code: string, seq: number): SiteRow => ({
    id,
    org_id: ORG_ID,
    name,
    project_code: code,
    address: 'Austin, TX',
    lat: 30.26,
    lng: -97.74,
    timezone: 'America/Chicago',
    deadline: null,
    working_hours: '07:00–15:30',
    status: 'active',
    active_since: '2026-03-01',
    paused_at: null,
    report_seq: seq,
    created_at: '2026-03-01T00:00:00Z',
  });
  const riverside = site(SITE_RIVERSIDE, 'Riverside Lofts — Block B', 'RL-2041', 186);
  const oakmont = site(SITE_OAKMONT, 'Oakmont Medical Center', 'OM-1187', 120);
  const reporter = (
    id: string,
    name: string,
    phone: string,
    role: ReporterRow['role'],
    languages: string[],
  ): ReporterRow => ({
    id,
    org_id: ORG_ID,
    name,
    phone_e164: phone,
    role,
    languages,
    status: 'verified',
    invited_at: '2026-03-01T00:00:00Z',
    verified_at: '2026-03-01T00:00:00Z',
    last_invite_error: null,
    created_at: '2026-03-01T00:00:00Z',
  });
  const marco = reporter(REPORTER_MARCO, 'Marco Ruiz', PHONE_MARCO, 'site_manager', ['es', 'en']);
  const jorge = reporter(REPORTER_JORGE, 'Jorge Medina', PHONE_JORGE, 'backup', ['es']);

  db.data.orgs.set(org.id, org);
  db.data.settings.set(org.id, settings);
  db.data.sites.set(riverside.id, riverside);
  db.data.sites.set(oakmont.id, oakmont);
  db.data.reporters.set(marco.id, marco);
  db.data.reporters.set(jorge.id, jorge);
  db.data.siteReporters.push({ site_id: riverside.id, reporter_id: marco.id, is_primary: true });
  db.data.siteReporters.push({ site_id: riverside.id, reporter_id: jorge.id, is_primary: false });
  db.data.siteReporters.push({ site_id: oakmont.id, reporter_id: jorge.id, is_primary: false });
  if (opts.multiSiteForMarco)
    db.data.siteReporters.push({ site_id: oakmont.id, reporter_id: marco.id, is_primary: false });
  db.data.recipients.push({ site_id: riverside.id, email: 'lena@kestrel.example' });
  db.data.members.push({
    org_id: ORG_ID,
    user_id: '00000000-0000-4000-8000-00000000e001',
    role: 'admin',
    email: 'lena@kestrel.example',
    display_name: 'Lena Ortiz',
  });
  db.data.members.push({
    org_id: ORG_ID,
    user_id: '00000000-0000-4000-8000-00000000e002',
    role: 'pm',
    email: 'sam@kestrel.example',
    display_name: 'Sam Kowalski',
  });
  for (const c of COMPANIES)
    db.data.companies.set(c.id, { ...c, org_id: ORG_ID, created_at: '2026-03-01T00:00:00Z' });

  let waSeq = 0;
  const h: Harness = {
    ctx,
    db,
    wa,
    email,
    storage,
    get now() {
      return now;
    },
    setNow(d) {
      now = d;
    },
    org,
    settings,
    riverside,
    oakmont,
    marco,
    jorge,
    async conversation(state, context = {}, phone = PHONE_MARCO) {
      const reporterRow = phone === PHONE_JORGE ? jorge : phone === PHONE_MARCO ? marco : null;
      const existing = await db.getConversationByPhone(phone);
      if (existing)
        return db.updateConversation(existing.id, { state, context, last_inbound_at: now });
      const row = await db.ensureConversation(phone, {
        org_id: reporterRow?.org_id ?? null,
        reporter_id: reporterRow?.id ?? null,
        state,
        context,
      });
      return db.updateConversation(row.id, { last_inbound_at: now });
    },
    async inbound(convo, input) {
      const row: MessageRow = {
        id: randomUUID(),
        conversation_id: convo.id,
        direction: 'in',
        wa_message_id: `wamid.in.${++waSeq}`,
        type: input.type,
        body: input.body ?? null,
        payload: input.payload ?? null,
        media_id:
          input.media_id ??
          (input.type === 'audio' || input.type === 'image' ? `media-${waSeq}` : null),
        media_mime:
          input.media_mime ??
          (input.type === 'audio'
            ? 'audio/ogg; codecs=opus'
            : input.type === 'image'
              ? 'image/jpeg'
              : null),
        storage_path: input.storage_path ?? null,
        duration_s: input.duration_s ?? null,
        template_name: null,
        status: 'received',
        error: null,
        created_at: input.created_at ?? now.toISOString(),
      };
      db.data.messages.set(row.id, row);
      if (row.media_id)
        wa.media.set(row.media_id, {
          buffer: Buffer.from('fake-media'),
          mime: row.media_mime,
          sha256: null,
        });
      await db.updateConversation(convo.id, { last_inbound_at: now });
      return row;
    },
    async send(convo, input) {
      const m = await h.inbound(convo, input);
      await h.runJob('inbound_message', { messageId: m.id });
      return m;
    },
    async runJob(type, payload) {
      const handler = registry[type] as (c: Ctx, p: unknown, j: JobRow) => Promise<void>;
      const job: JobRow = {
        id: 0,
        type,
        payload: payload as JobRow['payload'],
        status: 'running',
        attempts: 1,
        run_after: now.toISOString(),
        locked_at: null,
        locked_by: 'test',
        last_error: null,
        dedupe_key: null,
        created_at: now.toISOString(),
        finished_at: null,
      };
      await handler({ ...ctx, metrics: createMetrics() }, payload, job);
    },
    async drain(types) {
      const ran: JobRow[] = [];
      for (let i = 0; i < 50; i++) {
        const next = Array.from(db.data.jobs.values()).find(
          (j) => j.status === 'queued' && (!types || types.includes(j.type as JobTypeKey)),
        );
        if (!next) break;
        next.status = 'running';
        next.attempts += 1;
        const handler = registry[next.type as JobTypeKey] as (
          c: Ctx,
          p: unknown,
          j: JobRow,
        ) => Promise<void>;
        const { parseJobPayload } = await import('@sitelog/shared');
        await handler(
          { ...ctx, metrics: createMetrics() },
          parseJobPayload(next.type as JobTypeKey, next.payload),
          next,
        );
        next.status = 'done';
        ran.push(next);
      }
      return ran;
    },
    claude(client) {
      ctx.ai.claude = client;
    },
    sentTexts() {
      return wa.sent.map((s) => s.body ?? '').filter(Boolean);
    },
  };
  return h;
}

/** A scripted Anthropic Messages client: each call returns the next tool input. */
export function scriptedClaude(
  responses: Array<{ tool?: string; input: unknown } | { text: string }>,
): MessagesClient & { calls: Anthropic.MessageCreateParamsNonStreaming[] } {
  const calls: Anthropic.MessageCreateParamsNonStreaming[] = [];
  let i = 0;
  return {
    calls,
    messages: {
      async create(params) {
        calls.push(params);
        const r = responses[Math.min(i, responses.length - 1)];
        i++;
        if (!r) throw new Error('no scripted response');
        const toolName = (params.tools?.[0] as { name: string } | undefined)?.name ?? 'tool';
        const content: Anthropic.ContentBlock[] =
          'text' in r
            ? [{ type: 'text', text: r.text, citations: null }]
            : [
                {
                  type: 'tool_use',
                  id: `toolu_${i}`,
                  name: r.tool ?? toolName,
                  input: r.input,
                  caller: { type: 'direct' },
                },
              ];
        return {
          id: `msg_${i}`,
          type: 'message',
          role: 'assistant',
          model: params.model,
          content,
          stop_reason: 'text' in r ? 'end_turn' : 'tool_use',
          stop_sequence: null,
          stop_details: null,
          usage: {
            input_tokens: 1000,
            output_tokens: 200,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 500,
            cache_creation: null,
            server_tool_use: null,
            service_tier: null,
            inference_geo: null,
            output_tokens_details: null,
            iterations: null,
            speed: null,
          } as unknown as Anthropic.Usage,
        } as Anthropic.Message;
      },
    },
  };
}

export function buttonPayload(id: string, title: string): MessageRow['payload'] {
  return { interactive: { type: 'button_reply', button_reply: { id, title } } };
}

export function reactionPayload(emoji: string, toWaId: string): MessageRow['payload'] {
  return { reaction: { emoji, message_id: toWaId } };
}
