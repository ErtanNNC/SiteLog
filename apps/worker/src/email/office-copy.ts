import type { ReportLanguage } from '@sitelog/shared';

/**
 * §13's office emails other than the report email, in EN and TR (W4-09, spec §19 Q239): report
 * missing, invoice query, EOT evidence pack ready, weekly digest, unknown contact and edited after
 * sign-off. Each reader gets their panel language (`OFFICE_EMAIL_LANGUAGE`); the invoice query goes
 * out in the org's report language. The Turkish is listed here for the native-speaker read (Q63).
 * Dates and hours come formatted in the email's language; no emoji.
 */
export interface OfficeEmailCopy {
  open: string;
  missing: {
    subject: (site: string, date: string) => string;
    someone: string;
    reminded: (site: string, who: string, n: number) => string;
    notSent: (site: string, who: string, date: string) => string;
    call: (who: string) => string;
    callText: (who: string, phone: string) => string;
    chip: string;
    title: string;
  };
  invoice: {
    subject: (company: string, invoiceNo: string | null) => string;
    intro: (org: string, invoiceNo: string | null, period: string | null) => string;
    invoiced: string;
    reported: string;
    difference: string;
    ask: string;
    askShort: string;
    title: string;
    footer: string;
  };
  pack: {
    subject: (site: string, from: string, to: string) => string;
    body: (site: string, from: string, to: string) => string;
    validity: string;
    download: string;
    panel: string;
    weatherData: string;
    title: string;
    cta: string;
    allSites: string;
  };
  digest: {
    subject: (from: string, to: string, pct: number) => string;
    onTime: string;
    percent: (pct: number) => string;
    onTimeDetail: (onTime: number, siteDays: number, filed: number) => string;
    calls: string;
    callsLine: (pct: number, filed: number, days: number) => string;
    weather: string;
    noWeather: string;
    gaps: string;
    noGaps: string;
    unsigned: string;
    allSigned: string;
    openTalkOlog: string;
    title: string;
  };
  unknown: {
    subject: string;
    number: string;
    message: string;
    noText: string;
    unknownNumber: string;
    body: string;
    textLine: string;
    cta: string;
  };
  edited: {
    subject: (reportNo: string) => string;
    body: (reportNo: string, version: number) => string;
    change: string;
    noNote: string;
    review: string;
    cta: string;
  };
}

