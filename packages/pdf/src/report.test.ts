import { pdfFileName, pdfStoragePath } from '@sitelog/shared';
import { describe, expect, it } from 'vitest';
import {
  durationIn,
  languageList,
  PDF_COPY,
  pdfCopy,
  upper,
  type ConfirmFacts,
  type SourceFacts,
} from './copy';
import { letterheadLine, manpowerFootnotes, pageSize, sourceChannel } from './ReportDocument';
import { demirReportInput, sampleReportInput } from './sample-data';
import { statusLabel } from './components';

/** The key paths of a copy object (functions count as leaves). */
function keyPaths(o: object, prefix = ''): string[] {
  return Object.entries(o).flatMap(([k, v]) =>
    v && typeof v === 'object' ? keyPaths(v as object, `${prefix}${k}.`) : [`${prefix}${k}`],
  );
}

describe('PDF copy by report language (§12, D34)', () => {
  it('prints the §10.10 title and the §12 badge in each language', () => {
    expect(pdfCopy('en').title).toBe('Daily Site Report');
    expect(pdfCopy('tr').title).toBe('Günlük Şantiye Raporu');
    expect(pdfCopy('en').badge.daily).toBe('DAILY SITE REPORT');
    expect(pdfCopy('tr').badge.daily).toBe('GÜNLÜK ŞANTİYE RAPORU');
  });

  it('falls back to English for a language the PDF has no copy for', () => {
    expect(pdfCopy('es').lang).toBe('en');
    expect(pdfCopy(null).lang).toBe('en');
  });

  it('has the same keys in English and Turkish', () => {
    expect(keyPaths(PDF_COPY.tr).sort()).toEqual(keyPaths(PDF_COPY.en).sort());
  });

  it('upper-cases labels with Turkish rules (i → İ), not react-pdf’s locale-free upper case', () => {
    const tr = pdfCopy('tr');
    expect(upper(tr, tr.meta.date)).toBe('TARİH');
    expect(upper(tr, tr.sections.safety)).toBe('İŞ GÜVENLİĞİ');
    expect(upper(pdfCopy('en'), 'Site manager')).toBe('SITE MANAGER');
  });

  it('formats dates, hours, numbers and durations per language', () => {
    const [en, tr] = [pdfCopy('en'), pdfCopy('tr')];
    expect(en.dateFull('2026-10-09')).toBe('Friday, October 9, 2026');
    expect(tr.dateFull('2026-10-09')).toBe('Cuma, 9 Ekim 2026');
    expect(en.dateMedium('2026-10-09')).toBe('Oct 9, 2026');
    expect(tr.dateMedium('2026-10-09')).toBe('9 Eki 2026');
    expect(en.hours(3.5)).toBe('3.5 h');
    expect(tr.hours(3.5)).toBe('3,5 sa');
    expect(tr.num(10.25)).toBe('10,25');
    expect(durationIn(168, 'en')).toBe('2 min 48 s');
    expect(durationIn(252, 'tr')).toBe('4 dk 12 sn');
    expect(durationIn(48, 'tr')).toBe('48 sn');
    expect(languageList(['es', 'en'], 'en')).toBe('Spanish and English');
    expect(languageList(['tr', 'en', 'xx'], 'tr')).toBe('Türkçe, İngilizce ve XX');
    expect(statusLabel(en, 'in_progress', 60)).toBe('In progress · approx. 60%');
    expect(statusLabel(tr, 'in_progress', 60)).toBe('Devam ediyor · yaklaşık %60');
  });
});

describe('paper (§12: org_settings.pdf_paper, preset from the country pack)', () => {
  it('maps pdf_paper to the react-pdf page size', () => {
    expect(pageSize('letter')).toBe('LETTER');
    expect(pageSize('a4')).toBe('A4');
    expect(sampleReportInput.settings.paper).toBe('letter');
    expect(demirReportInput.settings.paper).toBe('a4');
  });
});

describe('file names (§12, D33)', () => {
  it('serves the §12 name and keeps the storage object name', () => {
    const { report, data } = demirReportInput;
    expect(pdfFileName(report.reportNo, data.reportDate, report.version)).toBe(
      'KK-1203-0005_2026-10-09_v1.pdf',
    );
    expect(pdfStoragePath('org', 'site', report.reportNo, report.version)).toBe(
      'org/site/KK-1203-0005_v1.pdf',
    );
  });
});

describe('letterhead line (§12: address / license / tax)', () => {
  const org = { ...sampleReportInput.org, taxNo: '74-1234567' };
  it('joins the parts the org has', () => {
    expect(letterheadLine(org, pdfCopy('en'))).toBe(
      '1200 Industrial Pkwy, Austin, TX 78741 · License TX-GC-20481 · Tax ID 74-1234567',
    );
    expect(
      letterheadLine(
        { ...org, address: null, licenseNo: null, taxNo: '1234567890' },
        pdfCopy('tr'),
      ),
    ).toBe('Vergi no. 1234567890');
  });
  it('is absent when the org has none of them', () => {
    expect(letterheadLine(demirReportInput.org, pdfCopy('tr'))).toBeNull();
  });
});

