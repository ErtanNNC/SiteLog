import { useState } from 'react';
import type { ReporterRole } from '@sitelog/shared/enums.ts';
import { formatPhone } from '@sitelog/shared/format.ts';
import { useAuth } from '@/auth/AuthProvider';
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
import { useUpdateReporter } from '@/data/hooks';
import type { SiteOption, TeamReporter } from '@/data/types';
import { reportLanguageName } from '../setup/countries';
import { LANGUAGES } from './InviteReporterDialog';

interface Props {
  reporter: TeamReporter | null;
  onOpenChange: (open: boolean) => void;
  sites: SiteOption[];
}

const sameSet = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((x) => b.includes(x));

/**
 * Team row menu → Edit (§P10): name, role, sites and languages. The WhatsApp number is shown
 * read-only — a new number means disable + invite again (it is how messages are matched).
 */
export function EditReporterDialog({ reporter, onOpenChange, sites }: Props) {
  const c = copy.team.invite;
  const e = copy.team.edit;
  const update = useUpdateReporter();
  const { currentOrg } = useAuth();
  // The parent keys this dialog by reporter id, so state initialises per reporter.
  const [name, setName] = useState(reporter?.name ?? '');
  const [role, setRole] = useState<ReporterRole>(reporter?.role ?? 'site_manager');
  const [siteIds, setSiteIds] = useState<string[]>(() => reporter?.sites.map((s) => s.id) ?? []);
  const [languages, setLanguages] = useState<string[]>(() => reporter?.languages ?? ['en']);
  const [errors, setErrors] = useState<Record<string, string>>({});

  // Keep languages outside the default list (e.g. set by an earlier import) visible and editable.
  const languageOptions = [
    ...LANGUAGES,
    ...(reporter?.languages ?? []).filter((l) => !(LANGUAGES as readonly string[]).includes(l)),
  ];
  const languageName = (l: string) =>
    (c.languageNames as Record<string, string>)[l] ?? l.toUpperCase();
  const toggle = (list: string[], id: string, on: boolean) =>
    on ? [...list, id] : list.filter((x) => x !== id);

  const dirty =
    !!reporter &&
    (name.trim() !== reporter.name ||
      role !== reporter.role ||
      !sameSet(
        siteIds,
        reporter.sites.map((s) => s.id),
      ) ||
      languages.join() !== reporter.languages.join());

  const submit = () => {
    if (!reporter) return;
    const next: Record<string, string> = {};
    if (!name.trim()) next.name = c.nameRequired;
    if (siteIds.length === 0) next.sites = c.sitesRequired;
    setErrors(next);
    if (Object.keys(next).length) return;
    update.mutate(
      {
        reporterId: reporter.id,
        name: name.trim(),
        role,
        siteIds,
        languages: languages.length ? languages : ['en'],
      },
      { onSuccess: () => onOpenChange(false) },
    );
  };

  return (
    <Dialog open={!!reporter} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{e.title(reporter?.name ?? '')}</DialogTitle>
          <DialogDescription>{e.description}</DialogDescription>
        </DialogHeader>
        <form
          className="mt-4 grid gap-4"
          noValidate
          onSubmit={(ev) => {
            ev.preventDefault();
            submit();
          }}
        >
          <div className="grid gap-1.5">
            <Label htmlFor="edit-name">{c.name}</Label>
            <Input
              id="edit-name"
              value={name}
              onChange={(ev) => setName(ev.target.value)}
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
          <div className="grid gap-1.5">
            <Label htmlFor="edit-phone">{e.phone}</Label>
            <Input
              id="edit-phone"
              value={reporter ? formatPhone(reporter.phone) : ''}
              readOnly
              aria-readonly="true"
              aria-describedby="edit-phone-hint"
              className="bg-concrete font-mono text-dust"
              data-testid="edit-phone"
            />
            <p id="edit-phone-hint" className="text-caption text-dust">
              {e.phoneHint}
            </p>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="edit-role">{c.role}</Label>
            <Select value={role} onValueChange={(v) => setRole(v as ReporterRole)}>
              <SelectTrigger id="edit-role">
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
            <div className="grid gap-1 sm:grid-cols-2">
              {sites.map((s) => (
                <label
                  key={s.id}
                  className="flex min-h-target-dense items-center gap-3 text-[15px]"
                >
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
              {languageOptions.map((l) => {
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
                        ? 'h-target-dense rounded-chip border border-asphalt bg-asphalt px-3 text-[15px] font-medium text-chalk'
                        : 'h-target-dense rounded-chip border border-rebar bg-chalk px-3 text-[15px] font-medium text-asphalt hover:bg-concrete'
                    }
                  >
                    {languageName(l)}
                  </button>
                );
              })}
            </div>
            <p className="text-caption text-dust">
              {c.languagesHint(reportLanguageName(currentOrg?.locale))}
            </p>
          </fieldset>
          <DialogFooter className="mt-2">
            <DialogClose asChild>
              <Button variant="ghost">{copy.common.cancel}</Button>
            </DialogClose>
            <Button type="submit" variant="primary" disabled={!dirty} loading={update.isPending}>
              {e.save}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
