import { describe, expect, it } from 'vitest';
import { WHATSAPP_KEYS } from '@sitelog/shared/channels.ts';
import { LANGUAGES } from '@sitelog/shared/locale.ts';
import { whatsappTemplatesFor } from '@sitelog/shared/whatsapp/templates.ts';
import type { CountriesSetConnection, PackEndpoints, Query } from './countries-set.ts';
import {
  approvalBody,
  buildPlan,
  contentCreateBody,
  parseApproval,
  parseContentPage,
  parseWhatsappTemplatesArgs,
  runWhatsappTemplates,
  SAMPLES,
  sampleVariables,
  submitTemplates,
  syncPack,
  templateName,
  twilioContentClient,
  type ContentRecord,
  type Fetch,
} from './whatsapp-templates.ts';

const WA = { whatsapp_provider: 'twilio', whatsapp_sender_id: null, whatsapp_templates: null };
const TR: PackEndpoints = {
  code: 'TR',
  sms_provider: 'twilio',
  sms_sender_type: 'long_code',
  sms_sender_id: null,
  voice_number: null,
  field_locales: ['tr-TR', 'en-US'],
  ...WA,
};
const US: PackEndpoints = {
  code: 'US',
  sms_provider: 'twilio',
  sms_sender_type: 'toll_free',
  sms_sender_id: null,
  voice_number: null,
  field_locales: ['en-US', 'es-US'],
  ...WA,
};
const ACCOUNT = `AC${'1'.repeat(32)}`;
const TOKEN = 'tw-auth-token-secret';
const LOCAL = 'postgresql://postgres:s3cret-pw@127.0.0.1:54322/postgres';
const hx = (n: number) => `HX${n.toString(16).padStart(32, '0')}`;

/** A fake Content API: records every request, answers from its own store. */
function fakeTwilio(
  initial: ContentRecord[] = [],
  opts: { pageSize?: number; failCreate?: string } = {},
) {
  const store = [...initial];
  const calls: Array<{ method: string; url: string; body: unknown; auth: string | null }> = [];
  let next = 0x100;
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const fetch: Fetch = async (url, init) => {
    const u = new URL(url);
    const body = typeof init.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
    const method = init.method ?? 'GET';
    calls.push({
      method,
      url: u.pathname + u.search,
      body,
      auth: new Headers(init.headers).get('authorization'),
    });
    if (method === 'GET' && u.pathname === '/v1/ContentAndApprovals') {
      const size = opts.pageSize ?? 500;
      const page = Number(u.searchParams.get('Page') ?? '0');
      const slice = store.slice(page * size, (page + 1) * size);
      const more = (page + 1) * size < store.length;
      return json(200, {
        contents: slice.map((c) => ({
          sid: c.sid,
          friendly_name: c.friendlyName,
          language: c.language,
          types: c.body === null ? {} : { 'twilio/text': { body: c.body } },
          approval_requests: c.approval
            ? {
                status: c.approval.status,
                category: c.approval.category,
                rejection_reason: c.approval.rejectionReason ?? '',
                name: c.approval.name,
              }
            : {},
        })),
        meta: {
          next_page_url: more
            ? `https://content.twilio.com/v1/ContentAndApprovals?PageSize=${size}&Page=${page + 1}`
            : null,
        },
      });
    }
    if (method === 'POST' && u.pathname === '/v1/Content') {
      const b = body as { friendly_name: string; language: string; types: Record<string, unknown> };
      if (b.friendly_name === opts.failCreate)
        return json(400, { code: 20001, message: 'Invalid variables' });
      const sid = hx(next++);
      const text = b.types['twilio/text'] as { body: string } | undefined;
      store.push({
        sid,
        friendlyName: b.friendly_name,
        language: b.language,
        body: text?.body ?? null,
        approval: null,
      });
      return json(201, { sid, friendly_name: b.friendly_name });
    }
    const m = /^\/v1\/Content\/(HX\w+)\/ApprovalRequests\/whatsapp$/.exec(u.pathname);
    if (method === 'POST' && m) {
      const c = store.find((x) => x.sid === m[1]);
      const b = body as { name: string; category: string };
      if (c)
        c.approval = {
          status: 'received',
          category: b.category,
          rejectionReason: null,
          name: b.name,
        };
      return json(201, { name: b.name, category: b.category, status: 'received' });
    }
    return json(404, { message: 'not found' });
  };
  return { fetch, calls, store };
}

