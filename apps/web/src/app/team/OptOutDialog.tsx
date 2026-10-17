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
import { useClearReporterOptOut } from '@/data/hooks';
import type { TeamReporter } from '@/data/types';
import { useCopy } from '@/i18n/useCopy';

/**
 * Team → Turn texts back on (§19 Q242, W4-03): an admin, on a one-way pack, clears an opt-out the
 * phone company recorded, only with the attestation that the person asked for texts again
 * (`clear_reporter_opt_out()`: an `sms` consent `office_attested`, audited).
 */
export function OptOutDialog({
  reporter,
  onOpenChange,
}: {
  reporter: TeamReporter | null;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useCopy();
  const clear = useClearReporterOptOut();
  // The parent keys this dialog by reporter id, so the box starts unticked for each one.
  const [attested, setAttested] = useState(false);
  const first = firstName(reporter?.name ?? '');
  return (
    <Dialog open={!!reporter} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('team.optOutDialog.title', { name: reporter?.name ?? '' })}</DialogTitle>
          <DialogDescription>{t('team.optOutDialog.body', { first })}</DialogDescription>
        </DialogHeader>
        <label className="mt-4 flex min-h-target items-center gap-3 rounded-card border border-rebar bg-concrete/60 px-3 text-[15px] font-medium">
          <Checkbox checked={attested} onCheckedChange={(v) => setAttested(v === true)} />
          {t('team.optOutDialog.attest', { first })}
        </label>
        <DialogFooter className="mt-4">
          <DialogClose asChild>
            <Button variant="ghost">{t('common.cancel')}</Button>
          </DialogClose>
          <Button
            variant="primary"
            disabled={!attested}
            loading={clear.isPending}
            onClick={() => {
              if (!reporter) return;
              clear.mutate(
                { reporterId: reporter.id, name: reporter.name, attested },
                { onSuccess: () => onOpenChange(false) },
              );
            }}
          >
            {t('team.optOutDialog.confirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
