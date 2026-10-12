import { HardHat, Mail, Plus, X } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { EmptyState } from '@/components/sitelog/States';
import { Button } from '@/components/ui/Button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { Label } from '@/components/ui/Label';
import { copy } from '@/copy/en';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type RecipientsDraft = Array<{ siteId: string; siteName: string; emails: string[] }>;

/** Recipients: per-site email chips + "Apply to all sites" (§F18). */
export function RecipientsSection({
  draft,
  update,
}: {
  draft: RecipientsDraft;
  update: (next: RecipientsDraft) => void;
}) {
  const c = copy.settings.recipients;
  const setEmails = (siteId: string, emails: string[]) =>
    update(draft.map((s) => (s.siteId === siteId ? { ...s, emails } : s)));
  const applyAll = (siteId: string) => {
    const src = draft.find((s) => s.siteId === siteId);
    if (!src) return;
    update(draft.map((s) => ({ ...s, emails: [...src.emails] })));
  };

  // Lists are per site: a new org has none to show (Settings is admin-only, as is adding a site).
  if (draft.length === 0) {
    return (
      <EmptyState
        icon={HardHat}
        title={c.noSitesTitle}
        body={c.noSitesBody}
        action={
          <Button variant="primary" asChild>
            <Link to="/setup/site">{copy.overview.connectFirstSite}</Link>
          </Button>
        }
      />
    );
  }

  return (
    <div className="grid gap-4">
      <p className="text-caption text-dust">{c.hint}</p>
      <div className="grid gap-4 md:grid-cols-2" data-testid="recipients">
        {draft.map((site) => (
          <SiteRecipients
            key={site.siteId}
            siteId={site.siteId}
            siteName={site.siteName}
            emails={site.emails}
            onChange={(emails) => setEmails(site.siteId, emails)}
            onApplyAll={draft.length > 1 ? () => applyAll(site.siteId) : undefined}
          />
        ))}
      </div>
    </div>
  );
}

function SiteRecipients({
  siteId,
  siteName,
  emails,
  onChange,
  onApplyAll,
}: {
  siteId: string;
  siteName: string;
  emails: string[];
  onChange: (emails: string[]) => void;
  onApplyAll?: () => void;
}) {
  const c = copy.settings.recipients;
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const add = () => {
    const e = value.trim().toLowerCase();
    if (!e) return;
    if (!EMAIL.test(e)) {
      setError(c.invalid);
      return;
    }
    setError(null);
    setValue('');
    if (!emails.includes(e)) onChange([...emails, e]);
  };
  return (
    <Card data-testid="site-recipients" data-site={siteName}>
      <CardHeader className="items-center">
        <CardTitle className="text-[17px]">{siteName}</CardTitle>
        {onApplyAll ? (
          <Button
            variant="link"
            size="sm"
            onClick={onApplyAll}
            disabled={emails.length === 0}
            title={c.applyAllHint(siteName)}
            aria-label={`${c.applyAll} · ${siteName}`}
          >
            {c.applyAll}
          </Button>
        ) : null}
      </CardHeader>
      <CardContent className="pt-3">
        <ul className="flex flex-wrap gap-2" aria-label={`${c.perSite} · ${siteName}`}>
          {emails.length === 0 ? (
            <li className="text-caption text-dust">{c.none}</li>
          ) : (
            emails.map((e) => (
              <li
                key={e}
                className="inline-flex h-9 items-center gap-1 rounded-chip border border-rebar bg-concrete/60 pl-2.5 pr-1 font-mono text-[12px]"
              >
                <Mail className="size-3.5 text-dust" aria-hidden="true" />
                {e}
                <button
                  type="button"
                  className="ml-1 flex size-7 items-center justify-center rounded-chip text-dust hover:bg-rebar hover:text-asphalt"
                  aria-label={c.remove(e)}
                  onClick={() => onChange(emails.filter((x) => x !== e))}
                >
                  <X className="size-4" aria-hidden="true" />
                </button>
              </li>
            ))
          )}
        </ul>
        <form
          className="mt-3 flex gap-2"
          onSubmit={(ev) => {
            ev.preventDefault();
            add();
          }}
          noValidate
        >
          <Label htmlFor={`rcpt-${siteId}`} className="sr-only">
            {c.add} · {siteName}
          </Label>
          <Input
            id={`rcpt-${siteId}`}
            type="email"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={c.placeholder}
            aria-invalid={!!error}
            className="h-10"
          />
          <Button type="submit" variant="ghost" size="dense" aria-label={`${c.add} · ${siteName}`}>
            <Plus aria-hidden="true" />
            {c.add}
          </Button>
        </form>
        {error ? (
          <p role="alert" className="mt-1 text-caption font-medium text-missing">
            {error}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
