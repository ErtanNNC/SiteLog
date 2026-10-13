import { Camera } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import {
  formatDateInTz,
  formatDateShort,
  formatMonthDay,
  formatTimeInTz,
} from '@sitelog/shared/format.ts';
import { EmptyState } from '@/components/sitelog/States';
import { Button } from '@/components/ui/Button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/Card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/Dialog';
import { Label } from '@/components/ui/Label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/Select';
import { copy } from '@/copy/en';
import type { SitePhoto } from '@/data/types';
import { formatDateTimeShort } from '@/lib/format';
import { uniq } from '@/lib/utils';

/** Photos tab: grid with a date filter; click opens a lightbox with the caption and report link. */
export function PhotosTab({ photos, timezone }: { photos: SitePhoto[]; timezone: string }) {
  const [date, setDate] = useState<string>('all');
  const [open, setOpen] = useState<SitePhoto | null>(null);
  const dates = useMemo(() => uniq(photos.map((p) => p.date)).filter(Boolean), [photos]);
  const visible = date === 'all' ? photos : photos.filter((p) => p.date === date);

  // The time, or "Taken Oct 12 · 14:05" for a photo taken another day than its report's.
  const takenOf = (p: SitePhoto) =>
    p.takenAt && formatDateInTz(p.takenAt, timezone) !== p.date
      ? copy.report.photoCaption(formatDateTimeShort(p.takenAt, timezone))
      : p.takenAt
        ? formatTimeInTz(p.takenAt, timezone)
        : '';
  const captionOf = (p: SitePhoto) =>
    p.caption ??
    copy.siteDetail.photosTab.caption(
      formatMonthDay(p.date),
      p.takenAt ? formatTimeInTz(p.takenAt, timezone) : '',
    );

  return (
    <Card>
      <CardHeader className="flex-col gap-3 md:flex-row md:items-center">
        <CardTitle>{copy.siteDetail.photosTab.title(visible.length)}</CardTitle>
        <div className="flex items-center gap-2">
          <Label htmlFor="photo-date" className="eyebrow text-dust">
            {copy.siteDetail.photosTab.dateFilter}
          </Label>
          <Select value={date} onValueChange={setDate}>
            <SelectTrigger id="photo-date" dense className="w-48">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{copy.siteDetail.photosTab.allDates}</SelectItem>
              {dates.map((d) => (
                <SelectItem key={d} value={d}>
                  {formatDateShort(d)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </CardHeader>
      <CardContent className="pt-3">
        {visible.length === 0 ? (
          <EmptyState icon={Camera} title={copy.siteDetail.photosTab.empty} />
        ) : (
          <ul
            className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(160px,1fr))]"
            aria-label={copy.siteDetail.tabs.photos}
          >
            {visible.map((p) => (
              <li key={p.messageId}>
                <button
                  type="button"
                  onClick={() => setOpen(p)}
                  aria-label={copy.siteDetail.photosTab.open(captionOf(p))}
                  className="group block w-full overflow-hidden rounded-card border border-rebar bg-concrete text-left hover:border-iron"
                >
                  <PhotoFrame photo={p} alt="" className="aspect-[4/3]" />
                  <span className="block px-2.5 py-2">
                    <span className="block truncate text-caption font-medium text-asphalt">
                      {captionOf(p)}
                    </span>
                    <span className="block font-mono text-[11px] uppercase tracking-[0.08em] text-dust">
                      {formatMonthDay(p.date)}
                      {p.takenAt ? ` · ${takenOf(p)}` : ''}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </CardContent>

      <Dialog open={!!open} onOpenChange={(o) => !o && setOpen(null)}>
        <DialogContent className="max-w-3xl p-0">
          {open ? (
            <>
              <PhotoFrame
                photo={open}
                alt={captionOf(open)}
                className="aspect-[4/3] rounded-t-card"
              />
              <div className="p-5">
                <DialogHeader>
                  <DialogTitle>{captionOf(open)}</DialogTitle>
                  <DialogDescription>
                    {formatDateShort(open.date)}
                    {open.takenAt ? ` · ${takenOf(open)}` : ''} ·{' '}
                    <span className="font-mono">{open.reportNo}</span>
                  </DialogDescription>
                </DialogHeader>
                <div className="mt-4">
                  <Button variant="secondary" size="dense" asChild>
                    <Link to={`/reports/${open.reportId}`}>
                      {copy.siteDetail.photosTab.openReport(open.reportNo)}
                    </Link>
                  </Button>
                </div>
              </div>
            </>
          ) : null}
        </DialogContent>
      </Dialog>
    </Card>
  );
}

function PhotoFrame({
  photo,
  alt,
  className,
}: {
  photo: SitePhoto;
  alt: string;
  className?: string;
}) {
  if (photo.url) {
    return <img src={photo.url} alt={alt} className={`${className ?? ''} w-full object-cover`} />;
  }
  return (
    <div
      className={`${className ?? ''} flex w-full flex-col items-center justify-center gap-1 bg-concrete text-dust`}
      role="img"
      aria-label={alt || copy.siteDetail.photosTab.noPreview}
      title={copy.siteDetail.photosTab.noPreview}
    >
      <Camera className="size-6 stroke-2" aria-hidden="true" />
      <span className="font-mono text-[11px] uppercase tracking-[0.08em]">
        {copy.siteDetail.tabs.photos}
      </span>
    </div>
  );
}
