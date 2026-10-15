import {
  formatDate,
  formatHoursIn,
  intlLocaleOf,
  parseIsoDate,
  upperIn,
  type FieldChannel,
  type ReportLanguage,
  type VersionAuthor,
} from '@sitelog/shared';

/**
 * §12 report copy in the report language (§9.6: the org locale; EN or TR), GAP D34. Every label,
 * sentence and number format the daily report prints comes from here, so the document itself
 * holds no English. Times are HH:MM in the site's time zone (24 h, §10.10); "approx." /
 * "yaklaşık" marks spoken estimates.
 *
 * The source record, sign-off lines and footer follow `reports.channel` and `confirmed_via`
 * (v1.2: the web recorder, the voice assistant, SMS replies, the panel). A report from before
 * v1.2 has neither (null, D13): it came in on Meta WhatsApp, and its record says so.
 */

export type ReportKind = 'daily' | 'weather_day' | 'no_work';

/** How a report reached SiteLog, for its source record: v1.2 channels, or the v1.0 WhatsApp era. */
export type SourceChannel = FieldChannel | 'whatsapp_legacy';

export interface SourceFacts {
  channel: SourceChannel;
  /** Voice notes or calls, and their total length in seconds. */
  audioCount: number;
  audioSeconds: number;
  /** ISO 639-1 codes heard ("es", "en"). */
  languages: string[];
  textCount: number;
  photoCount: number;
  /** HH:MM (or a date and time) when the submission arrived; null when unknown. */
  receivedAt: string | null;
  /** Office entry: who typed the report, and when it was filed. */
  enteredBy: string | null;
  filedAt: string | null;
}

export interface ConfirmFacts {
  /** `confirmed_via`, else the report's channel. */
  via: SourceChannel;
  confirmedAt: string | null;
  filedAt: string | null;
}

export interface PdfCopy {
  lang: ReportLanguage;
  /** The BCP 47 tag for Intl. */
  intl: string;
  title: string;
  badge: Record<ReportKind, string>;
  reportNo(no: string, version: number): string;
  license(no: string): string;
  taxNo(no: string): string;
  meta: {
    date: string;
    projectNo: string;
    siteManager: string;
    preparedBy: string;
    workingHours: string;
    weather: string;
    filed: string;
  };
  filed(at: string, editedAt: string | null): string;
  draft: string;
  lost(hours: number): string;
  sections: {
    summary: string;
    weather: string;
    manpower: string;
    work: string;
    deliveries: string;
    safety: string;
    next: string;
    issues: string;
    photos: string;
    source: string;
  };
  noSummary: string;
  late: string;
  notStated: string;
  noneStated: string;
  noPhotos: string;
  weatherTable: {
    period: string;
    condition: string;
    impact: string;
    lost: string;
    fullDay: string;
    from(start: string): string;
    workStopped: string;
    noImpact: string;
    conditionsNotStated: string;
    observed: string;
    precipitation: string;
    wind: string;
    gusts: string;
  };
  manpowerTable: {
    company: string;
    trade: string;
    area: string;
    workers: string;
    hours: string;
    total(companies: number): string;
    unconfirmed: string;
    confirmed: string;
    edited: string;
  };
  workTable: {
    area: string;
    activity: string;
    status: string;
    statuses: Record<'complete' | 'in_progress' | 'started' | 'stopped' | 'planned', string>;
    percent(pct: number): string;
  };
  approx: string;
  hours(h: number | null | undefined): string;
  num(n: number, maxDigits?: number): string;
  safety: {
    toolboxTalk(topic: string): string;
    noIncidents: string;
    visitors(list: string): string;
    severity: Record<'near_miss' | 'first_aid' | 'recordable' | 'lost_time', string>;
  };
  /** Manpower footnote for a value the site manager confirmed by answering a question. */
  answerNote(company: string, field: string | null, at: string | null): string;
  /** Footnote for version `version` (> 1). */
  editNote(version: number, author: VersionAuthor, note: string | null, at: string): string;
  reviewFlags(flags: string): string;
  sourceRecord(src: SourceFacts, confirm: ConfirmFacts): string;
  signoff: {
    siteManager: string;
    preparedBy: string;
    projectManager: string;
    signatureAndDate: string;
    confirmed(via: SourceChannel, at: string): string;
    notConfirmed: string;
    entered(at: string | null): string;
    signedOff(name: string, at: string): string;
  };
  footer: {
    voice: string;
    typed: string;
    plain: string;
    weather: string;
    page(n: number, of: number): string;
  };
  dateFull(date: string): string;
  /** "Oct 9, 2026" · "9 Eki 2026" (running header). */
  dateMedium(date: string): string;
  /** "Oct 10, 09:12" · "10 Eki 09:12": a time on another day than the report's. */
  dayTime(date: string, time: string): string;
  /** "Oct 9, 2026, 20:10" · "9 Eki 2026 20:10". */
  dateTime(date: string, time: string): string;
}

