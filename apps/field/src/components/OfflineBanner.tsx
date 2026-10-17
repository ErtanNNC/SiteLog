import { useState } from 'react';
import { useQueueSnapshot } from '@/queue/useQueue';
import { useFieldCopy } from '@/i18n/useFieldCopy';
import { useOnline } from '@/lib/online';
import { FailedSheet } from './FailedSheet';

/**
 * §9.3 "Expired / offline": the banner when the phone has no signal, with the number of
 * recordings waiting to be sent (the queue keeps them through reloads), the ones the phone could
 * not store (keep the app open), and the ones field-api refused, kept on the phone until the
 * reporter reviews them: each with its reason, Try again where that can help, and Remove.
 */
export function OfflineBanner({ showFailed = true }: { showFailed?: boolean } = {}) {
  const { t } = useFieldCopy();
  const online = useOnline();
  const snapshot = useQueueSnapshot();
  const [reviewing, setReviewing] = useState(false);
  const pending = snapshot.pending;
  const unsaved = snapshot.unsaved;
  // A screen that already shows its refusal (Recording) leaves the list out here.
  const failed = showFailed ? snapshot.failed : 0;
  // The last refused item removed or sent: the list closes, and a later refusal does not reopen it.
  if (reviewing && failed === 0) setReviewing(false);
  if (online && pending === 0 && failed === 0 && unsaved === 0) return null;
  return (
    <div
      role="status"
      className="-mx-[18px] -mt-[18px] mb-1 flex flex-col gap-0.5 border-b border-rebar bg-concrete px-[18px] py-2 text-[14px] leading-5 text-steel"
    >
      {!online ? <span>{t('offline.banner')}</span> : null}
      {pending > 0 ? (
        <span className="font-mono">{t('offline.queued', { count: pending })}</span>
      ) : null}
      {unsaved > 0 ? <span>{t('offline.unsaved')}</span> : null}
      {failed > 0 ? (
        <span className="flex items-center justify-between gap-3">
          <span className="font-mono">{t('offline.failed', { count: failed })}</span>
          <button
            type="button"
            onClick={() => setReviewing(true)}
            className="flex h-target min-w-target flex-none items-center justify-center rounded-btn border border-rebar bg-white px-4 text-[15px] font-semibold text-asphalt"
          >
            {t('offline.review')}
          </button>
        </span>
      ) : null}
      <FailedSheet open={reviewing} onClose={() => setReviewing(false)} />
    </div>
  );
}
