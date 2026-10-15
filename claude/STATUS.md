# SiteLog · Durum

Güncelleme: 2026-10-15 (UTC) · dal `spec-v1.2` · PR #1 · son commit: `2fc3262` (W1-08 `27fc876` CI'da yeşil; inceleme düzeltmeleri `31b8d81` + `300b7f7` CI'da yeşil, run 38659474311) · W1-09 ayrı dalda (`w1-09-field`) sürüyor

Gün numaraları: 27 günlük plan bu repoda yok; spec §16'nın hafta-1 gün aralıklarını kullanıyorum (M0 gün 1 · M1 gün 1–2 · M2 gün 2–3 · M3 gün 3–4 · M4 gün 4–5 · M5 gün 5–7 → demo). Planın farklı bir eşlemesi varsa söyleyin, buna göre düzeltirim.

## Bitti

**1, 2** — M0 (W1-01 … W1-04) ve M1 (W1-05 kod tarafı, W1-06, W1-06a ülke paketleri). Her ticket PR #1'de CI yeşil (Deno, PGlite, gerçek Supabase yığını, demo e2e). W1-05'in son adımı (preview projesine `db push`) sizi bekliyor, aşağıda.

## Sürüyor

**Gün 2–3 (M2)** — W1-08 _SMS katmanı, davet ve Demo phone_: kod, testler ve belgeler commit'lendi (`27fc876`), CI yeşil. Üç incelemenin 35 bulgusu kapatıldı (`31b8d81`, CI'da yeşil: davet orkestrasyonu yığın testi, Realtime ile Demo phone e2e'si ve yeni migration yerel Supabase'te geçti): gelen Twilio SMS'i `sms_inbound` job'ına alındı (Twilio 5xx'te yeniden denemediği için; `20261014000008_sms_inbound.sql` ile öncelik 0, mesaj + denetim kaydı + job tek transaction'da `receive_sms_inbound()` ile, aynı numaranın mesajları `sms:<telefon>` kilidiyle sırayla), her anahtar kelime değişikliği denetim kaydı ve ofis bildirimiyle aynı transaction'da, bilinmeyen numaraya otomatik yanıt yeniden denemede de gidiyor, STOP her durumda kalıcı (`sms_opt_outs` paket başına, bilinmeyen numara ve devre dışı sorumlu dahil; Twilio 21610 da opt-out sayılıyor), opt-out ve geç teslim hatalarında ofise §13 bildirimi (geç Twilio hatası yalnızca 30003–30006'da numaraya yazılıyor; 30032 gibi hesap hataları ofise saatte en çok bir kez hesap bildirimi), Team'de "Opted out of texts" çipi ve davet bildirimi, Notifier'ın hata yolları (gönderici yokken gerçek org'da `failed` satır ve davet edilmemiş sorumlu, eksik kimlik bilgisinde kuyrukta kalan satır yok, `undeliverable` tekrarda sağlayıcı koduyla yeniden fırlatılıyor, gerçek org'a console yanıtı `failed`), `send_welcome`'da numara hatası / sağlayıcı hatası ayrımı (`PermanentJobError`), davet dili "Speaks" seçiminden (`es` → `es-US`), Demo phone 390 px'te 44 px sekmeler ve yanıt kutusu, klavye odağı, kaydırma ve sorumlu başına ayrı canlı bölge (panel genelindeki 41,25 px kontroller `docs/AUDIT_BACKLOG.md`'de), demo modunda STOP bildirimi, panelde bir konuşmanın en yeni 500 mesajı, sorumlu başına sayım ve son satır veritabanından (`SupabaseSource.test.ts`), davet orkestrasyonu için yığın testi (`supabase/db-tests/stack/api-invite-reporter.test.ts`), Demo phone e2e'si artık Realtime'ı gerçekten kanıtlıyor (ikinci sekme davetten önce açık), CI'da `api-invite-reporter` ısınma probu, belgeler (PLAN, RUNBOOK'ta Twilio webhook adresi ve yeniden deneme ayarı, README, spec §4.5/§9.5/Q45/Q48, GAP). W1-09 _saha ekranları_ ayrı bir çalışma ağacında (`w1-09-field`) sürüyor: kod sınırına takılan iki derleme turundan sonra Opus ile devam ediyor; ekranlar, oturum, çevrimdışı kuyruk ve kaydedici yazıldı, yerel Supabase'e karşı Playwright akışı, CI adımı ve belgeler kaldı. Bitince `spec-v1.2`'ye birleştirip push'layacağım. W1-07 `field-api` CI'da yeşil; kutusu yalnızca preview üzerinden çerez probe'unu bekliyor.

## Onayınızı bekleyen

1. Preview projesine migration push'u (`deploy.yml`, environment `preview`, target `supabase`) — token düzelince tekrar başlatacağım.
2. Preview'a demo verisinin uygulanması (`pnpm seed:demo -- --apply`, D41) — ilk telefon kontrolünden önce.
3. Spec §19'da sahibin kararını bekleyen sorular, önerileriyle birlikte:
   - Hafta 2'yi (M6) bloke edenler: Q19 kanal sırası, Q22 kanal yedekleme, Q25 ilk temas/WhatsApp onayı, Q26 gelen WhatsApp, Q27 web push, Q39 WhatsApp göndericisi, Q40 kanal bazlı opt-out.
   - W1-09'dan önce: Q41 (_No work_ / _Weather_ düğmelerinin ne yazacağı). W1-16'dan önce: Q44 (paylaşımlı göndericide gelen SMS kimin).
   - Go-live'dan önce: Q28 yasal metin anahtarları, Q42 link kodu uzunluğu, Q47 imza sırrının döndürülmesi, Q49 İYS (hukuk).
   - M10'dan önce: Q30 fatura ülkesi. Hafta 1 içinde: Q15 (GSM-7 noktalama), Q16 (v1 veri görünümü).
   - "Yapıldığı gibi" onayı istenenler: Q43 (öğleden önce başlayan rapor hangi güne), Q45/Q46 (Twilio'nun STOP/HELP'i kendisinin yanıtlaması; START/CALL/TEXT'e onay metni yok), Q48 (gerçek org'da gönderici yokken cihaz kodu gitmez; incelemeden sonra karşılama mesajı da gitmez, sorumlu davet edilmiş sayılmaz ve ofis bilgilendirilir).

## Sizden beklenen

1. **Preview token:** `preview` Environment'taki `SUPABASE_ACCESS_TOKEN`'ın `sftfnlfbtxowotuhdwep` projesine yetkisi yok ("does not have the necessary privileges"). Projenin sahibi hesaptan yeni token ya da projeyi aynı org'a taşıma.
2. **Preview Auth URL'leri:** `https://pr-1--staging-sitelog.netlify.app/**` eklenmeli (panel önizlemesinden giriş için).
3. **Anahtarlar:** `ANTHROPIC_API_KEY` ve `DEEPGRAM_API_KEY` (W1-11/W1-12'den itibaren; yoksa fake/console ile devam ederim, gerçek transkripsiyon ve çıkarım çalışmaz) · `RESEND_API_KEY` (W1-15; yoksa `EMAIL_PROVIDER=console`) · Twilio / İletimerkezi isteğe bağlı (console sürücüsü ve Demo phone yeter).
4. **Uzun süreli kayıtlar:** Twilio toll-free doğrulaması (US) ve İletimerkezi `SITELOG` başlığı (TR); onaylanınca gönderici kimliklerini `pnpm countries:set` ile siz girersiniz (paket satırı, env değil).
5. **Kontroller:** field preview'u telefonla açma (W1-04/W1-07 probe'u), logo kontrolü.
6. **Proje dosyaları:** bu ortamda claude.ai Projesi'ne dosya yazamıyorum; `docs/SITELOG_SPEC.md`, `docs/decisions/channel-options.md` ve bu `claude/STATUS.md` repoda güncel; Projeye kopyalanması size kalıyor (Proje GitHub'dan senkronsa kendiliğinden gelir).

## Özet

Hafta-1 planının M0–M1'i ve M2'nin ilk yarısı bitti, her commit CI'da yeşil, staging'e dokunulmadı; iş yalnızca preview token'ı ve yukarıdaki kararlar için sizi bekliyor.
