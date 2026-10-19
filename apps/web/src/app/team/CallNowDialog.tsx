import { Phone } from 'lucide-react';
import { useState } from 'react';
import { firstName } from '@sitelog/shared/format.ts';
import { Button } from '@/components/ui/Button';
import { Checkbox } from '@/components/ui/Checkbox';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/Dialog';
import { useOfficeCallNow } from '@/data/hooks';
import type { TeamReporter } from '@/data/types';
import { useCopy } from '@/i18n/useCopy';

/** Who and where Call now calls: the reporter and one of their sites. */
export interface CallNowTarget {
  reporter: TeamReporter;
  site: { id: string; name: string };
}

/**
 * Team → Call now (W4-04; spec F3 edge cases, P10, §19 Q230): the office attests that the person
 * agreed to get calls from TalkOlog for the daily report, then TalkOlog's assistant calls them about
 * today's report at the site (`office_call_start()`: an `auto_call` consent `office_attested`
 * with the office user, the call through the ladder's telephony). The box is required; unanswered,
 * nothing is texted, and the row shows how the call went.
 */
export function CallNowDialog({
  target,
  onOpenChange,
}: {
  target: CallNowTarget | null;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useCopy();
  const call = useOfficeCallNow();
  // The parent keys this dialog by reporter and site, so the box starts unticked for each.
  const [attested, setAttested] = useState(false);
  const name = target?.reporter.name ?? '';
  const first = firstName(name);
  return (
    <Dialog open={!!target} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('team.callNow.title', { name })}</DialogTitle>
          <DialogDescription>
            {t('team.callNow.body', { first, site: target?.site.name ?? '' })}
          </DialogDescription>
        </DialogHeader>
        <label className="mt-4 flex min-h-target items-center gap-3 rounded-card border border-rebar bg-concrete/60 px-3 py-2 text-[15px] font-medium">
          <Checkbox
            checked={attested}
            onCheckedChange={(v) => setAttested(v === true)}
            aria-describedby="call-now-attest-hint"
          />
          {t('team.callNow.attest', { first })}
        </label>
        <p id="call-now-attest-hint" className="mt-2 text-caption text-dust">
          {t('team.callNow.attestHint', { first })}
        </p>
        <p className="mt-1 text-caption text-dust">{t('team.callNow.noText', { first })}</p>
        <DialogFooter className="mt-4">
          <DialogClose asChild>
            <Button variant="ghost">{t('common.cancel')}</Button>
          </DialogClose>
          <Button
            variant="primary"
            disabled={!attested}
            loading={call.isPending}
            onClick={() => {
              if (!target) return;
              call.mutate(
                {
                  reporterId: target.reporter.id,
                  siteId: target.site.id,
                  attested,
                  name,
                },
                { onSuccess: () => onOpenChange(false) },
              );
            }}
          >
            <Phone aria-hidden="true" />
            {t('team.callNow.confirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
