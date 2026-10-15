# SiteLog · Durum

Güncelleme: 2026-10-15 18:58 UTC · dal `spec-v1.2` · PR #1 · son CI yeşil: a9cc55f (run 38740645053); GitHub Actions 13:54–19:04 UTC arası kapalıydı; o arada gelen commit'lerin CI'ı run 38790544024'te

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

**Çalışma kuralı (sizden, 2026-10-15):** aksini söyleyene kadar development durmadan devam ediyor; sizin kararınızı ya da doğrulamanızı gerektiren her şey aşağıda bekletiliyor.

- 16:00 civarında oturum kullanım limiti doldu; üç iş yarıda kaldı ve şimdi kaldıkları yerden sürdürülüyor:
  - W1-16 Overview: bitti ve push edildi (5846e2a, 4d5182a; kanal sütunu, "Bugünün linkini gönder", yeni dikkat maddeleri, EN/TR, Şantiye detayındaki düğme dahil).
  - W1-17 Raporlar arşivi ve Rapor inceleme (yüklemeler, aramalar, saha olayları, EN/TR): yerel commit hazır, son test ve push.
  - İnceleme düzeltmeleri: imza/geri alma PDF yarışı, e-posta tekrar denemesi (409), `missing` uyarısının kaybolmaması, Filed ekranının sonsuz beklemesi, panel e2e port/zaman aşımı.
- Sonra: W1-19 (cut-over ve prova) için yerelde yapılabilen hazırlık; uzak adımların her biri sizin onayınızla.

## Onayınızı bekleyen

1. Spec §19: "önerilerinle devam" kararınız işlendi (commit 25c1ead, c3b1cd4). Q10, Q19, Q20, Q22–Q28, Q30, Q33, Q35, Q37–Q48, Q50–Q62, Q64, Q65 karara bağlandı; davranışı değiştirenler kodlandı (Q53 geç kayıt 48 saat, Q55 `missing` uyarısı, Q46 CALL/TEXT onayı, Q45, Q42 12 karakterli link kodu, Q24, Q62 yarım gün = vardiyanın yarısı, Q59).
   **Sizde bekleyenler (öneri yok ya da yalnızca sizde olan bilgi):** Q15 SMS'te GSM-7 dışı karakterler (metinler olduğu gibi mi kalsın, yoksa "-" gibi GSM-7 noktalaması mı; İletimerkezi'nin cevabı da gerekli) · Q16 eski v1 rapor verisinin v2 görünümü (şimdilik yapıldığı gibi) · Q17 bağlı satırları olan kaydın silinmesi (şimdilik yapıldığı gibi) · Q2 TR SIP sağlayıcısı ve numara · Q8/Q9 TR fatura kurumu ve fiyatı · Q49 İYS (hukuk) · Q63 ES/TR metinlerinin ana dili konuşan biri tarafından incelenmesi · Q28/Q40/Q50 avukat metinleri (go-live'dan önce) · Q30 fatura kurumu ve fiyatlar · Q66 PDF'in Türkçe metinleri ve Q68 rapor e-postasının Türkçe metni (ana dili Türkçe biri gözden geçirmeli; örnek PDF'ler sohbette).
2. Preview'a yeni migration'lar (`20261015000001` W1-10, `…02` W1-12, `…03` Q53, `…04` Q24, `…10` W1-14 imza sonrası PDF, `…30` W1-15 dosyalama, `…40` W1-16 sahipsiz bilinmeyen numaralar): `preview` / `supabase` Deploy işi için onayınız (Actions çalışmaya başlayınca).

## Sizden beklenen

0. ~~GitHub Actions çalışmıyor~~ — 19:04 UTC'de düzeldi (teşekkürler); bekleyen commit'lerin CI'ı çalışıyor.
1. **Anahtarlar:** `ANTHROPIC_API_KEY` ve `DEEPGRAM_API_KEY` (W1-11/W1-12'den itibaren; yoksa fake/console ile devam ederim, gerçek transkripsiyon ve çıkarım çalışmaz) · `RESEND_API_KEY` (W1-15; yoksa `EMAIL_PROVIDER=console`) · Twilio / İletimerkezi isteğe bağlı (console sürücüsü ve Demo phone yeter).
2. **Uzun süreli kayıtlar:** Twilio toll-free doğrulaması (US) ve İletimerkezi `SITELOG` başlığı (TR); onaylanınca gönderici kimliklerini `pnpm countries:set` ile siz girersiniz (paket satırı, env değil).
3. **Kontroller:** field preview'u telefonla açma (W1-04/W1-07 probe'u), logo kontrolü; W1-09 için iPhone (Safari) ve Android (Chrome) ile HTTPS önizlemeden: 2 dk ses + 2 fotoğraf, uçak modunda kuyruk, ekran kilidi, sessize alma ve gelen arama sırasında kayıt.
4. **Proje dosyaları:** bu ortamda claude.ai Projesi'ne dosya yazamıyorum; `docs/SITELOG_SPEC.md`, `docs/decisions/channel-options.md` ve bu `claude/STATUS.md` repoda güncel; Projeye kopyalanması size kalıyor (Proje GitHub'dan senkronsa kendiliğinden gelir).

## Özet

Hafta-1 planının M0–M3'ü (W1-01 … W1-12) yazıldı ve CI'da yeşil, preview projesi ve demo verisi hazır; M3 sonunda incelemeniz, preview migration onayı, Q54–Q63 kararları ve anahtarlar için duruyorum.
