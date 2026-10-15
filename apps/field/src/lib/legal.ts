/**
 * Where the pack's privacy notice opens (F4 step 3, spec §19 Q28): the key is a versioned id such
 * as `US.privacy_notice.v1`, and no text or URL exists for one yet (both launch packs have `{}`),
 * so the link is shown only when a key is set and points at the app's own `/legal/<key>` path
 * until spec §19 Q50 decides where the texts live.
 */
export function privacyNoticeHref(key: string): string {
  return `/legal/${encodeURIComponent(key)}`;
}
