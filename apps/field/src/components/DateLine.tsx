import { formatDate, formatDateInTz } from '@sitelog/shared/format.ts';
import { useFieldCopy } from '@/i18n/useFieldCopy';
import { deviceTimeZone } from '@/lib/time';

/**
 * The date line under the top bar (Field-03 "FRI, OCT 9 · DUE 17:30", Field-10 "CUMA, 9 EKİM · SON
 * SAAT 17:30"): a date in `todayEyebrow` style, in the app's language, and on Today the deadline
 * in the site's time zone (`due`, already formatted). Without `date`, today in `timeZone`.
 */
export function DateLine({
  date,
  timeZone = deviceTimeZone(),
  due,
}: {
  date?: string;
  timeZone?: string;
  due?: string;
}) {
  const { t, language } = useFieldCopy();
  const day = date ?? formatDateInTz(new Date(), timeZone);
  return (
    <p className="m-0 font-mono text-[13px] leading-5 tracking-[0.04em] text-steel">
      <time dateTime={day}>{formatDate(day, 'todayEyebrow', language)}</time>
      {due ? <span> · {t('today.due', { time: due })}</span> : null}
    </p>
  );
}