const LANGUAGE_NAMES: Record<ReportLanguage, Record<string, string>> = {
  en: { en: 'English', es: 'Spanish', tr: 'Turkish' },
  tr: { en: 'İngilizce', es: 'İspanyolca', tr: 'Türkçe' },
};

/** ["es","en"] → "Spanish and English" · "İspanyolca ve İngilizce"; unknown codes print upper case. */
export function languageList(codes: readonly string[], lang: ReportLanguage): string {
  const names = codes.map((c) => LANGUAGE_NAMES[lang][c.toLowerCase()] ?? c.toUpperCase());
  return joinList(names, lang);
}

/** "a", "a and b", "a, b and c" (EN) · "a ve b" (TR). */
export function joinList(items: readonly string[], lang: ReportLanguage): string {
  const and = lang === 'tr' ? ' ve ' : ' and ';
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')}${and}${items[items.length - 1]}`;
}

/** 168 → "2 min 48 s" · "2 dk 48 sn". */
export function durationIn(seconds: number, lang: ReportLanguage): string {
  const [min, sec] = lang === 'tr' ? ['dk', 'sn'] : ['min', 's'];
  const s = Math.max(0, Math.round(seconds));
  const m = Math.floor(s / 60);
  const r = s % 60;
  if (m === 0) return `${r} ${sec}`;
  return r === 0 ? `${m} ${min}` : `${m} ${min} ${r} ${sec}`;
}

function capitalise(text: string, lang: ReportLanguage): string {
  return text ? upperIn(lang, text[0]!) + text.slice(1) : text;
}

function numberIn(lang: ReportLanguage) {
  return (n: number, maxDigits = 2) =>
    new Intl.NumberFormat(intlLocaleOf(lang), {
      maximumFractionDigits: maxDigits,
      useGrouping: false,
    }).format(n);
}

function monthDay(date: string, lang: ReportLanguage): string {
  return formatDate(date, 'monthDay', lang);
}

/** Which figure an answered question confirmed (§10.5 question fields). */
function answerTopic(field: string | null): 'headcount' | 'hours' | null {
  if (!field) return null;
  if (field.startsWith('manpower.workers')) return 'headcount';
  if (field.startsWith('manpower.hours')) return 'hours';
  return null;
}