describe('source record and sign-off (§12 page 2, driven by channel and confirmed_via)', () => {
  const base: SourceFacts = {
    channel: 'web',
    audioCount: 1,
    audioSeconds: 168,
    languages: ['es', 'en'],
    textCount: 0,
    photoCount: 2,
    receivedAt: '17:38',
    enteredBy: null,
    filedAt: '17:43',
  };
  const confirmed: ConfirmFacts = { via: 'web', confirmedAt: '17:43', filedAt: '17:43' };
  const en = pdfCopy('en');

  it('words a web-recorder report as §12 does', () => {
    expect(en.sourceRecord(base, confirmed)).toBe(
      'Compiled from a voice note recorded via the site manager’s personal link (2 min 48 s, Spanish and English) and 2 photos received at 17:38. Confirmed by the site manager on the recorder at 17:43. Audio, transcript and version history are retained in SiteLog.',
    );
    expect(en.signoff.confirmed('web', '17:43')).toBe('Confirmed on the recorder · 17:43');
  });

  it('words a call report as §12 does', () => {
    const call = {
      ...base,
      channel: 'voice' as const,
      audioSeconds: 252,
      languages: ['tr'],
      photoCount: 0,
      receivedAt: '18:41',
    };
    expect(en.sourceRecord(call, { ...confirmed, via: 'voice', confirmedAt: '18:46' })).toBe(
      'Compiled from a recorded phone call with the SiteLog assistant (4 min 12 s, Turkish) at 18:41. Confirmed by the site manager by voice on the call at 18:46. Audio, transcript and version history are retained in SiteLog.',
    );
    expect(en.signoff.confirmed('voice', '18:46')).toBe('Confirmed by voice on the call · 18:46');
    expect(pdfCopy('tr').signoff.confirmed('voice', '18:46')).toBe(
      'Görüşmede sesli onaylandı · 18:46',
    );
  });

  it('never names WhatsApp for a v1.2 channel, and keeps it for a WhatsApp-era report', () => {
    for (const lang of ['en', 'tr'] as const)
      for (const channel of ['web', 'voice', 'sms', 'office'] as const) {
        const c = pdfCopy(lang);
        const text = c.sourceRecord({ ...base, channel }, { ...confirmed, via: channel });
        expect(text).not.toMatch(/WhatsApp/);
        expect(c.signoff.confirmed(channel, '17:43')).not.toMatch(/WhatsApp/);
        expect(c.footer.voice).not.toMatch(/WhatsApp/);
      }
    expect(
      en.sourceRecord(
        { ...base, channel: 'whatsapp_legacy' },
        { ...confirmed, via: 'whatsapp_legacy' },
      ),
    ).toMatch(
      /^Compiled from a voice note sent on WhatsApp .* Confirmed by the site manager on WhatsApp at 17:43\./,
    );
  });

  it('says when a report was filed without the site manager’s confirmation', () => {
    expect(en.sourceRecord(base, { ...confirmed, confirmedAt: null })).toContain(
      'Filed at 17:43 without the site manager’s confirmation.',
    );
  });

  it('words a report typed in the panel', () => {
    const office = { ...base, channel: 'office' as const, enteredBy: 'Lena Ortiz', audioCount: 0 };
    expect(en.sourceRecord(office, { ...confirmed, via: 'office', confirmedAt: null })).toBe(
      'Entered in SiteLog by Lena Ortiz. Filed at 17:43. 2 photos attached. Version history is retained in SiteLog.',
    );
  });

  it('takes the channel from the report, office entry first, null as the WhatsApp era', () => {
    expect(sourceChannel(sampleReportInput)).toBe('web');
    expect(sourceChannel(demirReportInput)).toBe('voice');
    expect(sourceChannel({ ...sampleReportInput, enteredBy: 'Lena Ortiz' })).toBe('office');
    expect(
      sourceChannel({
        ...sampleReportInput,
        report: { ...sampleReportInput.report, channel: null },
      }),
    ).toBe('whatsapp_legacy');
  });
});

describe('manpower footnotes (answers and edits)', () => {
  it('names the confirmed company and time, and each later version up to the one printed', () => {
    expect(manpowerFootnotes(sampleReportInput, pdfCopy('en'))).toEqual([
      'Apex Concrete headcount confirmed by the site manager at 17:41.',
      'Delta Mechanical headcount confirmed by the site manager at 17:41.',
      'Apex Concrete 6 → 7 workers: corrected by the site manager at 20:10 (v2).',
    ]);
    const v1 = { ...sampleReportInput, report: { ...sampleReportInput.report, version: 1 } };
    expect(manpowerFootnotes(v1, pdfCopy('en'))).not.toContain(
      'Apex Concrete 6 → 7 workers: corrected by the site manager at 20:10 (v2).',
    );
  });

  it('prints in Turkish for a Turkish report, without a time when the answer has none', () => {
    expect(manpowerFootnotes(demirReportInput, pdfCopy('tr'))).toEqual([
      'Akış Mekanik işçi sayısı şantiye şefi tarafından teyit edildi (saat 18:44).',
    ]);
    expect(manpowerFootnotes({ ...demirReportInput, answers: {} }, pdfCopy('tr'))).toEqual([
      'Akış Mekanik bilgileri şantiye şefi tarafından teyit edildi.',
    ]);
  });

  it('words an office edit without a change note', () => {
    expect(PDF_COPY.en.editNote(3, 'office_user', null, '09:12')).toBe(
      'Edited in SiteLog by the office at 09:12 (v3).',
    );
    expect(PDF_COPY.tr.editNote(3, 'office_user', null, '09:12')).toBe(
      'Ofis tarafından SiteLog’da düzenlendi (saat 09:12, v3).',
    );
  });
});
