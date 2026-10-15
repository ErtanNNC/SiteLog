# SiteLog · Durum

Güncelleme: 2026-10-15 22:30 UTC · dal `spec-v1.2` · PR #1 · son CI yeşil: a9cc55f (run 38740645053); **tüm hafta-1 işi CI'da yeşil: run 38796723632 (f1d46c4), e2e:supabase ve worker akışları dahil**

Gün numaraları: 27 günlük plan bu repoda yok; spec §16'nın hafta-1 gün aralıklarını kullanıyorum (M0 gün 1 · M1 gün 1–2 · M2 gün 2–3 · M3 gün 3–4 · M4 gün 4–5 · M5 gün 5–7 → demo). Planın farklı bir eşlemesi varsa söyleyin, buna göre düzeltirim.

## Bitti

**1, 2** — M0 (W1-01 … W1-04) ve M1 (W1-05, W1-06, W1-06a ülke paketleri). W1-05 preview'a yüklendi (Deploy run 38695343167), demo verisi uygulandı (38699886514).

**2–3** — M2 _saha uygulaması + SMS_ (W1-07, W1-08, W1-09), hepsi CI'da yeşil. W1-09'un kutusu yalnızca telefon kontrollerinizi bekliyor.

**3–4** — M3 _pipeline v1_ (W1-10 worker çalışma zamanı, W1-11 Deepgram transkripsiyonu, W1-12 çıkarım v2, sorular ve sahadan cevap), hepsi CI'da yeşil (son run 38719172765). Anahtarlı kontroller (`ANTHROPIC_API_KEY`, `DEEPGRAM_API_KEY`) yapılmadı.

**4–5** — M4:

- W1-13 sahada soru → taslak → onayla gönder: CI'da yeşil (run 38740645053); kutusu yalnızca telefon kontrolünüzü bekliyor.
- W1-14 PDF günlük rapor EN/TR, Türkçe örnek, imza sonrası yeniden PDF (bcd7b8c, e28184b): yerel testler yeşil. Örnek PDF'ler sohbette.
- W1-15 web'den dosyalama, "dosyalandı" SMS'i, PDF'li e-posta (tekrar denemede iki kez gitmez), Filed ekranı (a5da973): yerel testler yeşil.
- W1-18 Şantiyeler ve Şantiye detayı EN/TR (3392785): yerel testler yeşil; "Bugünün linkini gönder" düğmesi W1-16 ile bağlanacak.
- §19 kararları işlendi ve kodlandı (25c1ead, c3b1cd4).
- Bugünkü commit'lerin bağımsız incelemesi: 1 gerçek hata bulundu ve düzeltildi (0d6007e: zamanında gelen bir kaydın tekrar denemesi raporu yanlışlıkla "geç" işaretliyordu).

## Sürüyor

**Çalışma kuralı (sizden, 2026-10-15, güncel):** aksini söyleyene kadar development durmadan devam ediyor. Sizin bakmanız gereken her şey bu dosyaya yazılıp bekletiliyor. Yalnızca çok önemli bir karar ya da sizin yapmanız gereken bir iş olmadan hiç ilerleyemeyeceksem durulacak; o zaman nedeni basit ve ayrıntılı açıklanacak.