const en: PdfCopy = {
  lang: 'en',
  intl: intlLocaleOf('en'),
  title: 'Daily Site Report',
  badge: {
    daily: 'DAILY SITE REPORT',
    weather_day: 'WEATHER DAY REPORT',
    no_work: 'NO WORK REPORT',
  },
  reportNo: (no, v) => `No. ${no} · v${v}`,
  license: (no) => `License ${no}`,
  taxNo: (no) => `Tax ID ${no}`,
  meta: {
    date: 'Date',
    projectNo: 'Project no.',
    siteManager: 'Site manager',
    preparedBy: 'Prepared by',
    workingHours: 'Working hours',
    weather: 'Weather',
    filed: 'Filed / edited',
  },
  filed: (at, edited) => (edited ? `${at} · edited ${edited}` : at),
  draft: 'Draft',
  lost: (h) => `${formatHoursIn(h, 'en')} lost`,
  sections: {
    summary: 'Summary',
    weather: 'Weather & delays',
    manpower: 'Manpower on site',
    work: 'Work performed',
    deliveries: 'Deliveries',
    safety: 'Safety',
    next: 'Next workday',
    issues: 'Issues',
    photos: 'Site photos',
    source: 'Source record',
  },
  noSummary: 'No summary.',
  late: 'Filed after the reporting deadline.',
  notStated: 'Not stated',
  noneStated: 'None stated',
  noPhotos: 'No photos attached.',
  weatherTable: {
    period: 'Period',
    condition: 'Condition',
    impact: 'Impact on work',
    lost: 'Lost time',
    fullDay: 'Full day',
    from: (start) => `from ${start}`,
    workStopped: 'Work stopped',
    noImpact: 'No impact',
    conditionsNotStated: 'Conditions not stated.',
    observed: 'Observed:',
    precipitation: 'precipitation',
    wind: 'wind',
    gusts: 'gusts',
  },
  manpowerTable: {
    company: 'Company',
    trade: 'Trade',
    area: 'Area',
    workers: 'Workers',
    hours: 'Hours',
    total: (n) => `Total · ${n} compan${n === 1 ? 'y' : 'ies'}`,
    unconfirmed: 'UNCONFIRMED',
    confirmed: 'CONFIRMED',
    edited: 'EDITED',
  },
  workTable: {
    area: 'Area',
    activity: 'Activity',
    status: 'Status',
    statuses: {
      complete: 'Complete',
      in_progress: 'In progress',
      started: 'Started',
      stopped: 'Stopped',
      planned: 'Planned',
    },
    percent: (p) => `${p}%`,
  },
  approx: 'approx.',
  hours: (h) => formatHoursIn(h, 'en'),
  num: numberIn('en'),
  safety: {
    toolboxTalk: (t) => `Toolbox talk: ${t}`,
    noIncidents: 'No incidents reported.',
    visitors: (l) => `Visitors: ${l}`,
    severity: {
      near_miss: 'near miss',
      first_aid: 'first aid',
      recordable: 'recordable',
      lost_time: 'lost time',
    },
  },
  answerNote: (company, field, at) => {
    const topic = answerTopic(field);
    const what = topic === 'headcount' ? ' headcount' : topic === 'hours' ? ' hours' : '';
    return `${company}${what} confirmed by the site manager${at ? ` at ${at}` : ''}.`;
  },
  editNote: (v, author, note, at) => {
    const what =
      author === 'reporter'
        ? 'corrected by the site manager'
        : author === 'office_user'
          ? 'edited in SiteLog by the office'
          : 'updated';
    const tail = `${what} at ${at} (v${v}).`;
    return note ? `${note}: ${tail}` : capitalise(tail, 'en');
  },
  reviewFlags: (f) => `Review flags: ${f}`,
  sourceRecord: (src, confirm) => {
    const out: string[] = [];
    const audio = src.audioCount > 0;
    const langs = src.languages.length ? `, ${languageList(src.languages, 'en')}` : '';
    const detail = `(${durationIn(src.audioSeconds, 'en')}${langs})`;
    const photos = src.photoCount
      ? `${src.photoCount} photo${src.photoCount === 1 ? '' : 's'}`
      : null;
    if (src.enteredBy !== null || src.channel === 'office') {
      out.push(`Entered in SiteLog by ${src.enteredBy ?? 'the office'}.`);
      if (src.filedAt) out.push(`Filed at ${src.filedAt}.`);
      if (photos) out.push(`${capitalise(photos, 'en')} attached.`);
      out.push('Version history is retained in SiteLog.');
      return out.join(' ');
    }
    if (src.channel === 'voice') {
      const calls =
        src.audioCount > 1 ? `${src.audioCount} recorded phone calls` : 'a recorded phone call';
      out.push(
        `Compiled from ${calls} with the SiteLog assistant ${detail}${src.receivedAt ? ` at ${src.receivedAt}` : ''}.`,
      );
      if (photos) out.push(`${capitalise(photos, 'en')} attached.`);
    } else {
      const parts: string[] = [];
      if (audio) {
        const notes = src.audioCount > 1 ? `${src.audioCount} voice notes` : 'a voice note';
        parts.push(
          src.channel === 'whatsapp_legacy'
            ? `${notes} sent on WhatsApp ${detail}`
            : src.channel === 'sms'
              ? `${notes} ${detail}`
              : `${notes} recorded via the site manager’s personal link ${detail}`,
        );
      }
      if (src.textCount > 0)
        parts.push(`${src.textCount} text message${src.textCount === 1 ? '' : 's'}`);
      if (photos) parts.push(photos);
      const what = parts.length ? joinList(parts, 'en') : 'the site manager’s report';
      out.push(`Compiled from ${what}${src.receivedAt ? ` received at ${src.receivedAt}` : ''}.`);
    }
    if (confirm.confirmedAt) {
      const how: Record<SourceChannel, string> = {
        web: 'on the recorder',
        voice: 'by voice on the call',
        sms: 'by text message',
        office: 'in SiteLog',
        whatsapp_legacy: 'on WhatsApp',
      };
      out.push(`Confirmed by the site manager ${how[confirm.via]} at ${confirm.confirmedAt}.`);
    } else if (confirm.filedAt) {
      out.push(`Filed at ${confirm.filedAt} without the site manager’s confirmation.`);
    }
    out.push(
      audio
        ? 'Audio, transcript and version history are retained in SiteLog.'
        : 'Version history is retained in SiteLog.',
    );
    return out.join(' ');
  },
  signoff: {
    siteManager: 'Site manager',
    preparedBy: 'Prepared by',
    projectManager: 'Project manager',
    signatureAndDate: 'signature and date',
    confirmed: (via, at) => {
      const how: Record<SourceChannel, string> = {
        web: 'Confirmed on the recorder',
        voice: 'Confirmed by voice on the call',
        sms: 'Confirmed by text message',
        office: 'Confirmed in SiteLog',
        whatsapp_legacy: 'Confirmed on WhatsApp',
      };
      return `${how[via]} · ${at}`;
    },
    notConfirmed: 'Not confirmed',
    entered: (at) => (at ? `Entered in SiteLog · ${at}` : 'Entered in SiteLog'),
    signedOff: (name, at) => `Signed off in SiteLog by ${name} · ${at}`,
  },
  footer: {
    voice: 'Generated by SiteLog from a voice report',
    typed: 'Generated by SiteLog',
    plain: 'SiteLog',
    weather: 'Weather data: Open-Meteo',
    page: (n, of) => `Page ${n} of ${of}`,
  },
  dateFull: (d) => formatDate(d, 'full', 'en'),
  dateMedium: (d) => `${monthDay(d, 'en')}, ${parseIsoDate(d).y}`,
  dayTime: (d, t) => `${monthDay(d, 'en')}, ${t}`,
  dateTime: (d, t) => `${monthDay(d, 'en')}, ${parseIsoDate(d).y}, ${t}`,
};

