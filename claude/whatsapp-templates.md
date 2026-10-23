# WhatsApp şablonları (Twilio Content Template Builder)

Kaynak: `packages/shared/src/whatsapp/templates.ts` (`pnpm countries:set -- --code US --print-whatsapp-templates`, `--code TR` aynısı), 2026-10-20, spec §19 Q372 ile. Gövdeler SMS metinlerinden (`packages/shared/src/copy/sms.{en,es,tr}.ts`) üretilir; burada sesli arama numarası **olmayan** paket varyantı var (preview'da `voice_number` boş). Numara eklenirse "ya da {numara} arayın" cümlesi olan şablonlar (welcome, daily_link, reminder_2, …) yeniden gönderilmeli: o zaman listeyi yeniden yazdırın.

## Nasıl gönderilir

1. Twilio Console → Messaging → **Content Template Builder** → _Create new_.
2. **Ad:** `talkolog_<anahtar>_<dil>` (örnek `talkolog_filed_tr`); metni yeniden yazılan anahtarlarda `talkolog_<anahtar>_v2_<dil>`: karşılama `talkolog_welcome_v2_<dil>` (§19 Q373: ilk metni Meta "Marketing" saydı, yeni metin bir davet bildirimi) ve `daily_link`, `reminder_1`, `missed_call`, `finish_report`, `edit_applied` (§19 Q377, aşağıda). Dil: aşağıdaki tablonun dili (`en`, `es`, `tr`).
3. **Tür (content type):**
   - `verify_code` dışındaki her şablon: **Text** (`twilio/text`), WhatsApp onay kategorisi **Utility**.
   - `verify_code`: **Authentication** (`whatsapp/authentication`), kategori **Authentication**. Metni Meta sabitler, siz yazmazsınız: "Add security recommendation" **açık**, "Code expiration" **10 dakika**, buton **Copy code** (Türkçe şablonda buton metni `Kodu kopyala`, İspanyolcada `Copiar código`). Tek değişken `{{1}}` = kod.
4. Gövdeyi aşağıdan **aynen** yapıştırın; `{{1}}`, `{{2}}` … numaralarını ve sırasını değiştirmeyin. Meta örnek değer ister: "Örnek" sütunundakileri girin.
5. _Save and submit for WhatsApp approval_. Onaylanınca her şablonun `HX…` kimliğini bana şu biçimde yazın (§19 Q374'ten beri SMS kapalı: şablonu olmayan anahtar/dil hiç gitmez, ofise "ulaşılamadı" bildirimi düşer):

```json
{
  "welcome": { "en": "HX…", "es": "HX…", "tr": "HX…" },
  "verify_code": { "en": "HX…", "es": "HX…", "tr": "HX…" },
  "daily_link": { "en": "HX…", "es": "HX…", "tr": "HX…" }
}
```

Aynı numara (+17752628262) iki pakete de hizmet ediyor; aynı `HX…` kimliklerini US paketine `en`/`es`, TR paketine `tr`/`en` olarak `countries-set` ile ben işlerim.

**Öncelik:** önce `welcome` ve `verify_code` (üç dilde): ilk temas (karşılama ve cihaz kodu) artık WhatsApp'tan gidebiliyor (§19 Q372) ; şablonu onaylanmayan mesaj gitmez (§19 Q374). Sonra `daily_link`, `reminder_1`, `reminder_2`, `question_ready`, `draft_ready`, `filed`.

## 2026-10-23: beş şablonun yeni metni (§19 Q377)

Meta ilk gönderimde şunları söyledi:

- **Reddedildi:** `missed_call.en` ("Missed you for today's report. Tap {{1}}."): değişken metnin sonunda. Son değişkenden sonraki "." bunu değiştirmiyor, Meta yine "sonda" sayıyor.
- **Reddedildi:** `edit_applied` (tr, en): metnin uzunluğuna göre çok fazla değişken.
- **Marketing'e çevrildi (beklemede):** `daily_link.tr`, `reminder_1` (tr, en: "…A one-minute voice note is plenty…"), `missed_call.tr`, `finish_report` (tr, en: "…Finish in one tap…").

Sahibin kararı (2026-10-23): bu beş anahtarın WhatsApp metni SMS metninden ayrıldı. Yeni metinler sade, bilgilendirici, ikna etmeye çalışmayan Utility metinleri; değişkenler aynı sırada ve aynı anlamda; hiçbiri değişkenle başlamıyor ya da bitmiyor ("(lütfen paylaşmayın)." gibi bir kuyruk var); hepsi "TalkOlog: " ile başlıyor. Twilio ve Meta'da ad tekil ve eski şablonlar duruyor, bu yüzden yeni adlarla gönderilirler: `talkolog_<anahtar>_v2_<dil>`. `--sync` yalnızca güncel adı okur: eski Marketing ya da reddedilmiş şablonlar hiç yazılmaz. Başlangıç/son kuralı (§19 Q110) da düzeltildi: değişkenle kenar arasında yalnızca noktalama ya da boşluk varsa değişken yine "başta" ya da "sonda" sayılır ve `TalkOlog: ` / ` - TalkOlog` eklenir. SMS metinleri değişmedi. Sesli arama numarası olan pakette de bu beş şablonda "ya da {numara} arayın" cümlesi yoktur (karşılamadaki gibi).

Gönderim: `pnpm whatsapp:templates -- --submit --code TR,US --lang tr,en` (ya da Actions → Deploy, hedef `whatsapp-templates`) yalnızca yeni `_v2` adlarını oluşturur; onaydan sonra `--sync`.

## Otomatik yükleme

Şablonları Console'da tek tek oluşturmak gerekmez: `pnpm whatsapp:templates` (`scripts/src/whatsapp-templates.ts`) Twilio Content API ile yapar. Preview'da Actions → **Deploy**, ortam `preview`, hedef `whatsapp-templates`, `pack_code` (örnek `TR,US`), `wa_mode` ve `wa_languages` (varsayılan `tr,en`). Sonuç tablosu çalışmanın özetine (run summary) yazılır.

1. **Kuru çalışma** (`wa_mode` = `dry-run`): paketlerin hangi şablonlara ihtiyacı olduğunu adı, kategorisi, gövdesi ve örnek değerleriyle yazar; Twilio'ya hiçbir şey göndermez, Twilio anahtarı istemez.
2. **Gönderim** (`wa_mode` = `submit`): Twilio'daki şablonları listeler; adı zaten olanı atlar ve onay durumunu yazar (oluşturulmuş ama onaya gönderilmemişi gönderir); eksikleri yukarıdaki adlar, gövdeler ve örnek değerlerle oluşturur ve her birini WhatsApp onayına gönderir (`verify_code` Authentication: güvenlik önerisi açık, 10 dakika, dile göre kopyala düğmesi; diğerleri Utility). Tekrar çalıştırmak güvenlidir: hiçbir şey iki kez oluşturulmaz.
3. **Eşitleme** (`wa_mode` = `sync`, Meta onayladıktan sonra, genelde dakikalar ile bir gün arası): her paket, dil ve anahtar için güncel adlı şablon **onaylıysa**, kategorisi Utility (kod için Authentication) ise ve gövdesi paketin bugünkü gövdesiyse `HX…` kimliğini paketin `whatsapp_templates` alanına ekler; var olan kayıtlar kalır. Yazma `countries-set` ile aynı yoldan, `set_country_endpoints()` üzerinden ve denetim kaydıyla (`country.endpoints_set`) olur. Meta'nın Marketing'e çevirdiği bir şablon asla yazılmaz; tabloda ayrıca listelenir (yeni bir adla, örneğin `_v3`, yeniden gönderilmeli).

Yerelde: `SUPABASE_DB_URL=… TWILIO_ACCOUNT_SID=… TWILIO_AUTH_TOKEN=… pnpm whatsapp:templates -- --submit --code TR,US --lang tr,en` (ya da `--dry-run`, ya da `--sync --code TR,US`); barındırılan veritabanı `--yes` ister. Aynı ad iki pakette farklı gövde isterse (biri sesli arama numaralı, öbürü değil) betik durur: bir ad tek gövde taşır.

## Değişkenler

| Değişken         | Anlamı                                  | Örnek                                           |
| ---------------- | --------------------------------------- | ----------------------------------------------- |
| `first`          | Raporcunun adı (ilk ad)                 | Marco                                           |
| `company`        | Şirketin adı                            | Kestrel Build Group                             |
| `site`           | Şantiye adı                             | Riverside Lofts                                 |
| `deadline`       | Günlük rapor saati (şantiye saatiyle)   | 17:30                                           |
| `link`           | Kişisel rapor linki                     | https://go.talkolog.com/r/K7Q2MX4P9ZTA          |
| `time`           | Saat (arama ya da ofise bildirim saati) | 16:30                                           |
| `weather_phrase` | Hava durumu cümlesi                     | Rain is forecast from 14:00.                    |
| `report_no`      | Rapor numarası                          | RL-2041-0187                                    |
| `pdf_link`       | Raporun PDF linki                       | https://go.talkolog.com/r/K7Q2MX4P9ZTA/report/1 |
| `weekday`        | Raporun günü                            | Fri                                             |
| `change`         | Yapılan değişiklik                      | Apex 7 workers, not 6                           |
| `v`              | Yeni sürüm numarası                     | 2                                               |
| `code`           | 6 haneli doğrulama kodu                 | 482913                                          |

## İngilizce (en)

| Anahtar               | Kategori       | Değişkenler                                    | Metin                                                                                                                                                      |
| --------------------- | -------------- | ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| welcome               | Utility        | 1=first, 2=company, 3=site, 4=deadline, 5=link | TalkOlog: {{1}}, {{2}} added you as the daily reporter for {{3}}. Each workday before {{4}}, send your report from this link: {{5}} Reply STOP to opt out. |
| verify_code           | Authentication | 1=code                                         | {{1}} is your verification code. For your security, do not share this code. _(alt bilgi, Meta'nın: This code expires in 10 minutes.)_                      |
| daily_link (`_v2`)    | Utility        | 1=site, 2=link                                 | TalkOlog: the daily report for {{1}} is open. Your personal report link for today: {{2}} (please do not share it).                                         |
| call_coming           | Utility        | 1=time, 2=link                                 | I'll call you at {{1}} for today's report. Prefer to do it now? {{2}} - TalkOlog                                                                           |
| weather_headsup       | Utility        | 1=deadline, 2=weather_phrase                   | Heads-up: report due at {{1}}. {{2}} - mention the hours lost and what stopped.                                                                            |
| reminder_1 (`_v2`)    | Utility        | 1=site, 2=link                                 | TalkOlog: the daily report for {{1}} has not been received yet today. Your report link: {{2}} (please do not share it).                                    |
| reminder_2            | Utility        | 1=time, 2=link                                 | Still nothing for today. I'll let the office know at {{1}}. {{2}} - TalkOlog                                                                               |
| missed_call (`_v2`)   | Utility        | 1=link                                         | TalkOlog: we could not reach you by phone for today's daily report. Your report link: {{1}} (please do not share it).                                      |
| question_ready        | Utility        | 1=link                                         | One quick question about today's report: {{1}} - TalkOlog                                                                                                  |
| draft_ready           | Utility        | 1=link                                         | Your report is ready to check: {{1}} - TalkOlog                                                                                                            |
| filed                 | Utility        | 1=report_no, 2=pdf_link                        | Filed: Daily Report {{1}}. PDF: {{2}} - TalkOlog                                                                                                           |
| photos_link           | Utility        | 1=link                                         | Add photos to today's report: {{1}} - TalkOlog                                                                                                             |
| edit_applied (`_v2`)  | Utility        | 1=weekday, 2=change, 3=v                       | TalkOlog: your daily report for {{1}} was updated with this change: {{2}}. Version {{3}} of the report has been sent to the office.                        |
| finish_report (`_v2`) | Utility        | 1=link                                         | TalkOlog: your call ended before today's report was filed, so the report is not filed yet. Your report link: {{1}} (please do not share it).               |
| site_paused           | Utility        | 1=site                                         | TalkOlog: {{1}} is paused in TalkOlog. Ask the office to resume it.                                                                                        |

## İspanyolca (es)

| Anahtar               | Kategori       | Değişkenler                                    | Metin                                                                                                                                                                                              |
| --------------------- | -------------- | ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| welcome               | Utility        | 1=first, 2=company, 3=site, 4=deadline, 5=link | TalkOlog: {{1}}, {{2}} le agregó como responsable del reporte diario de {{3}}. Cada día de trabajo antes de las {{4}}, envíe su reporte desde este enlace: {{5}} Responda STOP para darse de baja. |
| verify_code           | Authentication | 1=code                                         | Tu código de verificación es {{1}}. Por tu seguridad, no lo compartas. _(alt bilgi, Meta'nın: Este código caduca en 10 minutos.)_                                                                  |
| daily_link (`_v2`)    | Utility        | 1=site, 2=link                                 | TalkOlog: el reporte diario de {{1}} está abierto. Su enlace personal de reporte para hoy: {{2}} (por favor, no lo comparta).                                                                      |
| call_coming           | Utility        | 1=time, 2=link                                 | Le llamaré a las {{1}} para el reporte de hoy. ¿Prefiere hacerlo ahora? {{2}} - TalkOlog                                                                                                           |
| weather_headsup       | Utility        | 1=deadline, 2=weather_phrase                   | Aviso: el reporte se entrega a las {{1}}. {{2}} - mencione las horas perdidas y qué trabajos se detuvieron.                                                                                        |
| reminder_1 (`_v2`)    | Utility        | 1=site, 2=link                                 | TalkOlog: el reporte diario de {{1}} de hoy todavía no se ha recibido. Su enlace de reporte: {{2}} (por favor, no lo comparta).                                                                    |
| reminder_2            | Utility        | 1=time, 2=link                                 | Todavía nada para hoy. Le avisaré a la oficina a las {{1}}. {{2}} - TalkOlog                                                                                                                       |
| missed_call (`_v2`)   | Utility        | 1=link                                         | TalkOlog: no pudimos comunicarnos con usted por teléfono para el reporte diario de hoy. Su enlace de reporte: {{1}} (por favor, no lo comparta).                                                   |
| question_ready        | Utility        | 1=link                                         | Una pregunta rápida sobre el reporte de hoy: {{1}} - TalkOlog                                                                                                                                      |
| draft_ready           | Utility        | 1=link                                         | Su reporte está listo para revisar: {{1}} - TalkOlog                                                                                                                                               |
| filed                 | Utility        | 1=report_no, 2=pdf_link                        | Registrado: Reporte diario {{1}}. PDF: {{2}} - TalkOlog                                                                                                                                            |
| photos_link           | Utility        | 1=link                                         | Agregue fotos al reporte de hoy: {{1}} - TalkOlog                                                                                                                                                  |
| edit_applied (`_v2`)  | Utility        | 1=weekday, 2=change, 3=v                       | TalkOlog: su reporte diario del {{1}} se actualizó con este cambio: {{2}}. La versión {{3}} del reporte se envió a la oficina.                                                                     |
| finish_report (`_v2`) | Utility        | 1=link                                         | TalkOlog: su llamada terminó antes de registrar el reporte de hoy, así que el reporte todavía no está registrado. Su enlace de reporte: {{1}} (por favor, no lo comparta).                         |
| site_paused           | Utility        | 1=site                                         | TalkOlog: {{1}} está en pausa en TalkOlog. Pida a la oficina que reactive la obra.                                                                                                                 |

## Türkçe (tr)

| Anahtar               | Kategori       | Değişkenler                                    | Metin                                                                                                                                                       |
| --------------------- | -------------- | ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| welcome               | Utility        | 1=first, 2=company, 3=site, 4=deadline, 5=link | TalkOlog: {{1}}, {{2}} sizi {{3}} için günlük raporcu olarak ekledi. Her iş günü {{4}} öncesi raporunuzu bu linkten verin: {{5}} Durdurmak için STOP yazın. |
| verify_code           | Authentication | 1=code                                         | Doğrulama kodunuz {{1}}. Güvenliğiniz için bu kodu kimseyle paylaşmayın. _(alt bilgi, Meta'nın: Bu kodun süresi 10 dakika içinde dolar.)_                   |
| daily_link (`_v2`)    | Utility        | 1=site, 2=link                                 | TalkOlog: {{1}} için bugünkü günlük rapor açıldı. Bugünkü kişisel rapor linkiniz: {{2}} (lütfen paylaşmayın).                                               |
| call_coming           | Utility        | 1=time, 2=link                                 | Bugünkü rapor için sizi saat {{1}} gibi arayacağım. Şimdi yapmak isterseniz: {{2}} - TalkOlog                                                               |
| weather_headsup       | Utility        | 1=deadline, 2=weather_phrase                   | Hatırlatma: rapor saati {{1}}. {{2}} - kaybedilen saatleri ve duran işleri belirtin.                                                                        |
| reminder_1 (`_v2`)    | Utility        | 1=site, 2=link                                 | TalkOlog: {{1}} için bugünkü günlük rapor henüz alınmadı. Rapor linkiniz: {{2}} (lütfen paylaşmayın).                                                       |
| reminder_2            | Utility        | 1=time, 2=link                                 | Bugün için hâlâ rapor yok. Saat {{1}} itibarıyla ofise bilgi vereceğim. {{2}} - TalkOlog                                                                    |
| missed_call (`_v2`)   | Utility        | 1=link                                         | TalkOlog: bugünkü günlük rapor için size telefonla ulaşamadık. Rapor linkiniz: {{1}} (lütfen paylaşmayın).                                                  |
| question_ready        | Utility        | 1=link                                         | Bugünkü raporla ilgili tek bir soru: {{1}} - TalkOlog                                                                                                       |
| draft_ready           | Utility        | 1=link                                         | Raporunuz kontrol için hazır: {{1}} - TalkOlog                                                                                                              |
| filed                 | Utility        | 1=report_no, 2=pdf_link                        | Kaydedildi: Günlük Rapor {{1}}. PDF: {{2}} - TalkOlog                                                                                                       |
| photos_link           | Utility        | 1=link                                         | Bugünkü rapora fotoğraf ekleyin: {{1}} - TalkOlog                                                                                                           |
| edit_applied (`_v2`)  | Utility        | 1=weekday, 2=change, 3=v                       | TalkOlog: {{1}} günlük raporunuz şu değişiklikle güncellendi: {{2}}. Raporun {{3}}. sürümü ofise gönderildi.                                                |
| finish_report (`_v2`) | Utility        | 1=link                                         | TalkOlog: görüşme bugünkü rapor kaydedilmeden bitti, rapor henüz kaydedilmedi. Rapor linkiniz: {{1}} (lütfen paylaşmayın).                                  |
| site_paused           | Utility        | 1=site                                         | TalkOlog: {{1}} TalkOlog'da duraklatıldı. Ofisten yeniden açmasını isteyin.                                                                                 |

`verify_code` metinleri Meta'nın sabit metnidir (seçilen dilde "{{1}} doğrulama kodunuzdur" ve güvenlik notu); burada yalnızca raporcunun ne göreceğini göstermek için var. `welcome` (§19 Q373) ve `(_v2)` işaretli beş anahtarın (§19 Q377) WhatsApp metni kendinedir. Diğer her metin SMS metniyle aynıdır; başı ya da sonu değişkense (aradaki noktalama sayılmaz) Meta kuralı gereği başına `TalkOlog: ` ya da sonuna ` - TalkOlog` eklenmiştir (§19 Q110).
