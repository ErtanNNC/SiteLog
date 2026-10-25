import { ImagePlus, Minus, Plus } from 'lucide-react';
import { useRef, useState } from 'react';
import type { OrgLocale, UnitSystem } from '@sitelog/shared/locale.ts';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/Dialog';
import { RadioGroup, RadioGroupItem } from '@/components/ui/Checkbox';
import { Input } from '@/components/ui/Input';
import { Label } from '@/components/ui/Label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/Select';
import { useSaveReportLocale } from '@/data/hooks';
import type { SettingsData } from '@/data/types';
import { TURKISH_ON } from '@/i18n/language';
import { useCopy } from '@/i18n/useCopy';
import { LOGO_ACCEPT } from '@/lib/logo';
import { cn } from '@/lib/utils';
import { SettingsCard, SwitchRow } from './fields';
import type { SectionProps } from './ReportsSection';

export interface PdfSectionProps extends SectionProps {
  org: SettingsData['org'];
  logoUrl: string | null;
  /** Uploads (File) or removes (null) the logo right away. */
  onLogoChange: (file: File | null) => void;
  logoBusy?: boolean;
  logoError?: string | null;
}

/**
 * PDF template: logo upload, letterhead lines, footer, paper size, live thumbnail (§12, §P12), and
 * the report language and units (§19 Q233, W4-05).
 */
