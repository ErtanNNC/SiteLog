# SiteLog · Durum

Güncelleme: 2026-10-15 (UTC) · dal `spec-v1.2` · PR #1 · W1-08 ve inceleme düzeltmeleri CI'da yeşil (run 38659474311) · W1-09 CI'da yeşil (run 38666565445), telefon kontrolleriniz bekleniyor

Gün numaraları: 27 günlük plan bu repoda yok; spec §16'nın hafta-1 gün aralıklarını kullanıyorum (M0 gün 1 · M1 gün 1–2 · M2 gün 2–3 · M3 gün 3–4 · M4 gün 4–5 · M5 gün 5–7 → demo). Planın farklı bir eşlemesi varsa söyleyin, buna göre düzeltirim.

## Bitti

**1, 2** — M0 (W1-01 … W1-04) ve M1 (W1-05, W1-06, W1-06a ülke paketleri). W1-05 preview'a yüklendi (Deploy run 38695343167), demo verisi uygulandı (38699886514).

**2–3** — M2 _saha uygulaması + SMS_ (W1-07, W1-08, W1-09), hepsi CI'da yeşil. W1-09'un kutusu yalnızca telefon kontrollerinizi bekliyor.

**3–4** — M3 _pipeline v1_ (W1-10 worker çalışma zamanı, W1-11 Deepgram transkripsiyonu, W1-12 çıkarım v2, sorular ve sahadan cevap), hepsi CI'da yeşil (son run 38719172765). Anahtarlı kontroller (`ANTHROPIC_API_KEY`, `DEEPGRAM_API_KEY`) yapılmadı.

## Sürüyor

**M3 sonu: incelemeniz için durdum** (kickoff kuralı). Sıradaki: M4 (W1-13 soru ve taslak ekranları, W1-14 …). Onay verirseniz devam ederim.

## Onayınızı bekleyen

1. Preview'a yeni migration'ların yüklenmesi (W1-10 `20261015000001`, W1-12 `20261015000002`; aynı Deploy işi: `preview` / `supabase`).
2. Spec §19'da sahibin kararını bekleyen sorular, önerileriyle birlikte:
   - Hafta 2'yi (M6) bloke edenler: Q19 kanal sırası, Q22 kanal yedekleme, Q25 ilk temas/WhatsApp onayı, Q26 gelen WhatsApp, Q27 web push, Q39 WhatsApp göndericisi, Q40 kanal bazlı opt-out.
   - W1-09'dan önce: Q41 (_No work_ / _Weather_ düğmelerinin ne yazacağı). W1-16'dan önce: Q44 (paylaşımlı göndericide gelen SMS kimin).
   - Go-live'dan önce: Q28 yasal metin anahtarları, Q42 link kodu uzunluğu, Q47 imza sırrının döndürülmesi, Q49 İYS (hukuk).
   - M10'dan önce: Q30 fatura ülkesi. Hafta 1 içinde: Q15 (GSM-7 noktalama), Q16 (v1 veri görünümü).
   - W1-09'dan çıkanlar: Q50 gizlilik metninin açıldığı sayfa (go-live'dan önce, avukatla), Q51 otomatik arama onay kutusu (M8'den önce), Q52 20 sn'lik deneme kaydı (M6), Q53 gününün süresi geçtikten sonra ulaşan kayıt (saha pilotundan önce; şu an telefonda kalıyor ve yalnızca silinebiliyor, önerim: kaydedildiği güne, 48 saatlik süre ve "geç geldi" işaretiyle).
   - W1-10'dan çıkan: Q54 hangi ölen job'ların ofise bildirileceği ve kime (önerim yapıldığı gibi: sahaya giden/gelen mesaj job'ları `message_failed` ile ops ve admin'e, rapor adımları `processing_failed` ile admin, pm ve ops'a, diğerleri yalnızca Sentry ve `/ops`).
   - Q55: hatırlatmalar M6'ya kadar kapalıyken bir gün `missing` olunca ofise uyarı gitsin mi (şu an gitmiyor; yalnızca durum değişiyor ve denetim kaydı yazılıyor).
   - W1-12'den çıkanlar: Q58 çıkarım modeli ve zorunlu tool_choice (önerim: yapıldığı gibi, ilk anahtarlı `pnpm eval` ile yeniden bakılır), Q59 kaynak biçimi notunun spec'e yazılması, Q60 yeniden çıkarımda cevapların kodla korunması (önerim: yapıldığı gibi), Q61 30 sn kuralında sorumlu hemen çıkarsa (önerim: M6'da 30 sn sonra yeniden kontrol), Q62 "Yarım gün"ün anlamı (önerim: vardiya saatinin yarısı), Q63 ES/TR yedek soru metinlerinin ana dili konuşan biri tarafından gözden geçirilmesi.
   - W1-11'den çıkanlar: Q56 Deepgram dili (yalnızca İngilizce konuşan sorumluya da `multi`, PL · EN ya da EN · HI konuşana `en`; önerim yapıldığı gibi), Q57 birden fazla ses kaydından biri yazıya dökülemezse (önerim pilot için: hepsi bitmeden taslak yok, ölen job ofise bildiriliyor ve `/ops`'tan yeniden çalıştırılabiliyor).
   - "Yapıldığı gibi" onayı istenenler: Q43 (öğleden önce başlayan rapor hangi güne), Q45/Q46 (Twilio'nun STOP/HELP'i kendisinin yanıtlaması; START/CALL/TEXT'e onay metni yok), Q48 (gerçek org'da gönderici yokken cihaz kodu gitmez; incelemeden sonra karşılama mesajı da gitmez, sorumlu davet edilmiş sayılmaz ve ofis bilgilendirilir).

## Sizden beklenen

1. **Anahtarlar:** `ANTHROPIC_API_KEY` ve `DEEPGRAM_API_KEY` (W1-11/W1-12'den itibaren; yoksa fake/console ile devam ederim, gerçek transkripsiyon ve çıkarım çalışmaz) · `RESEND_API_KEY` (W1-15; yoksa `EMAIL_PROVIDER=console`) · Twilio / İletimerkezi isteğe bağlı (console sürücüsü ve Demo phone yeter).
2. **Uzun süreli kayıtlar:** Twilio toll-free doğrulaması (US) ve İletimerkezi `SITELOG` başlığı (TR); onaylanınca gönderici kimliklerini `pnpm countries:set` ile siz girersiniz (paket satırı, env değil).
3. **Kontroller:** field preview'u telefonla açma (W1-04/W1-07 probe'u), logo kontrolü; W1-09 için iPhone (Safari) ve Android (Chrome) ile HTTPS önizlemeden: 2 dk ses + 2 fotoğraf, uçak modunda kuyruk, ekran kilidi, sessize alma ve gelen arama sırasında kayıt.
4. **Proje dosyaları:** bu ortamda claude.ai Projesi'ne dosya yazamıyorum; `docs/SITELOG_SPEC.md`, `docs/decisions/channel-options.md` ve bu `claude/STATUS.md` repoda güncel; Projeye kopyalanması size kalıyor (Proje GitHub'dan senkronsa kendiliğinden gelir).

## Özet

Hafta-1 planının M0–M3'ü (W1-01 … W1-12) yazıldı ve CI'da yeşil, preview projesi ve demo verisi hazır; M3 sonunda incelemeniz, preview migration onayı, Q54–Q63 kararları ve anahtarlar için duruyorum.
