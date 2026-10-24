import { beforeAll, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { asService, asUser, bootDatabase } from './harness.ts';

/**
 * W4-03 (20261017000420_team_v1_2.sql; spec P10, F15, F16, F24, §19 Q242–Q244): Team's RPCs.
 * update_reporter_contact() and revoke_reporter_devices() for admin and ops of the reporter's org
 * only, audited `via office`; the attestation a preference or channel change needs; a channel or
 * language the pack does not offer refused; clear_reporter_opt_out() for an admin on a one-way
 * pack only, never a STOP the person sent; team_reporter_states() with the welcome's attempts.
 */

const ADMIN = 'eeeeeeee-1111-4111-8111-000000000001';
const OPS = 'eeeeeeee-1111-4111-8111-000000000002';
const PM = 'eeeeeeee-1111-4111-8111-000000000003';
const OUTSIDER = 'eeeeeeee-1111-4111-8111-000000000004';
const TR_ADMIN = 'eeeeeeee-1111-4111-8111-000000000005';
const TR_OPS = 'eeeeeeee-1111-4111-8111-000000000006';

const MARCO = 'eeeeeeee-2222-4222-8222-000000000001';
const JORGE = 'eeeeeeee-2222-4222-8222-000000000002';
const EMRE = 'eeeeeeee-2222-4222-8222-000000000003';
const MURAT = 'eeeeeeee-2222-4222-8222-000000000004';

let db: PGlite;
let usOrg: string;
let trOrg: string;

async function createOrg(user: string, email: string, name: string, country: 'US' | 'TR') {
  return asUser(
    db,
    user,
    async (q) =>
      (
        await q<{ r: { id: string } }>(`select create_org($1, null, null, null, $2) as r`, [
          name,
          country,
        ])
      ).rows[0]!.r.id,
    email,
  );
}

const as = <T>(user: string, sql: string, params: unknown[] = []) =>
  asUser(db, user, (q) => q<T>(sql, params));

async function reporter(id: string) {
  const r = await asService(db, (q) =>
    q<{
      contact_pref: string;
      message_channel: string | null;
      locale: string;
      status: string;
      opted_out_at: string | null;
    }>(
      `select contact_pref::text, message_channel::text, locale, status::text, opted_out_at
       from reporters where id = $1`,
      [id],
    ),
  );
  return r.rows[0]!;
}

async function audits(entityId: string, action: string) {
  const r = await asService(db, (q) =>
    q<{ actor_id: string | null; diff: Record<string, unknown> }>(
      `select actor_id, diff from audit_log where entity_id = $1 and action = $2 order by id`,
      [entityId, action],
    ),
  );
  return r.rows;
}

beforeAll(async () => {
  db = await bootDatabase();
  await db.exec(`
    insert into auth.users (id, email) values
      ('${ADMIN}', 'lena@kestrel.test'), ('${OPS}', 'sam@kestrel.test'), ('${PM}', 'pm@kestrel.test'),
      ('${OUTSIDER}', 'x@other.test'), ('${TR_ADMIN}', 'elif@demir.test'), ('${TR_OPS}', 'ops@demir.test');
  `);
  usOrg = await createOrg(ADMIN, 'lena@kestrel.test', 'Kestrel', 'US');
  trOrg = await createOrg(TR_ADMIN, 'elif@demir.test', 'Demir Yapı', 'TR');
  await createOrg(OUTSIDER, 'x@other.test', 'Other GC', 'US');
  await db.exec('reset role;');
  await db.exec(`
    insert into org_members (org_id, user_id, role) values
      ('${usOrg}', '${OPS}', 'ops'), ('${usOrg}', '${PM}', 'pm'), ('${trOrg}', '${TR_OPS}', 'ops');
    insert into reporters (id, org_id, name, phone_e164, status, locale, activated_at) values
      ('${MARCO}', '${usOrg}', 'Marco Ruiz', '+15550143378', 'active', 'en-US', now()),
      ('${JORGE}', '${usOrg}', 'Jorge Medina', '+15550143390', 'invited', 'es-US', null),
      ('${EMRE}', '${trOrg}', 'Emre Yıldız', '+905320000001', 'opted_out', 'tr-TR', now()),
      ('${MURAT}', '${trOrg}', 'Murat Kaya', '+905320000002', 'opted_out', 'tr-TR', null);
    insert into sms_opt_outs (phone_e164, country, method) values
      ('+905320000001', 'TR', 'provider_opt_out'), ('+905320000002', 'TR', 'sms_keyword'),
      ('+15550143390', 'US', 'provider_opt_out');
    insert into consents (reporter_id, type, method, text_version) values
      ('${MARCO}', 'sms', 'web_checkbox', 'v1'), ('${MARCO}', 'recording', 'web_checkbox', 'v1');
    insert into field_devices (reporter_id, device_token_hash, verified_at) values
      ('${MARCO}', 'marco-phone', now()), ('${MARCO}', 'marco-tablet', now()),
      ('${MARCO}', 'marco-pending', null);
    insert into push_subscriptions (org_id, reporter_id, endpoint, p256dh, auth) values
      ('${usOrg}', '${MARCO}', 'https://fcm.googleapis.com/fcm/send/marco', 'k', 'a');
  `);
});

describe('update_reporter_contact', () => {
  const call = (
    user: string,
    id: string,
    pref: string,
    channel: string | null,
    locale: string,
    attested: boolean,
  ) =>
    as<{ r: { changed: boolean } }>(
      user,
      `select update_reporter_contact($1, $2, $3, $4, $5) as r`,
      [id, pref, channel, locale, attested],
    );

  it('an ops user moves Marco to WhatsApp with the attestation, audited via office', async () => {
    const res = await call(OPS, MARCO, 'link', 'whatsapp', 'en-US', true);
    expect(res.rows[0]!.r.changed).toBe(true);
    expect(await reporter(MARCO)).toMatchObject({
      message_channel: 'whatsapp',
      contact_pref: 'link',
    });
    expect(await audits(MARCO, 'reporter.preferences_changed')).toEqual([
      {
        actor_id: OPS,
        diff: {
          from: { message_channel: null },
          to: { message_channel: 'whatsapp' },
          via: 'office',
          attested: true,
        },
      },
    ]);
    // No consent row: a preference is not a consent (Q243).
    const consents = await asService(db, (q) =>
      q(`select 1 from consents where reporter_id = $1 and type = 'whatsapp'`, [MARCO]),
    );
    expect(consents.rows).toEqual([]);
  });

  it('refuses a preference or channel change without the attestation; a language alone needs none', async () => {
    await expect(call(ADMIN, MARCO, 'call', 'whatsapp', 'en-US', false)).rejects.toThrow(
      /attestation_required/,
    );
    await expect(call(ADMIN, MARCO, 'link', null, 'en-US', false)).rejects.toThrow(
      /attestation_required/,
    );
    const res = await call(ADMIN, MARCO, 'link', 'whatsapp', 'es-US', false);
    expect(res.rows[0]!.r.changed).toBe(true);
    expect((await reporter(MARCO)).locale).toBe('es-US');
    expect((await audits(MARCO, 'reporter.preferences_changed')).at(-1)!.diff).toMatchObject({
      to: { locale: 'es-US' },
      attested: false,
    });
    // Nothing changed: no audit row.
    const n = (await audits(MARCO, 'reporter.preferences_changed')).length;
    expect((await call(ADMIN, MARCO, 'link', 'whatsapp', 'es-US', false)).rows[0]!.r.changed).toBe(
      false,
    );
    expect(await audits(MARCO, 'reporter.preferences_changed')).toHaveLength(n);
  });

  it('refuses push, a channel the pack does not list and a language it does not offer', async () => {
    await expect(call(ADMIN, MARCO, 'link', 'push', 'en-US', true)).rejects.toThrow(
      /channel_not_offered/,
    );
    // The US pack's field locales are en-US and es-US.
    await expect(call(ADMIN, MARCO, 'link', 'sms', 'tr-TR', true)).rejects.toThrow(
      /locale_not_offered/,
    );
    await expect(call(TR_ADMIN, EMRE, 'link', 'sms', 'es-US', true)).rejects.toThrow(
      /locale_not_offered/,
    );
  });

  it('is admin and ops of the reporter’s org only', async () => {
    await expect(call(PM, MARCO, 'call', 'sms', 'en-US', true)).rejects.toThrow(/not allowed/);
    await expect(call(OUTSIDER, MARCO, 'call', 'sms', 'en-US', true)).rejects.toThrow(
      /not allowed/,
    );
    await expect(call(TR_ADMIN, MARCO, 'call', 'sms', 'en-US', true)).rejects.toThrow(
      /not allowed/,
    );
    expect((await reporter(MARCO)).contact_pref).toBe('link');
  });
});

describe('revoke_reporter_devices (§19 Q244)', () => {
  it('revokes every device and push subscription, keeps the consents and the link, audited', async () => {
    await expect(as(PM, `select revoke_reporter_devices($1)`, [MARCO])).rejects.toThrow(
      /not allowed/,
    );
    await expect(as(TR_OPS, `select revoke_reporter_devices($1)`, [MARCO])).rejects.toThrow(
      /not allowed/,
    );
    const res = await as<{ r: { devices: number; push_subscriptions: number } }>(
      OPS,
      `select revoke_reporter_devices($1) as r`,
      [MARCO],
    );
    expect(res.rows[0]!.r).toMatchObject({ devices: 3, push_subscriptions: 1 });
    const left = await asService(db, (q) =>
      q<{ live: number; subs: number; consents: number }>(
        `select (select count(*)::int from field_devices where reporter_id = $1 and revoked_at is null) as live,
                (select count(*)::int from push_subscriptions where reporter_id = $1 and revoked_at is null) as subs,
                (select count(*)::int from consents where reporter_id = $1 and revoked_at is null) as consents`,
        [MARCO],
      ),
    );
    expect(left.rows[0]).toEqual({ live: 0, subs: 0, consents: 2 });
    const reason = await asService(db, (q) =>
      q<{ revoked_reason: string }>(
        `select revoked_reason from push_subscriptions where reporter_id = $1`,
        [MARCO],
      ),
    );
    expect(reason.rows).toEqual([{ revoked_reason: 'signed_out' }]);
    const [audit] = await audits(MARCO, 'device.revoked');
    expect(audit).toMatchObject({
      actor_id: OPS,
      diff: { via: 'office', devices: 3, push_subscriptions: 1 },
    });
    // A second tap revokes nothing more, and says so.
    const again = await as<{ r: { devices: number } }>(
      ADMIN,
      `select revoke_reporter_devices($1) as r`,
      [MARCO],
    );
    expect(again.rows[0]!.r.devices).toBe(0);
  });
});

describe('clear_reporter_opt_out (§19 Q242)', () => {
  const clear = (user: string, id: string, attested = true) =>
    as<{ r: { status: string; consent_id: string | null } }>(
      user,
      `select clear_reporter_opt_out($1, 'team.textsAgain.v1', $2) as r`,
      [id, attested],
    );

  it('never on a two-way pack', async () => {
    await expect(clear(ADMIN, JORGE)).rejects.toThrow(/two_way_pack/);
  });

  it('an admin only, with the attestation, never a STOP the person sent', async () => {
    await expect(clear(TR_OPS, EMRE)).rejects.toThrow(/not allowed/);
    await expect(clear(ADMIN, EMRE)).rejects.toThrow(/not allowed/);
    await expect(clear(TR_ADMIN, EMRE, false)).rejects.toThrow(/attestation_required/);
    await expect(clear(TR_ADMIN, MURAT)).rejects.toThrow(/opted_out_by_person/);
    expect((await reporter(EMRE)).status).toBe('opted_out');
  });

  it('clears a provider opt-out on a one-way pack: an sms consent office_attested, audited', async () => {
    const res = await clear(TR_ADMIN, EMRE);
    expect(res.rows[0]!.r.status).toBe('active');
    expect(await reporter(EMRE)).toMatchObject({ status: 'active', opted_out_at: null });
    const optOuts = await asService(db, (q) =>
      q(`select 1 from sms_opt_outs where phone_e164 = '+905320000001'`),
    );
    expect(optOuts.rows).toEqual([]);
    const consent = await asService(db, (q) =>
      q<{ method: string; text_version: string; evidence: Record<string, unknown> }>(
        `select method, text_version, evidence from consents where reporter_id = $1 and type = 'sms'`,
        [EMRE],
      ),
    );
    expect(consent.rows).toEqual([
      {
        method: 'office_attested',
        text_version: 'team.textsAgain.v1',
        evidence: expect.objectContaining({ user_id: TR_ADMIN, via: 'office' }),
      },
    ]);
    expect(await audits(EMRE, 'reporter.opt_out_cleared')).toEqual([
      {
        actor_id: TR_ADMIN,
        diff: {
          via: 'office',
          method: 'provider_opt_out',
          status: { from: 'opted_out', to: 'active' },
        },
      },
    ]);
    const given = await asService(db, (q) =>
      q<{ diff: Record<string, unknown> }>(
        `select diff from audit_log where action = 'consent.given' and entity_id = $1`,
        [res.rows[0]!.r.consent_id],
      ),
    );
    expect(given.rows[0]!.diff).toMatchObject({
      type: 'sms',
      method: 'office_attested',
      via: 'office',
    });
    await expect(clear(TR_ADMIN, EMRE)).rejects.toThrow(/not_opted_out/);
  });
});

describe('team_reporter_states', () => {
  it('gives admin and ops the opt-out, devices, consents and the welcome’s latest attempts', async () => {
    await asService(db, (q) =>
      q(
        `insert into messages (org_id, reporter_id, phone_e164, direction, channel, provider, copy_key, status, payload, provider_message_id, created_at) values
           ($1, $2, '+15550143390', 'out', 'sms', 'twilio', 'welcome', 'delivered', '{"dedupe_key":"welcome:old"}', 'SM0', now() - interval '3 days'),
           ($1, $2, '+15550143390', 'out', 'sms', 'twilio', 'welcome', 'undeliverable', '{"dedupe_key":"welcome:new","attempt":1}', null, now() - interval '1 hour'),
           ($1, $2, '+15550143390', 'out', 'whatsapp', 'twilio', 'welcome', 'failed', '{"dedupe_key":"welcome:new","attempt":2}', 'MM1', now() - interval '50 minutes'),
           ($1, $2, '+15550143390', 'out', 'sms', 'twilio', 'daily_link', 'delivered', '{}', 'SM2', now())`,
        [usOrg, JORGE],
      ),
    );
    const res = await as<{
      reporter_id: string;
      opt_out_method: string | null;
      devices: number;
      consents: string[];
      welcome: Array<{ status: string; channel: string; attempt: number }>;
    }>(OPS, `select * from team_reporter_states($1)`, [usOrg]);
    const byId = new Map(res.rows.map((r) => [r.reporter_id, r]));
    expect(byId.get(MARCO)).toMatchObject({
      opt_out_method: null,
      devices: 0,
      consents: ['recording', 'sms'],
      welcome: [],
    });
    const jorge = byId.get(JORGE)!;
    expect(jorge.opt_out_method).toBe('provider_opt_out');
    expect(jorge.welcome.map((w) => [w.status, w.channel, w.attempt])).toEqual([
      ['undeliverable', 'sms', 1],
      ['failed', 'whatsapp', 2],
    ]);
    await expect(as(PM, `select * from team_reporter_states($1)`, [usOrg])).rejects.toThrow(
      /not allowed/,
    );
    await expect(as(OPS, `select * from team_reporter_states($1)`, [trOrg])).rejects.toThrow(
      /not allowed/,
    );
  });
});

describe('org_members.ui_locale (F24)', () => {
  it('takes en-US, tr-TR or null (the org’s language), nothing else', async () => {
    await asService(db, (q) =>
      q(`update org_members set ui_locale = 'tr-TR' where org_id = $1 and user_id = $2`, [
        usOrg,
        OPS,
      ]),
    );
    await expect(
      asService(db, (q) =>
        q(`update org_members set ui_locale = 'tr' where org_id = $1 and user_id = $2`, [
          usOrg,
          OPS,
        ]),
      ),
    ).rejects.toThrow(/org_members_ui_locale_check/);
    await asService(db, (q) =>
      q(`update org_members set ui_locale = null where org_id = $1 and user_id = $2`, [usOrg, OPS]),
    );
  });
});