const tr: PdfCopy = {
  lang: 'tr',
  intl: intlLocaleOf('tr'),
  title: 'Günlük Şantiye Raporu',
  badge: {
    daily: 'GÜNLÜK ŞANTİYE RAPORU',
    weather_day: 'HAVA MUHALEFETİ RAPORU',
    no_work: 'ÇALIŞMA YAPILMAYAN GÜN RAPORU',
  },
  reportNo: (no, v) => `No. ${no} · v${v}`,
  license: (no) => `Lisans no. ${no}`,
  taxNo: (no) => `Vergi no. ${no}`,
  meta: {
    date: 'Tarih',
    projectNo: 'Proje no.',
    siteManager: 'Şantiye şefi',
    preparedBy: 'Hazırlayan',
    workingHours: 'Çalışma saatleri',
    weather: 'Hava durumu',
    filed: 'Teslim / düzenleme',
  },
  filed: (at, edited) => (edited ? `${at} · düzenleme ${edited}` : at),
  draft: 'Taslak',
  lost: (h) => `${formatHoursIn(h, 'tr')} kayıp`,
  sections: {
    summary: 'Özet',
    weather: 'Hava durumu ve gecikmeler',
    manpower: 'Şantiyedeki işgücü',
    work: 'Yapılan işler',
    deliveries: 'Malzeme girişi',
    safety: 'İş güvenliği',
    next: 'Sonraki iş günü',
    issues: 'Sorunlar',
    photos: 'Şantiye fotoğrafları',
    source: 'Kaynak kaydı',
  },
  noSummary: 'Özet yok.',
  late: 'Rapor, teslim saatinden sonra gönderildi.',
  notStated: 'Belirtilmedi',
  noneStated: 'Belirtilmedi',
  noPhotos: 'Fotoğraf eklenmedi.',
  weatherTable: {
    period: 'Zaman',
    condition: 'Durum',
    impact: 'İşe etkisi',
    lost: 'Kayıp süre',
    fullDay: 'Tüm gün',
    from: (start) => `${start} itibarıyla`,
    workStopped: 'Çalışma durdu',
    noImpact: 'Etkisi yok',
    conditionsNotStated: 'Hava koşulları belirtilmedi.',
    observed: 'Ölçülen:',
    precipitation: 'yağış',
    wind: 'rüzgâr',
    gusts: 'hamle',
  },
  manpowerTable: {
    company: 'Firma',
    trade: 'İş kolu',
    area: 'Alan',
    workers: 'İşçi',
    hours: 'Saat',
    total: (n) => `Toplam · ${n} firma`,
    unconfirmed: 'ONAYLANMAMIŞ',
    confirmed: 'TEYİTLİ',
    edited: 'DÜZELTİLDİ',
  },
  workTable: {
    area: 'Alan',
    activity: 'Faaliyet',
    status: 'Durum',
    statuses: {
      complete: 'Tamamlandı',
      in_progress: 'Devam ediyor',
      started: 'Başladı',
      stopped: 'Durdu',
      planned: 'Planlandı',
    },
    percent: (p) => `%${p}`,
  },
  approx: 'yaklaşık',
  hours: (h) => formatHoursIn(h, 'tr'),
  num: numberIn('tr'),
  safety: {
    toolboxTalk: (t) => `İş güvenliği bilgilendirmesi: ${t}`,
    noIncidents: 'Olay bildirilmedi.',
    visitors: (l) => `Ziyaretçiler: ${l}`,
    severity: {
      near_miss: 'ramak kala',
      first_aid: 'ilk yardım',
      recordable: 'kayda geçen olay',
      lost_time: 'iş günü kayıplı kaza',
    },
  },
  answerNote: (company, field, at) => {
    const topic = answerTopic(field);
    const what =
      topic === 'headcount'
        ? ' işçi sayısı'
        : topic === 'hours'
          ? ' çalışma saatleri'
          : ' bilgileri';
    return `${company}${what} şantiye şefi tarafından teyit edildi${at ? ` (saat ${at})` : ''}.`;
  },
  editNote: (v, author, note, at) => {
    const what =
      author === 'reporter'
        ? 'şantiye şefi tarafından düzeltildi'
        : author === 'office_user'
          ? 'ofis tarafından SiteLog’da düzenlendi'
          : 'güncellendi';
    const tail = `${what} (saat ${at}, v${v}).`;
    return note ? `${note}: ${tail}` : capitalise(tail, 'tr');
  },
  reviewFlags: (f) => `İnceleme işaretleri: ${f}`,
  sourceRecord: (src, confirm) => {
    const out: string[] = [];
    const audio = src.audioCount > 0;
    const langs = src.languages.length ? `, ${languageList(src.languages, 'tr')}` : '';
    const detail = `(${durationIn(src.audioSeconds, 'tr')}${langs})`;
    if (src.enteredBy !== null || src.channel === 'office') {
      out.push(
        src.enteredBy
          ? `Rapor, SiteLog’a ${src.enteredBy} tarafından girilmiştir.`
          : 'Rapor, SiteLog’a ofis tarafından girilmiştir.',
      );
      if (src.filedAt) out.push(`Teslim saati ${src.filedAt}.`);
      if (src.photoCount) out.push(`${src.photoCount} fotoğraf eklendi.`);
      out.push('Sürüm geçmişi SiteLog’da saklanmaktadır.');
      return out.join(' ');
    }
    if (src.channel === 'voice') {
      const calls =
        src.audioCount > 1
          ? `${src.audioCount} kayıtlı telefon görüşmesinden`
          : 'kayıtlı bir telefon görüşmesinden';
      out.push(
        `Rapor, SiteLog asistanıyla yapılan ${calls} ${detail} derlenmiştir${src.receivedAt ? ` (görüşme saati ${src.receivedAt})` : ''}.`,
      );
      if (src.photoCount) out.push(`${src.photoCount} fotoğraf eklendi.`);
    } else {
      const parts: string[] = [];
      if (audio) {
        const notes = src.audioCount > 1 ? `${src.audioCount} sesli nottan` : 'bir sesli nottan';
        parts.push(
          src.channel === 'whatsapp_legacy'
            ? `WhatsApp’tan gönderilen ${notes} ${detail}`
            : src.channel === 'sms'
              ? `${notes} ${detail}`
              : `şantiye şefinin kişisel bağlantısıyla kaydedilen ${notes} ${detail}`,
        );
      }
      if (src.textCount > 0) parts.push(`${src.textCount} kısa mesajdan`);
      if (src.photoCount) parts.push(`${src.photoCount} fotoğraftan`);
      const what = parts.length ? joinList(parts, 'tr') : 'şantiye şefinin bildiriminden';
      out.push(
        `Rapor, ${what} derlenmiştir${src.receivedAt ? ` (alınma saati ${src.receivedAt})` : ''}.`,
      );
    }
    if (confirm.confirmedAt) {
      const how: Record<SourceChannel, string> = {
        web: 'raporu kayıt ekranında onayladı',
        voice: 'raporu görüşmede sesli olarak onayladı',
        sms: 'raporu kısa mesajla onayladı',
        office: 'raporu SiteLog’da onayladı',
        whatsapp_legacy: 'raporu WhatsApp’ta onayladı',
      };
      out.push(`Şantiye şefi ${how[confirm.via]} (saat ${confirm.confirmedAt}).`);
    } else if (confirm.filedAt) {
      out.push(`Rapor, şantiye şefinin onayı olmadan teslim edildi (saat ${confirm.filedAt}).`);
    }
    out.push(
      audio
        ? 'Ses kaydı, döküm ve sürüm geçmişi SiteLog’da saklanmaktadır.'
        : 'Sürüm geçmişi SiteLog’da saklanmaktadır.',
    );
    return out.join(' ');
  },
  signoff: {
    siteManager: 'Şantiye şefi',
    preparedBy: 'Hazırlayan',
    projectManager: 'Proje müdürü',
    signatureAndDate: 'imza ve tarih',
    confirmed: (via, at) => {
      const how: Record<SourceChannel, string> = {
        web: 'Kayıt ekranında onaylandı',
        voice: 'Görüşmede sesli onaylandı',
        sms: 'Kısa mesajla onaylandı',
        office: 'SiteLog’da onaylandı',
        whatsapp_legacy: 'WhatsApp’ta onaylandı',
      };
      return `${how[via]} · ${at}`;
    },
    notConfirmed: 'Onaylanmadı',
    entered: (at) => (at ? `SiteLog’a girildi · ${at}` : 'SiteLog’a girildi'),
    signedOff: (name, at) => `SiteLog’da onaylayan: ${name} · ${at}`,
  },
  footer: {
    voice: 'SiteLog tarafından sesli rapordan oluşturuldu',
    typed: 'SiteLog tarafından oluşturuldu',
    plain: 'SiteLog',
    weather: 'Hava durumu verisi: Open-Meteo',
    page: (n, of) => `Sayfa ${n} / ${of}`,
  },
  dateFull: (d) => formatDate(d, 'full', 'tr'),
  dateMedium: (d) => `${monthDay(d, 'tr')} ${parseIsoDate(d).y}`,
  dayTime: (d, t) => `${monthDay(d, 'tr')} ${t}`,
  dateTime: (d, t) => `${monthDay(d, 'tr')} ${parseIsoDate(d).y} ${t}`,
};

export const PDF_COPY: Record<ReportLanguage, PdfCopy> = { en, tr };

/** The copy for a report language; anything else (a bad stored value) prints English. */
export function pdfCopy(lang: string | null | undefined): PdfCopy {
  return lang === 'tr' ? tr : en;
}

/** Section titles print in upper case with the language's rules (Turkish i → İ). */
export function upper(copy: PdfCopy, text: string): string {
  return upperIn(copy.lang, text);
}