- W1-16 Overview (5846e2a, 4d5182a) ve W1-17 Raporlar arşivi + Rapor inceleme (81c9500; kanal filtresi, "Fotoğraf yok", her ses/arama için oynatıcı ve saniyeye atlama, saha olayları, EN/TR) bitti.
- İnceleme düzeltmeleri bitti (1d26288 … c7b79f3): imza/geri alma PDF yarışı, e-posta 409, `missing` uyarısının tek işlemde ve kaybolmadan gitmesi, Filed ekranında 3 dk sonra "PDF yolda" mesajı.
- **Demo phone'a kod gelmemesi (çözüldü, telefon testi yarın sabah):** cihaz kodları veritabanına doğru yazılıyordu, sorun panel önizlemesindeydi. (1) GitHub anon key çıktısını düşürüyordu; düzeltildi (fca8145). (2) preview Environment'taki `VITE_SUPABASE_ANON_KEY` değişkeni staging'in anahtarıydı; sizin güncellemenizle düzeldi. Deploy artık başka projenin anahtarını hata olarak gösteriyor (577c0a3). Panel önizlemesi preview projesine bağlı (run 38804915745). **Yarın sabah test için:** siz sorduğunuzda phone-setup ve preview-worker'ı yeniden çalıştırıp yeni linkleri paylaşacağım; bu gece çalışan worker'ı iptal ettim.
- **Gece işleri (2026-10-15 akşam):** Paneldeki paylaşılan butonlar ve giriş kutuları en az 44 px yapıldı (9d698f9). Bugünkü işin bağımsız incelemesi 6 sorun buldu, 5'i düzeltildi:
  - Taslak değiştiyse onay reddediliyor, rapor görülmeden dosyalanamaz (fa67bbe, 86b7bac; yeni migration `20261015000070_draft_rev`).
  - Sahte (fake) AI verisi artık yalnızca açıkça seçilince çalışıyor, production'da hiç çalışmıyor (efd375f).
  - Eski sürümün PDF'inde yanlış imza basılmıyor (8d627d2).
  - "Bugünün linkini gönder" pasif kişiyi seçmiyor (3a252cd).
  - Geçiş temizlik dosyası ikinci çalıştırmada yeni işleri silmiyor (ce13c55).
  - Panel tarafındaki takipler sürüyor: Türkçe bildirimler, link butonunun Türkçe hata metni, panel PDF'i, `/team` sayfasının 390 px'te yana kayması.
- **Yarın sabahki telefon testi öncesi (benim yapacaklarım):** yeni migration `20261015000070` ve güncel edge function'lar preview projesine yüklenecek. Saha uygulaması artık onayda taslak sürümünü (`draftRev`) istiyor, eski field-api ile onay çalışmaz. Ardından phone-setup ve preview-worker çalışacak, linkler size gelecek. Hepsi yalnızca preview projesinde, staging'e dokunulmuyor.
- **Geliştiriciler için not:** anahtar yoksa worker artık sahte veriye kendiliğinden geçmiyor. Yerelde uçtan uca çalıştırmak için `.env` içine `EXTRACT_PROVIDER=fake` ve `TRANSCRIBE_PROVIDER=fake` yazılmalı.
- Actions döndükten sonraki CI'da iki eski test güncellendi (9278b0e, a41cdec); kod hatası değildi. Tüm işin birlikte CI sonucu bekleniyor.
- W1-19 yerel hazırlık bitti (a767f12): RUNBOOK §2 "Cut-over (W1-19), step by step" (adım 0–8, her biri komut, ön koşul, doğrulama, geri alma), `docs/DEMO_NOTES.md` (demo senaryosu tıklama tıklama), `pnpm cutover:preflight` (yerel ön kontrol; paketlerde sır yok: PASS), staging şeklindeki veritabanında cut-over provası (cutover.test.ts). Hiçbir uzak adım yapılmadı. **Hafta 1 ticket'larının tamamı kodlandı;** kalanlar sizin onay ve kontrollerinizde.
- Sonra: W1-19 (cut-over ve prova) için yerelde yapılabilen hazırlık; uzak adımların her biri sizin onayınızla.

## Onayınızı bekleyen

1. Spec §19: "önerilerinle devam" kararınız işlendi (commit 25c1ead, c3b1cd4). Q10, Q19, Q20, Q22–Q28, Q30, Q33, Q35, Q37–Q48, Q50–Q62, Q64, Q65 karara bağlandı; davranışı değiştirenler kodlandı (Q53 geç kayıt 48 saat, Q55 `missing` uyarısı, Q46 CALL/TEXT onayı, Q45, Q42 12 karakterli link kodu, Q24, Q62 yarım gün = vardiyanın yarısı, Q59).
   **Q15–Q17 de karara bağlandı (5b208ea): SMS'lerde GSM-7 noktalama (EN SMS'ler artık tek parça), Q16/Q17 yapıldığı gibi. Sizde bekleyenler (yalnızca sizde olan bilgi):** İletimerkezi'nin Türkçe karakter tablosunu destekleyip desteklemediği · Q2 TR SIP sağlayıcısı ve numara · Q8/Q9 TR fatura kurumu ve fiyatı · Q49 İYS (hukuk) · Q63 ES/TR metinlerinin ana dili konuşan biri tarafından incelenmesi · Q28/Q40/Q50 avukat metinleri (go-live'dan önce) · Q30 fatura kurumu ve fiyatlar · Q66 PDF'in Türkçe metinleri ve Q68 rapor e-postasının Türkçe metni (ana dili Türkçe biri gözden geçirmeli; örnek PDF'ler sohbette).
