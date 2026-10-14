import { describe, expect, it, vi } from 'vitest';
import {
  applyCountriesSet,
  type CountriesSetConnection,
  describeEndpoints,
  isLocalDbHost,
  nextEndpoints,
  parseCountriesSetArgs,
  refuseCountriesTarget,
  runCountriesSet,
  SELECT_PACK_SQL,
  SET_ENDPOINTS_SQL,
  senderProblem,
  type PackEndpoints,
  type Query,
} from './countries-set.ts';
import { describeTarget, STAGING_PROJECT_REF } from './seed-target.ts';

const LOCAL = 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
const HOSTED = 'postgresql://postgres:s3cret-pw@db.abcdefghijklmnopqrst.supabase.co:5432/postgres';
const STAGING = `postgresql://postgres.${STAGING_PROJECT_REF}:s3cret-pw@aws-0-eu-central-1.pooler.supabase.com:6543/postgres`;

const TR: PackEndpoints = {
  code: 'TR',
  sms_provider: 'iletimerkezi',
  sms_sender_type: 'alphanumeric',
  sms_sender_id: null,
  voice_number: null,
};
const US: PackEndpoints = {
  code: 'US',
  sms_provider: 'twilio',
  sms_sender_type: 'toll_free',
  sms_sender_id: null,
  voice_number: null,
};

describe('parseCountriesSetArgs', () => {
  it('takes the pack and the values to set or clear; a flag left out keeps the value', () => {
    expect(parseCountriesSetArgs(['--', '--code', 'tr', '--sms-sender', 'SITELOG'])).toEqual({
      code: 'TR',
      smsSenderId: 'SITELOG',
      yes: false,
      allowStaging: false,
    });
    expect(
      parseCountriesSetArgs(['--code=US', '--voice=+15550142290', '--clear-sms-sender', '--yes']),
    ).toEqual({
      code: 'US',
      smsSenderId: null,
      voiceNumber: '+15550142290',
      yes: true,
      allowStaging: false,
    });
    expect(parseCountriesSetArgs(['--code', 'TR', '--clear-voice', '--allow-staging'])).toEqual({
      code: 'TR',
      voiceNumber: null,
      yes: false,
      allowStaging: true,
    });
  });

  it('refuses a missing or malformed pack, conflicting or empty flags and nothing to do', () => {
    expect(() => parseCountriesSetArgs(['--sms-sender', 'SITELOG'])).toThrow('--code is required');
    expect(() => parseCountriesSetArgs(['--code', 'TUR', '--clear-voice'])).toThrow(
      'country code like TR',
    );
    expect(() => parseCountriesSetArgs(['--code', 'TR'])).toThrow('nothing to set');
    expect(() =>
      parseCountriesSetArgs(['--code', 'TR', '--sms-sender', 'SITELOG', '--clear-sms-sender']),
    ).toThrow('conflicts');
    expect(() => parseCountriesSetArgs(['--code', 'TR', '--sms-sender', '  '])).toThrow(
      '--clear-sms-sender',
    );
    expect(() => parseCountriesSetArgs(['--code', 'TR', '--sms-sender'])).toThrow('needs a value');
    expect(() => parseCountriesSetArgs(['--code', 'US', '--voice', '555 014 2290'])).toThrow(
      'E.164',
    );
    expect(() => parseCountriesSetArgs(['--code', 'TR', '--force'])).toThrow('unknown argument');
  });
});

describe('refuseCountriesTarget', () => {
  it('writes to a local database without more flags', () => {
    expect(refuseCountriesTarget({ dbUrl: LOCAL, yes: false, allowStaging: false })).toBeNull();
    expect(isLocalDbHost('localhost')).toBe(true);
    expect(isLocalDbHost('[::1]')).toBe(true);
    expect(isLocalDbHost('db.abcdefghijklmnopqrst.supabase.co')).toBe(false);
  });

  it('needs SUPABASE_DB_URL as a postgres URL', () => {
    expect(refuseCountriesTarget({ dbUrl: '', yes: true, allowStaging: true })).toMatch(
      'SUPABASE_DB_URL is not set',
    );
    expect(
      refuseCountriesTarget({ dbUrl: 'https://x.supabase.co', yes: true, allowStaging: true }),
    ).toMatch('postgres://');
  });

  it('a hosted database needs --yes, the staging project also --allow-staging', () => {
    expect(refuseCountriesTarget({ dbUrl: HOSTED, yes: false, allowStaging: false })).toMatch(
      "owner's approval and --yes",
    );
    expect(refuseCountriesTarget({ dbUrl: HOSTED, yes: true, allowStaging: false })).toBeNull();
    expect(refuseCountriesTarget({ dbUrl: STAGING, yes: true, allowStaging: false })).toMatch(
      `staging project ${STAGING_PROJECT_REF}`,
    );
    // A tunnelled staging database is still staging when SUPABASE_URL names it.
    expect(
      refuseCountriesTarget({
        dbUrl: LOCAL,
        supabaseUrl: `https://${STAGING_PROJECT_REF}.supabase.co`,
        yes: true,
        allowStaging: false,
      }),
    ).toMatch('staging project');
    expect(refuseCountriesTarget({ dbUrl: STAGING, yes: false, allowStaging: true })).toMatch(
      '--yes',
    );
    expect(refuseCountriesTarget({ dbUrl: STAGING, yes: true, allowStaging: true })).toBeNull();
  });

  it('prints the target without its password', () => {
    expect(describeTarget(HOSTED)).not.toContain('s3cret-pw');
    expect(describeTarget(STAGING)).toContain(`Supabase project ${STAGING_PROJECT_REF}`);
    expect(describeTarget(STAGING)).not.toContain('s3cret-pw');
  });
});

