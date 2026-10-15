# SiteLog · Durum

Güncelleme: 2026-10-15 (UTC) · dal `spec-v1.2` · PR #1 · W1-08 ve inceleme düzeltmeleri CI'da yeşil (run 38659474311) · W1-09 CI'da yeşil (run 38666565445), telefon kontrolleriniz bekleniyor

Gün numaraları: 27 günlük plan bu repoda yok; spec §16'nın hafta-1 gün aralıklarını kullanıyorum (M0 gün 1 · M1 gün 1–2 · M2 gün 2–3 · M3 gün 3–4 · M4 gün 4–5 · M5 gün 5–7 → demo). Planın farklı bir eşlemesi varsa söyleyin, buna göre düzeltirim.

## Bitti

**1, 2** — M0 (W1-01 … W1-04) ve M1 (W1-05 kod tarafı, W1-06, W1-06a ülke paketleri). Her ticket PR #1'de CI yeşil (Deno, PGlite, gerçek Supabase yığını, demo e2e). W1-05 de tamam: preview projesine migration'lar ve edge function'lar 2026-10-15'te yüklendi (Deploy run 38695343167); demo verisi (Kestrel, Demir Yapı) onayınızla aynı gün uygulandı (Deploy run 38699886514, hedef `seed`).

## Sürüyor

**Gün 2–3 (M2)** — W1-08 _SMS katmanı, davet ve Demo phone_ bitti: kod `27fc876`, üç incelemenin 35 bulgusu `31b8d81`'de kapandı, CI yeşil (davet orkestrasyonu yığın testi, Realtime ile Demo phone e2e'si ve `20261014000008_sms_inbound.sql` yerel Supabase'te geçti). W1-07 `field-api` CI'da yeşil; kutusu yalnızca preview üzerinden çerez probe'unu bekliyor.

