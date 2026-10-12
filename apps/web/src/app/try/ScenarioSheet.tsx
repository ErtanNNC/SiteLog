import { Keyboard, Mic } from 'lucide-react';
import { formatDuration, formatMonthDay } from '@sitelog/shared/format.ts';
import { Button } from '@/components/ui/Button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/Dialog';
import { copy } from '@/copy/en';
import type { DemoStore } from '@/data/demo/store';
import { cn } from '@/lib/utils';
import { SCENARIOS, type Scenario, type ScenarioId } from './scenarios';

const t = copy.try;

function who(store: DemoStore, sc: Scenario) {
  const site = store.data.sites.find((s) => s.project_code === sc.siteCode);
  const link = store.data.siteReporters.find((x) => x.site_id === site?.id && x.is_primary);
  const reporter = store.data.reporters.find((r) => r.id === link?.reporter_id);
  return { site, reporter };
}

/** "Send voice note": the recorded cases, each tied to its Kestrel site and site manager. */
export function ScenarioSheet({
  open,
  onOpenChange,
  store,
  currentId,
  currentReporterId,
  unfinishedSite,
  onPick,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  store: DemoStore;
  currentId: ScenarioId;
  currentReporterId: string;
  /** The current chat's site when its report is started but not filed (switching clears it). */
  unfinishedSite: string | null;
  onPick: (id: ScenarioId) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100dvh-32px)] max-w-2xl overflow-hidden p-0">
        <DialogHeader className="px-5 pb-3 pt-5 sm:px-6">
          <DialogTitle>{t.sheet.title}</DialogTitle>
          <DialogDescription>{t.sheet.description}</DialogDescription>
        </DialogHeader>
        <ul className="min-h-0 flex-1 space-y-2 overflow-y-auto px-5 pb-5 scrollbar-thin sm:px-6">
          {SCENARIOS.map((sc) => {
            const { site, reporter } = who(store, sc);
            if (!site || !reporter) return null;
            const day = store.fieldDay(site.id);
            const meta = [
              site.name,
              reporter.name,
              sc.kind === 'voice' ? formatDuration(sc.durationS ?? 0) : t.sheet.typed,
              t.sheet.languages(sc.languages),
            ].join(' · ');
            const label = t.scenarios[sc.id]?.title ?? sc.id;
            const isCurrent = sc.id === currentId;
            return (
              <li
                key={sc.id}
                className={cn(
                  'rounded-card border bg-chalk p-3',
                  isCurrent ? 'border-asphalt' : 'border-rebar',
                )}
                data-scenario={sc.id}
              >
                <div className="flex items-start gap-3">
                  <span
                    className="mt-0.5 inline-flex size-8 shrink-0 items-center justify-center rounded-full bg-concrete"
                    aria-hidden="true"
                  >
                    {sc.kind === 'voice' ? (
                      <Mic className="size-4" />
                    ) : (
                      <Keyboard className="size-4" />
                    )}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <span className="font-semibold">{label}</span>
                      <span className="rounded-chip border border-rebar px-1.5 font-mono text-[12px] uppercase tracking-[0.06em] text-dust">
                        {t.sheet.outcomes[sc.outcome]}
                      </span>
                      {isCurrent ? (
                        <span className="font-mono text-[12px] uppercase tracking-[0.06em] text-dust">
                          {t.sheet.current}
                        </span>
                      ) : null}
                    </div>
                    <p className="mt-0.5 text-caption text-dust">{meta}</p>
                    <p className="mt-1 text-[14px] leading-5">{t.scenarios[sc.id]?.shows}</p>
                    <p className="mt-1 text-caption text-dust">
                      {t.sheet.recordedOn(formatMonthDay(sc.recordedOn))}
                      {' · '}
                      {day.needsReset
                        ? t.sheet.replaces(site.name, day.reportNo)
                        : t.sheet.fresh(site.name)}
                      {reporter.id !== currentReporterId
                        ? ` ${t.sheet.switches(reporter.name)}.`
                        : ''}
                      {unfinishedSite ? ` ${t.sheet.clearsUnfinished(unfinishedSite)}` : ''}
                    </p>
                  </div>
                  <Button
                    variant={isCurrent ? 'primary' : 'ghost'}
                    size="dense"
                    className="min-h-[44px]"
                    onClick={() => onPick(sc.id)}
                    aria-label={t.sheet.sendLabel(label)}
                  >
                    {t.sheet.send}
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      </DialogContent>
    </Dialog>
  );
}
