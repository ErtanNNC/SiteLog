import { describe, expect, it } from 'vitest';
import type { JobRow } from '@sitelog/shared/db/types.ts';
import { createMetrics } from '../context';
import { createHarness, ORG_ID, SITE_RIVERSIDE, type Harness } from '../test/harness';
import { buildEmail, sendEmail } from './send_email';
import { weeklyDigest } from './weekly_digest';

/**
 * W4-09 (spec §19 Q239, `OFFICE_EMAIL_LANGUAGE`): the office emails go to each reader in their
 * panel language (`org_members.ui_locale`, else the org's locale); the invoice query in the org's
 * report language; one message per language, the Turkish one under `{key}:tr`.
 */

const ELIF = '00000000-0000-4000-8000-00000000e011';
const MURAT = '00000000-0000-4000-8000-00000000e012';

/** The harness org as a Turkish one (Demir Yapı's shape): Lena keeps the org's language. */
function turkishOrg(): Harness {
  const h = createHarness();
  h.db.data.orgs.set(ORG_ID, { ...h.org, name: 'Demir Yapı A.Ş.', locale: 'tr-TR' });
  h.db.data.members.push(
    {
      org_id: ORG_ID,
      user_id: ELIF,
      role: 'ops',
      email: 'elif@demiryapi.example',
      display_name: 'Elif Aydın',
      ui_locale: null,
    },
    {
      org_id: ORG_ID,
      user_id: MURAT,
      role: 'admin',
      email: 'murat@demiryapi.example',
      display_name: 'Murat Kaya',
      ui_locale: 'en-US',
    },
  );
  return h;
}

function job(dedupeKey: string): JobRow {
  return {
    id: 7,
    type: 'send_email',
    payload: {} as JobRow['payload'],
    status: 'running',
    attempts: 1,
    run_after: '2026-10-09T23:00:00Z',
    locked_at: null,
    locked_by: 'test',
    last_error: null,
    dedupe_key: dedupeKey,
    lock_key: null,
    created_at: '2026-10-09T23:00:00Z',
    finished_at: null,
  };
}

async function missingDay(h: Harness): Promise<string> {
  const day = await h.db.getOrCreateSiteDay(
    SITE_RIVERSIDE,
    '2026-10-09',
    new Date('2026-10-09T22:30:00Z'),
  );
  return day.id;
}

