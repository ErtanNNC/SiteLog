import { ArrowLeft, ArrowRight, Camera, ImagePlus, LoaderCircle, X } from 'lucide-react';
import { useId, useRef } from 'react';
import { OFFICE_PHOTO_MAX, PHOTO_CAPTION_MAX } from '@sitelog/shared/report/photos.ts';
import { Button } from '@/components/ui/Button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { useCopy } from '@/i18n/useCopy';
import { formatDateTimeShort, formatWhen } from '@/lib/format';
import { PHOTO_ACCEPT } from '@/lib/photos';
import type { PhotoDraft } from './usePhotoDraft';

/**
 * "Photos" in the report editor (New report and Edit): add photos (camera or library on a
 * phone), a caption per photo, move, remove; at most OFFICE_PHOTO_MAX per report. In Edit it
 * starts with the version's photos. The files are uploaded by the page when the report is saved.
 * With more photos than the PDF prints, the ones it prints are marked.
 */
export function PhotoPicker({
  draft,
  timezone,
  reportDate,
  pdfMaxPhotos,
  disabled = false,
}: {
  draft: PhotoDraft;
  /** Site time zone for the "Taken …" line; none before a site is chosen. */
  timezone?: string | null;
  /** The report's date (YYYY-MM-DD): a photo taken another day shows its date too. */
  reportDate?: string | null;
  /** settings.pdf_max_photos: how many the daily PDF prints. */
  pdfMaxPhotos?: number | null;
  /** While the report is being saved. */
  disabled?: boolean;
}) {
  const { t, language } = useCopy();
  const inputRef = useRef<HTMLInputElement>(null);
  const id = useId();
  const count = draft.items.length;
  const full = count >= OFFICE_PHOTO_MAX;
  // Only worth saying (and marking) when some photos will not print.
  const pdfMax = pdfMaxPhotos != null && count > pdfMaxPhotos ? pdfMaxPhotos : null;
  const taken = (iso: string, tz: string) =>
    reportDate ? formatWhen(iso, tz, reportDate, language) : formatDateTimeShort(iso, tz);

  return (
    <Card data-testid="photo-picker">
      <CardHeader className="flex-wrap">
        {/* On a phone the count and the button move under the title instead of squeezing it. */}
        <div className="min-w-[14rem] flex-1">
          <CardTitle id={`${id}-title`}>{t('report.editMode.photos.title')}</CardTitle>
          <p id={`${id}-hint`} className="mt-1 text-caption text-dust">
            {full
              ? t('report.editMode.photos.full', { max: OFFICE_PHOTO_MAX })
              : t('report.editMode.photos.hint')}
          </p>
          {pdfMax !== null ? (
            <p className="mt-1 text-caption text-dust" data-testid="photo-pdf-hint">
              {t('report.editMode.photos.pdfHint', { count: pdfMax })}
            </p>
          ) : null}
        </div>
        <div className="flex items-center gap-3">
          <span className="font-mono text-caption tabular text-dust" data-testid="photo-count">
            <span aria-hidden="true">
              {t('report.editMode.photos.count', { n: count, max: OFFICE_PHOTO_MAX })}
            </span>
            <span className="sr-only">
              {t('report.editMode.photos.countLabel', { count, max: OFFICE_PHOTO_MAX })}
            </span>
          </span>
          <input
            ref={inputRef}
            type="file"
            accept={PHOTO_ACCEPT}
            multiple
            className="sr-only"
            tabIndex={-1}
            aria-label={t('report.editMode.photos.add')}
            data-testid="photo-input"
            disabled={disabled || full}
            onChange={(e) => {
              const picked = e.target.files;
              if (picked?.length) draft.add(picked);
              e.target.value = '';
            }}
          />
          <Button
            variant="ghost"
            size="dense"
            onClick={() => inputRef.current?.click()}
            disabled={disabled || full}
            aria-describedby={`${id}-hint`}
          >
            <ImagePlus aria-hidden="true" />
            {t('report.editMode.photos.add')}
          </Button>
        </div>
      </CardHeader>
      <CardContent className="pt-3">
        {draft.errors.length ? (
          <div
            role="alert"
            className="mb-3 flex items-start justify-between gap-3 rounded-card border border-missing/60 bg-chip-miss-bg/30 px-3 py-2"
          >
            <ul className="space-y-1 text-caption font-medium text-missing">
              {draft.errors.map((e, i) => (
                <li key={i}>{e}</li>
              ))}
            </ul>
            <Button variant="link" size="sm" onClick={draft.dismissErrors}>
              {t('report.editMode.photos.dismiss')}
            </Button>
          </div>
        ) : null}
        {count === 0 ? (
          <p className="text-caption text-dust">{t('report.editMode.photos.empty')}</p>
        ) : (
          <ul
            className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4"
            aria-labelledby={`${id}-title`}
          >
            {draft.items.map((p, i) => {
              const n = i + 1;
              const alt = p.caption.trim() || t('report.editMode.photos.alt', { n });
              return (
                <li
                  key={p.key}
                  className="min-w-0 overflow-hidden rounded-card border border-rebar"
                  data-testid="photo-item"
                >
                  <div className="relative aspect-[4/3] bg-concrete">
                    {pdfMax !== null && i < pdfMax ? (
                      <span
                        className="absolute left-1 top-1 rounded-sm bg-chalk/90 px-1.5 py-0.5 font-mono text-[11px] uppercase tracking-[0.08em] text-asphalt"
                        data-testid="photo-in-pdf"
                      >
                        {t('report.editMode.photos.inPdf')}
                      </span>
                    ) : null}
                    {p.previewUrl ? (
                      <img
                        src={p.previewUrl}
                        alt={alt}
                        className="size-full object-cover"
                        data-testid="photo-thumb"
                      />
                    ) : p.status === 'preparing' ? (
                      <div
                        className="flex size-full flex-col items-center justify-center gap-1 text-dust"
                        role="status"
                      >
                        <LoaderCircle className="size-5 animate-sl-spin" aria-hidden="true" />
                        <span className="text-caption">
                          {t('report.editMode.photos.preparing')}
                        </span>
                      </div>
                    ) : (
                      <div
                        className="flex size-full items-center justify-center text-dust"
                        role="img"
                        aria-label={alt}
                        title={t('report.editMode.photos.noPreview')}
                      >
                        <Camera className="size-6 stroke-2" aria-hidden="true" />
                      </div>
                    )}
                    <Button
                      variant="subtle"
                      size="iconDense"
                      className="absolute right-1 top-1 bg-chalk/90 hover:bg-chalk"
                      aria-label={t('report.editMode.photos.remove', { n })}
                      onClick={() => draft.remove(p.key)}
                      disabled={disabled}
                    >
                      <X aria-hidden="true" />
                    </Button>
                    {/* Order: the PDF prints the first few. */}
                    {count > 1 ? (
                      <>
                        <Button
                          variant="subtle"
                          size="iconDense"
                          className="absolute bottom-1 left-1 bg-chalk/90 hover:bg-chalk"
                          aria-label={t('report.editMode.photos.moveEarlier', { n })}
                          onClick={() => draft.move(p.key, -1)}
                          disabled={disabled || i === 0}
                        >
                          <ArrowLeft aria-hidden="true" />
                        </Button>
                        <Button
                          variant="subtle"
                          size="iconDense"
                          className="absolute bottom-1 right-1 bg-chalk/90 hover:bg-chalk"
                          aria-label={t('report.editMode.photos.moveLater', { n })}
                          onClick={() => draft.move(p.key, 1)}
                          disabled={disabled || i === count - 1}
                        >
                          <ArrowRight aria-hidden="true" />
                        </Button>
                      </>
                    ) : null}
                  </div>
                  <div className="space-y-1 p-2">
                    <Input
                      aria-label={t('report.editMode.photos.caption', { n })}
                      placeholder={t('report.editMode.photos.captionPlaceholder')}
                      value={p.caption}
                      maxLength={PHOTO_CAPTION_MAX}
                      onChange={(e) => draft.setCaption(p.key, e.target.value)}
                      className="h-10 px-2.5 text-[14px]"
                      disabled={disabled}
                    />
                    {p.takenAt && timezone ? (
                      <p className="font-mono text-[11px] uppercase tracking-[0.08em] text-dust">
                        {t('report.editMode.photos.taken', { when: taken(p.takenAt, timezone) })}
                      </p>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
