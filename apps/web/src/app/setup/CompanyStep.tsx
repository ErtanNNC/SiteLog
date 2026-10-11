import { ArrowRight, ImagePlus } from 'lucide-react';
import { useRef, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Card, CardContent } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { copy } from '@/copy/en';
import { Field, TimezoneSelect } from './fields';
import type { CompanyDraft } from './state';

const MAX_LOGO = 2 * 1024 * 1024;

export function CompanyStep({
  draft,
  onChange,
  onContinue,
  busy,
  logoUrl,
  onLogoChange,
}: {
  draft: CompanyDraft;
  onChange: (next: CompanyDraft) => void;
  onContinue: () => void;
  busy: boolean;
  logoUrl: string | null;
  onLogoChange: (file: File | null) => string | null;
}) {
  const c = copy.setup.company;
  const fileRef = useRef<HTMLInputElement>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const set = (patch: Partial<CompanyDraft>) => onChange({ ...draft, ...patch });

  const submit = () => {
    const next: Record<string, string> = {};
    if (!draft.name.trim()) next.name = c.nameRequired;
    setErrors(next);
    if (Object.keys(next).length) return;
    onContinue();
  };

  return (
    <Card>
      <CardContent className="p-6 md:p-8">
        <h2 className="font-h2 text-h2">{c.title}</h2>
        <p className="mt-1 text-[15px] text-dust">{c.subtitle}</p>
        <form
          className="mt-6 grid gap-5"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <Field id="co-name" label={c.name} error={errors.name}>
            <Input
              id="co-name"
              value={draft.name}
              onChange={(e) => set({ name: e.target.value })}
              placeholder={c.namePlaceholder}
              autoComplete="organization"
              aria-invalid={!!errors.name}
            />
          </Field>
          <div className="grid gap-5 md:grid-cols-2">
            <Field id="co-address" label={c.address} optional>
              <Input
                id="co-address"
                value={draft.address}
                onChange={(e) => set({ address: e.target.value })}
                placeholder={c.addressPlaceholder}
                autoComplete="street-address"
              />
            </Field>
            <Field id="co-license" label={c.licenseNo} optional>
              <Input
                id="co-license"
                value={draft.licenseNo}
                onChange={(e) => set({ licenseNo: e.target.value })}
                className="font-mono"
              />
            </Field>
          </div>
          <div className="grid gap-5 md:grid-cols-2">
            <Field id="co-logo" label={c.logo} hint={c.logoHint} error={errors.logo} optional>
              <div className="flex items-center gap-4">
                <div className="flex size-16 shrink-0 items-center justify-center overflow-hidden rounded-card border border-rebar bg-concrete">
                  {logoUrl ? (
                    <img src={logoUrl} alt={c.logo} className="max-h-full max-w-full object-contain" />
                  ) : (
                    <ImagePlus className="size-6 text-dust" aria-hidden="true" />
                  )}
                </div>
                <input
                  ref={fileRef}
                  id="co-logo"
                  type="file"
                  accept="image/png,image/svg+xml"
                  className="sr-only"
                  onChange={(e) => {
                    const f = e.target.files?.[0] ?? null;
                    if (f && f.size > MAX_LOGO) {
                      setErrors((er) => ({ ...er, logo: c.logoTooLarge }));
                      return;
                    }
                    if (f && !['image/png', 'image/svg+xml'].includes(f.type)) {
                      setErrors((er) => ({ ...er, logo: c.logoWrongType }));
                      return;
                    }
                    setErrors(({ logo: _l, ...rest }) => rest);
                    onLogoChange(f);
                  }}
                />
                <div className="flex flex-wrap gap-2">
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
            </Field>
            <Field id="co-tz" label={c.timezone}>
              <TimezoneSelect id="co-tz" value={draft.timezone} onChange={(tz) => set({ timezone: tz })} />
            </Field>
          </div>
          <div className="flex justify-end border-t border-rebar pt-5">
            <Button type="submit" variant="primary" loading={busy}>
              {c.next}
              <ArrowRight aria-hidden="true" />
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