describe('office emails in the reader’s language (W4-09, Q239)', () => {
  it('report missing: Turkish to Elif (the org’s language), English to Murat, keys split', async () => {
    const h = turkishOrg();
    const siteDayId = await missingDay(h);
    await sendEmail(
      { ...h.ctx, metrics: createMetrics() },
      { kind: 'report_missing', siteDayId, reminders: 2 },
      job(`email:missing:${siteDayId}`),
    );
    const sent = h.email.sent;
    expect(sent).toHaveLength(2);
    const en = sent.find((m) => m.to.includes('murat@demiryapi.example'))!;
    const tr = sent.find((m) => m.to.includes('elif@demiryapi.example'))!;
    expect(en.to).toEqual(['murat@demiryapi.example']);
    expect(en.subject).toBe('Riverside Lofts — no report · Fri Oct 9');
    expect(en.idempotencyKey).toBe(`email:missing:${siteDayId}`);
    // Lena (admin, no language of her own) reads the org's language with Elif.
    expect(tr.to.sort()).toEqual(['elif@demiryapi.example', 'lena@kestrel.example']);
    expect(tr.subject).toBe('Riverside Lofts — rapor yok · Cum 9 Eki');
    expect(tr.text).toContain('Marco 2 hatırlatmaya yanıt vermedi.');
    expect(tr.html).toContain('Eksik');
    expect(tr.html).toContain('TalkOlog’da aç');
    expect(tr.idempotencyKey).toBe(`email:missing:${siteDayId}:tr`);

    // A retry sends nothing twice, in either language.
    await sendEmail(
      { ...h.ctx, metrics: createMetrics() },
      { kind: 'report_missing', siteDayId, reminders: 2 },
      job(`email:missing:${siteDayId}`),
    );
    expect(h.email.sent).toHaveLength(2);
  });

  it('an English org: everyone in English unless their panel is Turkish', async () => {
    const h = createHarness();
    h.db.data.members.find((m) => m.email === 'lena@kestrel.example')!.ui_locale = 'tr-TR';
    const siteDayId = await missingDay(h);
    const built = (await buildEmail(h.ctx, { kind: 'report_missing', siteDayId }))!;
    expect(built.messages.map((m) => [m.language, m.to])).toEqual([
      ['tr', ['lena@kestrel.example']],
    ]);
    expect(built.messages[0]!.rendered.text).toContain('son saat geçti');
  });

  it('unknown contact and weekly digest follow each reader', async () => {
    const h = turkishOrg();
    const unknown = (await buildEmail(h.ctx, { kind: 'unknown_contact', orgId: ORG_ID }))!;
    expect(unknown.messages.map((m) => m.language)).toEqual(['en', 'tr']);
    expect(unknown.messages[0]!.rendered.subject).toBe('Unknown number tried to report');
    expect(unknown.messages[1]!.rendered.subject).toBe(
      'Bilinmeyen bir numara rapor göndermeye çalıştı',
    );
    expect(unknown.messages[1]!.rendered.text).toContain('Numara: bilinmeyen numara');

    const digest = (await buildEmail(h.ctx, {
      kind: 'weekly_digest',
      orgId: ORG_ID,
      weekStart: '2026-10-05',
    } as never))!;
    // admin + pm: Murat (EN); Lena (admin) and Sam (pm) read the org's Turkish.
    expect(digest.messages.map((m) => [m.language, m.to.sort()])).toEqual([
      ['en', ['murat@demiryapi.example']],
      ['tr', ['lena@kestrel.example', 'sam@kestrel.example']],
    ]);
    expect(digest.messages[1]!.rendered.subject).toBe(
      'TalkOlog haftalık · Pzt 5 Eki – Paz 11 Eki · %0 zamanında',
    );

    // The scheduled digest job sends the same two.
    await weeklyDigest(
      { ...h.ctx, metrics: createMetrics() },
      {
        orgId: ORG_ID,
        weekStart: '2026-10-05',
      } as never,
      job('weekly_digest:x'),
    );
    expect(h.email.sent.map((m) => m.subject)).toEqual([
      'TalkOlog weekly · Mon Oct 5 – Sun Oct 11 · 0% on time',
      'TalkOlog haftalık · Pzt 5 Eki – Paz 11 Eki · %0 zamanında',
    ]);
  });

  it('edited after sign-off goes to the signer, in their language', async () => {
    const h = turkishOrg();
    const report = await h.db.insertReport({
      org_id: ORG_ID,
      site_id: SITE_RIVERSIDE,
      reporter_id: null,
      report_no: 'RL-2041-0190',
      kind: 'daily',
      status: 'filed',
    } as never);
    const built = (await buildEmail(h.ctx, {
      kind: 'report_edited_after_signoff',
      reportId: report.id,
      version: 2,
      changeNote: 'Ekip 6 → 7',
      signerId: ELIF,
    }))!;
    expect(built.messages).toHaveLength(1);
    expect(built.messages[0]!.to).toEqual(['elif@demiryapi.example']);
    expect(built.messages[0]!.language).toBe('tr');
    expect(built.messages[0]!.rendered.subject).toBe(
      `${report.report_no} onaydan sonra düzenlendi`,
    );
    expect(built.messages[0]!.rendered.text).toContain('Değişiklik: Ekip 6 → 7');

    const toMurat = (await buildEmail(h.ctx, {
      kind: 'report_edited_after_signoff',
      reportId: report.id,
      version: 2,
      changeNote: 'Crew 6 → 7',
      signerId: MURAT,
    }))!;
    expect(toMurat.messages[0]!.rendered.subject).toBe(
      `${report.report_no} was edited after sign-off`,
    );
  });

  it('the invoice query goes out in the org’s report language', async () => {
    const h = turkishOrg();
    h.db.getInvoiceSummary = async () =>
      ({
        id: 'inv-1',
        org_id: ORG_ID,
        company_name: 'Yıldız Elektrik',
        invoice_no: 'YE-2210',
        period_start: '2026-10-05',
        period_end: '2026-10-09',
        invoiced_hours: 212,
        reported_hours: 196.5,
      }) as never;
    const built = (await buildEmail(h.ctx, {
      kind: 'invoice_query',
      invoiceId: '00000000-0000-4000-8000-0000000f0001',
      to: ['muhasebe@yildiz.example'],
    }))!;
    expect(built.messages).toHaveLength(1);
    const m = built.messages[0]!;
    expect(m.language).toBe('tr');
    expect(m.keySuffix).toBeNull();
    expect(m.rendered.subject).toBe('Saat sorgusu · Yıldız Elektrik · YE-2210');
    expect(m.rendered.text).toContain(
      'Demir Yapı A.Ş., YE-2210 numaralı faturayı Pzt 5 Eki – Cum 9 Eki dönemine ait günlük şantiye raporlarıyla karşılaştırdı.',
    );
    expect(m.rendered.text).toContain('Fark: +15,5 sa');
  });
});