describe('parseWhatsappTemplatesArgs', () => {
  it('takes a mode, packs and languages', () => {
    expect(
      parseWhatsappTemplatesArgs(['--', '--submit', '--code', 'tr,us', '--lang', 'TR,en', '--yes']),
    ).toEqual({
      mode: 'submit',
      codes: ['TR', 'US'],
      languages: ['tr', 'en'],
      dryRun: false,
      yes: true,
      allowStaging: false,
    });
    expect(parseWhatsappTemplatesArgs(['--sync', '--code=TR'])).toMatchObject({
      mode: 'sync',
      codes: ['TR'],
      languages: null,
    });
  });

  it('refuses a missing mode or pack, both modes, bad values and a sync dry run', () => {
    expect(() => parseWhatsappTemplatesArgs(['--code', 'TR'])).toThrow('--submit');
    expect(() => parseWhatsappTemplatesArgs(['--submit'])).toThrow('--code is required');
    expect(() => parseWhatsappTemplatesArgs(['--submit', '--sync', '--code', 'TR'])).toThrow(
      'one of',
    );
    expect(() => parseWhatsappTemplatesArgs(['--submit', '--code', 'TUR'])).toThrow('TR,US');
    expect(() => parseWhatsappTemplatesArgs(['--submit', '--code', 'TR', '--lang', 'de'])).toThrow(
      'en, es, tr',
    );
    expect(() => parseWhatsappTemplatesArgs(['--sync', '--code', 'TR', '--dry-run'])).toThrow(
      '--dry-run goes with --submit',
    );
    expect(() => parseWhatsappTemplatesArgs(['--submit', '--code', 'TR', '--x'])).toThrow(
      'unknown argument',
    );
  });
});

describe('names, categories and samples', () => {
  it('names templates talkolog_<key>_<lang>, the welcome v2 (§19 Q373)', () => {
    expect(templateName('daily_link', 'tr')).toBe('talkolog_daily_link_tr');
    expect(templateName('welcome', 'en')).toBe('talkolog_welcome_v2_en');
    expect(templateName('verify_code', 'es')).toBe('talkolog_verify_code_es');
  });

  it('has a sample for every variable of every template, with and without a voice number', () => {
    for (const voiceNumber of [null, '+15550142290'] as const)
      for (const t of whatsappTemplatesFor({
        voiceNumber: voiceNumber as never,
        fieldLocales: ['en-US', 'es-US', 'tr-TR'],
      })) {
        const vars = sampleVariables(t, t.language);
        expect(Object.keys(vars)).toHaveLength(t.variables.length);
        for (const v of Object.values(vars)) expect(v.trim()).not.toBe('');
      }
    for (const l of LANGUAGES)
      expect(Object.keys(SAMPLES[l]).sort()).toEqual(Object.keys(SAMPLES.en).sort());
    expect(SAMPLES.tr.site).toBe('İnallar Hayat 2');
    expect(SAMPLES.tr.deadline).toBe('17:30');
  });
});

