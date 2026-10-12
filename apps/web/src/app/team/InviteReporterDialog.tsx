import { useState } from 'react';
import { Link } from 'react-router';
import type { ReporterRole } from '@sitelog/shared/enums.ts';
import { useAuth } from '@/auth/AuthProvider';
import { canAccess, ROUTE_ROLES } from '@/auth/guards';
import { emptyPhone, PhoneInput, type PhoneValue } from '@/components/sitelog/PhoneInput';
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
import { copy } from '@/copy/en';
import { useInviteReporter } from '@/data/hooks';
import type { SiteOption } from '@/data/types';

export const LANGUAGES = ['en', 'es', 'pl', 'pt', 'hi', 'fr'] as const;

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sites: SiteOption[];
  defaultSiteIds?: string[];
}

/** "Invite reporter": name, phone (E.164 + country), role, sites, languages → sitelog_welcome (F3). */
export function InviteReporterDialog({ open, onOpenChange, sites, defaultSiteIds = [] }: Props) {
  const c = copy.team.invite;
  const invite = useInviteReporter();
  const { role: memberRole } = useAuth();
  // A reporter reports for a site; with none yet the dialog explains how to get one.
  const noSites = sites.length === 0;
  const canAddSite = canAccess(memberRole, ROUTE_ROLES.setup!);
  const [name, setName] = useState('');
  const [phone, setPhone] = useState<PhoneValue>(emptyPhone());
  const [role, setRole] = useState<ReporterRole>('site_manager');
  const [siteIds, setSiteIds] = useState<string[]>(defaultSiteIds);
  const [languages, setLanguages] = useState<string[]>(['en']);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const reset = () => {
    setName('');
    setPhone(emptyPhone());
    setRole('site_manager');
    setSiteIds(defaultSiteIds);
    setLanguages(['en']);
    setErrors({});
  };

  const toggle = (list: string[], id: string, on: boolean) =>
    on ? [...list, id] : list.filter((x) => x !== id);

  const submit = () => {
    if (noSites) return;
    const next: Record<string, string> = {};
    if (!name.trim()) next.name = c.nameRequired;
    if (!phone.e164) next.phone = c.phoneInvalid;
    if (siteIds.length === 0) next.sites = c.sitesRequired;
    setErrors(next);
    if (Object.keys(next).length) return;
    invite.mutate(
      {
        name: name.trim(),
        phone: phone.e164!,
        role,
        siteIds,
        languages: languages.length ? languages : ['en'],
      },
      {
        onSuccess: () => {
          onOpenChange(false);
          reset();
        },
      },
    );
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        onOpenChange(o);
        if (!o) reset();
      }}
    >
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{c.title}</DialogTitle>
          <DialogDescription>{c.description}</DialogDescription>
        </DialogHeader>
        <form
          className="mt-4 grid gap-4"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <div className="grid gap-1.5">
            <Label htmlFor="inv-name">{c.name}</Label>
            <Input
              id="inv-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={c.namePlaceholder}
              autoComplete="name"
              aria-invalid={!!errors.name}
            />
            {errors.name ? (
              <p role="alert" className="text-caption font-medium text-missing">
                {errors.name}
              </p>
            ) : null}
          </div>
          <PhoneInput
            label={c.phone}
            value={phone}
            onChange={setPhone}
            error={errors.phone ?? null}
            required
            data-testid="invite-phone"
          />
          <div className="grid gap-1.5">
            <Label htmlFor="inv-role">{c.role}</Label>
            <Select value={role} onValueChange={(v) => setRole(v as ReporterRole)}>
              <SelectTrigger id="inv-role">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="site_manager">{copy.team.roles.site_manager}</SelectItem>
                <SelectItem value="backup">{copy.team.roles.backup}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <fieldset className="grid gap-2">
            <legend className="text-caption font-medium">{c.sites}</legend>
            {noSites ? (
              <div
                className="flex flex-wrap items-center justify-between gap-3 rounded-card border border-dashed border-rebar bg-concrete/60 p-3"
                data-testid="invite-no-sites"
              >
                <p className="text-[15px] text-dust">
                  {canAddSite ? c.noSites : c.noSitesAskAdmin}
                </p>
                {canAddSite ? (
                  <Button variant="secondary" size="dense" asChild>
                    <Link to="/setup/site">{c.addSite}</Link>
                  </Button>
                ) : null}
              </div>
            ) : null}
            <div className="grid gap-1 sm:grid-cols-2">
              {sites.map((s) => (
                <label key={s.id} className="flex min-h-10 items-center gap-3 text-[15px]">
                  <Checkbox
                    checked={siteIds.includes(s.id)}
                    onCheckedChange={(v) => setSiteIds((prev) => toggle(prev, s.id, v === true))}
                    aria-label={s.name}
                  />
                  <span className="truncate">{s.name}</span>
                </label>
              ))}
            </div>
            {errors.sites ? (
              <p role="alert" className="text-caption font-medium text-missing">
                {errors.sites}
              </p>
            ) : null}
          </fieldset>
          <fieldset className="grid gap-2">
            <legend className="text-caption font-medium">{c.languages}</legend>
            <div className="flex flex-wrap gap-2">
              {LANGUAGES.map((l) => {
                const on = languages.includes(l);
                return (
                  <button
                    key={l}
                    type="button"
                    role="checkbox"
                    aria-checked={on}
                    onClick={() => setLanguages((prev) => toggle(prev, l, !on))}
                    className={
                      on
                        ? 'h-10 rounded-chip border border-asphalt bg-asphalt px-3 text-[15px] font-medium text-chalk'
                        : 'h-10 rounded-chip border border-rebar bg-chalk px-3 text-[15px] font-medium text-asphalt hover:bg-concrete'
                    }
                  >
                    {c.languageNames[l]}
                  </button>
                );
              })}
            </div>
            <p className="text-caption text-dust">{c.languagesHint}</p>
          </fieldset>
          <DialogFooter className="mt-2">
            <DialogClose asChild>
              <Button variant="ghost">{copy.common.cancel}</Button>
            </DialogClose>
            <Button type="submit" variant="primary" loading={invite.isPending} disabled={noSites}>
              {c.send}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
