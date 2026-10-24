import type { LegalDoc } from './index.ts';

/**
 * W4-06: the test-only legal texts that prove the `/legal/<key>` path, the recording notice by key
 * and the pack check before counsel's texts exist (spec §19 Q28, Q50; plan W4-06 "a test-only key
 * proves the path"). Country `ZZ` is ISO 3166's user-assigned code: no pack is ever `ZZ`, and every
 * entry is `status: 'placeholder'`, which the pack check refuses (`packCopyGaps`), so no real pack
 * can name one. The words say they are placeholders: none of this is legal wording.
 *
 * Counsel's approved texts replace nothing here: they are new entries in `docs.ts`, shipped with the
 * data migration that fills the pack's `legal_keys` (W4-13, §19 Q50).
 */
const EFFECTIVE = '2026-10-17';

export const PLACEHOLDER_LEGAL_DOCS: readonly LegalDoc[] = [
  {
    key: 'ZZ.privacy_notice.v1',
    effective: EFFECTIVE,
    status: 'placeholder',
    texts: {
      en: {
        title: 'Privacy notice (placeholder)',
        body: [
          'Placeholder text pending counsel. This page will show the privacy notice counsel approves for this country.',
          'It is not a legal text. It is here only to test the page.',
        ],
      },
      es: {
        title: 'Aviso de privacidad (provisional)',
        body: [
          'Texto provisional, pendiente del abogado. Esta página mostrará el aviso de privacidad que apruebe el abogado para este país.',
          'No es un texto legal. Solo está aquí para probar la página.',
        ],
      },
      tr: {
        title: 'Aydınlatma metni (yer tutucu)',
        body: [
          'Avukat onayı bekleyen yer tutucu metin. Bu sayfada, avukatın bu ülke için onayladığı aydınlatma metni gösterilecek.',
          'Bu bir hukuki metin değildir. Yalnızca sayfayı test etmek için buradadır.',
        ],
      },
    },
  },
  {
    key: 'ZZ.recording_notice.v1',
    effective: EFFECTIVE,
    status: 'placeholder',
    texts: {
      en: {
        title: 'Recording notice (placeholder)',
        body: [
          'Placeholder text pending counsel. This page will show the recording notice counsel approves for this country.',
          'It is not a legal text. It is here only to test the page and the call.',
        ],
        spoken: 'Placeholder recording notice, pending counsel.',
      },
      es: {
        title: 'Aviso de grabación (provisional)',
        body: [
          'Texto provisional, pendiente del abogado. Esta página mostrará el aviso de grabación que apruebe el abogado para este país.',
          'No es un texto legal. Solo está aquí para probar la página y la llamada.',
        ],
        spoken: 'Aviso de grabación provisional, pendiente del abogado.',
      },
      tr: {
        title: 'Kayıt bildirimi (yer tutucu)',
        body: [
          'Avukat onayı bekleyen yer tutucu metin. Bu sayfada, avukatın bu ülke için onayladığı kayıt bildirimi gösterilecek.',
          'Bu bir hukuki metin değildir. Yalnızca sayfayı ve aramayı test etmek için buradadır.',
        ],
        spoken: 'Avukat onayı bekleyen yer tutucu kayıt bildirimi.',
      },
    },
  },
  {
    key: 'ZZ.consent.v1',
    effective: EFFECTIVE,
    status: 'placeholder',
    texts: {
      en: {
        title: 'Consent wording (placeholder)',
        body: [
          'Placeholder text pending counsel. This page will show the consent wording counsel approves for this country.',
          'It is not a legal text. It is here only to test the page.',
        ],
      },
      es: {
        title: 'Texto del consentimiento (provisional)',
        body: [
          'Texto provisional, pendiente del abogado. Esta página mostrará el texto del consentimiento que apruebe el abogado para este país.',
          'No es un texto legal. Solo está aquí para probar la página.',
        ],
      },
      tr: {
        title: 'Açık rıza metni (yer tutucu)',
        body: [
          'Avukat onayı bekleyen yer tutucu metin. Bu sayfada, avukatın bu ülke için onayladığı açık rıza metni gösterilecek.',
          'Bu bir hukuki metin değildir. Yalnızca sayfayı test etmek için buradadır.',
        ],
      },
    },
  },
];
