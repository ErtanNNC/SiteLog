import { useState } from 'react';
import { formatHoursIn, formatMonthYearIn } from '@sitelog/shared/format.ts';
import { PACK_SECTIONS } from '@sitelog/shared/report/evidence-pack.ts';
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
import { Input } from '@/components/ui/Input';
import { Label } from '@/components/ui/Label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/Select';
import { useRequestEvidencePack } from '@/data/hooks';
import type { DelayEntry, SiteOption } from '@/data/types';
import { useCopy } from '@/i18n/useCopy';
import { monthDaysRange } from './month';

const SECTIONS = PACK_SECTIONS;

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sites: SiteOption[];
  defaultSiteId: string | null;
  month: string;
  entries: DelayEntry[];
}

/**
 * The site preselected when the page is not filtered: the one with the most lost hours this month
 * (an extension claim is per project, so a pack is always for one site — F16 "choose site + period").
 */
function likeliestSite(sites: SiteOption[], entries: DelayEntry[]): string {
  const hours = new Map<string, number>();
  for (const e of entries) hours.set(e.siteId, (hours.get(e.siteId) ?? 0) + e.lostHours);
  const ranked = [...sites].sort((a, b) => (hours.get(b.id) ?? 0) - (hours.get(a.id) ?? 0));
  return ranked[0]?.id ?? '';
}

/**
 * "Build EOT evidence pack": site, period, included sections → requestEvidencePack (F20); the
 * worker prints only the ticked sections (W3-07). The parent keys it per open. EN/TR.
 */
export function PackDialog({ open, onOpenChange, sites, defaultSiteId, month, entries }: Props) {
  const { t, language } = useCopy();
  const request = useRequestEvidencePack();
  const range = monthDaysRange(month);
  const [siteId, setSiteId] = useState(() => defaultSiteId ?? likeliestSite(sites, entries));
  const [from, setFrom] = useState(range.start);
  const [to, setTo] = useState(range.end);
  const [sections, setSections] = useState<string[]>([...SECTIONS]);
  const [error, setError] = useState<string | null>(null);

  // The page has loaded this month's delays only, so a period reaching past it is summed for
  // this month and says so (the pack itself covers the whole period).
  const inScope = entries.filter((e) => e.siteId === siteId && e.date >= from && e.date <= to);
  const siteDays = new Set(inScope.map((e) => `${e.siteId}:${e.date}`)).size;
  const hours = inScope.reduce((a, e) => a + e.lostHours, 0);
  const pastMonth = from < range.start || to > range.end;

  const toggle = (key: string, on: boolean) =>
    setSections((prev) => (on ? [...prev, key] : prev.filter((k) => k !== key)));

  const submit = () => {
    if (!siteId) {
      setError(t('weather.packDialog.siteRequired'));
      return;
    }
    if (to < from) {
      setError(t('weather.packDialog.periodInvalid'));
      return;
    }
    if (sections.length === 0) {
      setError(t('weather.packDialog.sectionsRequired'));
      return;
    }
    setError(null);
    request.mutate(
      {
        siteId,
        periodStart: from,
        periodEnd: to,
        sections: SECTIONS.filter((s) => sections.includes(s)),
      },
      { onSuccess: () => onOpenChange(false) },
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('weather.pack.title')}</DialogTitle>
          <DialogDescription>{t('weather.packDialog.description')}</DialogDescription>
        </DialogHeader>
        <form
          className="mt-4 grid gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
          noValidate
        >
          <div className="grid gap-1.5">
            <Label htmlFor="pack-site">{t('weather.pack.site')}</Label>
            <Select value={siteId} onValueChange={setSiteId}>
              <SelectTrigger id="pack-site">
                <SelectValue placeholder={t('weather.packDialog.sitePlaceholder')} />
              </SelectTrigger>
              <SelectContent>
                {sites.map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    {s.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <fieldset className="grid gap-1.5">
            <legend className="text-caption font-medium">{t('weather.pack.period')}</legend>
            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-1">
                <Label htmlFor="pack-from" className="text-dust">
                  {t('weather.packDialog.from')}
                </Label>
                <Input
                  id="pack-from"
                  type="date"
                  value={from}
                  onChange={(e) => setFrom(e.target.value)}
                  className="font-mono"
                />
              </div>
              <div className="grid gap-1">
                <Label htmlFor="pack-to" className="text-dust">
                  {t('weather.packDialog.to')}
                </Label>
                <Input
                  id="pack-to"
                  type="date"
                  value={to}
                  onChange={(e) => setTo(e.target.value)}
                  className="font-mono"
                />
              </div>
            </div>
            <p className="font-mono text-[12px] text-dust" data-testid="pack-summary">
              {pastMonth
                ? t('weather.packDialog.summaryMonthOnly', {
                    month: formatMonthYearIn(month, language),
                    count: siteDays,
                    hours: formatHoursIn(hours, language),
                  })
                : t('weather.packDialog.summary', {
                    count: siteDays,
                    hours: formatHoursIn(hours, language),
                  })}
            </p>
          </fieldset>
          <fieldset className="grid gap-2">
            <legend className="text-caption font-medium">{t('weather.pack.sections')}</legend>
            {SECTIONS.map((key) => (
              <label key={key} className="flex min-h-target-dense items-center gap-3 text-[15px]">
                <Checkbox
                  checked={sections.includes(key)}
                  onCheckedChange={(v) => toggle(key, v === true)}
                  aria-label={t(`weather.pack.sectionNames.${key}`)}
                />
                {t(`weather.pack.sectionNames.${key}`)}
              </label>
            ))}
          </fieldset>
          {error ? (
            <p role="alert" className="text-caption font-medium text-missing">
              {error}
            </p>
          ) : null}
          <DialogFooter className="mt-2">
            <DialogClose asChild>
              <Button variant="ghost">{t('common.cancel')}</Button>
            </DialogClose>
            <Button type="submit" variant="primary" loading={request.isPending}>
              {t('weather.pack.generate')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
