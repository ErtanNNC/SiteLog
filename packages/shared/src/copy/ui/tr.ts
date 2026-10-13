import type { PanelCopyTree, UiResources } from './types.ts';

/** UI copy, Turkish (D9). Sentences use the formal "siz", no exclamation marks (§9.7). */
export const uiTr: UiResources & { panel: PanelCopyTree } = {
  common: {
    appName: 'SiteLog',
    language: 'Dil',
    languageNames: { en: 'English', es: 'Español', tr: 'Türkçe' },
    loading: 'Yükleniyor…',
    retry: 'Tekrar dene',
    errorTitle: 'Bir sorun oluştu',
  },
  /**
   * The panel's Turkish, keyed by the paths of `apps/web/src/copy/en.ts` (the panel's English, D9):
   * the shell, sign-in and the global states (W1-03). `apps/web/src/copy/tr-keys.test.ts` checks
   * every key against that file. A counted English phrase (`activeSites_one` / `_other`) has one
   * Turkish key without the suffix: Turkish keeps the noun singular after a number. Buttons and
   * menu items are short imperatives ("Çıkış yap"); sentences address the reader as "siz".
   */
  panel: {
    app: {
      name: 'SiteLog',
      tagline: 'Anlatın. Kayda geçsin.',
      skipToContent: 'İçeriğe geç',
    },
    nav: {
      overview: 'Genel bakış',
      sites: 'Şantiyeler',
      reports: 'Raporlar',
      hours: 'Puantaj',
      weather: 'Hava ve gecikmeler',
      setupLabel: 'Kurulum',
      team: 'Ekip ve numaralar',
      glossary: 'Şantiye sözlüğü',
      settings: 'Ayarlar',
      billing: 'Faturalandırma',
      try: 'WhatsApp demosu',
      devPhone: 'Demo telefon',
      badges: {
        reportsToReview: '{{count}} rapor inceleme bekliyor',
        unknownSenders: '{{count}} bilinmeyen numara',
        termsToReview: '{{count}} terim inceleme bekliyor',
      },
      openMenu: 'Menüyü aç',
      closeMenu: 'Menüyü kapat',
      mainNavigation: 'Ana gezinme',
    },
    shell: {
      orgSwitcher: {
        label: 'Şirket değiştir',
        activeSites: '{{count}} aktif şantiye',
        currentOrg: 'Geçerli şirket',
        otherOrgs: 'Şirketleriniz',
      },
      search: {
        placeholder: 'Rapor, şantiye veya taşeron arayın',
        label: 'Arama',
        clear: 'Aramayı temizle',
        noResults: '“{{query}}” için sonuç bulunamadı.',
        hint: 'En az 2 karakter yazın',
        groups: {
          report: 'Raporlar',
          site: 'Şantiyeler',
          company: 'Firmalar',
          transcript: 'Konuşma dökümleri',
          reporter: 'Rapor verenler',
          term: 'Sözlük',
        },
      },
      notifications: {
        label: 'Bildirimler',
        unread: '{{count}} yeni',
        title: 'Bildirimler',
        empty: 'Yeni bir şey yok. Raporlar ve uyarılar burada görünecek.',
        markAllRead: 'Tümünü okundu işaretle',
      },
      footer: {
        agentReady: 'Asistan hazır · mesaj ve arama',
        sitelogNumbers: 'SiteLog numaraları',
        profile: 'Profil',
        signOut: 'Çıkış yap',
        userMenu: 'Hesap menüsü',
      },
      demo: {
        chip: 'Demo',
        chipTitle: 'Demo modu: bellekteki örnek veriler, hiçbir şey kaydedilmez',
        menuTitle: 'Demo kontrolleri',
        simulate: 'Rapor simüle et',
        simulateHint: 'Elm St. geç bir rapor gönderir',
        simulated: 'Priya’nın raporu geldi. Elm St. raporu geç kaydedildi.',
        alreadyFiled: 'Elm St. bugünkü raporunu zaten gönderdi.',
        resetHint: 'Verileri sıfırlamak için çıkış yapıp yeniden giriş yapın',
        switchUser: 'Demo kullanıcısını değiştir',
        users: {
          admin: 'Lena Ortiz · yönetici',
          pm: 'Sam Kowalski · proje müdürü',
          ops: 'Ravi Patel · operasyon',
          accounts: 'Muhasebe · bordro',
        },
      },
      offline: 'Çevrimdışısınız. Bağlantı gelince değişiklikler yeniden gönderilecek.',
      backOnline: 'Yeniden çevrimiçisiniz.',
    },
    common: {
      loading: 'Yükleniyor…',
    },
    team: {
      officeRoles: {
        admin: 'Yönetici',
        pm: 'Proje müdürü',
        ops: 'Operasyon',
        accounts: 'Muhasebe',
      },
    },
    settings: {
      tabs: {
        fieldChannels: 'Saha kanalları',
      },
    },
    states: {
      error: '{{thing}} yüklenemedi.',
      errorId: 'Hata kimliği {{id}}',
      retry: 'Tekrar dene',
      noAccessTitle: 'Erişim yok',
      noAccess: '{{page}} sayfasına erişiminiz yok. Bir yöneticiye danışın.',
      goToHours: 'Puantaja git',
      goHome: 'Genel bakışa git',
      notFoundTitle: 'Sayfa bulunamadı',
      notFound: 'Bu sayfa yok ya da link yanlış yazılmış.',
      comingNextTitle: 'Yakında',
      comingNext: 'Bu sayfa hazırlanıyor, yakında kullanıma açılacak.',
    },
    a11y: {
      searchResults: 'Arama sonuçları',
      loadingPage: 'Sayfa yükleniyor',
    },
    login: {
      headline: 'Gün sonu raporları, üç dakikada anlatılır.',
      bullets: {
        link: 'Şantiye şefleri mesajdaki linke dokunur ya da aramayı yanıtlar; kurulacak bir şey yok.',
        pdf: 'Günlük şantiye raporu düzgün bir PDF olarak buraya gelir, dosyalanmaya hazır.',
        trace:
          'Taşeron saatleri ve hava kaynaklı gecikmeler; her biri ses kaydına kadar izlenebilir.',
      },
      tagline: 'Anlatın. Kayda geçsin.',
      title: 'Ofis paneline giriş yapın',
      subtitle:
        'Size e-postayla tek kullanımlık bir link göndereceğiz. Hatırlamanız gereken bir şifre yok.',
      emailLabel: 'İş e-postası',
      emailPlaceholder: 'ad@sirket.com',
      emailInvalid: 'Geçerli bir iş e-postası girin.',
      submit: 'Bana giriş linki gönder',
      sending: 'Gönderiliyor…',
      or: 'veya',
      sso: 'Kurumsal SSO ile devam et',
      ssoSoon: 'Yakında',
      managersNoteLead: 'Şantiye şefleri giriş yapmaz.',
      managersNote: 'Mesajdaki link ya da telefon aramasıyla rapor verirler.',
      footer: 'Yeni misiniz?',
      footerCta: 'Şirket hesabınızı açın',
      footerSuffix: '— kurulum ücreti yok.',
      sentTitle: 'Gelen kutunuza bakın',
      sent: '{{email}} adresine bir giriş linki gönderdik. Link 1 saat geçerli.',
      resend: 'Linki yeniden gönder',
      resendIn: '{{seconds}} sn sonra yeniden gönder',
      useAnother: 'Başka bir e-posta kullan',
      expired: 'Bu linkin süresi doldu. Aşağıdan yenisini isteyin.',
      authError: 'Giriş yapılamadı. Tekrar deneyin.',
      rateLimited: 'Çok fazla giriş e-postası istendi. Bir dakika bekleyip tekrar deneyin.',
      demoHint:
        'Demo modu: hangi e-postayı girerseniz girin Lena Ortiz (yönetici) olarak giriş yaparsınız.',
      demoHintAs: 'Demo modu: {{name}} olarak giriş yapacaksınız.',
      callbackTitle: 'Giriş yapılıyor…',
      callbackBody: 'Linkinizi kontrol ediyoruz, bir saniye.',
      accountThing: 'şirketleriniz',
      signOut: 'Çıkış yap',
    },
    errorBoundary: {
      title: 'Bir sorun oluştu',
      body: 'SiteLog beklenmeyen bir hatayla karşılaştı. Tekrar deneyin ya da çıkış yapıp yeniden giriş yapın.',
      retry: 'Tekrar dene',
      signOut: 'Çıkış yap',
      reported: 'SiteLog ekibine bildirildi.',
      errorId: 'Hata kimliği {{id}}',
    },
    devPhone: {
      subtitle:
        'SiteLog’un konsol sürücüsüyle gönderdiği tüm mesajlar; her rapor veren için ayrı bir konuşma.',
    },
  },
  field: {
    routes: {
      link: 'Linkiniz açılıyor…',
      today: 'Bugün',
      record: 'Kayıt',
      report: 'Rapor',
      history: 'Geçmiş raporlar',
      settings: 'Ayarlar',
      expired: 'Linkin süresi doldu',
    },
    placeholderBody: 'Bu ekran yakında geliyor.',
  },
};
