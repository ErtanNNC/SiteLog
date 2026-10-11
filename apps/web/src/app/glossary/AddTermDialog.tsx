import { useState } from 'react';
import { TERM_KINDS, type TermKind } from '@sitelog/shared/enums.ts';
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
import { useAddGlossaryTerm } from '@/data/hooks';
import type { SiteOption } from '@/data/types';

const ALL = 'all';
const LANGS = ['en', 'es', 'pl', 'hi', 'pt'] as const;

/** "Add term": heard → official, kind, language, scope (F17). */
export function AddTermDialog({
  open,
  onOpenChange,
  sites,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sites: SiteOption[];
}) {
  const c = copy.glossary.form;
  const add = useAddGlossaryTerm();
  const [heard, setHeard] = useState('');
  const [official, setOfficial] = useState('');
  const [kind, setKind] = useState<TermKind>('term');
  const [language, setLanguage] = useState<string>('en');
  const [scope, setScope] = useState(ALL);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const reset = () => {
    setHeard('');
    setOfficial('');
    setKind('term');
    setLanguage('en');
    setScope(ALL);
    setErrors({});
  };

  const submit = () => {
    const next: Record<string, string> = {};
    if (!heard.trim()) next.heard = c.heardRequired;
    if (!official.trim()) next.official = c.officialRequired;
    setErrors(next);
    if (Object.keys(next).length) return;
    add.mutate(
      {
        heard: heard.trim(),
        official: official.trim(),
        kind,
        language,
        scopeSiteId: scope === ALL ? null : scope,
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
      <DialogContent>
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
            <Label htmlFor="term-heard">{c.heard}</Label>
            <Input
              id="term-heard"
              value={heard}
              onChange={(e) => setHeard(e.target.value)}
              placeholder={c.heardPlaceholder}
              aria-invalid={!!errors.heard}
            />
            {errors.heard ? (
              <p role="alert" className="text-caption font-medium text-missing">
                {errors.heard}
              </p>
            ) : null}
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="term-official">{c.official}</Label>
            <Input
              id="term-official"
              value={official}
              onChange={(e) => setOfficial(e.target.value)}
              placeholder={c.officialPlaceholder}
              aria-invalid={!!errors.official}
            />
            {errors.official ? (
              <p role="alert" className="text-caption font-medium text-missing">
                {errors.official}
              </p>
            ) : null}
          </div>
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="grid gap-1.5">
              <Label htmlFor="term-kind">{c.kind}</Label>
              <Select value={kind} onValueChange={(v) => setKind(v as TermKind)}>
                <SelectTrigger id="term-kind">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {TERM_KINDS.map((k) => (
                    <SelectItem key={k} value={k}>
                      {copy.glossary.kinds[k]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="term-lang">{c.language}</Label>
              <Select value={language} onValueChange={setLanguage}>
                <SelectTrigger id="term-lang">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {LANGS.map((l) => (
                    <SelectItem key={l} value={l}>
                      {copy.glossary.languages[l]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="term-scope">{c.scope}</Label>
              <Select value={scope} onValueChange={setScope}>
                <SelectTrigger id="term-scope">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL}>{c.allSites}</SelectItem>
                  {sites.map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      {s.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter className="mt-2">
            <DialogClose asChild>
              <Button variant="ghost">{copy.common.cancel}</Button>
            </DialogClose>
            <Button type="submit" variant="primary" loading={add.isPending}>
              {c.save}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
