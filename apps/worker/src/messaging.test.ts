import { describe, expect, it } from 'vitest';
import { DEMO_COUNTRIES } from '@sitelog/shared/demo/countries.ts';
import { SmsConfigError } from '@sitelog/shared';
import { testConfig } from './config';
import { createConsoleProvider } from './email/provider';
import { silentLogger } from './log';
import {
  describePackTransports,
  loadOrgPack,
  statusCallbackUrl,
  workerTransports,
} from './messaging';
import { createFakeDb } from './test/fake-db';

describe('worker messaging (W1-08)', () => {
  it('logs one line per pack: console until the sender id is set here', () => {
    const rows = DEMO_COUNTRIES.map((c) => ({ ...c }));
    expect(describePackTransports(rows)).toEqual({
      TR: 'console: no sender id; whatsapp: no sender id',
      US: 'console: no sender id; whatsapp: no sender id',
    });
    rows.find((r) => r.code === 'TR')!.sms_sender_id = 'SITELOG';
    rows.find((r) => r.code === 'TR')!.whatsapp_sender_id = '+905320000099';
    expect(describePackTransports(rows).TR).toBe(
      'iletimerkezi (SITELOG); whatsapp twilio (+905320000099)',
    );
  });

  it("reads the org's pack fresh; an unknown pack is an error", async () => {
    const db = createFakeDb();
    expect((await loadOrgPack(db, { country: 'TR' })).smsProvider).toBe('iletimerkezi');
    db.data.countries.find((c) => c.code === 'US')!.sms_sender_id = '+18885550142';
    expect((await loadOrgPack(db, { country: 'US' })).smsSenderId).toBe('+18885550142');
    await expect(loadOrgPack(db, { country: 'ZZ' })).rejects.toThrow(/No country pack ZZ/);
  });

  it('asks Twilio for delivery callbacks only at a public https URL', () => {
    const cfg = (o: Partial<{ SMS_WEBHOOK_URL: string; SUPABASE_URL: string }>) => ({
      SMS_WEBHOOK_URL: '',
      SUPABASE_URL: '',
      ...o,
    });
    expect(statusCallbackUrl(cfg({ SUPABASE_URL: 'https://p.supabase.co' }))).toBe(
      'https://p.supabase.co/functions/v1/sms-webhook/status',
    );
    expect(statusCallbackUrl(cfg({ SMS_WEBHOOK_URL: 'https://hooks.example/sms/' }))).toBe(
      'https://hooks.example/sms/status',
    );
    expect(statusCallbackUrl(cfg({ SUPABASE_URL: 'http://127.0.0.1:54321' }))).toBeNull();
  });

  it('a provider driver needs its credentials from the worker env', () => {
    const pick = workerTransports(testConfig());
    expect(pick('console').driver).toBe('console');
    expect(() => pick('twilio')).toThrow(SmsConfigError);
    expect(
      workerTransports(testConfig({ TWILIO_ACCOUNT_SID: 'AC1', TWILIO_AUTH_TOKEN: 't' }))('twilio')
        .driver,
    ).toBe('twilio');
  });

  it('the console email provider files what it would send for the Demo phone', async () => {
    const filed: unknown[] = [];
    const provider = createConsoleProvider(silentLogger, 'SiteLog <reports@sitelog.app>', {
      async insertConsoleEmail(row) {
        filed.push(row);
        return 'e-1';
      },
    });
    const res = await provider.send({
      to: ['pm@kestrelbuild.example'],
      subject: 'Daily report · Riverside',
      html: '<p>Filed.</p>',
      text: 'Filed.',
      attachments: [{ filename: 'RL-2041-0187.pdf', content: Buffer.alloc(42) }],
      tags: { kind: 'report_filed' },
      orgId: 'org-1',
    });
    expect(res).toEqual({ id: 'console:e-1' });
    expect(filed).toEqual([
      {
        org_id: 'org-1',
        kind: 'report_filed',
        recipients: ['pm@kestrelbuild.example'],
        subject: 'Daily report · Riverside',
        body_text: 'Filed.',
        attachments: [{ filename: 'RL-2041-0187.pdf', bytes: 42 }],
        dedupe_key: null,
      },
    ]);
    // W1-15: the send_email job's key goes along, so a retried job files no second row.
    await provider.send({
      to: ['pm@kestrelbuild.example'],
      subject: 's',
      html: '',
      text: '',
      orgId: 'org-1',
      idempotencyKey: 'email:report_filed:r1:1',
    });
    expect(filed[1]).toMatchObject({ dedupe_key: 'email:report_filed:r1:1' });
    filed.pop();
    // No org: logged only.
    expect(await provider.send({ to: ['x@y.z'], subject: 's', html: '', text: '' })).toEqual({
      id: null,
    });
    expect(filed).toHaveLength(1);
  });
});
