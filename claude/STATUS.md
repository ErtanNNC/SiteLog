# TalkOlog · Durum

**2026-10-19 (12:30 UTC) — Ürün adı TalkOlog (eski adıyla SiteLog).**

- **Değişen:** kullanıcının okuduğu her metin TalkOlog diyor: SMS ve WhatsApp metinleri, e-postalar, PDF, panel, saha uygulaması (EN/ES/TR), sesli asistanın cümleleri, kurulum sihirbazı. TR paketinin SMS başlığı `TALKOLOG` (belgelerde, testlerde ve CI'da). Marka SVG'lerinin etiketleri ve paneldeki logo yazısı TalkOlog; işaret (logo) ve ikonlar aynı.
- **Değişmeyen:** teknik isimler (`@sitelog/*` paketleri, veritabanı, repo, env adları, `docs/SITELOG_SPEC.md`). Uygulanmış migration'lar da değişmedi (geriye dönük düzenleme yasak). İçlerindeki iki bildirim metni panelde zaten çeviri anahtarıyla gösteriliyor, eski isim ekrana çıkmıyor.
- **Alan adları (sizin seçiminiz, §19 Q360):** panel `app.talkolog.com`, saha uygulaması ve linkler `go.talkolog.com`, e-posta `reports@talkolog.com`. Koddaki varsayılanlar buna göre. **Sizin adımlarınız:** DNS, Netlify'da alan adı, Supabase Auth adresi, Resend alan doğrulaması (RUNBOOK "Domain talkolog.com"). Hiçbirini ben yapmadım.
- **Sizin yaptığınız (2026-10-19):** `talkolog.com` Netlify'da `staging-sitelog.netlify.app` sitesine bağlandı. Bu site `main`'deki eski v1.0 sürümünü (SiteLog adıyla) ve staging veritabanını gösteriyor. Panel orada açılır, ama staging'in Supabase Auth adresi ve `APP_URL` hâlâ Netlify adresi: girişler o adrese döner, `api-*` çağrıları (davet, faturalama) CORS yüzünden `talkolog.com`'dan çalışmayabilir. Karar sizde (aşağıdaki seçenekler sohbette); staging ayarlarına sizin onayınız olmadan dokunmuyorum.
- **Test:** `scripts/src/product-name.test.ts` eski adı her metinde arıyor; geri gelirse `pnpm check` kırılıyor.
- **Bilmeniz gereken:** `CLAUDE.md` ve geçmiş plan belgeleri (PLAN_WEEK1–4, GAP_ANALYSIS, AUDIT_BACKLOG, START_HERE) eski adla kaldı; bunlar geçmiş kayıt. CLAUDE.md'yi isterseniz siz güncelleyin ya da bana söyleyin. Tasarım çizimleri (`docs/design`) de teslim edildiği gibi duruyor.

**2026-10-19 (11:10 UTC) — Talk now preview'de uçtan uca çalışıyor.**

- **Sonuç:** Dana ile Talk now: asistan raporu aldı, soruları sordu, rapor oluştu. Sizin testiniz, 2026-10-19.
- **Bugün bulunan ve düzeltilen hatalar** (hepsi testli, preview'e kurulu):
  - Asistan çağrı kimliğini odanın bilgisinden okuyordu; bilgi gelmeden çöküyordu. Artık çağrı isteğinden okuyor.
  - `set_preference` aracının şeması Anthropic'in reddettiği biçimdeydi; model hiç çalışmıyordu. Düzeltildi, bütün araçları kontrol eden test eklendi.
  - Kodun ara cümleleri ("Still working on it") modelin geçmişine giriyordu; yeni model bunu reddediyordu. Artık girmiyor.
  - Arama bitince kayıt yüklenmeden süreç kapatılıyordu (10 sn). Süre 90 sn.
  - Yedek kayda ("bip") geçen aramanın açık sorusu web'e devredilmiyordu; uygulamada soru takılıyordu. Migration `20261019000100` düzeltti ve takılı soruları devretti.
  - deploy.yml: `voice-setup` artık günlükleri gösteriyor; `voice_logs_only` asistanı yeniden kurmadan günlükleri okuyor.
- **Bakmanız gereken (karar değil, bilgi):**
  - **Yavaşlık:** kısa bir rapor yaklaşık 6 dk sürdü. Ölçülen: işçinin bir `update_draft` turu ~24 sn (Claude çıkarımı, GitHub runner'da çalışan işçi). Asistanın field-api isteği 15 sn'de zaman aşımına uğrayıp yeniden deniyor. Preview kurulumu (ücretsiz katmanlar, runner'daki işçi) bunun bir kısmı; canlıda Fly.io'daki işçiyle yeniden ölçülmeli (`pnpm voice:latency`, F6 hedefleri).
  - **Talk now saatlik sınırı** (§19 Q171) testte çabuk doluyor; değiştirmedim.
  - İşçi preview'de 60 dk çalışıyor; her test oturumunda `preview-worker` yeniden başlatılmalı.

**2026-10-17 (18:45 UTC) — Onaylarınız işlendi.**

- **Bütün açık sorular kararlaştırıldı.** "Önerdiğin ve yaptığın tüm işleri ve soruların cevabını onaylıyorum" mesajınızla spec §19'daki 116 açık soru **Decided 2026-10-17 (önerilen varsayılan)** olarak işaretlendi.
  - Bu, hafta 2–4'te açılan bütün soruları kapsıyor: Q135–Q227, Q229–Q246, Q270, Q280, Q290, Q300, Q330, Q340, Q350 ve öncekiler.
  - Kodda değişen bir şey yok; hepsi zaten önerilen varsayılanla çalışıyordu.
  - Tek istisna Q340: önerilen çözüm yazılmamıştı; şimdi yazıldı. Kullanıcı panelde dilini değiştirince, sonraki giriş e-postası da o dilde geliyor.
- **Açık kalan iki soru:**
  - Q281: İletimerkezi mesaj türünü "ticari" sayarsa doldurulacak İYS alanları. Bu soru yalnız avukat Q49'a "ticari" derse geçerli.
  - Q49: Türkçe SMS'lerin İYS'de "bilgilendirme" mi "ticari" mi sayılacağı. Önerimi onayladınız (bilgilendirme), ama bunu avukatın da teyit etmesi gerekiyor.
- **Hafta 1 ve 2 tamamlandı.** "Testler yapıldı" demeniz üzerine `docs/PLAN_WEEK1.md` ve `docs/PLAN_WEEK2.md`'deki bütün kutular işaretlendi, "owner confirmed done, 2026-10-17" notuyla. Bu, W1-19 cut-over adımlarını da içeriyor.
- **Hafta 3'te sizi bekleyenler:**
  - W3-16: ses dinleme testi ve telefonla 10 arama.
  - W3-04, W3-11, W3-12, W3-13 ve W3-18: telefon kontrolleri.
  - Bunlar da yapıldıysa söyleyin, işaretleyeyim.
- **Hafta 4'te sizi bekleyenler:**
  - W4-13: İletimerkezi ve avukat metinleri.
  - W4-14: Türkçe ses ve telefon testleri.
  - W4-15: Stripe test modu.
  - Rehberler RUNBOOK'ta: "TR go-live" ve "Billing" bölümleri.

**2026-10-17 (18:00 UTC) — Hafta 4'ün kodu bitti.**

- **CI'da yeşil:** W4-01 … W4-12 ve W4-16. Ayarlar'daki "Beni şimdi ara" (Q350) ve M10/M11 kabul testleri (`pnpm e2e:m10`, `pnpm e2e:m11`) dahil.
- **M11 testi:** Elif'in gezdiği her panel sayfasında İngilizce metin kalmadığını kontrol ediyor. Demir Yapı'nın Türkçe link raporunu, Türkçe PDF'ini ve Türkçe aramaları da uçtan uca deniyor.
- **Hafta 4 açık soruları:** tamamı `docs/PLAN_WEEK4.md` sonundaki "Week 4 open questions" tablosunda, kodda çalışan varsayılanlarıyla birlikte.
  - Q340 tek istisna: önerdiğim çözüm henüz yapılmadı. Giriş e-postasının dili, kullanıcının davet ya da kayıt anındaki dilinde kalıyor.
  - Yeni soru Q350: "Beni şimdi ara" için bütçe ve arama saatleri.
- **Demo notları:** `docs/DEMO_NOTES.md` "Week 4". Yeni bir şirketin kendi kendine kurulumu, Türkçe demo ve faturalama döngüsü adım adım; sizin hesaplarınızı gerektiren adımlar **(owner)** olarak işaretli.
- **Kalanlar sizde:**
  - **W4-13:** İletimerkezi hesabı, `TALKOLOG` başlığı, avukat metinleri.
  - **W4-14:** Azure ve LiveKit ile Türkçe ses testi, telefon testleri.
  - **W4-15:** Stripe test modu.
  - **Supabase şablonları:** giriş ve davet e-posta şablonlarının önizleme projesine yüklenmesi (RUNBOOK "Auth email templates").

**2026-10-17 (16:00 UTC) — Hafta 4 ilerliyor.**

**Bitti ve CI'da yeşil:**

- **W4-01:** telefon ülke seçici artık tüm ülkeleri listeliyor; şirketin ülkesi en üstte.
- **W4-02:** kurulum sihirbazı Türkçe. Karşılama mesajı önizlemesi gerçek SMS metnini gösteriyor ve numaranın SMS alıp alamayacağını kontrol ediyor.
- **W4-03:** Ekip sayfası v1.2'ye uygun hale geldi.
- **W4-04:** Ekip sayfasına "Şimdi ara" düğmesi geldi. Ofis önce kişinin aranmayı kabul ettiğini onaylıyor; açmayan kişiye SMS gitmiyor.
- **W4-05 (son parçası hariç):** Ayarlar Türkçe.
  - "Saha kanalları" sekmesi, varsayılan iletişim tercihi, günlük link süresi.
  - Rapor dili ve birimleri değiştirilebiliyor.
  - "Bana test mesajı gönder" düğmesi var.
- **W4-06, W4-07, W4-08:** hukuki metinler, Türkçe sesli asistanın sayıları doğru söylemesi ve başlangıç sözlüğü.
- **W4-10:** fiyat şirket başına tutuluyor. Türk şirketleri "manuel" faturalanıyor.
- **W4-11:** İletimerkezi teslim durumu kontrol ediliyor.
- **W4-12:** kayıt olma testi ve sahte SMS sağlayıcısı. Karşılama mesajı tepki gelmezse 48 saat sonra bir kez otomatik tekrar gönderiliyor.

**Push edildi, CI bekleniyor:**

- **W4-09 (CI yeşil):** panelin kalan sayfaları Türkçe. Yalnız `/ops` ve `/try` İngilizce kaldı.
  - Ofis e-postaları her okuyucunun panel dilinde gidiyor.
  - Giriş ve davet e-postalarının Türkçe metni var.
  - **Bulunan hata:** "imzadan sonra değiştirildi" e-postası daha önce kimseye gitmiyordu. Düzeltildi.

**Sürüyor:**

- Ayarlar'daki "Beni şimdi ara" düğmesi (W4-05'in son parçası). Kısa bir test araması: bilgilendirme, tek cümle, veda; kaydedilmiyor.
- Sırada W4-16 var: M10 ve M11 kabul testleri, demo notları.

**Yeni açık sorular.** Hepsinde önerdiğim varsayılan kodda çalışıyor:

- **Q270:** Fiyatı Stripe fiyatından farklı olan şirkete ödeme sayfası açılmıyor. Böyle bir şirket için Stripe'ta ayrı fiyat açılmalı.
- **Q280:** İletimerkezi teslim raporunun adresi. Hesap açılınca dokümanından doldurulacak; o zamana kadar kontrol kapalı.
- **Q290:** Ülke paketinin avukat onay metni geldiğinde Karşılama ekranındaki kutunun yazısı o metin mi olsun? Önerim evet; metin gelene kadar uygulamanın kendi yazısı duruyor.
- **Q300:** Ofis karşılamayı son 48 saatte elle yeniden gönderdiyse otomatik tekrar gönderim atlanıyor (iki gün içinde iki mesaj spam gibi görünür).
- **Q330:** "Şimdi ara" aynı kişi ve şantiye için günde en fazla 3 kez kullanılabiliyor, sonra "sınıra ulaşıldı".
- **Q340:** Giriş e-postasının dili, kullanıcı oluşturulurken belirleniyor. Önerim: kullanıcı panelde dilini değiştirince bu da güncellensin (henüz yapılmadı).

**Sizden beklenenler değişmedi:** 08:00 UTC notundaki 6 madde. En acil olanlar:

- İletimerkezi hesabı ve `TALKOLOG` başlığı;
- avukat metinleri;
- TR faturalama (Q8, Q9);
- Stripe test modu.

**Yeni:** Supabase'in giriş ve davet e-postası şablonlarının önizleme projesine yüklenmesi sizin adımınız. RUNBOOK'ta "Auth email templates (W4-09)" bölümünde anlatılıyor.

**2026-10-17 (08:00 UTC) — Hafta 4 başladı.**

- **Hafta 4 planı yazıldı:** `docs/PLAN_WEEK4.md` (171dfc9). İçinde W4-01 … W4-16 var: M10 (kurulum, ekip, ayarlar, faturalama) ve M11 (Türkiye pazarı).
- **Plan yazılırken bulunan eksikler:**
  - Kurulum, Ekip, Ayarlar ve Faturalama sayfaları hâlâ yalnız İngilizce.
  - Kurulumdaki karşılama mesajı önizlemesi hâlâ eski WhatsApp şablonunu gösteriyor.
  - Ayarlar'daki "Saha kanalları" sekmesi boş.
  - Fiyat kodda sabit yazılı.
  - Deneme süresi bitince hiçbir şey kilitlenmiyor.
- **Şu an çalışanlar:**
  - W4-01: telefon ülke seçici, artık tüm ülkeleri listeleyecek.
  - W4-07: Türkçe sesli asistanın sayıları, birimleri ve saatleri doğru söylemesi; örneğin "metreküp", "on yedi otuz".
  - W4-08: yeni şirketlere hazır gelen Türkçe başlangıç sözlüğü ve Türkçe test seti.
- **CI:** hafta 3'ün ardından Q227 ve Q226 da yeşil (fa630b2).
- **Yeni açık sorular Q229–Q246.** Hepsinde önerdiğim varsayılan var ve kod onunla kurulacak; listeyi `docs/PLAN_WEEK4.md` "Owner decisions" bölümünde bulabilirsiniz. Önemli olanlar:
  - **Q234:** Fiyat şirket başına tutulsun, yalnız TalkOlog ekibi değiştirebilsin.
  - **Q235:** Deneme süresi biter ve kart girilmemişse, ödemesi gecikmiş şirket gibi işlem yapılsın: önce uyarı, sonra hatırlatmalar durur.
  - **Q236:** Q8 karara bağlanana kadar Türk şirketleri "manuel" faturalansın, yani faturayı TalkOlog doğrudan kessin.
  - **Q230:** Ekip sayfasındaki "Şimdi ara" düğmesi yalnız yönetici ve operasyon kullanıcılarında olsun ve önce ofisin onayını istesin.
- **Sizden, hafta 4 için (bugün başlayın, uzun sürüyor):**
  1. İletimerkezi hesabı, e-Devlet aboneliği ve `TALKOLOG` başlığı. Türkçe karakter tablosunu ve teslim raporlarını da sorun.
  2. Avukattan:
     - KVKK aydınlatma metni, kayıt bildirimi ve onay metni, TR ve EN;
     - yurt dışına aktarım dayanağı;
     - İYS (Q49);
     - Türkiye'de verinin nerede tutulacağı (Q12);
     - US gizlilik, kayıt ve otomatik arama metinleri.
  3. Türkiye'de fatura kesecek şirket ve sağlayıcı (Q8), ayrıca TR fiyatı (Q9).
  4. Henüz yapılmadıysa US numarası için Twilio toll-free doğrulaması.
  5. Hafta ortasına kadar:
     - Stripe test modu: hesap, site başına $399 fiyat, preview projesine webhook ve secret'lar;
     - preview projesinin giriş e-postası şablonları için onay.
  6. Tasarımlar: Web-Setup, Web-Team, Web-Settings ve Web-Billing dışa aktarılsın. Ya da spec ve mevcut sayfaların referans olduğunu onaylayın.

**2026-10-17 (07:30 UTC) — Hafta 3'ün kodu bitti.**

**Kısaca:** W3-01 … W3-18'in koddan yapılabilen her şeyi yapıldı ve CI'da yeşil. Kalanlar sizin hesaplarınıza ve telefon testlerinize bağlı.

**Bitti ve CI'da yeşil:**

- W3-01 … W3-15: sesli asistanın tamamı (sözleşme, Python asistan, canlı taslak, okuma ve "evet", aramadan sonraki iş, özel istekler, "Talk now"), 11 senaryolu arama test takımı.
- W3-16 kod kısmı: `pnpm voice:latency` (gecikme ölçümü), `pnpm voice:samples` (ses dinleme testi), RUNBOOK'ta LiveKit kurulumu için 11 adım.
- W3-17: giden hatırlatma aramaları, sahte (konsol) hatla. R1 araması, cevapsız → "cevapsız arama" mesajı, R2, telesekreter algılama, geri arama, "Bugün arama", /ops M8 ölçüsü.
- W3-18: `pnpm e2e:m9` ve `pnpm e2e:voice` test takımları, `docs/DEMO_NOTES.md` "Week 3" (arama senaryosu ve panel turu), açık soru özeti (`docs/PLAN_WEEK3.md` sonunda tablo).
- **Q227 düzeltildi:** telefonla gelen aramada LiveKit odanın adını kendisi veriyor (içinde arayanın numarası var). Kod artık odanın kimliğini (`RM_…`) kullanıyor; numara hiçbir yere yazılmıyor, loglanmıyor. Bu olmasa ilk gerçek telefon araması reddedilirdi.

**Yol boyunca bulunan ve düzeltilen hatalar:**

- Veritabanı kütüphanesi JSON'u iki kez kodluyordu (simülatör ve `countries:set` WhatsApp şablonları).
- Worker ileri tarihli işleri 2 dakikalık genel kontrolü bekleyerek yapıyordu; artık zamanı gelince uyanıyor (aramalar ve tekrar denemeler daha hızlı).
- Bir test hafta sonları kırılıyordu (demo verisi hafta içi); düzeltildi.

**Sizin kararınızı bekleyen sorular** (hepsinde önerdiğim varsayılan kodda çalışıyor; tam liste `docs/PLAN_WEEK3.md` "Week 3 open questions"):

- **Q193:** STOP göndermiş telefondan aramada "evet" → SMS onayı kaydedilmesin (önerim).
- **Q199:** Akşam 19:00'dan sonra aramada "bugün iş yok" → şu an reddediliyor.
- **Q206:** Deepgram'ın ses verisini model geliştirmede kullanmaması (opt-out). Fiyatı kontrol edin.
- **Q222:** Günde en fazla kaç "cevapsız arama" mesajı? Şu an 3, önerim 1.
- **Q228:** LiveKit'te hangi yönlendirme kuralı tipi? Önerim "callee + randomize" (LiveKit'in kendi panelinde numara görünmesin diye).

**Sizden bekleyenler** (en uzun sürenler önce):

1. **Twilio:** hesap yükseltmesi, SIP trunk, sesli US numarası, Trust Hub ve SHAKEN/STIR. Gerçek giden aramalar için; sonra tek komut: `pnpm countries:set -- --outbound-trunk ST_…`.
2. **Avukat metinleri:** otomatik arama onayı (TCPA), kayıt bildirimi, KVKK.
3. **LiveKit Cloud ve Azure Speech:** canlı aramalar için. Adımlar RUNBOOK "Voice: M7 live on the preview project (W3-16)" bölümünde; her adım sizin onayınızla.
4. **Ses dinleme testi:** `pnpm voice:samples` ile örnekleri üretip EN/ES/TR seslerini seçmeniz (Q225).
5. **Telefon testleri:** "Talk now" iPhone ve Android'de, 10 arama, Türkçe arama, gerçek R1 araması.
6. **Q140** (staging sözlük çiftleri), **Q181** (İspanyolca okuma), ES/TR ses metinlerinin anadil kontrolü (Q63).
7. Bildirim testi için demo olmayan bir test şirketi.

**Önizleme worker'ı durmuş durumda.** Test etmek isterseniz söyleyin, yeniden başlatırım.

**2026-10-16 (gece, devam):**

- **Q117–Q134 onaylandı** (sizin "onay bekleyen tüm işlemleri onaylıyorum" mesajınız). Spec §19'da karar verildi olarak işaretli.
- **Model karşılaştırması** (Actions → Deploy → environment `preview`, target `eval`):
  - Düzeltmelerden sonra Sonnet raporların 24/28'ini doğru çıkarıyor (önce 21/28). Rapor başına yaklaşık 2,4 sent.
  - Opus da 24/28 çıkarıyor ama yaklaşık 2,5 kat pahalı.
  - Haiku hızlı görevlerin hepsini geçti.
  - Önizleme ayarı: ana model Sonnet, hızlı model Haiku (9d15fbf).
- **Bitti ve CI'da yeşil:**
  - W3-01: sesli asistanın veri sözleşmesi, spec ekleri A ve B.
  - W3-06: saatler sayfası EN/TR, fatura farkı bildirimi, maaş CSV'si güvenlik düzeltmesi.
  - Çıkarım düzeltmeleri.
- **W3-08** (sözlük EN/TR, Türkçe sekme) gönderildi, CI bekleniyor.
- **Yeni açık sorular** (önerilerimle ilerliyorum):
  - Q135–Q139, eval'den: hava durumu kuralı, "bugün iş yok", toplam saat söylenince ne olacağı, ekip kelimeleri, söylenmemiş yüzde.
  - Q140–Q143, sözlükten.
  - Q138 önerildiği gibi uygulandı: "demirci ekibi" artık şirket sayılıyor.
- **Sizden (onay):** Q140. Staging'deki sözlükte eski hatanın oluşturduğu çift kayıtların birleştirilmesi. Bu, staging'de satır silmek demek; ancak sizin onayınızla yapılır.
- **Önizleme worker'ı durdu** (60 dakikası doldu). Teste devam etmek isterseniz söyleyin, yeniden başlatırım.

**2026-10-16 (gece):**

- **Web push önizlemede açık.** VAPID anahtarları worker'a geçiyor (9c3bc89). field-api'nin açık anahtarı GitHub secret'ından kuruldu; kurulum logunda "web push on" yazıyor. Telefonda test: uygulamayı ana ekrana ekle, Ayarlar → Bildirimler → izin ver. Demo şirketler (Kestrel, Demir) bildirimi yalnızca Demo phone'da gösterir (Q116). **Sizden:** gerçek telefona bildirim için demo olmayan bir test şirketi. Bunun için telefon numarası, panel e-postası ve ülke (US/TR) gerekiyor.
- **Hafta 3 planı yazıldı:** `docs/PLAN_WEEK3.md` (2fa6ae4), W3-01 … W3-18, M7–M9. W3-01 … W3-08 için anahtar ve onay gerekmiyor (M9'un tamamı dahil). Ben buradan devam ediyorum.
- **Spec düzeltmesi:** W2-03 commit'i (c7f8d59) spec'in §20 eklerini (A–E) yanlışlıkla silmişti. Ekler aynen geri getirildi (d8f23dc).
- **Yeni sorular Q117–Q134** (sesli arama, giden arama, fatura farkı, EOT paketi) spec §19'a "açık" olarak eklendi. Her birinde önerdiğim varsayılan var, hafta 3 onunla ilerliyor. Farklı karar verirseniz değiştiririm.
- **Sizden, en uzun sürenler önce:**
  1. Şimdiden başlayın: Twilio hesap yükseltmesi, Elastic SIP trunk, sesli arama yapabilen bir US numarası, Trust Hub profili ve SHAKEN/STIR. Bunlar olmazsa aramalar "spam" görünür. W3-17 (giden aramalar) için gerekli.
  2. Şimdiden başlayın: avukattan iki metin. Otomatik AI aramaları için onay metni (TCPA) ve her ülke ve dil için arama kaydı bildirimi. KVKK açısından ses kaydının yurt dışına gönderilmesi de bu metinlere dahil.
  3. Hafta ortasına kadar (her biri birkaç dakika): LiveKit Cloud projesi (Build plan, `lk` CLI erişimi, ücretsiz US numarası) ve Azure Speech F0 kaynağı. Ayrıca şu onaylar: sesli asistana mevcut Deepgram ve Anthropic anahtarlarının ve `VOICE_AGENT_TOOL_SECRET`'ın secret olarak eklenmesi, `voice-events` deploy'u ve `countries:set --voice` komutu.
  4. W3-16 sırasında: EN/ES/TR seslerin dinleme testi, gecikme ölçümü ve "Talk now" için telefonlar.
  5. Field-08, Field-09, Web-Hours, Web-Weather ve Web-Glossary tasarımlarının dışa aktarılması. Ya da spec ve mevcut sayfaların referans olduğunu onaylayın.

**2026-10-16 (akşam):** Q107–Q114 ve Q116 da onaylandı; tek açık kalan Q40'ın avukat kısmı.

**2026-10-16:** önerimle kurulup onayınızı bekleyen tüm sorular (Q94, Q96–Q105) onaylandı ve spec §19'da karar verilmiş olarak işaretlendi. Şu an onayınızı bekleyen açık bir soru yok; yalnızca anahtarlar ve sizin yapmanız gereken işler (aşağıda) duruyor.

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
  - Panel takipleri bitti:
    - Bildirimler artık panelin dilinde gösteriliyor (affe988; yeni migration `20261015000080_notice_data`).
    - Link butonunun hataları Türkçe (c0d46ab).
    - Panelin ürettiği PDF'te eski sürüm yanlış imza basmıyor (260cb7a).
    - `/team` sayfası 390 px'te yana kaymıyor (65cfcd5).
    - Kararsız bir test düzeltildi (42e8df5).
  - Dosyalama sırasında taslak değişirse yarış durumu kapandı: kontrol, okuma ve yazma tek işlemde (cccf287; migration `20261015000090`). Yeni iki migration'ın ikinci incelemesinde hata çıkmadı.
- **Sizin bakmanız gereken:**
  - Bildirimlerin Türkçe metinleri (~60 metin, `packages/shared/src/copy/ui/tr.ts` içinde `shell.notifications.notices`) benim çevirim. Q66/Q68 Türkçe okumasına eklendi.
  - Kestrel demo bildirimleri biraz değişti: "needs review" bildirimi şantiye adı yerine rapor numarasıyla başlıyor, sözlük bildirimi "3 new terms to review" diyor.
- **Yarın sabahki telefon testi öncesi (benim yapacaklarım):** bekleyen tüm yeni migration'lar (`20261015000070` … `20261016000070`) ve güncel edge function'lar preview projesine yüklenecek. Saha uygulaması artık onayda taslak sürümünü (`draftRev`) istiyor, eski field-api ile onay çalışmaz. Ardından phone-setup ve preview-worker çalışacak, linkler size gelecek. Hepsi yalnızca preview projesinde, staging'e dokunulmuyor.
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
2. **Uzun süreli kayıtlar:** Twilio toll-free doğrulaması (US) ve İletimerkezi `TALKOLOG` başlığı (TR); onaylanınca gönderici kimliklerini `pnpm countries:set` ile siz girersiniz (paket satırı, env değil).
3. **Kontroller:** field preview'u telefonla açma (W1-04/W1-07 probe'u), logo kontrolü; W1-09 için iPhone (Safari) ve Android (Chrome) ile HTTPS önizlemeden: 2 dk ses + 2 fotoğraf, uçak modunda kuyruk, ekran kilidi, sessize alma ve gelen arama sırasında kayıt.
4. **Proje dosyaları:** bu ortamda claude.ai Projesi'ne dosya yazamıyorum; `docs/SITELOG_SPEC.md`, `docs/decisions/channel-options.md` ve bu `claude/STATUS.md` repoda güncel; Projeye kopyalanması size kalıyor (Proje GitHub'dan senkronsa kendiliğinden gelir).

## Özet

Hafta-1 planının M0–M3'ü (W1-01 … W1-12) yazıldı ve CI'da yeşil, preview projesi ve demo verisi hazır; M3 sonunda incelemeniz, preview migration onayı, Q54–Q63 kararları ve anahtarlar için duruyorum.

**Kararlar (sizden, 2026-10-16):** önerimle ilerlettiğim, onayınızı bekleyen tüm sorular onaylandı. Kapsam:

- Q76–Q93
- cihaz kodu kuralı
- W2-01'de gecikmeli yedeğe geçiş
- Ayarlar, Geçmiş raporlar ve Süresi dolmuş link ekranlarının tasarım ekranı olmadan spec §9.3'e göre yapılması
- şimdiye kadar yazılan ES/TR metinler

Spec §19 ve planlara işleniyor. Q86 için SMS izninde "Aç" düğmesi ekleniyor. Q93 (cevap kaydını panelde dinleme) planda takip işi olarak duruyor. Yalnızca sizde olan bilgiyi gerektiren sorular hâlâ açık: İletimerkezi Türkçe karakter tablosu, Q2, Q8/Q9, Q49, Q28/Q40/Q50, Q30.

**Telefon testi geçti (sizden, 2026-10-16):** preview ortamında tüm akışı adım adım denediniz, hepsi beklendiği gibi çalıştı. Denenen akış:

- cihaz kodu, izinler, test kaydı
- kayıt, soru ve "Diğer…" cevabı
- taslak, onay, dosyalama ve PDF
- fotoğraf ekleme, geçmiş raporlar, ayarlar

W1-09, W1-13 ve W1-15 bu testle tamamlandı olarak işaretlendi. Bu testte giriş linkinde bir hata çıktı ve düzeltildi (9330786).

**Q86 yapıldı (74f97bd):** Ayarlar'da SMS izni için "Aç" düğmesi var. STOP ile çıkmış numara bu düğmeyle açılamıyor:

- iki yönlü SMS'te kişiye "START yazın" deniyor;
- tek yönlü SMS'te (TR) "ofise sorun" deniyor.
- **Q94 (onaylandı 2026-10-16):** tek yönlü SMS ülkelerinde operatör üzerinden STOP yapan numara nasıl geri dönsün? START orada bize ulaşamıyor. Öneri ve yapılan: "ofise sorun". Ofisin bunu kaldırma ekranı M10'da (Ekip sayfası) gelecek.

**Hafta-2 incelemesinin düzeltmeleri bitti (58431d8 … 07aa8c0):**

- Rapor meşgulken (ör. yazıya dökme sürerken) dolan 60 dakikalık soru süresi artık kaybolmuyor; birkaç dakika sonra yeniden deneniyor.
- Sesli cevaplar artık kişinin söylemediği bir sayıyı rapora eklemiyor ("tam gün", "yarım gün", hava saatleri, "0 saat kayıp" için kişinin bunu gerçekten söylemesi gerekiyor).
- Hâlâ okunan bir sesli cevap, süre dolduğu için kaybolmuyor.
- Test kaydının dosyası her durumda siliniyor.
- "Bana bugünün linkini gönder"e aynı anda iki kez basılırsa tek SMS gidiyor (yeni migration `20261016000090`).
- **Q95 (önerimle, aksini söylemezseniz böyle kalır):** kişi kayıt ya da işleme iznini kapatınca, o anda işlenmekte olan raporu, sesli cevabı ve test kaydı Deepgram'a ya da Claude'a gitmiyor. Taslak otomatik dosyalanmıyor, ofis inceliyor. Kişi izni yeniden verirse atlanan iş tekrar yapılmıyor.

**W2-10 yapıldı (422c7d8, 85613da, 6dd3535; telefon testi bekliyor):** taslak ekranında kişi bir sayıyı iki yolla düzeltebiliyor:

- **+/- düğmeleri:** bir ekip satırına dokunup işçi sayısını ±1, saati ±0,5 değiştirebiliyor ya da yazabiliyor.
- **"Sesle düzelt":** en fazla 30 saniye konuşuyor (ör. "Apex'te altı değil yedi kişi vardı"). Ekranda bir önizleme çıkıyor ("Apex Concrete 6 → 7 işçi, 48 → 56 saat"). Kişi "Değişikliği kaydet" ya da "Tekrar dene"yi seçiyor.

Toplamları her zaman kod hesaplıyor; kişinin söylemediği bir sayı kabul edilmiyor. Değişen her değer kaynağını gösteriyor: ses kaydı ya da "telefonda değiştirildi" (Q80). Yeni migration: `20261016000100`. Gerçek deneme için `ANTHROPIC_API_KEY` ve `DEEPGRAM_API_KEY` lazım.

- **Q96 (onaylandı 2026-10-16):** kişi bir sayıyı düzelttikten sonra yeni bir ses kaydı gelip taslak yeniden oluşturulursa ne olsun? Öneri ve yapılan:
  - yeni kayıt eski sayıyı geri getirirse kişinin düzeltmesi korunuyor;
  - yeni kayıt üçüncü, farklı bir sayı söylerse o sayı geçerli oluyor.
- **Q97 (onaylandı 2026-10-16):** düzeltme işlenirken taslağın 2 saatlik otomatik dosyalama süresi ne olsun? Öneri ve yapılan:
  - süre işlemeye devam ediyor;
  - düzeltme işlenirken ya da önizleme beklerken "Onayla ve gönder" düğmesi kapalı;
  - "Kaydet"e basılınca yeni taslak kendi süresini baştan başlatıyor.
- Tasarımla bir fark var: tasarımda dokunulacak yer 32 px'lik küçük bir kutu. Kural en az 56 px olduğu için ekip satırının tamamını dokunulabilir yaptım.
- CI yeşil (0154f5f, 2026-10-16 09:48 UTC). Önceki bir CI kırmızısı, paneldeki bir testin yoğun makinede zaman aşımına düşmesiydi; kalıcı olarak düzeltildi (f54ba7b).

**W2-10 bağımsız incelemesi (2026-10-16):** ciddi hata yok; 2 orta, 5 küçük sorun bulundu. Hiçbiri sizden karar istemiyor, hepsi düzeltilecek:

- **Orta:** sesle ya da yazarak yapılan bir düzeltme, şantiyede ölçülmüş hava verisi yoksa rapora ölçülmüş gibi görünen hava bilgisi yazabiliyordu (PDF'e ve hava gecikmesi kanıtına gider).
- **Orta:** metin olarak tutulan saat ve miktarlar kişinin söyledikleriyle karşılaştırılmıyordu (ör. "yarım saat geç bitirdik" bitiş saatini 17:30 yapabiliyordu).
- **Küçük:** "Onayla ve gönder"den hemen sonra +/- ile değişiklik, sıradaki dosyalamayı iptal edebiliyordu.
- **Küçük:** ses kaydı yüklenirken sayfa yenilenirse düzeltme kayboluyordu.
- **Küçük:** geç gelen bir fotoğraf raporu değiştirirse düzeltme kişiye söylenmeden düşüyordu.
- **Küçük:** ekran okuyucu ekip satırındaki "Cevaplandı" işaretini okumuyordu.
- **Küçük:** iki kişili şantiyede bir kişi diğerinin düzeltme önizlemesini görebiliyordu.

**W2-10 düzeltmeleri ve W2-11 yapıldı (0f66219 … 379c905; telefon testi bekliyor):**

- W2-10 incelemesindeki 7 sorunun hepsi düzeltildi, her biri kendi testiyle (yeni migration `20261016000120`).
- **W2-11, dosyalanmış raporu telefondan değiştirme:** Geçmiş raporlarda son 14 gündeki bir rapora "Bir şeyi değiştir" → konuş ya da yaz → önizleme → "Değişikliği kaydet".
  - Raporun yeni sürümü (v2, v3 …) oluşuyor, eski sürüme dokunulmuyor ve her sürüm onu kimin yaptığını gösteriyor.
  - Yeni `_v2` PDF hazırlanıyor. Ofise ve raporu imzalayan kişiye "güncellendi" e-postası, kişiye de "Güncellendi: … Sürüm 2 ofise gönderildi." mesajı gidiyor; tekrar denemelerde her biri yalnızca bir kez.
  - İmzalanmış bir rapor değişince tekrar "dosyalandı" durumuna dönüyor ve imzalayan kişiye panelde bildirim gidiyor.
  - 14 günden eski rapor kilitli: "Ofise sorun."
  - Yeni migration: `20261016000110`.
- CI'daki kırmızı test düzeltildi: testin şantiyesinde e-posta alıcısı tanımlı değildi, kodda hata yoktu.

**Yeni sorular (2026-10-16'da onayladınız, böyle kaldı):**

- **Q98:** dosyalanmış raporda +/- düğmeleri yok; değişiklik sesle ya da yazarak yapılıyor ve tek seferde kaydediliyor.
- **Q99:** durdurulmuş ya da arşivlenmiş bir şantiyenin raporu telefondan değiştirilemiyor; ofis panelden değiştiriyor.
- **Q100:** değişiklik notunu ("Apex Concrete 6 → 7 işçi") yapay zekâ değil kod yazıyor. Demo verisindeki örnek metin biraz farklı okunuyor.
- **Q101:** ofis, kişinin değişikliğinin PDF'i hazırlanmadan daha yeni bir sürüm yaparsa, kişinin sürümü için ayrı "güncellendi" e-postası ve mesajı gitmiyor.

**W2-11 incelemesi, W2-04 düzeltmesi ve W2-12 yapıldı (9c3abeb … 457e43d):**

- **W2-11 incelemesi:** 2 orta, 2 küçük sorun bulundu; hepsi kendi testiyle düzeltildi.
  - Değişiklik önizlemesi artık her zaman neyin değiştiğini yazıyor; boş önizleme kaydedilemiyor.
  - **Q106 (önerimle karar verilmiş sayıldı):** ofis bir raporu düzenlemek için açtıktan sonra kişi telefondan yeni bir sürüm kaydederse, ofisin kaydı reddediliyor ve panel "Rapor değişti. En son sürümü görmek için yenileyin." diyor. Böylece kişinin değişikliği sessizce silinmiyor.
  - "Rapor değişti" uyarısı ekran yenilense de görünüyor.
  - İmzalı bir rapor ofis tarafından düzenlenince imzalayan kişiye de "güncellendi" e-postası gidiyor.
- **W2-04:** imzalı rapora sonradan fotoğraf eklenince imzalayan kişiye de "güncellendi" e-postası gidiyor.
- **W2-12, SMS anahtar kelimeleri (yalnızca iki yönlü SMS ülkeleri; TR tek yönlü olduğu için orada çalışmıyor):**
  - **OK:** hiçbir şeyi onaylamıyor, açık taslağın linkini gönderiyor (Q82).
  - **NO WORK / WEATHER:** bugün raporu açık olan şantiyelerin günlük linkini gönderiyor. Gün, ancak kişi linkte bilgileri kaydedince değişiyor.
  - **EDIT** (ör. "EDIT FRI Apex was 7 not 6"): değişikliğin önizlemesini ve onay linkini gönderiyor. Kişi linkte "Kaydet"e basmadan hiçbir şey değişmiyor.
  - Anahtar kelimeler İngilizce, İspanyolca ve Türkçe okunuyor. STOP ile çıkmış numaralara cevap gitmiyor ve her cevap kayda geçiyor.
  - Yeni migration'lar: `20261016000130` – `…160`.
  - Gerçek deneme için `ANTHROPIC_API_KEY` lazım.

**Yeni sorular (2026-10-16'da onayladınız, böyle kaldı):**

- **Q102:** anlaşılamayan bir EDIT mesajına "anlayamadım" mesajı ve Geçmiş raporlar linki gidiyor.
- **Q103:** açık taslak yokken gelen OK'a cevap gitmiyor (kayda geçiyor).
- **Q104:** NO WORK / WEATHER, bugün raporu açık olan en fazla 3 şantiye için cevaplanıyor; açık şantiye yoksa cevap gitmiyor.
- **Q105:** anahtar kelimelerin İspanyolca ve Türkçe karşılıkları. YES, OK olarak okunmuyor, çünkü Twilio'da abonelik kelimesi.

**W2-12 incelemesinin 8 düzeltmesi ve W2-14 (web push) yapıldı (7ee3d98 sonrası 14 commit):**

- **W2-12 düzeltmeleri:** her biri kendi testiyle.
  - "Friedman", "Salih" gibi isimler artık gün olarak okunmuyor.
  - EDIT'e cevap kaybolmuyor.
  - Kaydedilen değişiklik, yapay zekânın yeniden yazdığı metin değil; kişinin kendi yazdığı kelimeler.
  - İzin kontrolü numaranın bütün kayıtlarına bakıyor.
  - Gün, her şantiyenin kendi saat diliminde okunuyor.
  - Yeniden denemede SMS tekrar gitmiyor.
- **W2-14, web push:** kişi saha uygulamasını telefona yükleyip Ayarlar'da "Bildirimler"i açarsa, soru, taslak, dosyalandı ve hatırlatma mesajları önce bildirim olarak gidiyor. Bildirim kesin olarak gidemezse mesaj SMS ile gidiyor. Bildirimi açmayan kişiler için hiçbir şey değişmiyor.
  - Yeni migration'lar: `20261016000170` – `…190`.
  - **Anahtar gerekiyor:** `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`. Bunları `npx web-push generate-vapid-keys` komutuyla siz üretip worker ortamına koyacaksınız; açık anahtar ayrıca fonksiyonların secret'ı olacak. Anahtar gelene kadar demo şirketlerde bildirimler Demo telefonda görünüyor, gerçek şirketlerde mesaj SMS ile gidiyor.

**Yeni sorular (önerimle kuruldu; aksini söylemezseniz böyle kalır):**

- **Q107:** bildirim, kanal sırasında her zaman SMS'ten önce geliyor ve hiçbir zaman en sonda olmuyor. Yalnızca bildirimi açan kişiyi etkiliyor.
- **Q108:** kişinin iki telefonu varsa, birinde bildirimi kapatmak diğerini etkilemiyor. Bildirim izni yalnızca son telefon da kapatınca geri alınıyor.
- **Q109:** telefon kapalıysa bildirim 4 saat bekletiliyor.

**W2-14 incelemesinin 7 düzeltmesi ve W2-15/16 (Twilio üzerinden WhatsApp) yapıldı (aa21f87 … 1744bb5):**

- **W2-14 düzeltmeleri:** her biri kendi testiyle.
  - Bildirim adresi olarak artık yalnızca Google, Mozilla, Apple ve Microsoft bildirim servisleri kabul ediliyor (Q115, önerimle karar verildi). Böylece sunucu, bir kişinin verdiği rastgele bir adrese istek atamıyor.
  - Bildirim servisi çökerse en fazla 3 deneme yapılıyor, sonra mesaj bir kez SMS ile gidiyor.
  - Anahtar değişince eski bildirim kaydı kapatılıyor.
  - Bildirime dokununca sayfa her zaman açılıyor.
  - Ayarlar'daki "Bildirimler açık" bilgisi doğru gösteriliyor.
- **W2-15, WhatsApp gönderme:** Twilio üzerinden WhatsApp mesajı.
  - Kişi Hoş geldin ekranında ya da Ayarlar'da "WhatsApp'tan mesaj at"ı işaretlerse mesajlar WhatsApp'tan gidiyor.
  - Son 24 saatte kişiden mesaj gelmediyse onaylı şablon kullanılıyor, geldiyse serbest metin.
  - Göndericisi tanımlı olmayan ortamda gerçek şirketlerin mesajı SMS ile gidiyor; demo şirketlerde mesajlar Demo telefonda görünüyor.
- **W2-16, WhatsApp'tan gelen mesajlar:** anahtar kelimeler çalışıyor.
  - WhatsApp'ta STOP yalnızca WhatsApp'ı kapatıyor, SMS'i değil (Q40'ın ilk seçeneği; avukat cevabı hâlâ bekleniyor).
  - Bir soruya WhatsApp'tan yazılan cevap rapora işleniyor.
  - Ses kaydı ve fotoğraf saklanıyor ama yazıya dökülmüyor; kişiye günde bir kez "linki kullanın" deniyor (Q85).
  - Kanal sırası: ABD bildirim → SMS → WhatsApp; Türkiye bildirim → WhatsApp → SMS.
- Yeni migration'lar: `20261016000200` – `…260`.

**Sizin yapmanız gerekenler (WhatsApp için):**

- Twilio WhatsApp göndericisi ve Meta işletme doğrulaması.
- EN/ES/TR şablonların Meta'ya gönderilip onaylanması. Şablon metinlerini `pnpm countries:set -- --code TR --print-whatsapp-templates` komutu yazdırıyor.
- Onaydan sonra gönderici numarası ve şablon kimlikleri her veritabanına `pnpm countries:set` ile girilecek. Barındırılan veritabanı için önce sizin onayınızı alacağım.
- Göndericinin gelen mesaj ve durum adreslerinin sms-webhook'a yönlendirilmesi; adımlar RUNBOOK'ta.

**Yeni sorular (önerimle kuruldu; aksini söylemezseniz böyle kalır):**

- **Q110:** şablon metni §9.2 metninin aynısı. Meta, değişkenle başlayan ya da biten şablonu kabul etmediği için başa "TalkOlog: " ya da sona " - TalkOlog" ekleniyor.
- **Q111 (metin kontrolünüz):** iki yönlü cevapların Türkçe metinleri (yardım, STOP onayı, bilinmeyen numara, tercih değişikliği).
- **Q112:** WhatsApp'ta START, WhatsApp iznini yalnızca daha önce bu izni vermiş kişiye geri veriyor.
- **Q113:** WhatsApp'tan gelen bir cevap anlaşılamazsa kişiye sorunun linki tekrar gönderiliyor; soru açık kalıyor.
- **Q114:** WhatsApp'tan gelen ses kaydı ve fotoğraflar Twilio'daki adresleriyle saklanıyor, kendi depolama alanımıza kopyalanmıyor.

**W2-15/16 incelemesinin 4 düzeltmesi ve W2-17 (hafta 2 kabul testi) yapıldı (be72cd3 … 67ed2fa):**

- **Düzeltmeler:**
  - Bildirim servisinden gelen bir hata artık herkesin bildirim kaydını silmiyor.
  - WhatsApp 24 saat kuralı yalnızca gerçek Twilio mesajlarını sayıyor.
  - "Bana bugünün linkini gönder" WhatsApp reddedince "gönderilemedi" diyor.
  - Bildirim deneme sınırı doğru sayılıyor.
- **W2-17:** hafta 2'nin her akışı için bir uçtan uca test hazır. `pnpm e2e:m6` hepsini çalıştırıyor, CI'da da çalışıyor.
  - Bu sırada bir hata bulundu ve düzeltildi: iki şantiyeli kişi, şantiye seçicide zaten açık olan şantiyeye dokununca Bugün ekranı boş kalıyordu.
  - Gerçek telefonla test senaryosu: `docs/DEMO_NOTES.md` ("Week 2").
- **Q116 (yeni, önerimle):** demo şirketlerin mesajları hiçbir zaman gerçek telefona gitmiyor. Gerçek telefona teslimi denemek için önizlemede ayrı bir test şirketi kurulması gerekiyor.
- **Anthropic ve Deepgram anahtarlarını preview ortamına eklediniz (2026-10-16).** Önizleme worker'ı bundan sonra kayıtları gerçek Deepgram ile yazıya döküyor ve raporu gerçek Claude ile çıkarıyor. Mesajlar yine yalnızca Demo telefonda görünüyor.
- **Model seçimi (önerim):** rapor çıkarma için Claude Sonnet 5.5, kısa işler için (cevap okuma, SMS/WhatsApp mesajı anlama) Claude Haiku 5.5. Hazır test setleriyle (`pnpm eval`) karşılaştırıp sonuçları size sunacağım.

**İkinci telefon testi (2026-10-16 akşam): geçti.**

- Önizlemeye her şey yüklendi: migration'lar `…080` – `…260`, fonksiyonlar, demo verisi.
- Worker ilk kez gerçek anahtarlarla çalıştı: kayıtlar Deepgram ile yazıya döküldü, rapor Claude ile çıkarıldı.
- Siz baştan sona denediniz: "Her şey güzel çalışıyor."
- Test sırasında çıkan ve düzeltilenler:
  - Deepgram anahtarı geçersizdi; yenisini girdiniz.
  - Anthropic anahtarı bir çalışma alanına bağlı değildi; çalışma alanına bağlı yeni bir anahtar girdiniz.
  - Worker'ın zaman aşımı kontrolü önizlemede açılışta veritabanı hatası veriyordu; düzeltildi (96d30ce).
  - Yanlış kod girildiğinde ekran hep "0 hak kaldı" diyordu; düzeltildi.
  - Ayarlar'daki tercih seçimi kaydedilene kadar geri atlıyordu; düzeltildi.
- CI yeşil (96d30ce); hafta 2'nin kabul testleri dahil.
- **Tamamlandı olarak işaretlenenler:** W2-02 – W2-11 ve W2-13.
- **Bekleyenler:**
  - W2-12, SMS anahtar kelimeleri: iki yönlü SMS ve gerçek SMS göndericisi gerekiyor.
  - W2-14, bildirim: VAPID anahtarları gerekiyor.
  - W2-15/16, WhatsApp: Twilio WhatsApp göndericisi ve şablonlar gerekiyor.
  - W2-17, kabul testi: iPhone ve Android'de test edilmesi gerekiyor.
- **Anahtarların durumu:** Anthropic, Deepgram ve Twilio hesap anahtarları preview ortamında. Twilio SMS için gönderici numarası ve test şirketi bekleniyor; ne gerektiği aşağıda.

**Sırada (ben):**

- Model karşılaştırması: hazır test setleriyle Sonnet / Haiku / Opus; sonuçları size tablo halinde sunacağım.
- Hafta 2'den kalan ve anahtar gerektirmeyen işler; ardından hafta 3 planı.

**Sizden beklenen:**

- Twilio: gönderici numarası, SMS'in gideceği kendi numaranız ve hesabın deneme hesabı olup olmadığı.
- VAPID anahtarları (`npx web-push generate-vapid-keys`).
- Twilio WhatsApp göndericisi ve Meta doğrulaması.

## Hafta 2 (M6) — başladı

Plan: `docs/PLAN_WEEK2.md` (5d28574), W2-01 … W2-17. Sizden karar ya da anahtar gerektirmeyen biletlerden başlıyorum: W2-01 (kanallar arası yedekleme), W2-02 (saha Ayarlar), W2-03 (geçmiş raporlar, süresi dolmuş link, yeni telefon), W2-04 (Filed ekranı ekleri).

**Sorular (hepsi onaylandı 2026-10-16; önerdiğim varsayımla kurulmuştu):**

- **Q76:** Aramayı tercih eden kişilere, aramalar (M8) gelene kadar 17:00 linki gitsin mi? Öneri: evet, "arayacağız" mesajı hiç gitmesin.
- **Q77:** Sessiz saatlerde (arama penceresi dışında) mesaj? Öneri: hatırlatma ve dürtme mesajları gitmesin; kişinin kendi işlemine cevaplar her zaman gitsin.
- **Q78:** 30 dakikalık "taslak bekliyor" dürtmesinin metni? Öneri: `draft_ready` mesajı tekrar gönderilsin.
- **Q79:** Rapor sürerken "İş yok" / "Hava" seçilirse? Öneri: şimdiki gibi reddedilsin.
- **Q80:** Kişinin sayıları elle değiştirmesi raporda nasıl kaynak olarak görünsün? Öneri: yeni kaynak türü `reporter_edit`.
- **Q81:** Kişi hangi dosyalanmış raporları düzenleyebilsin? Öneri: sorumlu olduğu şantiyelerin son 14 gündeki raporları.
- **Q82:** Aramalar yokken SMS "OK" ne yapsın? Öneri: hiçbir şeyi onaylamasın, taslak linkini göndersin.
- **Q83:** Anahtar kelime cevaplarının metni yok. Öneri: yeni metinler `day_off_link` ve `edit_preview`.
- **Q84:** Bir ortamda göndericisi olmayan kanal (ör. WhatsApp) gerçek bir şirket için ne olsun? Öneri: sıradan çıkarılsın, mesajı SMS taşısın. TR'nin `{whatsapp, sms}` sırası açılmadan önce önemli.
- **Q85:** WhatsApp'tan gelen sesli not ve fotoğraflar? Öneri: saklansın, yazıya dökülmesin; günde bir kez "linki kullanın" cevabı gitsin (yeni metin `whatsapp_use_link`).
- **W2-04 için okuma:** web'den dosyalanan rapora ertesi gün 23:59'a kadar fotoğraf eklenebilsin mi? Spec bu süreyi yalnızca aramadan sonraki fotoğraflar için veriyor. Öneri: evet.

**W2-01 bitti (2e4efc5):** bir kanal gönderemezse mesaj sıradaki kanaldan bir kez gidiyor. Her deneme ayrı kaydediliyor; tüm kanallar başarısız olursa ofise bildirim gidiyor (EN/TR).

- **Onayınız (öneri: kabul):** gönderildikten sonra gelen "teslim edilemedi" bilgisiyle sonradan yedeğe geçiş şimdilik yalnızca `notify` işiyle giden mesajlarda çalışıyor (bugün "dosyalandı" mesajı). Hoş geldin, cihaz kodu ve "bugünün linki" yalnızca gönderim anında yedeğe geçiyor. Bu mesajlar W2-06/W2-07'de `notify` işine taşınacak.
- Yeni Türkçe bildirim metni Q63 Türkçe okumasına eklendi.

**W2-02 bitti (ebfcee0):** saha uygulamasında Ayarlar ekranı. Kişi buradan iletişim tercihini (link / arama) ve dili seçebiliyor, izinleri kapatabiliyor ve bu telefondan çıkış yapabiliyor. Kayıt veya işleme izni kapatılırsa ofise bildirim gidiyor (yeni migration `20261016000010`).
**Hesap hatası bildirimleri (eb6dc4e):** SMS hesabı veya göndericide bir sorun olduğunda ofise her mesaj için ayrı bildirim gitmiyor. Saatte en fazla bir hesap bildirimi gidiyor; bu artık yalnızca hoş geldin mesajı için değil, tüm SMS'ler için geçerli.

- **Q86 (onaylandı 2026-10-16):** kişi kapattığı bir izni Ayarlar'dan yeniden açabilsin mi? Şu an "aç" düğmesi yok. Kayıt ve işleme izni onay ekranından geri alınabiliyor, ama SMS izni kapatılınca geri açmanın yolu yok. Öneri: SMS için "aç" düğmesi eklensin.
- **Onayınız:** cihaz kodu SMS'i artık SMS izni reddedilmiş ya da kapatılmış olsa da gidiyor; yalnızca STOP ile çıkmış numaraya gitmiyor. Gerekçe: kişi kodu kendisi istiyor. Öneri: kabul.
- Yeni ES/TR metinler (saha Ayarlar, iki panel bildirimi) Q63 okumasına eklendi. Ayarlar için tasarım ekranı yok; spec §9.3'e göre yapıldı.

**W2-03 bitti (c7f8d59):** Geçmiş raporlar (son 14 gün, şantiyeye göre) ve tek rapor görünümü eklendi. Süresi dolmuş link ekranında "Bana bugünün linkini gönder" düğmesi var. 5 yanlış kod girilirse telefon kilitleniyor ve ofise bir bildirim gidiyor. İki şantiyesi olan kişi şantiye değiştirebiliyor. Yeni migration: `20261016000020`.

- **Q87 (onaylandı 2026-10-16):** "Bana bugünün linkini gönder" düğmesi ne zaman ve ne göndersin? Öneri ve yapılan: aynı şantiyenin bugünkü linki, süresi dolmuş her link için günde bir kez. Şantiye durdurulmuşsa ya da bugün iş günü değilse link gitmiyor, nedeni ekranda gösteriliyor.
- **Q88 (onaylandı 2026-10-16):** Geçmiş raporlara nereden girilsin? Öneri ve yapılan: Bugün ekranının altındaki bir link; W2-04'te Filed ekranına da eklenecek.

**W2-04 bitti (1a7f0e0):** Filed ekranından "Daha fazla fotoğraf ekle" yapılabiliyor (en fazla 4 fotoğraf, ertesi gün 23:59'a kadar, isteğe bağlı sesli açıklamayla). Eklenen fotoğraflar raporun yeni sürümünü (v2) oluşturuyor: yeni PDF ve "güncellendi" e-postası gidiyor, eski sürüme dokunulmuyor. Ekranda ayrıca "Geçmiş raporlar" linki ve düzenleme ipucu var. Yeni migration: `20261016000030`.

- **Q89 (onaylandı 2026-10-16):** web'den dosyalanan rapora bu süre içinde fotoğraf eklenebilsin mi? Kişisel link de olsa günlük link de olsa geçerli olsun mu? Öneri ve yapılan: evet, ikisi için de (ayar: `FILED_PHOTOS_ON_WEB_LINKS`).
- Tasarımla bir fark var: tasarımdaki buton "Add photos", spec'te "Add more photos" yazıyor. Spec'teki kullanıldı.

**W2-05 ve W2-06 bitti (e81dd56, 62a411c):** hatırlatma merdiveni yeniden çalışıyor, artık SMS ile ve Notifier üzerinden. Sırası: 17:00 günün linki, ardından ön uyarı, R1 ve R2. Rapor dosyalanınca sonraki hatırlatmalar duruyor. Her adım bir kez çalışıyor ve gönderimden hemen önce yeniden kontrol ediliyor. Yaz saati geçişleri test edildi. Denetim listesindeki 6 hatırlatma bulgusu kapandı. Yeni migration: `20261016000040`.

- Q76 ve Q77 önerdiğim varsayımla kuruldu, cevabınızı bekliyor.
- **Q90 (onaylandı 2026-10-16):** bir şantiyede yedek kişi varsa hatırlatmaları kim alsın? Öneri ve yapılan: şantiyenin tüm aktif kişileri, önce asıl kişi.
- Hava durumu cümlesinin ES/TR metni Q63 okumasına eklendi.

**W2-07 ve W2-08 bitti (330c567, 13ef494):**

- **Zaman aşımları (W2-07):** web'de cevaplanmayan soru 60 dakika sonra taslağa işaretli olarak geçiyor. Onaylanmayan taslak için 30. dakikada bir hatırlatma gidiyor, 2 saatte otomatik dosyalanıyor. Kişi taslaktan hemen çıkarsa 30 saniye sonra "taslak hazır" mesajı gidiyor.
- **İş yok / Hava (W2-08):** bunlar artık rapor olarak kaydediliyor. Kayıp saat kodda hesaplanıyor ve sıradaki hatırlatmalar duruyor. Yeni migration: `20261016000050`.
- **CI düzeltmeleri:** hatırlatma testinin iki hatası giderildi (cbeb5a1, 5d1f9f6). Worker CI'da artık test saatini kullanıyor; production'da bu ayar reddediliyor.
- Q78 ve Q79 önerilen varsayımla kuruldu, cevabınızı bekliyor.
- **Q91 (onaylandı 2026-10-16):** plan "kayıp saat = işçi × kaybedilen saat" diyor, spec ise yalnızca durulan saat diyor. Ayrıca 12 işçi × 8,5 saat veritabanı alanına sığmıyor. Öneri ve yapılan: kayıp saat = durulan saat; ekip-saati kaybı özete yazılıyor.

**W2-09 ve W2-13 bitti (952689a, a765eef), test verisiyle:**

- **"Diğer…" cevabı (W2-09):** soruya sesle ya da sayı yazarak cevap verilebiliyor. Cevap anlaşılmazsa bir kez daha soruluyor, ikinci seferde soru cevapsız olarak işaretleniyor.
- **Test kaydı (W2-13):** uygulama ilk açıldığında kısa bir test kaydı alınıyor. Duyulan metin kişiye bir kez gösteriliyor, sonra kayıt silinip iz bırakılmıyor.
- **Anahtar gerekiyor:** gerçek denemeler için `ANTHROPIC_API_KEY` ve `DEEPGRAM_API_KEY` lazım.
- **Q92 (onaylandı 2026-10-16):** sayı içermeyen bir cevap gelirse (ör. "dünküyle aynı") ne olsun? Şimdilik bir kez daha soruluyor, sonra işaretleniyor.
- **Q93:** panelde cevap kaydı kaynak olarak görünüyor ama henüz dinlenemiyor.
- Yeni ES/TR metinler Q63 okumasına eklendi.

**Sizin yapmanız gerekenler (hafta 2, acele değil ama uzun sürüyor):**

- Twilio WhatsApp göndericisi + Meta doğrulaması + EN/ES/TR şablonlar (en uzun bekleme süresi bu).
- Web push için VAPID anahtarları (preview projesine secret olarak).
- Tasarım tuvalinden eksik ekranlar (Geçmiş raporlar, Ayarlar, Süresi dolmuş link) ya da "spec §9.3 yeterli" onayı.