describe('pack values', () => {
  it('keeps what a flag leaves out, sets or clears the rest', () => {
    const set = { ...US, sms_sender_id: '+18885550142', voice_number: '+15550142290' };
    expect(nextEndpoints(set, { voiceNumber: null })).toEqual({
      smsSenderId: '+18885550142',
      voiceNumber: null,
    });
    expect(nextEndpoints(TR, { smsSenderId: 'SITELOG' })).toEqual({
      smsSenderId: 'SITELOG',
      voiceNumber: null,
    });
  });

  it('checks the sender against the pack’s sender type', () => {
    expect(senderProblem('alphanumeric', 'SITELOG')).toBeNull();
    expect(senderProblem('alphanumeric', null)).toBeNull();
    expect(senderProblem('alphanumeric', '+905320000000')).toMatch('alphanumeric title');
    expect(senderProblem('alphanumeric', 'SITELOGSITEL')).toMatch('1 to 11');
    expect(senderProblem('toll_free', '+18885550142')).toBeNull();
    expect(senderProblem('toll_free', 'SITELOG')).toMatch('E.164');
    expect(senderProblem('short_code', '12345')).toBeNull();
  });

  it('describes a pack: console and Talk now until set', () => {
    expect(describeEndpoints(TR)).toBe(
      'TR · alphanumeric SMS sender: not set (console transport) · voice number: not set (Talk now only)',
    );
    expect(
      describeEndpoints({ ...US, sms_sender_id: '+18885550142', voice_number: '+15550142290' }),
    ).toBe(
      'US · toll_free SMS sender: +18885550142 (sends through twilio) · voice number: +15550142290',
    );
  });
});

/** The database as applyCountriesSet() meets it, with set_country_endpoints() mirrored. */
function fakeDb(rows: PackEndpoints[]) {
  const calls: Array<{ text: string; params: unknown[] }> = [];
  const query: Query = async (text, params) => {
    calls.push({ text, params });
    if (text === SELECT_PACK_SQL)
      return rows.filter((r) => r.code === params[0]).map((r) => ({ ...r }));
    if (text === SET_ENDPOINTS_SQL) {
      const row = rows.find((r) => r.code === params[0])!;
      row.sms_sender_id = params[1] as string | null;
      row.voice_number = params[2] as string | null;
      return [{ ...row }];
    }
    throw new Error(`unexpected SQL ${text}`);
  };
  return { query, calls };
}

describe('applyCountriesSet', () => {
  it('reads the pack locked, then writes through set_country_endpoints() with kept values', async () => {
    const { query, calls } = fakeDb([{ ...TR }, { ...US, voice_number: '+15550142290' }]);
    const result = await applyCountriesSet(
      query,
      parseCountriesSetArgs(['--code', 'US', '--sms-sender', '+18885550142']),
    );
    expect(calls).toEqual([
      { text: SELECT_PACK_SQL, params: ['US'] },
      { text: SET_ENDPOINTS_SQL, params: ['US', '+18885550142', '+15550142290'] },
    ]);
    expect(SELECT_PACK_SQL).toMatch(/for update$/);
    expect(result).toMatchObject({
      changed: true,
      before: { sms_sender_id: null, voice_number: '+15550142290' },
      after: { sms_sender_id: '+18885550142', voice_number: '+15550142290' },
    });
  });

  it('writes nothing when nothing changes', async () => {
    const { query, calls } = fakeDb([{ ...TR, sms_sender_id: 'SITELOG' }]);
    const result = await applyCountriesSet(
      query,
      parseCountriesSetArgs(['--code', 'TR', '--sms-sender', 'SITELOG']),
    );
    expect(result.changed).toBe(false);
    expect(calls.map((c) => c.text)).toEqual([SELECT_PACK_SQL]);
  });

  it('stops before writing on an unknown pack or a sender of the wrong shape', async () => {
    const { query, calls } = fakeDb([{ ...TR }]);
    await expect(
      applyCountriesSet(query, parseCountriesSetArgs(['--code', 'DE', '--clear-voice'])),
    ).rejects.toThrow('no country pack DE');
    await expect(
      applyCountriesSet(
        query,
        parseCountriesSetArgs(['--code', 'TR', '--sms-sender', '+905320000000']),
      ),
    ).rejects.toThrow('not a valid alphanumeric sender');
    expect(calls.every((c) => c.text === SELECT_PACK_SQL)).toBe(true);
  });
});

