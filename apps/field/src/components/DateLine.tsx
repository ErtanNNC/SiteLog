import { formatDate, formatDateInTz } from '@sitelog/shared/format.ts';
import { useFieldCopy } from '@/i18n/useFieldCopy';
import { deviceTimeZone } from '@/lib/time';

/**
 * The date line under the top bar (Field-03 "FRI, OCT 9 · DUE 17:30", Field-10 "CUMA, 9 EKİM · SON
 * SAAT 17:30"): today in `todayEyebrow` style, in the app's language. The deadline and the status
 * chip join it on the Today screen (W1-09), when field-api tells us the site.
 */
export function DateLine({ timeZone = deviceTimeZone() }: { timeZone?: string }) {
  const { language } = useFieldCopy();
  const today = formatDateInTz(new Date(), timeZone);
  return (
    <p className="m-0 font-mono text-[13px] leading-5 tracking-[0.04em] text-steel">
      <time dateTime={today}>{formatDate(today, 'todayEyebrow', language)}</time>
    </p>
  );
}