export const OFFICE_EMAIL_COPY: Record<ReportLanguage, OfficeEmailCopy> = {
  en: {
    open: 'Open in TalkOlog',
    missing: {
      subject: (site, date) => `${site} — no report · ${date}`,
      someone: 'The site manager',
      reminded: (site, who, n) =>
        `${site} — no report. ${who} didn't answer ${n} reminder${n === 1 ? '' : 's'}.`,
      notSent: (site, who, date) =>
        `${site} — no report. ${who} hasn't sent the report for ${date}, and the deadline has passed.`,
      call: (who) => `Call ${who}`,
      callText: (who, phone) => `Call ${who}: ${phone}`,
      chip: 'Missing',
      title: 'No report',
    },
    invoice: {
      subject: (company, no) => `Hours query · ${company}${no ? ` · ${no}` : ''}`,
      intro: (org, no, period) =>
        `${org} compared invoice ${no ?? ''} with the daily site reports for ${period ?? 'the invoice period'}.`,
      invoiced: 'Invoiced',
      reported: 'Reported',
      difference: 'Difference',
      ask: 'Could you check the days where the hours differ? The daily reports with audio evidence are available on request.',
      askShort: 'Could you check the days where the hours differ?',
      title: 'Hours query',
      footer: 'Sent with TalkOlog.',
    },
    pack: {
      subject: (site, from, to) => `EOT evidence pack ready · ${site} · ${from} – ${to}`,
      body: (site, from, to) => `The evidence pack for ${site}, ${from} – ${to}, is ready.`,
      validity: 'The download link is valid for 7 days. Weather data: Open-Meteo.',
      download: 'Download (valid 7 days)',
      panel: 'Weather & delays',
      weatherData: 'Weather data: Open-Meteo.',
      title: 'Evidence pack ready',
      cta: 'Download the pack',
      allSites: 'All sites',
    },
    digest: {
      subject: (from, to, pct) => `TalkOlog weekly · ${from} – ${to} · ${pct}% on time`,
      onTime: 'On time',
      percent: (pct) => `${pct}%`,
      onTimeDetail: (onTime, days, filed) => `(${onTime} of ${days} site-days; ${filed} filed)`,
      calls: 'Reminder calls',
      callsLine: (pct, filed, days) =>
        `${pct}% filed on the call (${filed} of ${days} site-days TalkOlog called about)`,
      weather: 'Weather hours by site',
      noWeather: 'No weather stoppages',
      gaps: 'Invoice gaps',
      noGaps: 'No open invoice gaps',
      unsigned: 'Unsigned reports',
      allSigned: 'All filed reports are signed off',
      openTalkOlog: 'Open TalkOlog',
      title: 'Weekly digest',
    },
    unknown: {
      subject: 'Unknown number tried to report',
      number: 'Number',
      message: 'Message',
      noText: '(no text)',
      unknownNumber: 'unknown number',
      body: 'Link the number to a site or ignore it on the Team page. Nothing was filed.',
      textLine: 'Nothing was filed. Link or ignore it on the Team page:',
      cta: 'Open Team & numbers',
    },
    edited: {
      subject: (no) => `${no} was edited after sign-off`,
      body: (no, v) =>
        `${no} was edited after you signed it off. Version ${v} needs a fresh sign-off.`,
      change: 'Change:',
      noNote: '(no note)',
      review: 'Review',
      cta: 'Review the report',
    },
  },
  tr: {
    open: 'TalkOlog’da aç',
    missing: {
      subject: (site, date) => `${site} — rapor yok · ${date}`,
      someone: 'Şantiye şefi',
      reminded: (site, who, n) => `${site} — rapor yok. ${who} ${n} hatırlatmaya yanıt vermedi.`,
      notSent: (site, who, date) =>
        `${site} — rapor yok. ${who} ${date} raporunu göndermedi ve son saat geçti.`,
      call: (who) => `Ara: ${who}`,
      callText: (who, phone) => `Ara: ${who}, ${phone}`,
      chip: 'Eksik',
      title: 'Rapor yok',
    },
    invoice: {
      subject: (company, no) => `Saat sorgusu · ${company}${no ? ` · ${no}` : ''}`,
      intro: (org, no, period) =>
        `${org}, ${no ? `${no} numaralı faturayı` : 'faturayı'} ${period ? `${period} dönemine ait` : 'fatura dönemine ait'} günlük şantiye raporlarıyla karşılaştırdı.`,
      invoiced: 'Faturalanan',
      reported: 'Raporlanan',
      difference: 'Fark',
      ask: 'Saatlerin farklı olduğu günleri kontrol edebilir misiniz? Ses kayıtlı günlük raporlar talep üzerine paylaşılabilir.',
      askShort: 'Saatlerin farklı olduğu günleri kontrol edebilir misiniz?',
      title: 'Saat sorgusu',
      footer: 'TalkOlog ile gönderildi.',
    },
    pack: {
      subject: (site, from, to) => `Süre uzatımı kanıt dosyası hazır · ${site} · ${from} – ${to}`,
      body: (site, from, to) => `${site} için ${from} – ${to} kanıt dosyası hazır.`,
      validity: 'İndirme bağlantısı 7 gün geçerlidir. Hava verisi: Open-Meteo.',
      download: 'İndir (7 gün geçerli)',
      panel: 'Hava ve gecikmeler',
      weatherData: 'Hava verisi: Open-Meteo.',
      title: 'Kanıt dosyası hazır',
      cta: 'Dosyayı indir',
      allSites: 'Tüm şantiyeler',
    },
    digest: {
      subject: (from, to, pct) => `TalkOlog haftalık · ${from} – ${to} · %${pct} zamanında`,
      onTime: 'Zamanında',
      percent: (pct) => `%${pct}`,
      onTimeDetail: (onTime, days, filed) =>
        `(${days} şantiye gününden ${onTime} tanesi; ${filed} dosyalandı)`,
      calls: 'Hatırlatma aramaları',
      callsLine: (pct, filed, days) =>
        `%${pct} aramada dosyalandı (TalkOlog’un aradığı ${days} şantiye gününden ${filed} tanesi)`,
      weather: 'Şantiyelere göre hava kaynaklı saatler',
      noWeather: 'Hava kaynaklı duruş yok',
      gaps: 'Fatura farkları',
      noGaps: 'Açık fatura farkı yok',
      unsigned: 'Onaylanmamış raporlar',
      allSigned: 'Dosyalanan tüm raporlar onaylandı',
      openTalkOlog: 'TalkOlog’u aç',
      title: 'Haftalık özet',
    },
    unknown: {
      subject: 'Bilinmeyen bir numara rapor göndermeye çalıştı',
      number: 'Numara',
      message: 'Mesaj',
      noText: '(metin yok)',
      unknownNumber: 'bilinmeyen numara',
      body: 'Numarayı Ekip ve numaralar sayfasında bir şantiyeye bağlayın ya da yok sayın. Hiçbir şey dosyalanmadı.',
      textLine: 'Hiçbir şey dosyalanmadı. Ekip ve numaralar sayfasında bağlayın ya da yok sayın:',
      cta: 'Ekip ve numaralar sayfasını aç',
    },
    edited: {
      subject: (no) => `${no} onaydan sonra düzenlendi`,
      body: (no, v) => `${no}, siz onayladıktan sonra düzenlendi. Sürüm ${v} yeniden onaylanmalı.`,
      change: 'Değişiklik:',
      noNote: '(not yok)',
      review: 'İncele',
      cta: 'Raporu incele',
    },
  },
};
