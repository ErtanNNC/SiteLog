import { useState } from 'react';
import type { ReporterRole } from '@sitelog/shared/enums.ts';
import { formatPhone } from '@sitelog/shared/format.ts';
import { Button } from '@/components/ui/Button';
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
import { useLinkUnknownSender } from '@/data/hooks';
import type { SiteOption, UnknownSenderItem } from '@/data/types';

interface Props {
  sender: UnknownSenderItem | null;
  onOpenChange: (open: boolean) => void;
  sites: SiteOption[];
}

/** Guess a first name from the held message ("this is Luis, covering…" → "Luis"). */
export function guessName(snippet: string | null): string {
  if (!snippet) return '';
  const m = /\b(?:this is|it's|it is|soy|i'm|im)\s+([A-Z][\p{L}'-]+)/iu.exec(snippet);
  if (!m?.[1]) return '';
  return m[1].charAt(0).toUpperCase() + m[1].slice(1);
}

/** "Link to {site}" dialog: name, role, site → linkUnknownSender (F11). */
export function LinkSenderDialog({ sender, onOpenChange, sites }: Props) {
  const c = copy.team.link;
  const link = useLinkUnknownSender();
  // The parent keys this dialog by sender id, so state initialises per sender.
  const [name, setName] = useState(() => guessName(sender?.snippet ?? null));
  const [role, setRole] = useState<ReporterRole>('backup');
  const [siteId, setSiteId] = useState(sender?.guessedSiteId ?? '');
  const [errors, setErrors] = useState<Record<string, string>>({});

  const submit = () => {
    if (!sender) return;
    const next: Record<string, string> = {};
    if (!name.trim()) next.name = c.nameRequired;
    if (!siteId) next.site = c.siteRequired;
    setErrors(next);
    if (Object.keys(next).length) return;
    link.mutate(
      { unknownSenderId: sender.id, siteId, name: name.trim(), role },
      { onSuccess: () => onOpenChange(false) },
    );
  };

  return (
    <Dialog open={!!sender} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{c.title(sender ? formatPhone(sender.phone) : '')}</DialogTitle>
          <DialogDescription>{c.description}</DialogDescription>
        </DialogHeader>
        {sender?.snippet ? (
          <blockquote className="mt-3 rounded-card border border-rebar bg-concrete/60 px-4 py-3 text-[15px] leading-[22px]">
            {copy.team.unknown.snippet(sender.snippet)}
          </blockquote>
        ) : null}
        <form
          className="mt-4 grid gap-4"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <div className="grid gap-1.5">
            <Label htmlFor="link-name">{c.name}</Label>
            <Input
              id="link-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={c.namePlaceholder}
              aria-invalid={!!errors.name}
            />
            {errors.name ? (
              <p role="alert" className="text-caption font-medium text-missing">
                {errors.name}
              </p>
            ) : null}
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <Label htmlFor="link-role">{c.role}</Label>
              <Select value={role} onValueChange={(v) => setRole(v as ReporterRole)}>
                <SelectTrigger id="link-role">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="backup">{copy.team.roles.backup}</SelectItem>
                  <SelectItem value="site_manager">{copy.team.roles.site_manager}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="link-site">{c.site}</Label>
              <Select value={siteId} onValueChange={setSiteId}>
                <SelectTrigger id="link-site" aria-invalid={!!errors.site}>
                  <SelectValue placeholder={copy.hours.siteSelect} />
                </SelectTrigger>
                <SelectContent>
                  {sites.map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      {s.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {errors.site ? (
                <p role="alert" className="text-caption font-medium text-missing">
                  {errors.site}
                </p>
              ) : null}
            </div>
          </div>
          <DialogFooter className="mt-2">
            <DialogClose asChild>
              <Button variant="ghost">{copy.common.cancel}</Button>
            </DialogClose>
            <Button type="submit" variant="primary" loading={link.isPending}>
              {c.confirm}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
