import type { PanelCopyTree, UiResources } from './types.ts';

/** UI copy, Turkish (D9 skeleton). Formal "siz", no exclamation marks (§9.7). */
export const uiTr: UiResources & { panel: PanelCopyTree } = {
  common: {
    appName: 'SiteLog',
    language: 'Dil',
    languageNames: { en: 'English', es: 'Español', tr: 'Türkçe' },
    loading: 'Yükleniyor…',
    retry: 'Tekrar deneyin',
    errorTitle: 'Bir sorun oluştu',
  },
  /**
   * The panel's Turkish, keyed by the paths of `apps/web/src/copy/en.ts` (the panel's English, D9).
   * Only the shell keys W1-03 needs so far; `apps/web/src/copy/tr-keys.test.ts` checks that every
   * key here is a string in that file.
   */
  panel: {
    nav: {
      devPhone: 'Demo telefon',
    },
    shell: {
      footer: {
        agentReady: 'Asistan hazır · mesaj ve arama',
      },
    },
    settings: {
      tabs: {
        fieldChannels: 'Saha kanalları',
      },
    },
    states: {
      comingNextTitle: 'Yakında',
      comingNext: 'Bu sayfa hazırlanıyor. Kabuk, veri katmanı ve gezinme zaten çalışıyor.',
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
