import { NOTICE_KEYS, type NoticeData, type NoticeKey } from '@sitelog/shared/notifications.ts';
import { describe, expect, it } from 'vitest';
import { renderCopyRef } from '@/i18n/copyRef';
import { i18n } from '@/i18n/i18n';
import type { CopyT } from '@/i18n/useCopy';
import { noticeText } from './notices';

/** One notice of every key, as its producer writes it. */
const SAMPLES: Record<NoticeKey, NoticeData['params']> = {
  late_upload: {
    site: 'Riverside',
    media: 'photo',
    date: '2026-10-26',
    reporter: 'Marco Ruiz',
    reportNo: 'RL-2041-0190',
  },
  missing_report: { site: 'Elm St. Townhomes', first: 'Priya' },
  report_edited: { reportNo: 'RL-2041-0187' },
  needs_review: { reportNo: 'OMC-0001', reasons: ['unknown_company:Ridgeway', 'no_photo'] },
  glossary_review: { count: 3 },
  pack_ready: { site: 'Riverside', from: '2026-09-01', to: '2026-09-30' },
  processing_delayed: { reportNo: 'RL-2041-0187' },
  processing_failed: { reportNo: 'RL-2041-0187', job: 'extract_report', tries: 6 },
  message_not_sent: { name: 'Marco Ruiz', job: 'notify', tries: 6 },
  message_not_handled: { name: 'Marco Ruiz', job: 'sms_inbound', tries: 6 },
  message_opted_out: { name: 'Marco Ruiz' },
  message_refused: { name: 'Marco Ruiz', error: 'twilio 21211' },
  message_no_sender: { name: 'Marco Ruiz' },
  message_account_fault: { name: 'Marco Ruiz', error: 'twilio 30032' },
  message_channels_failed: { name: 'Marco Ruiz', channels: 'sms, whatsapp', error: 'twilio 30005' },
  welcome_undeliverable: { name: 'Marco Ruiz' },
  welcome_provider_fault: { name: 'Marco Ruiz', error: 'twilio 20003' },
  welcome_not_sent: { name: 'Marco Ruiz', reason: 'no_consent' },
  welcome_carrier_undelivered: { name: 'Marco Ruiz', error: 'twilio 30006' },
  welcome_account_fault: { name: null, error: 'twilio failed' },
  reporter_opted_out: { name: 'Marco Ruiz', phone: '+1 555 014 3378' },
  reporter_stop: { name: 'Marco Ruiz', phone: '+1 555 014 3378' },
  unknown_contact: {},
  reporter_wrong_site: { name: 'Marco Ruiz' },
  payment_failed: {},
  subscription_canceled: {},
  late_report: { site: 'Elm St. Townhomes', reportNo: 'ES-0377-0042', crew: 6, hours: 48 },
  invoice_gap: {
    company: 'BrightLine',
    invoiceNo: 'BL-3381',
    invoiced: 212,
    reported: 196,
    gap: 16,
  },
};

function render(data: NoticeData, lang: 'en' | 'tr') {
  const t = i18n.getFixedT(lang, 'panel') as unknown as CopyT;
  const text = noticeText(data)!;
  return {
    title: renderCopyRef(t, lang, text.title),
    body: text.body?.map((r) => renderCopyRef(t, lang, r)).join(', ') ?? null,
  };
}

describe('noticeText: panel notices in the reader’s language', () => {
  it('renders every notice key in English and Turkish, with every value filled in', () => {
    for (const key of NOTICE_KEYS) {
      const data = { key, params: SAMPLES[key] } as NoticeData;
      for (const lang of ['en', 'tr'] as const) {
        const { title, body } = render(data, lang);
        for (const s of [title, body ?? '']) {
          expect(s, `${key} (${lang})`).not.toMatch(/\{\{|shell\.notifications|overview\./);
        }
        expect(title.length, `${key} (${lang})`).toBeGreaterThan(0);
      }
    }
  });

  it('says the missing-report and late-upload notices in Turkish (Demir Yapı)', () => {
    expect(
      render({ key: 'missing_report', params: SAMPLES.missing_report } as NoticeData, 'tr'),
    ).toEqual({
      title: 'Elm St. Townhomes: rapor yok',
      body: 'Priya bugünün raporunu göndermedi ve son saat geçti.',
    });
    expect(
      render(
        {
          key: 'late_upload',
          params: { ...SAMPLES.late_upload, media: 'audio', reporter: null },
        } as NoticeData,
        'tr',
      ).title,
    ).toBe('Riverside: 26 Eki için geç gelen sesli not');
  });

  it('keeps the producers’ English wording in English', () => {
    expect(render({ key: 'missing_report', params: { site: 'Elm', first: null } }, 'en')).toEqual({
      title: 'Elm — no report',
      body: 'The site manager hasn’t sent today’s report, and the deadline has passed.',
    });
    expect(render({ key: 'late_upload', params: SAMPLES.late_upload } as NoticeData, 'en')).toEqual(
      {
        title: 'Riverside — late photo for Oct 26',
        body: 'Marco Ruiz recorded it on that day, and it arrived after the day’s reporting window had closed. It is on report RL-2041-0190, marked late.',
      },
    );
    expect(
      render({ key: 'needs_review', params: SAMPLES.needs_review } as NoticeData, 'en'),
    ).toEqual({
      title: 'OMC-0001 needs review',
      body: 'Unknown subcontractor “Ridgeway”, No photo arrived after the call',
    });
    expect(render({ key: 'invoice_gap', params: SAMPLES.invoice_gap } as NoticeData, 'en')).toEqual(
      {
        title: 'Invoice gap: BrightLine +16 h',
        body: 'BL-3381 invoices 212 h · reports show 196 h',
      },
    );
  });

  it('leaves the stored body to notices whose body someone wrote (a change note, a snippet)', () => {
    expect(noticeText({ key: 'report_edited', params: { reportNo: 'X' } })!.body).toBeNull();
    expect(noticeText({ key: 'unknown_contact', params: {} })!.body).toBeNull();
  });

  it('is null without data, or for a key or values it does not know (the stored text shows)', () => {
    expect(noticeText(null)).toBeNull();
    expect(noticeText({ key: 'new_kind', params: {} })).toBeNull();
    expect(noticeText({ key: 'missing_report', params: {} })).toBeNull();
  });
});
