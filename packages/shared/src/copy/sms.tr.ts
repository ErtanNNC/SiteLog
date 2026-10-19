import type { SmsCatalog, SmsWeatherPhrases, TrSmsKey } from './sms.ts';

/**
 * §9.2 SMS copy, Turkish: verbatim from the spec table. The TR pack's SMS is one-way
 * (`two_way_sms = false`: a Twilio long code since §19 Q370, the `TALKOLOG` title later), so these texts never ask for a reply,
 * Turkish has no welcome reply hint, and the two-way keys (unknown_number, help, stop_confirm,
 * pref_call_ok, pref_text_ok) have no Turkish text: a pack with two-way SMS and Turkish fails `packCopyGaps()` until they
 * exist. The report keywords' replies (day_off_link, edit_preview, edit_unclear; W2-12, spec §19
 * Q83) do have Turkish text, for a two-way TR pack or WhatsApp later. Formal "siz", no exclamation marks (§9.7). Punctuation is GSM-7 only (spec §19 Q15), so
 * only Turkish letters (and the "â" of "hâlâ") fall outside GSM-7.
 */
export const smsTr: SmsCatalog<TrSmsKey> = {
  welcome: {
    withNumber:
      'Merhaba {first}, ben TalkOlog, {company} için {site} günlük rapor asistanıyım. Her iş günü {deadline} öncesi linke dokunup ~3 dk anlatın ya da {number} numarayı arayın: {link}',
    withoutNumber:
      'Merhaba {first}, ben TalkOlog, {company} için {site} günlük rapor asistanıyım. Her iş günü {deadline} öncesi linke dokunup ~3 dk anlatın: {link}',
  },
  verify_code: 'TalkOlog kodunuz: {code}. 10 dakika geçerlidir.',
  daily_link: {
    withNumber: '{site} bugünkü rapor: {link} - ya da {number} numarayı arayın.',
    withoutNumber: '{site} bugünkü rapor: {link}',
  },
  call_coming:
    'Bugünkü rapor için sizi saat {time} gibi arayacağım. Şimdi yapmak isterseniz: {link}',
  weather_headsup:
    'Hatırlatma: rapor saati {deadline}. {weather_phrase} - kaybedilen saatleri ve duran işleri belirtin.',
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
  site_paused: "{site} TalkOlog'da duraklatıldı. Ofisten yeniden açmasını isteyin.",
  // W2-12 (spec §19 Q83, Q102): the report keywords' replies, for a two-way TR pack or WhatsApp;
  // for the Q63 review.
  day_off_link: '{site} için bugünün ayrıntılarını ekleyin: {link}',
  edit_preview: '{weekday}: {change}? Buradan onaylayın: {link}',
  edit_unclear: 'Bu değişikliği mesajla yapamadım. Geçmiş raporlardan yapın: {link}',
  // W2-16 (spec §19 Q111): the two-way replies in Turkish, sent on WhatsApp (TR SMS is one-way);
  // for the Q63 review.
  unknown_number: "Bu numara TalkOlog'da kayıtlı değil. Ofisinizden sizi eklemesini isteyin.",
  help: {
    withNumber:
      '{company} için TalkOlog günlük raporları. Linkiniz: {link} - {number} numarayı arayın - Değiştirmek için CALL ya da TEXT yazın - Durdurmak için STOP yazın.',
    withoutNumber:
      '{company} için TalkOlog günlük raporları. Linkiniz: {link} - Değiştirmek için CALL ya da TEXT yazın - Durdurmak için STOP yazın.',
  },
  stop_confirm: "TalkOlog'dan artık mesaj almayacaksınız. Yeniden başlatmak için START yazın.",
  pref_call_ok: 'Tamam, günlük raporunuz artık telefonla. Linke geçmek için TEXT yazın.',
  pref_text_ok:
    'Tamam, günlük raporunuz artık mesajla gelen linkle. Aramaya geçmek için CALL yazın.',
  // W2-16 (spec §19 Q85, Q40): WhatsApp only.
  whatsapp_use_link: 'Sesli notlar linkinizden gönderilir: {link}',
  whatsapp_stop_confirm:
    "TalkOlog'dan artık WhatsApp mesajı almayacaksınız. Yeniden başlatmak için START yazın.",
};

/**
 * The heads-up's `{weather_phrase}` (W2-06, for the Q63 review). No "â": every letter is in the
 * GSM-7 Turkish single shift table, so a sender with it keeps the heads-up GSM-7.
 */
export const smsWeatherPhraseTr: SmsWeatherPhrases = {
  rainMorning: 'Bu sabah yağmur yağdı ({amount})',
  rainAfternoon: 'Öğleden sonra yağmur yağdı ({amount})',
  rainDay: 'Bugün yağmur yağdı ({amount})',
  gusts: 'Rüzgar hamleleri {speed} değerine ulaştı',
  gustsAfterRain: 'rüzgar hamleleri {speed} değerine ulaştı',
  and: ' ve ',
  fallback: 'Bugün hava şantiyeyi etkiledi',
  decimal: ',',
};

/**
 * W4-06 (spec §9.1): HELP's privacy clause, appended by `renderSms` when the pack names a privacy
 * notice (`SMS_HELP_PRIVACY`). For the Q63 review.
 */
export const smsHelpPrivacyTr = ' - Aydınlatma metni: {privacy_link}';

/** W4-05 (spec §19 Q232): Settings' "Send me a test message". For the Q63 review. */
export const smsTestMessageTr =
  '{company} için TalkOlog deneme mesajı. Şantiye şefleriniz mesajlarını bu göndericiden alır. Yanıt gerekmez.';