describe('buildPlan and the request bodies', () => {
  it('plans one template per name, shared by the packs that use it, in the chosen languages', () => {
    const plan = buildPlan([TR, US], ['tr', 'en']);
    expect(plan).toHaveLength(WHATSAPP_KEYS.length * 2);
    const daily = plan.find((p) => p.name === 'talkolog_daily_link_en')!;
    expect(daily.codes).toEqual(['TR', 'US']);
    expect(plan.some((p) => p.language === 'es')).toBe(false);
    expect(buildPlan([US], null).map((p) => p.language)).toContain('es');
  });

  it('refuses a name two packs need with different bodies (one has a voice number)', () => {
    expect(() => buildPlan([TR, { ...US, voice_number: '+15550142290' }], ['en'])).toThrow(
      'different bodies',
    );
  });

  it('builds a Utility text and an Authentication template as Twilio takes them', () => {
    const plan = buildPlan([TR], ['tr']);
    const welcome = plan.find((p) => p.key === 'welcome')!;
    expect(contentCreateBody(welcome)).toEqual({
      friendly_name: 'talkolog_welcome_v2_tr',
      language: 'tr',
      variables: {
        '1': 'Mehmet',
        '2': 'Demir Yapı',
        '3': 'İnallar Hayat 2',
        '4': '17:30',
        '5': 'https://go.talkolog.com/r/K7Q2MX4P9ZTA',
      },
      types: { 'twilio/text': { body: welcome.template.body } },
    });
    expect(approvalBody(welcome)).toEqual({
      name: 'talkolog_welcome_v2_tr',
      category: 'UTILITY',
      allow_category_change: false,
    });
    const code = plan.find((p) => p.key === 'verify_code')!;
    expect(contentCreateBody(code)).toEqual({
      friendly_name: 'talkolog_verify_code_tr',
      language: 'tr',
      variables: { '1': '482913' },
      types: {
        'whatsapp/authentication': {
          add_security_recommendation: true,
          code_expiration_minutes: 10,
          actions: [{ type: 'COPY_CODE', copy_code_text: 'Kodu kopyala' }],
        },
      },
    });
    expect(approvalBody(code)).toMatchObject({ category: 'AUTHENTICATION' });
    const en = buildPlan([US], ['en', 'es']).filter((p) => p.key === 'verify_code');
    expect(en.map((p) => (contentCreateBody(p).types as never)['whatsapp/authentication'])).toEqual(
      [
        expect.objectContaining({ actions: [{ type: 'COPY_CODE', copy_code_text: 'Copy code' }] }),
        expect.objectContaining({
          actions: [{ type: 'COPY_CODE', copy_code_text: 'Copiar código' }],
        }),
      ],
    );
  });
});

describe('response parsing', () => {
  it('reads an approval nested under whatsapp or flat, and none', () => {
    expect(
      parseApproval({
        whatsapp: { status: 'APPROVED', category: 'utility', rejection_reason: '', name: 'n' },
      }),
    ).toEqual({ status: 'approved', category: 'UTILITY', rejectionReason: null, name: 'n' });
    expect(
      parseApproval({
        status: 'rejected',
        category: 'MARKETING',
        rejection_reason: 'INVALID_FORMAT',
      }),
    ).toEqual({
      status: 'rejected',
      category: 'MARKETING',
      rejectionReason: 'INVALID_FORMAT',
      name: null,
    });
    expect(parseApproval({})).toBeNull();
    expect(parseApproval(null)).toBeNull();
  });

  it('reads a ContentAndApprovals page and refuses one with no contents', () => {
    expect(
      parseContentPage({
        contents: [
          {
            sid: hx(1),
            friendly_name: 'a',
            language: 'en',
            types: { 'twilio/text': { body: 'B' } },
            approval_requests: { status: 'pending', category: 'UTILITY' },
          },
          { sid: hx(2) },
        ],
        meta: { next_page_url: 'https://content.twilio.com/v1/ContentAndApprovals?Page=1' },
      }),
    ).toEqual({
      items: [
        {
          sid: hx(1),
          friendlyName: 'a',
          language: 'en',
          body: 'B',
          approval: { status: 'pending', category: 'UTILITY', rejectionReason: null, name: null },
        },
      ],
      next: 'https://content.twilio.com/v1/ContentAndApprovals?Page=1',
    });
    expect(() => parseContentPage({ message: 'x' })).toThrow('no contents');
  });

  it('follows next pages on the Content API only, with basic auth, and reports errors without the token', async () => {
    const twilio = fakeTwilio(
      [1, 2, 3].map((n) => ({
        sid: hx(n),
        friendlyName: `t${n}`,
        language: 'en',
        body: null,
        approval: null,
      })),
      { pageSize: 2 },
    );
    const client = twilioContentClient({
      accountSid: ACCOUNT,
      authToken: TOKEN,
      fetch: twilio.fetch,
    });
    expect((await client.listContent()).map((r) => r.friendlyName)).toEqual(['t1', 't2', 't3']);
    expect(twilio.calls).toHaveLength(2);
    expect(twilio.calls[0]!.auth).toBe(
      `Basic ${Buffer.from(`${ACCOUNT}:${TOKEN}`).toString('base64')}`,
    );

    const offsite: Fetch = async () =>
      new Response(
        JSON.stringify({ contents: [], meta: { next_page_url: 'https://evil.example/x' } }),
      );
    await expect(
      twilioContentClient({ accountSid: ACCOUNT, authToken: TOKEN, fetch: offsite }).listContent(),
    ).rejects.toThrow('refusing a URL');

    const failing: Fetch = async () =>
      new Response(JSON.stringify({ code: 20003, message: 'Authenticate' }), { status: 401 });
    const err = await twilioContentClient({ accountSid: ACCOUNT, authToken: TOKEN, fetch: failing })
      .listContent()
      .catch((e: Error) => e);
    expect(String(err)).toContain('HTTP 401');
    expect(String(err)).toContain('20003 Authenticate');
    expect(String(err)).not.toContain(TOKEN);
  });
});

