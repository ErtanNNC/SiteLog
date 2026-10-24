import { UI_RESOURCES, type UiKey } from '@sitelog/shared/copy/ui/index.ts';

/** The refusals `field.sending.errors` explains; anything else reads `generic`. */
const KNOWN = new Set(Object.keys(UI_RESOURCES.en.field.sending.errors));

/** The copy key that says why a clip or photo was not sent (the Recording screen, the review sheet). */
export function sendingErrorKey(error: string | null): UiKey<'field'> {
  const key = error && KNOWN.has(error) ? error : 'generic';
  return `sending.errors.${key}` as UiKey<'field'>;
}
