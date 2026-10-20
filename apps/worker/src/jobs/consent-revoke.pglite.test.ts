import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createConsoleSmsTransport } from '@sitelog/shared';
import { testConfig } from '../config';
import { createWorkerNotifier } from '../messaging';
import { startPgliteDatabase, type PgliteDatabase } from '../test/pglite';

/**
 * F15 on PGlite (W2-02): texts turned off in the recorder's Settings (`field_revoke_consent()`,
 * what field-api's `consent/revoke` calls) make the Notifier skip SMS for every key, audited
 * `notify.skipped` with `no_consent`, while the device code the person asks for still goes (spec
 * §19 Q25). No `messages` row is written for the skipped text. Settings' *Turn on*
 * (`field_grant_consent()`, spec §19 Q86) brings texts back, never past an opt-out.
 */

let pg: PgliteDatabase;
let MARCO = '';
const MARCO_PHONE = '+15550143378';

function notifier() {
  const config = testConfig();
  return createWorkerNotifier(
    config,
    pg.db,
    () => createConsoleSmsTransport(() => randomUUID()),
    () => new Date(),
  );
}

beforeAll(async () => {
  pg = await startPgliteDatabase({ seed: true });
  const [m] = await pg.q<{ id: string }>(`select id from reporters where phone_e164 = $1`, [
    MARCO_PHONE,
  ]);
  MARCO = m!.id;
});

afterAll(async () => {
  await pg?.close();
});

describe('a revoked sms consent (F15 Settings)', () => {
  it('skips the next daily_link with no_consent; the device code still goes', async () => {
    const n = notifier();
    const vars = { site: 'Riverside Lofts', link: 'https://go.talkolog.com/r/ABCDEF' };
    const before = await n.send(MARCO, 'daily_link', vars, { dedupeKey: 'w202:before' });
    expect(before.channel).toBe('sms');

    const [r] = await pg.q<{ r: { revoked: boolean } }>(
      `select field_revoke_consent($1, 'sms', null) as r`,
      [MARCO],
    );
    expect(r!.r.revoked).toBe(true);

    const after = await n.send(MARCO, 'daily_link', vars, { dedupeKey: 'w202:after' });
    expect(after).toMatchObject({ channel: null, reason: 'no_consent' });
    expect(
      await pg.q(`select id from messages where payload->>'dedupe_key' = 'w202:after'`),
    ).toEqual([]);
    const [skipped] = await pg.q<{ diff: Record<string, unknown> }>(
      `select diff from audit_log where action = 'notify.skipped' and entity_id = $1
       order by id desc limit 1`,
      [MARCO],
    );
    expect(skipped!.diff).toMatchObject({ copy_key: 'daily_link', reason: 'no_consent' });

    // Consent-free: on the US order (WhatsApp first since §19 Q372; console for this demo org).
    const code = await n.send(MARCO, 'verify_code', { code: '042917' });
    expect(code.channel).toBe('whatsapp');
    expect(
      (await n.send(MARCO, 'verify_code', { code: '042918' }, { channels: ['sms'] })).channel,
    ).toBe('sms');
  });

  it('Turn on (spec §19 Q86) brings texts back; an opted-out phone stays opted out', async () => {
    const n = notifier();
    const vars = { site: 'Riverside Lofts', link: 'https://go.talkolog.com/r/ABCDEF' };
    const [g] = await pg.q<{ r: { granted: boolean } }>(
      `select field_grant_consent($1, 'sms', 'field.consent.v1', null, null) as r`,
      [MARCO],
    );
    expect(g!.r.granted).toBe(true);
    const back = await n.send(MARCO, 'daily_link', vars, { dedupeKey: 'q86:on' });
    expect(back.channel).toBe('sms');

    // STOP on the pack's sender: the consent is held, yet nothing goes and Turn on is refused.
    await pg.q(
      `insert into sms_opt_outs (phone_e164, country, method) values ($1, 'US', 'sms_keyword')`,
      [MARCO_PHONE],
    );
    const stopped = await n.send(MARCO, 'daily_link', vars, { dedupeKey: 'q86:stopped' });
    expect(stopped).toMatchObject({ channel: null, reason: 'opted_out' });
    await pg.q(`select field_revoke_consent($1, 'sms', null)`, [MARCO]);
    await expect(
      pg.q(`select field_grant_consent($1, 'sms', 'field.consent.v1', null, null)`, [MARCO]),
    ).rejects.toThrow('texts_opted_out');
  });
});