2. ~~Preview migration'ları~~ — onaylandı (2026-10-15 19:45 UTC), Deploy run 38796512732 (`preview` / `supabase`: 9 migration + edge fonksiyonları).

## Cut-over sırası (W1-19; 2026-10-15'te "önerilerinle devam" dediniz; ayrıntı RUNBOOK §2)

Durum: adım 0 (yerel ön kontrol) çalışıyor; adım 1'in salt okunur envanteri çalışıyor (Deploy run 38796568727). Önerim: adım 2–8, preview'daki telefon testi geçtikten ve anahtarlar eklendikten sonra; adım 5 Chicago 17:00 (UTC 22:00) sonrası.

0. Yerelde `pnpm check && pnpm cutover:preflight -- --full-db`; ön koşullar: Anthropic ve Deepgram anahtarları, yedek için bir yer, bir zaman dilimi.
1. Deploy `staging` / `inventory` (salt okuma); demo dışı `verified` sorumlu olmadığını doğrula; `pg_dump` ve storage yedeği.
2. Staging SQL editöründe `supabase/ops/discard-backlog.sql` (eski kuyruktaki 2 job).
3. `supabase secrets set`: `LINK_SIGNING_SECRET` (bir kez üret, sakla; worker da aynısını kullanır), `FIELD_APP_URL`, `APP_URL`; Auth site/redirect URL'leri. Gönderici kimliği ve ses numarası girilmez.
4. PR #1'i birleştir; canlı daldan Deploy `staging` / `all` (db push → fonksiyonlar → web ve field `--prod`); duman kontrolleri.
5. Chicago 17:00'den sonra (İstanbul 01:00) demo verisi: `pnpm seed:demo -- --date today --apply --allow-staging`.
6. Lena ve Elif için tek kullanımlık panel giriş linkleri.
7. Worker'ı geliştirici makinesinde staging'e karşı başlat (`apps/worker/.env`: aynı `LINK_SIGNING_SECRET`, Deepgram, Anthropic, ücretsiz hava durumu adresi, `EMAIL_PROVIDER=console`); `/health`.
8. `docs/DEMO_NOTES.md` provasını gerçek telefonla arka arkaya iki kez (arada adım 5).

Not: `ANTHROPIC_API_KEY` ve `DEEPGRAM_API_KEY` worker'ın `.env`'ine girer (Supabase secret değil). Preview'da önce aynı akışı denemek için 9 migration'ın preview'a yüklenmesini onaylayabilirsiniz.

## Sizden beklenen

0. ~~GitHub Actions çalışmıyor~~ — 19:04 UTC'de düzeldi (teşekkürler); bekleyen commit'lerin CI'ı çalışıyor.
1. **Anahtarlar:** `ANTHROPIC_API_KEY` ve `DEEPGRAM_API_KEY` (W1-11/W1-12'den itibaren; yoksa fake/console ile devam ederim, gerçek transkripsiyon ve çıkarım çalışmaz) · `RESEND_API_KEY` (W1-15; yoksa `EMAIL_PROVIDER=console`) · Twilio / İletimerkezi isteğe bağlı (console sürücüsü ve Demo phone yeter).
2. **Uzun süreli kayıtlar:** Twilio toll-free doğrulaması (US) ve İletimerkezi `SITELOG` başlığı (TR); onaylanınca gönderici kimliklerini `pnpm countries:set` ile siz girersiniz (paket satırı, env değil).
3. **Kontroller:** field preview'u telefonla açma (W1-04/W1-07 probe'u), logo kontrolü; W1-09 için iPhone (Safari) ve Android (Chrome) ile HTTPS önizlemeden: 2 dk ses + 2 fotoğraf, uçak modunda kuyruk, ekran kilidi, sessize alma ve gelen arama sırasında kayıt.
4. **Proje dosyaları:** bu ortamda claude.ai Projesi'ne dosya yazamıyorum; `docs/SITELOG_SPEC.md`, `docs/decisions/channel-options.md` ve bu `claude/STATUS.md` repoda güncel; Projeye kopyalanması size kalıyor (Proje GitHub'dan senkronsa kendiliğinden gelir).

## Özet

Hafta-1 planının M0–M3'ü (W1-01 … W1-12) yazıldı ve CI'da yeşil, preview projesi ve demo verisi hazır; M3 sonunda incelemeniz, preview migration onayı, Q54–Q63 kararları ve anahtarlar için duruyorum.