describe('submitTemplates', () => {
  it('creates and submits only the missing ones; submits one created but never submitted', async () => {
    const plan = buildPlan([TR], ['tr']);
    const twilio = fakeTwilio([
      {
        sid: hx(1),
        friendlyName: 'talkolog_welcome_v2_tr',
        language: 'tr',
        body: plan.find((p) => p.key === 'welcome')!.template.body,
        approval: {
          status: 'approved',
          category: 'UTILITY',
          rejectionReason: null,
          name: 'talkolog_welcome_v2_tr',
        },
      },
      {
        sid: hx(2),
        friendlyName: 'talkolog_filed_tr',
        language: 'tr',
        body: 'old body',
        approval: null,
      },
    ]);
    const client = twilioContentClient({
      accountSid: ACCOUNT,
      authToken: TOKEN,
      fetch: twilio.fetch,
    });
    const rows = await submitTemplates(plan, client);
    expect(rows.find((r) => r.key === 'welcome')).toMatchObject({
      action: 'exists',
      status: 'approved',
      sid: hx(1),
    });
    expect(rows.find((r) => r.key === 'filed')).toMatchObject({
      action: 'submitted',
      status: 'received',
      sid: hx(2),
      bodyDiffers: true,
    });
    expect(rows.filter((r) => r.action === 'created')).toHaveLength(WHATSAPP_KEYS.length - 2);
    const creates = twilio.calls.filter((c) => c.method === 'POST' && c.url === '/v1/Content');
    expect(creates).toHaveLength(WHATSAPP_KEYS.length - 2);
    const approvals = twilio.calls.filter((c) => c.url.endsWith('/ApprovalRequests/whatsapp'));
    expect(approvals).toHaveLength(WHATSAPP_KEYS.length - 1);

    // A re-run creates and submits nothing.
    const again = await submitTemplates(plan, client);
    expect(again.every((r) => r.action === 'exists')).toBe(true);
    expect(twilio.calls.filter((c) => c.method === 'POST')).toHaveLength(
      creates.length + approvals.length,
    );
  });

  it('marks a failure and goes on; with no client (dry run) calls nothing', async () => {
    const plan = buildPlan([TR], ['en']);
    const twilio = fakeTwilio([], { failCreate: 'talkolog_daily_link_en' });
    const rows = await submitTemplates(
      plan,
      twilioContentClient({ accountSid: ACCOUNT, authToken: TOKEN, fetch: twilio.fetch }),
    );
    expect(rows.find((r) => r.key === 'daily_link')).toMatchObject({ action: 'failed' });
    expect(rows.find((r) => r.key === 'daily_link')!.error).toContain('20001 Invalid variables');
    expect(rows.filter((r) => r.action === 'created')).toHaveLength(WHATSAPP_KEYS.length - 1);
    expect((await submitTemplates(plan, null)).every((r) => r.action === 'would create')).toBe(
      true,
    );
  });
});

