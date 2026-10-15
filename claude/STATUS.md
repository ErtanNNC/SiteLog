# SiteLog · Durum

Güncelleme: 2026-10-15 (UTC) · dal `spec-v1.2` · PR #1 · W1-08 ve inceleme düzeltmeleri CI'da yeşil (run 38659474311) · W1-09 `spec-v1.2`'ye eklendi, CI bekleniyor

Gün numaraları: 27 günlük plan bu repoda yok; spec §16'nın hafta-1 gün aralıklarını kullanıyorum (M0 gün 1 · M1 gün 1–2 · M2 gün 2–3 · M3 gün 3–4 · M4 gün 4–5 · M5 gün 5–7 → demo). Planın farklı bir eşlemesi varsa söyleyin, buna göre düzeltirim.

## Bitti

**1, 2** — M0 (W1-01 … W1-04) ve M1 (W1-05 kod tarafı, W1-06, W1-06a ülke paketleri). Her ticket PR #1'de CI yeşil (Deno, PGlite, gerçek Supabase yığını, demo e2e). W1-05'in son adımı (preview projesine `db push`) sizi bekliyor, aşağıda.

## Sürüyor

**Gün 2–3 (M2)** — W1-08 _SMS katmanı, davet ve Demo phone_ bitti: kod `27fc876`, üç incelemenin 35 bulgusu `31b8d81`'de kapandı, CI yeşil (davet orkestrasyonu yığın testi, Realtime ile Demo phone e2e'si ve `20261014000008_sms_inbound.sql` yerel Supabase'te geçti). W1-07 `field-api` CI'da yeşil; kutusu yalnızca preview üzerinden çerez probe'unu bekliyor.

