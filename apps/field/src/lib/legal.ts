import { legalPagePath } from '@sitelog/shared/copy/legal/index.ts';

/**
 * Where the pack's privacy notice opens (F4 step 3, spec §19 Q28, Q50): the key is a versioned id
 * such as `US.privacy_notice.v1`, and the app's own `/legal/<key>` page shows its text from the
 * shared legal copy (W4-06). The Welcome screen shows the link only when the pack names a key.
 */
export function privacyNoticeHref(key: string): string {
  return legalPagePath(key);
}
