import { useId } from 'react';
import { formatDate } from '@sitelog/shared/format.ts';
import { useFieldCopy } from '@/i18n/useFieldCopy';
import { sendingErrorKey } from '@/lib/sendingErrors';
import { failedKind } from '@/queue/types';
import { useQueue, useQueueSnapshot } from '@/queue/useQueue';
import { QuietButton, SolidButton } from './Buttons';
import { Sheet } from './Sheet';

/**
 * The refused clips and photos (the offline banner's Review): each with what it is, the day and
 * why field-api refused it. *Try again* only where a tap can help (the office may have acted);
 * the refusals a new pass through the link clears go by themselves once the reporter opens it;
 * *Remove* deletes it from the phone, the only way one ever leaves without being sent.
 */
export function FailedSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t, language } = useFieldCopy();
  const queue = useQueue();
  const snapshot = useQueueSnapshot();
  const titleId = useId();
  const failed = snapshot.items.filter((i) => i.status === 'failed');
  return (
    <Sheet open={open} titleId={titleId} onClose={onClose}>
      <h2 id={titleId} className="m-0 text-[22px] leading-7 font-extrabold [font-stretch:118%]">
        {t('offline.sheetTitle')}
      </h2>
      <ul className="m-0 flex list-none flex-col gap-4 p-0">
        {failed.map((item) => {
          const label = t(item.kind === 'audio' ? 'offline.voiceNote' : 'offline.photo', {
            date: formatDate(item.date, 'weekdayMonthDay', language),
          });
          return (
            <li key={item.id} className="flex flex-col gap-2 border-b border-rebar pb-4">
              <b className="text-[16px]">{label}</b>
              <p className="m-0 text-[15px] leading-5 text-steel">
                {t(sendingErrorKey(item.error))}
              </p>
              <div className="flex gap-2">
                {failedKind(item.error) === 'retry' ? (
                  <SolidButton onClick={() => void queue.retry(item.id)} className="flex-1">
                    {t('sending.retry')}
                    <span className="sr-only">: {label}</span>
                  </SolidButton>
                ) : null}
                <QuietButton onClick={() => void queue.remove(item.id)} className="flex-1">
                  {t('offline.remove')}
                  <span className="sr-only">: {label}</span>
                </QuietButton>
              </div>
            </li>
          );
        })}
      </ul>
    </Sheet>
  );
}