**W1-09 _saha ekranları_ (adım 18'in ilk yarısı)** — `spec-v1.2`'de, CI yeşil (run 38666565445): saha akışı yerel Supabase'te uçtan uca geçti (link → SMS kodu → onay → sahte mikrofonla kayıt → yükleme → `web` raporu ve `transcribe_upload` job'ı → İşleniyor, her ekranda axe). Yapılanlar: `/r/:code` → cihaz kontrolü (SMS kodu; demo org'larda Demo phone'a düşer) → ilk açılışta karşılama ve onay → Bugün (şantiye, tarih, son saat, durum, Kaydet ≥ 120 px, Fotoğraf ekle, _Bugün çalışma yok_ / _Hava nedeniyle kapalı_ onay sayfası) → Kayıt (MediaRecorder, sayaç, seviye göstergesi, ekran kilidi, duraklat/devam, fotoğraf, 15 dk sınırı, 32 kbps) → imzalı URL ile yükleme ve `complete` → İşleniyor (önce 2 sn'de bir, sonra seyrekleşen sorgu; sayfa gizliyken sorgu yok). IndexedDB kuyruğu: kayıt parça parça telefona yazılır, sayfa kapanırsa bir sonraki açılışta gönderilir; geri tuşu, gelen arama ya da kulaklığın çıkması kaydı kaybettirmez; tek sekme gönderir; her istekte zaman aşımı var; gönderilemeyenler nedeniyle listelenir (_Tekrar dene_ ya da _Kaldır_). Metinler EN/ES/TR. İki incelemenin 25 bulgusundan 24'ü düzeltildi, 25.si (CLAUDE.md'nin eskimesi) birleştirmede düzeltildi. Kutusu CI'dan ve sizin telefon kontrollerinizden sonra işaretlenecek.

**W1-10 _worker çalışma zamanı_ (M3, adım 15)** — `w1-10-worker` dalında (PR #1'e değil, ayrı dal; henüz commit edilmedi, CI bekleniyor). Yapılanlar: worker yeni job'ları `NOTIFY jobs` ile hemen alıyor (kendi oturum bağlantısında LISTEN, kopunca 1 sn'den 30 sn'ye artan beklemeyle yeniden bağlanma; transaction pooler kullanılıyorsa `SUPABASE_DB_LISTEN_URL`), yedek olarak 5 sn'de bir yokluyor; `/health` `listening` gösteriyor. `notify` job'ı (Notifier üzerinden). Ölen job'larda sahaya WhatsApp `error_retry` yerine ofise panel bildirimi (`message_failed` / `processing_failed`) ve `job.dead` denetim kaydı (kapsam: spec §19 Q54). D16: bir job anahtarı bir kez kullanılır (`20261015000001_worker_runtime.sql`, staging'deki tekrarlı anahtarlar önce temizleniyor); tekrarlanan işler için olay başına anahtar (taslak sürümü başına dosyalama, davet başına karşılama) ve tüm anahtarları denetleyen test. D17: 30 sn · 2 dk · 10 dk · 30 dk · 2 sa, altıncı hatada `dead`. Zaman aşımı: job'ın AbortSignal'ı sağlayıcı ve HTTP çağrılarını durduruyor, job ancak işleyici bitince yeniden kuyruğa giriyor (arada `locked_at` canlı tutuluyor), yani aynı job iki kez aynı anda çalışmıyor (AUDIT_BACKLOG kaydı kapandı). `scheduler-tick` WhatsApp hatırlatmalarını ve eksik rapor uyarısını artık kuyruğa koymuyor (M6'da SMS ile dönecek; staging cut-over'a kadar eskisi gibi). Testler yerelde geçti; gerçek Postgres testleri (100 job, LISTEN, yokluma) burada geçici bir Postgres 16'da geçti, CI'da `e2e-supabase` işinde koşacak; CI'daki worker 120 sn yoklamayla çalışıyor, yani davet testi ancak NOTIFY ile geçebilir.

## Onayınızı bekleyen

1. Spec §19'da sahibin kararını bekleyen sorular, önerileriyle birlikte:
   - Hafta 2'yi (M6) bloke edenler: Q19 kanal sırası, Q22 kanal yedekleme, Q25 ilk temas/WhatsApp onayı, Q26 gelen WhatsApp, Q27 web push, Q39 WhatsApp göndericisi, Q40 kanal bazlı opt-out.
   - W1-09'dan önce: Q41 (_No work_ / _Weather_ düğmelerinin ne yazacağı). W1-16'dan önce: Q44 (paylaşımlı göndericide gelen SMS kimin).
   - Go-live'dan önce: Q28 yasal metin anahtarları, Q42 link kodu uzunluğu, Q47 imza sırrının döndürülmesi, Q49 İYS (hukuk).
   - M10'dan önce: Q30 fatura ülkesi. Hafta 1 içinde: Q15 (GSM-7 noktalama), Q16 (v1 veri görünümü).
   - W1-09'dan çıkanlar: Q50 gizlilik metninin açıldığı sayfa (go-live'dan önce, avukatla), Q51 otomatik arama onay kutusu (M8'den önce), Q52 20 sn'lik deneme kaydı (M6), Q53 gününün süresi geçtikten sonra ulaşan kayıt (saha pilotundan önce; şu an telefonda kalıyor ve yalnızca silinebiliyor, önerim: kaydedildiği güne, 48 saatlik süre ve "geç geldi" işaretiyle).
   - W1-10'dan çıkan: Q54 hangi ölen job'ların ofise bildirileceği ve kime (önerim yapıldığı gibi: sahaya giden/gelen mesaj job'ları `message_failed` ile ops ve admin'e, rapor adımları `processing_failed` ile admin, pm ve ops'a, diğerleri yalnızca Sentry ve `/ops`).
   - "Yapıldığı gibi" onayı istenenler: Q43 (öğleden önce başlayan rapor hangi güne), Q45/Q46 (Twilio'nun STOP/HELP'i kendisinin yanıtlaması; START/CALL/TEXT'e onay metni yok), Q48 (gerçek org'da gönderici yokken cihaz kodu gitmez; incelemeden sonra karşılama mesajı da gitmez, sorumlu davet edilmiş sayılmaz ve ofis bilgilendirilir).

## Sizden beklenen

1. **Preview Auth URL'leri:** `https://pr-1--staging-sitelog.netlify.app/**` eklenmeli (panel önizlemesinden giriş için).
2. **Anahtarlar:** `ANTHROPIC_API_KEY` ve `DEEPGRAM_API_KEY` (W1-11/W1-12'den itibaren; yoksa fake/console ile devam ederim, gerçek transkripsiyon ve çıkarım çalışmaz) · `RESEND_API_KEY` (W1-15; yoksa `EMAIL_PROVIDER=console`) · Twilio / İletimerkezi isteğe bağlı (console sürücüsü ve Demo phone yeter).
3. **Uzun süreli kayıtlar:** Twilio toll-free doğrulaması (US) ve İletimerkezi `SITELOG` başlığı (TR); onaylanınca gönderici kimliklerini `pnpm countries:set` ile siz girersiniz (paket satırı, env değil).
4. **Kontroller:** field preview'u telefonla açma (W1-04/W1-07 probe'u), logo kontrolü; W1-09 için iPhone (Safari) ve Android (Chrome) ile HTTPS önizlemeden: 2 dk ses + 2 fotoğraf, uçak modunda kuyruk, ekran kilidi, sessize alma ve gelen arama sırasında kayıt.
5. **Proje dosyaları:** bu ortamda claude.ai Projesi'ne dosya yazamıyorum; `docs/SITELOG_SPEC.md`, `docs/decisions/channel-options.md` ve bu `claude/STATUS.md` repoda güncel; Projeye kopyalanması size kalıyor (Proje GitHub'dan senkronsa kendiliğinden gelir).

## Özet

Hafta-1 planının M0–M1'i ve M2'nin üç ticket'ı (W1-07, W1-08, W1-09) yazıldı, W1-09 CI'da yeşil, telefon kontrolleriniz bekleniyor; W1-10 (worker) ayrı dalda yapılıyor; staging'e dokunulmadı, preview projesi güncel; iş yukarıdaki kararlar ve kontroller için sizi bekliyor.
