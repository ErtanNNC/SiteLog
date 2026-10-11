import { ImagePlus, Minus, Plus } from 'lucide-react';
import { useRef } from 'react';
import { Button } from '@/components/ui/Button';
import { RadioGroup, RadioGroupItem } from '@/components/ui/Checkbox';
import { Input } from '@/components/ui/Input';
import { Label } from '@/components/ui/Label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/Select';
import { copy } from '@/copy/en';
import { cn } from '@/lib/utils';
import { SettingsCard, SwitchRow } from './fields';
import type { SectionProps } from './ReportsSection';

export interface PdfSectionProps extends SectionProps {
  orgName: string;
  logoUrl: string | null;
  onLogoChange: (file: File | null) => void;
}

/** PDF template: logo (preview only), letterhead lines, footer, paper size, live thumbnail (§12). */
export function PdfSection({ draft, update, orgName, logoUrl, onLogoChange }: PdfSectionProps) {
  const c = copy.settings.pdf;
  const fileRef = useRef<HTMLInputElement>(null);
  const lines = draft.letterhead_lines;
  const setLine = (i: number, v: string) =>
    update({ letterhead_lines: lines.map((l, j) => (j === i ? v : l)) });

  return (
    <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_320px]">
      <div className="grid gap-6">
        <SettingsCard title={c.logo} hint={c.logoHint}>
          <div className="flex flex-wrap items-center gap-4">
            <div className="flex size-20 items-center justify-center overflow-hidden rounded-card border border-rebar bg-concrete">
              {logoUrl ? (
                <img src={logoUrl} alt={copy.settings.pdf.logo} className="max-h-full max-w-full object-contain" />
              ) : (
                <ImagePlus className="size-6 text-dust" aria-hidden="true" />
              )}
            </div>
            <div className="flex flex-wrap gap-2">
              <input
                ref={fileRef}
                type="file"
                accept="image/png,image/svg+xml"
                className="sr-only"
                aria-label={c.upload}
                onChange={(e) => onLogoChange(e.target.files?.[0] ?? null)}
              />
              <Button variant="ghost" size="dense" onClick={() => fileRef.current?.click()}>
                {logoUrl ? c.replace : c.upload}
              </Button>
              {logoUrl ? (
                <Button variant="destructive" size="dense" onClick={() => onLogoChange(null)}>
                  {c.removeLogo}
                </Button>
              ) : null}
            </div>
          </div>
        </SettingsCard>

        <SettingsCard title={c.letterhead} hint={c.letterheadHint}>
          <div className="grid gap-2" data-testid="letterhead-lines">
            {lines.map((l, i) => (
              <div key={i} className="flex items-center gap-2">
                <Label htmlFor={`lh-${i}`} className="sr-only">
                  {c.letterheadPlaceholder} {i + 1}
                </Label>
                <Input
                  id={`lh-${i}`}
                  value={l}
                  onChange={(e) => setLine(i, e.target.value)}
                  placeholder={c.letterheadPlaceholder}
                />
                <Button
                  variant="subtle"
                  size="iconDense"
                  aria-label={`${c.removeLine} ${i + 1}`}
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
              {c.addLine}
            </Button>
          </div>
        </SettingsCard>

        <SettingsCard title={c.paper}>
          <div className="grid gap-5 md:grid-cols-2">
            <RadioGroup
              value={draft.pdf_paper}
              onValueChange={(v) => update({ pdf_paper: v })}
              aria-label={c.paper}
              className="grid-cols-2"
            >
              {(
                [
                  ['letter', c.letter, '8.5 × 11 in'],
                  ['a4', c.a4, '210 × 297 mm'],
                ] as const
              ).map(([value, label, size]) => (
                <label
                  key={value}
                  className={cn(
                    'flex min-h-11 cursor-pointer items-center gap-3 rounded-chip border px-3',
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
              <Label htmlFor="pdf-photos">{c.photos}</Label>
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
              <p className="text-caption text-dust">{c.photosHint}</p>
            </div>
          </div>
          <div className="mt-5 border-t border-rebar pt-4">
            <SwitchRow
              id="pdf-footer"
              label={c.footerToggle}
              hint={c.footerText}
              checked={draft.pdf_footer_enabled}
              onCheckedChange={(v) => update({ pdf_footer_enabled: v })}
            />
          </div>
        </SettingsCard>
      </div>

      <aside aria-label={c.preview}>
        <div className="eyebrow mb-2 text-dust">{c.preview}</div>
        <PdfThumbnail
          orgName={orgName}
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
  const c = copy.settings.pdf;
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
            <span className="font-mono text-[6px] text-dust">{c.previewLogo}</span>
          )}
        </div>
      </div>
      <div className="mt-2 flex items-baseline justify-between">
        <div className="font-display text-[10px]">{c.previewReport}</div>
        <div className="font-mono text-[6px] text-dust">{c.previewNo}</div>
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
        {footer ? c.footerText : ' '}
      </div>
    </div>
  );
}