describe('syncPack', () => {
  const plan = buildPlan([TR], ['tr', 'en']);
  const body = (name: string) => plan.find((p) => p.name === name)!.template.body;
  const approved = (
    n: number,
    name: string,
    category = 'UTILITY',
    b: string | null = body(name),
  ): ContentRecord => ({
    sid: hx(n),
    friendlyName: name,
    language: name.slice(-2),
    body: b,
    approval: { status: 'approved', category, rejectionReason: null, name },
  });

  it('sets approved Utility and Authentication templates, keeps other entries, never Marketing', () => {
    const pack: PackEndpoints = {
      ...TR,
      whatsapp_templates: { daily_link: { tr: hx(99), en: hx(98) }, filed: { tr: hx(97) } },
    };
    const records: ContentRecord[] = [
      approved(1, 'talkolog_welcome_v2_tr'),
      // The first welcome (Marketing, §19 Q373): another name, never read.
      approved(2, 'talkolog_welcome_tr', 'MARKETING', 'x'),
      approved(3, 'talkolog_verify_code_tr', 'AUTHENTICATION', null),
      approved(4, 'talkolog_daily_link_tr'),
      approved(5, 'talkolog_reminder_1_tr', 'MARKETING'),
      {
        ...approved(6, 'talkolog_reminder_2_tr'),
        approval: {
          status: 'rejected',
          category: 'UTILITY',
          rejectionReason: 'INVALID_FORMAT',
          name: null,
        },
      },
      approved(7, 'talkolog_draft_ready_tr', 'UTILITY', 'a stale body'),
      approved(8, 'talkolog_filed_tr'),
    ];
    const { rows, templates } = syncPack(pack, records, null);
    const by = (name: string) => rows.find((r) => r.name === name)!;
    expect(by('talkolog_welcome_v2_tr').outcome).toBe('set');
    expect(by('talkolog_verify_code_tr').outcome).toBe('set');
    expect(by('talkolog_daily_link_tr').outcome).toBe('set');
    expect(by('talkolog_reminder_1_tr')).toMatchObject({
      outcome: 'wrong category',
      category: 'MARKETING',
    });
    expect(by('talkolog_reminder_2_tr')).toMatchObject({
      outcome: 'not approved',
      rejectionReason: 'INVALID_FORMAT',
    });
    expect(by('talkolog_draft_ready_tr').outcome).toBe('body differs');
    expect(by('talkolog_photos_link_tr').outcome).toBe('missing');
    expect(templates).toEqual({
      daily_link: { tr: hx(4), en: hx(98) },
      filed: { tr: hx(8) },
      welcome: { tr: hx(1) },
      verify_code: { tr: hx(3) },
    });
    expect(by('talkolog_filed_tr').outcome).toBe('set');
    // Twice: everything already set.
    const again = syncPack({ ...pack, whatsapp_templates: templates }, records, null);
    expect(again.templates).toEqual(templates);
    expect(again.rows.filter((r) => r.outcome === 'set')).toEqual([]);
  });

  it('a verify_code approved as Utility is not set', () => {
    const { rows, templates } = syncPack(
      TR,
      [approved(3, 'talkolog_verify_code_en', 'UTILITY', null)],
      ['en'],
    );
    expect(rows.find((r) => r.key === 'verify_code')!.outcome).toBe('wrong category');
    expect(templates).toBeNull();
  });
});

