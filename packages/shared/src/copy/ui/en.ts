/**
 * UI copy, English (D9 skeleton). i18next resources by namespace: `common` (both apps) and `field`
 * (field app, EN/ES/TR). Interpolation uses i18next's `{{name}}`. This is the source of the key
 * structure for those two namespaces: `tr.ts` and `es.ts` must have the same keys.
 *
 * Only the keys the W1-04 field placeholders need. The panel has no English here: its English is
 * `apps/web/src/copy/en.ts`, which W1-03 serves as the `panel` EN resource, so new panel strings
 * go there (CLAUDE.md) and only their Turkish lives in `tr.ts`.
 */
export const uiEn = {
  common: {
    appName: 'SiteLog',
    language: 'Language',
    /** Endonyms: each language is named in itself, whatever the UI language. */
    languageNames: { en: 'English', es: 'Español', tr: 'Türkçe' },
    loading: 'Loading…',
    retry: 'Try again',
    errorTitle: 'Something went wrong',
  },
  field: {
    /** §9.3 routes, as placeholder titles. */
    routes: {
      link: 'Opening your link…',
      today: 'Today',
      record: 'Record',
      report: 'Report',
      history: 'Past reports',
      settings: 'Settings',
      expired: 'Link expired',
    },
    placeholderBody: 'This screen is coming next.',
  },
} as const;