describe('runCountriesSet (pnpm countries:set)', () => {
  /** The script's surroundings with a fake database; `connect` records every call. */
  function harness(env: Record<string, string | undefined>, rows: PackEndpoints[] = [{ ...TR }]) {
    const lines: string[] = [];
    const { query } = fakeDb(rows);
    const end = vi.fn(async () => undefined);
    const connect = vi.fn(async (): Promise<CountriesSetConnection> => ({
      transaction: (fn) => fn(query),
      end,
    }));
    return { deps: { env, connect, log: (l: string) => lines.push(l) }, connect, end, lines };
  }
  const SET_TR = ['--code', 'TR', '--sms-sender', 'SITELOG'];

  it.each([
    ['no SUPABASE_DB_URL', {}, SET_TR, 'SUPABASE_DB_URL is not set'],
    ['a hosted database without --yes', { SUPABASE_DB_URL: HOSTED }, SET_TR, '--yes'],
    [
      'the staging project without --allow-staging',
      { SUPABASE_DB_URL: STAGING },
      [...SET_TR, '--yes'],
      `staging project ${STAGING_PROJECT_REF}`,
    ],
    [
      'a local tunnel to staging (SUPABASE_URL)',
      { SUPABASE_DB_URL: LOCAL, SUPABASE_URL: `https://${STAGING_PROJECT_REF}.supabase.co` },
      SET_TR,
      'staging project',
    ],
  ])('refuses %s before connecting', async (_label, env, argv, message) => {
    const h = harness(env);
    await expect(runCountriesSet(argv, h.deps)).rejects.toThrow(message);
    expect(h.connect).not.toHaveBeenCalled();
    expect(h.lines).toEqual([]);
  });

  it('refuses bad flags before reading the environment or connecting', async () => {
    const h = harness({ SUPABASE_DB_URL: LOCAL });
    await expect(runCountriesSet(['--code', 'TR'], h.deps)).rejects.toThrow('nothing to set');
    expect(h.connect).not.toHaveBeenCalled();
  });

  it('writes to an allowed hosted target, logging it without the password', async () => {
    const h = harness({ SUPABASE_DB_URL: ` ${HOSTED} ` });
    const result = await runCountriesSet([...SET_TR, '--yes'], h.deps);
    expect(result).toMatchObject({ changed: true, after: { sms_sender_id: 'SITELOG' } });
    expect(h.connect).toHaveBeenCalledWith(HOSTED);
    expect(h.end).toHaveBeenCalledTimes(1);
    expect(h.lines).toEqual([
      `countries:set → ${describeTarget(HOSTED)}`,
      `  before: ${describeEndpoints(TR)}`,
      `  after:  ${describeEndpoints({ ...TR, sms_sender_id: 'SITELOG' })} (audited as country.endpoints_set)`,
    ]);
    expect(h.lines.join('\n')).not.toContain('s3cret-pw');
  });

  it('says when nothing changed, and closes the connection when the apply fails', async () => {
    const same = harness({ SUPABASE_DB_URL: LOCAL }, [{ ...TR, sms_sender_id: 'SITELOG' }]);
    expect(await runCountriesSet(SET_TR, same.deps)).toMatchObject({ changed: false });
    expect(same.lines.at(-1)).toBe('  unchanged: nothing written');

    const bad = harness({ SUPABASE_DB_URL: LOCAL });
    await expect(
      runCountriesSet(['--code', 'TR', '--sms-sender', '+905320000000'], bad.deps),
    ).rejects.toThrow('not a valid alphanumeric sender');
    expect(bad.end).toHaveBeenCalledTimes(1);
  });
});
