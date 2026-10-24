import { beforeAll, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { DEMO_SITELOG_NUMBER } from '@sitelog/shared/demo/kestrel.ts';
import { asService, bootDatabase } from './harness.ts';

/**
 * 20261017000460_disclosure_version.sql (W4-06; spec §9.1, §9.4 "Disclosure", §19 Q28): the
 * recording notice version a call played, `calls.disclosure_version`, set by voice_call_update()
 * with the disclosure mark only, kept once set, audited in the same `call.updated` diff; the old
 * four-argument call still works.
 */

const ID = (n: number) => `d15c0460-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const KEVIN_PHONE = '+15550142087';

let db: PGlite;

async function svc<T = Record<string, unknown>>(sql: string, params: unknown[] = []) {
  return (await asService(db, (q) => q<T>(sql, params))).rows;
}

async function failure(sql: string, params: unknown[] = []): Promise<string | null> {
  try {
    await svc(sql, params);
    return null;
  } catch (err) {
    return (err as Error).message;
  }
}

const start = (n: number) =>
  svc<{ r: { callId: string } }>(`select voice_call_start($1, 'pstn', null, $2, $3) as r`, [
    `call-${ID(n)}`,
    KEVIN_PHONE,
    DEMO_SITELOG_NUMBER,
  ]).then((rows) => rows[0]!.r.callId);

const update = (callId: string, played: boolean | null, version: string | null) =>
  svc<{ r: Record<string, unknown> }>(
    `select voice_call_update(p_call_id => $1, p_disclosure_played => $2,
                              p_disclosure_version => $3) as r`,
    [callId, played, version],
  ).then((rows) => rows[0]!.r);

const row = (id: string) =>
  svc<{ disclosure_played: boolean; disclosure_version: string | null }>(
    `select disclosure_played, disclosure_version from calls where id = $1`,
    [id],
  ).then((r) => r[0]!);

beforeAll(async () => {
  db = await bootDatabase({ seed: true });
  await svc(`update countries set voice_number = $1 where code = 'US'`, [DEMO_SITELOG_NUMBER]);
});

describe('calls.disclosure_version (W4-06)', () => {
  it('is set with the disclosure mark only, kept once set, and audited', async () => {
    const id = await start(1);
    // A version without the mark sets nothing.
    expect(await update(id, null, 'voice.recording_notice.v1')).toMatchObject({
      disclosurePlayed: false,
      disclosureVersion: null,
      changed: false,
    });
    expect(await update(id, true, 'US.recording_notice.v2')).toMatchObject({
      disclosurePlayed: true,
      disclosureVersion: 'US.recording_notice.v2',
      changed: true,
    });
    // A repeat with another version changes nothing: the first notice played is the one kept.
    expect(await update(id, true, 'voice.recording_notice.v1')).toMatchObject({
      disclosureVersion: 'US.recording_notice.v2',
      changed: false,
    });
    expect(await row(id)).toEqual({
      disclosure_played: true,
      disclosure_version: 'US.recording_notice.v2',
    });
    const audits = await svc<{ diff: Record<string, unknown>; actor_type: string }>(
      `select diff, actor_type from audit_log where entity = 'call' and entity_id = $1
         and action = 'call.updated' order by id`,
      [id],
    );
    expect(audits).toEqual([
      {
        actor_type: 'agent',
        diff: { disclosure_played: true, disclosure_version: 'US.recording_notice.v2' },
      },
    ]);
  });

  it('a mark without a version (an older agent) leaves it null; the old call shape still works', async () => {
    const id = await start(2);
    const [{ r }] = (await svc<{ r: Record<string, unknown> }>(
      `select voice_call_update($1, null, true) as r`,
      [id],
    )) as [{ r: Record<string, unknown> }];
    expect(r).toMatchObject({ disclosurePlayed: true, disclosureVersion: null, changed: true });
    expect(await row(id)).toEqual({ disclosure_played: true, disclosure_version: null });
  });

  it('refuses a version that is not an id', async () => {
    const id = await start(3);
    expect(
      await failure(`update calls set disclosure_version = 'a b' where id = $1`, [id]),
    ).toMatch(/check constraint/);
  });
});
