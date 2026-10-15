import type { SharedSmsKey, SmsCatalog } from './sms.ts';

/**
 * §9.2 SMS copy, Turkish: verbatim from the spec table. The TR pack's SMS is one-way (the
 * `SITELOG` alphanumeric title, `two_way_sms = false`), so these texts never ask for a reply,
 * Turkish has no welcome reply hint, and the two-way keys (unknown_number, help, stop_confirm,
 * pref_call_ok, pref_text_ok) have no Turkish text: a pack with two-way SMS and Turkish fails `packCopyGaps()` until they
 * exist. Formal "siz", no exclamation marks (§9.7).
 */
export const smsTr: SmsCatalog<SharedSmsKey> = {
  welcome: {
    withNumber:
      'Merhaba {first}, ben SiteLog, {company} için {site} günlük rapor asistanıyım. Her iş günü {deadline} öncesi linke dokunup ~3 dk anlatın ya da {number} numarayı arayın: {link}',
    withoutNumber:
      'Merhaba {first}, ben SiteLog, {company} için {site} günlük rapor asistanıyım. Her iş günü {deadline} öncesi linke dokunup ~3 dk anlatın: {link}',
  },
  verify_code: 'SiteLog kodunuz: {code}. 10 dakika geçerlidir.',
  daily_link: {
    withNumber: '{site} bugünkü rapor: {link} — ya da {number} numarayı arayın.',
    withoutNumber: '{site} bugünkü rapor: {link}',
  },
  call_coming:
    'Bugünkü rapor için sizi saat {time} gibi arayacağım. Şimdi yapmak isterseniz: {link}',
  weather_headsup:
    'Hatırlatma: rapor saati {deadline}. {weather_phrase} — kaybedilen saatleri ve duran işleri belirtin.',
  reminder_1: '{site} için bugün henüz rapor yok. Bir dakikalık sesli not yeterli: {link}',
  reminder_2: {
    withNumber:
      'Bugün için hâlâ rapor yok. Saat {time} itibarıyla ofise bilgi vereceğim. {link} ya da {number}.',
    withoutNumber:
      'Bugün için hâlâ rapor yok. Saat {time} itibarıyla ofise bilgi vereceğim. {link}',
  },
  missed_call: {
    withNumber: 'Bugünkü rapor için ulaşamadım. {number} numarayı arayın ya da: {link}',
    withoutNumber: 'Bugünkü rapor için ulaşamadım. {link}',
  },
  question_ready: 'Bugünkü raporla ilgili tek bir soru: {link}',
  draft_ready: 'Raporunuz kontrol için hazır: {link}',
  filed: 'Kaydedildi: Günlük Rapor {report_no}. PDF: {pdf_link}',
  photos_link: 'Bugünkü rapora fotoğraf ekleyin: {link}',
  edit_applied: '{weekday} güncellendi: {change}. Sürüm {v} ofise gönderildi.',
  finish_report: 'Görüşme kayıttan önce bitti. Tek dokunuşla tamamlayın: {link}',
  site_paused: "{site} SiteLog'da duraklatıldı. Ofisten yeniden açmasını isteyin.",
};