describe('runWhatsappTemplates', () => {
  /** A fake database: the two packs, and the set_country_endpoints() writes. */
  function fakeDb(packs: PackEndpoints[]) {
    const rows = new Map(packs.map((p) => [p.code, structuredClone(p)]));
    const writes: unknown[][] = [];
    const calls = { connect: 0, end: 0 };
    const query: Query = async (text, params) => {
      if (/from set_country_endpoints/.test(text)) {
        writes.push(params);
        const row = rows.get(params[0] as string)!;
        row.whatsapp_templates = params[4] === null ? null : JSON.parse(params[4] as string);
        return [structuredClone(row)];
      }
      const row = rows.get(params[0] as string);
      return row ? [structuredClone(row)] : [];
    };
    const connect = async (): Promise<CountriesSetConnection> => {
      calls.connect += 1;
      return { transaction: (fn) => fn(query), end: async () => void (calls.end += 1) };
    };
    return { connect, rows, writes, calls };
  }
  const env = { SUPABASE_DB_URL: LOCAL, TWILIO_ACCOUNT_SID: ACCOUNT, TWILIO_AUTH_TOKEN: TOKEN };

  it('a dry run reads the packs, calls Twilio never and needs no credentials', async () => {
    const db = fakeDb([TR, US]);
    const lines: string[] = [];
    const twilio = fakeTwilio();
    const result = await runWhatsappTemplates(
      ['--submit', '--code', 'TR,US', '--lang', 'tr,en', '--dry-run'],
      {
        env: { SUPABASE_DB_URL: LOCAL },
        connect: db.connect,
        fetch: twilio.fetch,
        log: (l) => lines.push(l),
      },
    );
    expect(twilio.calls).toEqual([]);
    expect(result.mode).toBe('submit');
    expect(result.rows).toHaveLength(WHATSAPP_KEYS.length * 2);
    expect(db.calls).toEqual({ connect: 1, end: 1 });
    const out = lines.join('\n');
    expect(out).toContain('talkolog_welcome_v2_tr');
    expect(out).toContain('Kodu kopyala');
    expect(out).not.toContain('s3cret-pw');
  });

  it('submit then sync: creates, and once approved writes the sids audited, without the token or a phone number in the output', async () => {
    const voiced = { ...US, voice_number: '+15550142290' };
    const db = fakeDb([voiced]);
    const twilio = fakeTwilio();
    const lines: string[] = [];
    const deps = {
      env,
      connect: db.connect,
      fetch: twilio.fetch,
      log: (l: string) => lines.push(l),
    };
    const submitted = await runWhatsappTemplates(
      ['--submit', '--code', 'US', '--lang', 'en'],
      deps,
    );
    if (submitted.mode !== 'submit') throw new Error('expected a submit result');
    expect(submitted.rows.every((r) => r.action === 'created')).toBe(true);

    // Meta approves all; it recategorises one.
    for (const c of twilio.store) {
      c.approval = { ...c.approval!, status: 'approved' };
      if (c.friendlyName === 'talkolog_filed_en') c.approval.category = 'MARKETING';
    }
    const synced = await runWhatsappTemplates(['--sync', '--code', 'US', '--lang', 'en'], deps);
    expect(synced).toMatchObject({ mode: 'sync', changed: ['US'] });
    expect(db.writes).toHaveLength(1);
    const written = db.rows.get('US')!.whatsapp_templates!;
    expect(Object.keys(written)).toHaveLength(WHATSAPP_KEYS.length - 1);
    expect(written.filed).toBeUndefined();
    expect(written.verify_code?.en).toMatch(/^HX/);
    const out = lines.join('\n');
    expect(out).toContain('talkolog_filed_en (MARKETING)');
    expect(out).toContain('country.endpoints_set');
    expect(out).not.toContain(TOKEN);
    expect(out).not.toContain('5550142290');

    // A second sync writes nothing.
    const again = await runWhatsappTemplates(['--sync', '--code', 'US', '--lang', 'en'], deps);
    expect(again).toMatchObject({ changed: [] });
    expect(db.writes).toHaveLength(1);
  });

  it('refuses without credentials, and a hosted database without --yes before connecting', async () => {
    const db = fakeDb([TR]);
    const twilio = fakeTwilio();
    const base = { connect: db.connect, fetch: twilio.fetch, log: () => undefined };
    await expect(
      runWhatsappTemplates(['--sync', '--code', 'TR'], {
        ...base,
        env: { SUPABASE_DB_URL: LOCAL },
      }),
    ).rejects.toThrow('TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN');
    await expect(
      runWhatsappTemplates(['--sync', '--code', 'TR'], {
        ...base,
        env: {
          ...env,
          SUPABASE_DB_URL:
            'postgresql://postgres:pw@db.abcdefghijklmnopqrst.supabase.co:5432/postgres',
        },
      }),
    ).rejects.toThrow('--yes');
    expect(db.calls.connect).toBe(0);
    expect(twilio.calls).toEqual([]);
  });

  it('fails the run when a template failed, after printing the table', async () => {
    const db = fakeDb([TR]);
    const twilio = fakeTwilio([], { failCreate: 'talkolog_filed_tr' });
    const lines: string[] = [];
    await expect(
      runWhatsappTemplates(['--submit', '--code', 'TR', '--lang', 'tr'], {
        env,
        connect: db.connect,
        fetch: twilio.fetch,
        log: (l) => lines.push(l),
      }),
    ).rejects.toThrow('1 template(s) failed: talkolog_filed_tr');
    expect(lines.join('\n')).toContain('| talkolog_filed_tr |');
  });
});
