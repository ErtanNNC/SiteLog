# WhatsApp şablonları (Twilio Content Template Builder)

Kaynak: `packages/shared/src/whatsapp/templates.ts` (`pnpm countries:set -- --code US --print-whatsapp-templates`, `--code TR` aynısı), 2026-10-20, spec §19 Q372 ile. Gövdeler SMS metinlerinden (`packages/shared/src/copy/sms.{en,es,tr}.ts`) üretilir; burada sesli arama numarası **olmayan** paket varyantı var (preview'da `voice_number` boş). Numara eklenirse "ya da {numara} arayın" cümlesi olan şablonlar (welcome, daily_link, reminder_2, …) yeniden gönderilmeli: o zaman listeyi yeniden yazdırın.

## Nasıl gönderilir

1. Twilio Console → Messaging → **Content Template Builder** → _Create new_.
2. **Ad:** `talkolog_<anahtar>_<dil>` (örnek `talkolog_daily_link_tr`); karşılama için `talkolog_welcome_v2_<dil>` (§19 Q373: ilk metni Meta "Marketing" saydı, yeni metin bir davet bildirimi). Dil: aşağıdaki tablonun dili (`en`, `es`, `tr`).
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

| Anahtar         | Kategori       | Değişkenler                                    | Metin                                                                                                                                                      |
| --------------- | -------------- | ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| welcome         | Utility        | 1=first, 2=company, 3=site, 4=deadline, 5=link | TalkOlog: {{1}}, {{2}} added you as the daily reporter for {{3}}. Each workday before {{4}}, send your report from this link: {{5}} Reply STOP to opt out. |
| verify_code     | Authentication | 1=code                                         | {{1}} is your verification code. For your security, do not share this code. _(alt bilgi, Meta'nın: This code expires in 10 minutes.)_                      |
| daily_link      | Utility        | 1=site, 2=link                                 | Today's report for {{1}}: {{2}} - TalkOlog                                                                                                                 |
| call_coming     | Utility        | 1=time, 2=link                                 | I'll call you at {{1}} for today's report. Prefer to do it now? {{2}} - TalkOlog                                                                           |
| weather_headsup | Utility        | 1=deadline, 2=weather_phrase                   | Heads-up: report due at {{1}}. {{2}} - mention the hours lost and what stopped.                                                                            |
| reminder_1      | Utility        | 1=site, 2=link                                 | No report yet for {{1}} today. A one-minute voice note is plenty: {{2}} - TalkOlog                                                                         |
| reminder_2      | Utility        | 1=time, 2=link                                 | Still nothing for today. I'll let the office know at {{1}}. {{2}} - TalkOlog                                                                               |
| missed_call     | Utility        | 1=link                                         | Missed you for today's report. Tap {{1}}.                                                                                                                  |
| question_ready  | Utility        | 1=link                                         | One quick question about today's report: {{1}} - TalkOlog                                                                                                  |
| draft_ready     | Utility        | 1=link                                         | Your report is ready to check: {{1}} - TalkOlog                                                                                                            |
| filed           | Utility        | 1=report_no, 2=pdf_link                        | Filed: Daily Report {{1}}. PDF: {{2}} - TalkOlog                                                                                                           |
| photos_link     | Utility        | 1=link                                         | Add photos to today's report: {{1}} - TalkOlog                                                                                                             |
| edit_applied    | Utility        | 1=weekday, 2=change, 3=v                       | Updated {{1}}: {{2}}. Version {{3}} sent to the office.                                                                                                    |
| finish_report   | Utility        | 1=link                                         | Your call ended before filing. Finish in one tap: {{1}} - TalkOlog                                                                                         |
| site_paused     | Utility        | 1=site                                         | TalkOlog: {{1}} is paused in TalkOlog. Ask the office to resume it.                                                                                        |

## İspanyolca (es)

| Anahtar         | Kategori       | Değişkenler                                    | Metin                                                                                                                                                                                              |
| --------------- | -------------- | ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| welcome         | Utility        | 1=first, 2=company, 3=site, 4=deadline, 5=link | TalkOlog: {{1}}, {{2}} le agregó como responsable del reporte diario de {{3}}. Cada día de trabajo antes de las {{4}}, envíe su reporte desde este enlace: {{5}} Responda STOP para darse de baja. |
| verify_code     | Authentication | 1=code                                         | Tu código de verificación es {{1}}. Por tu seguridad, no lo compartas. _(alt bilgi, Meta'nın: Este código caduca en 10 minutos.)_                                                                  |
| daily_link      | Utility        | 1=site, 2=link                                 | Reporte de hoy para {{1}}: {{2}} - TalkOlog                                                                                                                                                        |
| call_coming     | Utility        | 1=time, 2=link                                 | Le llamaré a las {{1}} para el reporte de hoy. ¿Prefiere hacerlo ahora? {{2}} - TalkOlog                                                                                                           |
| weather_headsup | Utility        | 1=deadline, 2=weather_phrase                   | Aviso: el reporte se entrega a las {{1}}. {{2}} - mencione las horas perdidas y qué trabajos se detuvieron.                                                                                        |
| reminder_1      | Utility        | 1=site, 2=link                                 | Todavía no hay reporte de {{1}} hoy. Una nota de voz de un minuto es suficiente: {{2}} - TalkOlog                                                                                                  |
| reminder_2      | Utility        | 1=time, 2=link                                 | Todavía nada para hoy. Le avisaré a la oficina a las {{1}}. {{2}} - TalkOlog                                                                                                                       |
| missed_call     | Utility        | 1=link                                         | No pude comunicarme con usted para el reporte de hoy. Toque {{1}}.                                                                                                                                 |
| question_ready  | Utility        | 1=link                                         | Una pregunta rápida sobre el reporte de hoy: {{1}} - TalkOlog                                                                                                                                      |
| draft_ready     | Utility        | 1=link                                         | Su reporte está listo para revisar: {{1}} - TalkOlog                                                                                                                                               |
| filed           | Utility        | 1=report_no, 2=pdf_link                        | Registrado: Reporte diario {{1}}. PDF: {{2}} - TalkOlog                                                                                                                                            |
| photos_link     | Utility        | 1=link                                         | Agregue fotos al reporte de hoy: {{1}} - TalkOlog                                                                                                                                                  |
| edit_applied    | Utility        | 1=weekday, 2=change, 3=v                       | Reporte del {{1}} actualizado: {{2}}. Versión {{3}} enviada a la oficina.                                                                                                                          |
| finish_report   | Utility        | 1=link                                         | Su llamada terminó antes de registrar el reporte. Termínelo con un toque: {{1}} - TalkOlog                                                                                                         |
| site_paused     | Utility        | 1=site                                         | TalkOlog: {{1}} está en pausa en TalkOlog. Pida a la oficina que reactive la obra.                                                                                                                 |

## Türkçe (tr)

| Anahtar         | Kategori       | Değişkenler                                    | Metin                                                                                                                                                       |
| --------------- | -------------- | ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| welcome         | Utility        | 1=first, 2=company, 3=site, 4=deadline, 5=link | TalkOlog: {{1}}, {{2}} sizi {{3}} için günlük raporcu olarak ekledi. Her iş günü {{4}} öncesi raporunuzu bu linkten verin: {{5}} Durdurmak için STOP yazın. |
| verify_code     | Authentication | 1=code                                         | Doğrulama kodunuz {{1}}. Güvenliğiniz için bu kodu kimseyle paylaşmayın. _(alt bilgi, Meta'nın: Bu kodun süresi 10 dakika içinde dolar.)_                   |
| daily_link      | Utility        | 1=site, 2=link                                 | TalkOlog: {{1}} bugünkü rapor: {{2}} - TalkOlog                                                                                                             |
| call_coming     | Utility        | 1=time, 2=link                                 | Bugünkü rapor için sizi saat {{1}} gibi arayacağım. Şimdi yapmak isterseniz: {{2}} - TalkOlog                                                               |
| weather_headsup | Utility        | 1=deadline, 2=weather_phrase                   | Hatırlatma: rapor saati {{1}}. {{2}} - kaybedilen saatleri ve duran işleri belirtin.                                                                        |
| reminder_1      | Utility        | 1=site, 2=link                                 | TalkOlog: {{1}} için bugün henüz rapor yok. Bir dakikalık sesli not yeterli: {{2}} - TalkOlog                                                               |
| reminder_2      | Utility        | 1=time, 2=link                                 | Bugün için hâlâ rapor yok. Saat {{1}} itibarıyla ofise bilgi vereceğim. {{2}} - TalkOlog                                                                    |
| missed_call     | Utility        | 1=link                                         | Bugünkü rapor için ulaşamadım. {{1}} - TalkOlog                                                                                                             |
| question_ready  | Utility        | 1=link                                         | Bugünkü raporla ilgili tek bir soru: {{1}} - TalkOlog                                                                                                       |
| draft_ready     | Utility        | 1=link                                         | Raporunuz kontrol için hazır: {{1}} - TalkOlog                                                                                                              |
| filed           | Utility        | 1=report_no, 2=pdf_link                        | Kaydedildi: Günlük Rapor {{1}}. PDF: {{2}} - TalkOlog                                                                                                       |
| photos_link     | Utility        | 1=link                                         | Bugünkü rapora fotoğraf ekleyin: {{1}} - TalkOlog                                                                                                           |
| edit_applied    | Utility        | 1=weekday, 2=change, 3=v                       | TalkOlog: {{1}} güncellendi: {{2}}. Sürüm {{3}} ofise gönderildi.                                                                                           |
| finish_report   | Utility        | 1=link                                         | Görüşme kayıttan önce bitti. Tek dokunuşla tamamlayın: {{1}} - TalkOlog                                                                                     |
| site_paused     | Utility        | 1=site                                         | TalkOlog: {{1}} TalkOlog'da duraklatıldı. Ofisten yeniden açmasını isteyin.                                                                                 |

`verify_code` metinleri Meta'nın sabit metnidir (seçilen dilde "{{1}} doğrulama kodunuzdur" ve güvenlik notu); burada yalnızca raporcunun ne göreceğini göstermek için var. Diğer her metin SMS metniyle aynıdır; başı ya da sonu değişkense Meta kuralı gereği başına `TalkOlog: ` ya da sonuna ` - TalkOlog` eklenmiştir (§19 Q110).