**W1-09 _saha ekranları_ (adım 18'in ilk yarısı)** — `spec-v1.2`'ye eklendi, CI bekleniyor. Yapılanlar: `/r/:code` → cihaz kontrolü (SMS kodu; demo org'larda Demo phone'a düşer) → ilk açılışta karşılama ve onay → Bugün (şantiye, tarih, son saat, durum, Kaydet ≥ 120 px, Fotoğraf ekle, _Bugün çalışma yok_ / _Hava nedeniyle kapalı_ onay sayfası) → Kayıt (MediaRecorder, sayaç, seviye göstergesi, ekran kilidi, duraklat/devam, fotoğraf, 15 dk sınırı, 32 kbps) → imzalı URL ile yükleme ve `complete` → İşleniyor (önce 2 sn'de bir, sonra seyrekleşen sorgu; sayfa gizliyken sorgu yok). IndexedDB kuyruğu: kayıt parça parça telefona yazılır, sayfa kapanırsa bir sonraki açılışta gönderilir; geri tuşu, gelen arama ya da kulaklığın çıkması kaydı kaybettirmez; tek sekme gönderir; her istekte zaman aşımı var; gönderilemeyenler nedeniyle listelenir (_Tekrar dene_ ya da _Kaldır_). Metinler EN/ES/TR. İki incelemenin 25 bulgusundan 24'ü düzeltildi, 25.si (CLAUDE.md'nin eskimesi) birleştirmede düzeltildi. Yerelde bütün kontroller yeşil; yerel Supabase'e karşı saha akışı (link → kod → onay → kayıt → yükleme → rapor ve `transcribe_upload` job'ı) ilk kez CI'da koşacak. Kutusu CI'dan ve sizin telefon kontrollerinizden sonra işaretlenecek.

Sonraki: W1-10 _worker çalışma zamanı_ (M3).

## Onayınızı bekleyen

1. Preview projesine migration push'u (`deploy.yml`, environment `preview`, target `supabase`) — token düzelince tekrar başlatacağım.
2. Preview'a demo verisinin uygulanması (`pnpm seed:demo -- --apply`, D41) — ilk telefon kontrolünden önce.
3. Spec §19'da sahibin kararını bekleyen sorular, önerileriyle birlikte:
   - Hafta 2'yi (M6) bloke edenler: Q19 kanal sırası, Q22 kanal yedekleme, Q25 ilk temas/WhatsApp onayı, Q26 gelen WhatsApp, Q27 web push, Q39 WhatsApp göndericisi, Q40 kanal bazlı opt-out.
   - W1-09'dan önce: Q41 (_No work_ / _Weather_ düğmelerinin ne yazacağı). W1-16'dan önce: Q44 (paylaşımlı göndericide gelen SMS kimin).
   - Go-live'dan önce: Q28 yasal metin anahtarları, Q42 link kodu uzunluğu, Q47 imza sırrının döndürülmesi, Q49 İYS (hukuk).
   - M10'dan önce: Q30 fatura ülkesi. Hafta 1 içinde: Q15 (GSM-7 noktalama), Q16 (v1 veri görünümü).
   - W1-09'dan çıkanlar: Q50 gizlilik metninin açıldığı sayfa (go-live'dan önce, avukatla), Q51 otomatik arama onay kutusu (M8'den önce), Q52 20 sn'lik deneme kaydı (M6), Q53 gününün süresi geçtikten sonra ulaşan kayıt (saha pilotundan önce; şu an telefonda kalıyor ve yalnızca silinebiliyor, önerim: kaydedildiği güne, 48 saatlik süre ve "geç geldi" işaretiyle).
   - "Yapıldığı gibi" onayı istenenler: Q43 (öğleden önce başlayan rapor hangi güne), Q45/Q46 (Twilio'nun STOP/HELP'i kendisinin yanıtlaması; START/CALL/TEXT'e onay metni yok), Q48 (gerçek org'da gönderici yokken cihaz kodu gitmez; incelemeden sonra karşılama mesajı da gitmez, sorumlu davet edilmiş sayılmaz ve ofis bilgilendirilir).

## Sizden beklenen

1. **Preview token:** `preview` Environment'taki `SUPABASE_ACCESS_TOKEN`'ın `sftfnlfbtxowotuhdwep` projesine yetkisi yok ("does not have the necessary privileges"). Projenin sahibi hesaptan yeni token ya da projeyi aynı org'a taşıma.
2. **Preview Auth URL'leri:** `https://pr-1--staging-sitelog.netlify.app/**` eklenmeli (panel önizlemesinden giriş için).
3. **Anahtarlar:** `ANTHROPIC_API_KEY` ve `DEEPGRAM_API_KEY` (W1-11/W1-12'den itibaren; yoksa fake/console ile devam ederim, gerçek transkripsiyon ve çıkarım çalışmaz) · `RESEND_API_KEY` (W1-15; yoksa `EMAIL_PROVIDER=console`) · Twilio / İletimerkezi isteğe bağlı (console sürücüsü ve Demo phone yeter).
4. **Uzun süreli kayıtlar:** Twilio toll-free doğrulaması (US) ve İletimerkezi `SITELOG` başlığı (TR); onaylanınca gönderici kimliklerini `pnpm countries:set` ile siz girersiniz (paket satırı, env değil).
5. **Kontroller:** field preview'u telefonla açma (W1-04/W1-07 probe'u), logo kontrolü; W1-09 için iPhone (Safari) ve Android (Chrome) ile HTTPS önizlemeden: 2 dk ses + 2 fotoğraf, uçak modunda kuyruk, ekran kilidi, sessize alma ve gelen arama sırasında kayıt.
6. **Proje dosyaları:** bu ortamda claude.ai Projesi'ne dosya yazamıyorum; `docs/SITELOG_SPEC.md`, `docs/decisions/channel-options.md` ve bu `claude/STATUS.md` repoda güncel; Projeye kopyalanması size kalıyor (Proje GitHub'dan senkronsa kendiliğinden gelir).

## Özet

Hafta-1 planının M0–M1'i ve M2'nin üç ticket'ı (W1-07, W1-08, W1-09) yazıldı, W1-09'un CI sonucu ve telefon kontrolleri bekleniyor; staging'e dokunulmadı, iş yalnızca preview token'ı ve yukarıdaki kararlar için sizi bekliyor.
