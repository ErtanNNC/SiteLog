import type { UiResources } from './types.ts';

/**
 * UI copy, Spanish (D9 skeleton): the field app only (the panel is EN/TR), so `common` and
 * `field`. Latin American Spanish, formal "usted", as in the SMS copy.
 */
export const uiEs: UiResources = {
  common: {
    appName: 'SiteLog',
    language: 'Idioma',
    languageNames: { en: 'English', es: 'Español', tr: 'Türkçe' },
    loading: 'Cargando…',
    retry: 'Intente de nuevo',
    errorTitle: 'Algo salió mal',
  },
  field: {
    routes: {
      link: 'Abriendo su enlace…',
      today: 'Hoy',
      record: 'Grabar',
      report: 'Reporte',
      history: 'Reportes anteriores',
      settings: 'Configuración',
      expired: 'Enlace vencido',
    },
    placeholderBody: 'Esta pantalla llega pronto.',
    notFound: {
      title: 'Página no encontrada',
      body: 'Esa página no existe o el enlace está mal escrito.',
      action: 'Ir a Hoy',
    },
  },
};