export function PdfSection({
  draft,
  update,
  org,
  logoUrl,
  onLogoChange,
  logoBusy = false,
  logoError = null,
}: PdfSectionProps) {
  const { t } = useCopy();
  const fileRef = useRef<HTMLInputElement>(null);
  const lines = draft.letterhead_lines;
  const setLine = (i: number, v: string) =>
    update({ letterhead_lines: lines.map((l, j) => (j === i ? v : l)) });

  return (
    <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_320px]">
      <div className="grid gap-6">
        <SettingsCard title={t('settings.pdf.logo')} hint={t('settings.pdf.logoHint')}>
          <div className="flex flex-wrap items-center gap-4">
            <div className="flex size-20 items-center justify-center overflow-hidden rounded-card border border-rebar bg-concrete">
              {logoUrl ? (
                <img
                  src={logoUrl}
                  alt={t('settings.pdf.logo')}
                  className="max-h-full max-w-full object-contain"
                />
              ) : (
                <ImagePlus className="size-6 text-dust" aria-hidden="true" />
              )}
            </div>
            <div className="flex flex-wrap gap-2">
              <input
                ref={fileRef}
                type="file"
                accept={LOGO_ACCEPT}
                className="sr-only"
                aria-label={t('settings.pdf.upload')}
                aria-describedby={logoError ? 'pdf-logo-error' : undefined}
                data-testid="logo-input"
                onChange={(e) => {
                  const file = e.target.files?.[0] ?? null;
                  e.target.value = '';
                  if (file) onLogoChange(file);
                }}
              />
              <Button
                variant="ghost"
                size="dense"
                loading={logoBusy}
                onClick={() => fileRef.current?.click()}
              >
                {logoBusy
                  ? t('settings.pdf.logoUploading')
                  : logoUrl
                    ? t('settings.pdf.replace')
                    : t('settings.pdf.upload')}
              </Button>
              {logoUrl ? (
                <Button
                  variant="destructive"
                  size="dense"
                  disabled={logoBusy}
                  onClick={() => onLogoChange(null)}
                >
                  {t('settings.pdf.removeLogo')}
                </Button>
              ) : null}
            </div>
          </div>
          {logoError ? (
            <p
              id="pdf-logo-error"
              role="alert"
              className="mt-2 text-caption font-medium text-missing"
            >
              {logoError}
            </p>
          ) : null}
        </SettingsCard>

        <SettingsCard title={t('settings.pdf.letterhead')} hint={t('settings.pdf.letterheadHint')}>
          <div className="grid gap-2" data-testid="letterhead-lines">
            {lines.map((l, i) => (
              <div key={i} className="flex items-center gap-2">
                <Label htmlFor={`lh-${i}`} className="sr-only">
                  {t('settings.pdf.letterheadLine', { n: i + 1 })}
                </Label>
                <Input
                  id={`lh-${i}`}
                  value={l}
                  onChange={(e) => setLine(i, e.target.value)}
                  placeholder={t('settings.pdf.letterheadPlaceholder')}
                />
                <Button
                  variant="subtle"
                  size="iconDense"
                  aria-label={t('settings.pdf.removeLineN', { n: i + 1 })}
                  onClick={() => update({ letterhead_lines: lines.filter((_, j) => j !== i) })}
                >
                  <Minus aria-hidden="true" />
                </Button>
              </div>
            ))}
            <Button
              variant="ghost"
              size="dense"
              className="justify-self-start"
              disabled={lines.length >= 4}
              onClick={() => update({ letterhead_lines: [...lines, ''] })}
            >
              <Plus aria-hidden="true" />
              {t('settings.pdf.addLine')}
            </Button>
          </div>
        </SettingsCard>

        <SettingsCard title={t('settings.pdf.paper')}>
          <div className="grid gap-5 md:grid-cols-2">
            <RadioGroup
              value={draft.pdf_paper}
              onValueChange={(v) => update({ pdf_paper: v })}
              aria-label={t('settings.pdf.paper')}
              className="grid-cols-2"
            >
              {(
                [
                  ['letter', t('settings.pdf.letter'), '8.5 × 11 in'],
                  ['a4', t('settings.pdf.a4'), '210 × 297 mm'],
                ] as const
              ).map(([value, label, size]) => (
                <label
                  key={value}
                  className={cn(
                    'flex min-h-target cursor-pointer items-center gap-3 rounded-chip border px-3',
                    draft.pdf_paper === value ? 'border-asphalt' : 'border-rebar',
                  )}
                >
                  <RadioGroupItem value={value} aria-label={label} />
                  <span>
                    <span className="block font-medium">{label}</span>
                    <span className="block font-mono text-[12px] text-dust">{size}</span>
                  </span>
                </label>
              ))}
            </RadioGroup>
            <div className="grid gap-1.5">
              <Label htmlFor="pdf-photos">{t('settings.pdf.photos')}</Label>
              <Select
                value={String(draft.pdf_max_photos)}
                onValueChange={(v) => update({ pdf_max_photos: Number(v) })}
              >
                <SelectTrigger id="pdf-photos" className="w-32 font-mono">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {[0, 1, 2, 3, 4].map((n) => (
                    <SelectItem key={n} value={String(n)}>
                      {n}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-caption text-dust">{t('settings.pdf.photosHint')}</p>
            </div>
          </div>
          <div className="mt-5 border-t border-rebar pt-4">
            <SwitchRow
              id="pdf-footer"
              label={t('settings.pdf.footerToggle')}
              hint={t('settings.pdf.footerText')}
              checked={draft.pdf_footer_enabled}
              onCheckedChange={(v) => update({ pdf_footer_enabled: v })}
            />
          </div>
        </SettingsCard>

        <ReportLocaleCard org={org} />
      </div>

      <aside aria-label={t('settings.pdf.preview')}>
        <div className="eyebrow mb-2 text-dust">{t('settings.pdf.preview')}</div>
        <PdfThumbnail
          orgName={org.name}
          lines={lines}
          logoUrl={logoUrl}
          paper={draft.pdf_paper}
          footer={draft.pdf_footer_enabled}
          photos={draft.pdf_max_photos}
        />
      </aside>
    </div>
  );
}

/** Small CSS mock of PDF page 1 (§12): letterhead, title block, three table bands, photo grid, footer. */
export function PdfThumbnail({
  orgName,
  lines,
  logoUrl,
  paper,
  footer,
  photos,
}: {
  orgName: string;
  lines: string[];
  logoUrl: string | null;
  paper: string;
  footer: boolean;
  photos: number;
}) {
  const { t } = useCopy();
  return (
    <div
      className="mx-auto flex w-full max-w-[320px] flex-col border border-rebar bg-white p-4 text-asphalt"
      style={{ aspectRatio: paper === 'a4' ? '210 / 297' : '8.5 / 11' }}
      data-testid="pdf-preview"
      data-paper={paper}
      aria-hidden="true"
    >
      <div className="flex items-start justify-between gap-2 border-b border-asphalt pb-2">
        <div className="min-w-0">
          <div className="truncate font-display text-[11px] leading-4">{orgName}</div>
          {lines
            .filter((l) => l.trim())
            .map((l, i) => (
              <div key={i} className="truncate text-[7px] leading-[10px] text-dust">
                {l}
              </div>
            ))}
        </div>
        <div className="flex size-8 shrink-0 items-center justify-center overflow-hidden border border-rebar">
          {logoUrl ? (
            <img src={logoUrl} alt="" className="max-h-full max-w-full object-contain" />
          ) : (
            <span className="font-mono text-[6px] text-dust">{t('settings.pdf.previewLogo')}</span>
          )}
        </div>
      </div>
      <div className="mt-2 flex items-baseline justify-between">
        <div className="font-display text-[10px]">{t('settings.pdf.previewReport')}</div>
        <div className="font-mono text-[6px] text-dust">{t('settings.pdf.previewNo')}</div>
      </div>
      <div className="mt-2 grid grid-cols-3 gap-1">
        {[0, 1, 2].map((i) => (
          <div key={i} className="h-5 border border-rebar" />
        ))}
      </div>
      <div className="mt-2 space-y-1">
        {[0, 1, 2, 3, 4].map((i) => (
          <div key={i} className={cn('h-1.5 bg-concrete', i === 0 && 'bg-rebar')} />
        ))}
      </div>
      <div className="mt-2 space-y-1">
        {[0, 1, 2].map((i) => (
          <div key={i} className="h-1 w-[90%] bg-concrete" />
        ))}
      </div>
      {photos > 0 ? (
        <div className="mt-2 grid grid-cols-4 gap-1">
          {Array.from({ length: photos }, (_, i) => (
            <div key={i} className="aspect-[4/3] bg-rebar" />
          ))}
        </div>
      ) : null}
      <div className="mt-auto border-t border-rebar pt-1 text-[5px] leading-[8px] text-dust">
        {footer ? t('settings.pdf.footerText') : ' '}
      </div>
    </div>
  );
}

// §19 Q378: Turkish reports only in a build with Turkish on.
const REPORT_LOCALES: readonly OrgLocale[] = TURKISH_ON ? ['en-US', 'tr-TR'] : ['en-US'];
const UNITS: readonly UnitSystem[] = ['imperial', 'metric'];
const languageKey = (l: OrgLocale) => (l === 'tr-TR' ? 'tr' : 'en');

/**
 * §19 Q233 (W4-05): the org's report language and units (`update_org` p_locale / p_units, admin,
 * audited `org.updated`), saved on their own after a confirm, not with "Save changes". New report
 * versions take them; a filed version keeps its own (its data carries `reportLanguage`, `units`).
 */
function ReportLocaleCard({ org }: { org: SettingsData['org'] }) {
  const { t } = useCopy();
  const save = useSaveReportLocale();
  const [locale, setLocale] = useState<OrgLocale>(org.locale);
  const [units, setUnits] = useState<UnitSystem>(org.units);
  const [confirming, setConfirming] = useState(false);
  const changed = locale !== org.locale || units !== org.units;
  const unitsLabel = (u: UnitSystem) => t(`settings.pdf.unitNames.${u}`);
  return (
    <SettingsCard
      title={t('settings.pdf.reportLocale')}
      hint={t('settings.pdf.reportLocaleHint')}
      data-testid="report-locale"
    >
      <div className="grid gap-4 md:grid-cols-2">
        <div className="grid gap-1.5">
          <Label htmlFor="report-language">{t('settings.pdf.reportLanguage')}</Label>
          <Select value={locale} onValueChange={(v) => setLocale(v as OrgLocale)}>
            <SelectTrigger id="report-language">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(REPORT_LOCALES.includes(org.locale)
                ? REPORT_LOCALES
                : [...REPORT_LOCALES, org.locale]
              ).map((l) => (
                <SelectItem key={l} value={l}>
                  {t(`settings.pdf.reportLanguages.${languageKey(l)}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="report-units">{t('settings.pdf.units')}</Label>
          <Select value={units} onValueChange={(v) => setUnits(v as UnitSystem)}>
            <SelectTrigger id="report-units">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {UNITS.map((u) => (
                <SelectItem key={u} value={u}>
                  {unitsLabel(u)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
      <Button
        variant="ghost"
        className="mt-4"
        disabled={!changed}
        loading={save.isPending}
        onClick={() => setConfirming(true)}
      >
        {t('settings.pdf.reportLocaleApply')}
      </Button>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={t('settings.pdf.reportLocaleConfirmTitle')}
        description={t('settings.pdf.reportLocaleConfirmBody', {
          language: t(`settings.pdf.reportLanguages.${languageKey(locale)}`),
          units: unitsLabel(units),
        })}
        confirmLabel={t('settings.pdf.reportLocaleConfirm')}
        loading={save.isPending}
        onConfirm={async () => {
          try {
            await save.mutateAsync({
              name: org.name,
              timezone: org.timezone,
              address: org.address,
              licenseNo: org.licenseNo,
              locale,
              units,
            });
            setConfirming(false);
          } catch {
            /* the mutation hook already toasted */
          }
        }}
      />
    </SettingsCard>
  );
}
