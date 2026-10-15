import { formatPhone } from '@sitelog/shared/format.ts';
import { useState } from 'react';
import { DataTable, type Column } from '@/components/sitelog/DataTable';
import { ErrorState } from '@/components/sitelog/States';
import { Button } from '@/components/ui/Button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/Card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/Select';
import { copy } from '@/copy/en';
import { useAssignUnknownContact, useIgnoreOrglessContact, useOrglessContacts } from '@/data/hooks';
import type { OrglessContacts as OrglessData } from '@/data/types';
import { formatDateTimeShort } from '@/lib/format';

type Contact = OrglessData['contacts'][number];

/**
 * /ops (spec §19 Q44, W1-16): the unknown contacts no organisation sees (an SMS on a sender every
 * org of the pack shares, from a number with no history in exactly one of them). SiteLog staff
 * give one to its organisation, which then links it with consent, or ignore it. Times in UTC.
 */
export function OrglessContacts() {
  const c = copy.ops.orgless;
  const data = useOrglessContacts();
  const assign = useAssignUnknownContact();
  const ignore = useIgnoreOrglessContact();
  const [choice, setChoice] = useState<Record<string, string>>({});

  if (data.isError)
    return <ErrorState thing={c.thing} error={data.error} onRetry={() => void data.refetch()} />;
  // The page shows its own skeleton; this card waits for its data rather than claim "none".
  if (data.isPending) return null;
  const contacts = data.data?.contacts ?? [];
  const orgs = data.data?.orgs ?? [];

  const columns: Column<Contact>[] = [
    {
      key: 'contact',
      header: c.columns.contact,
      cell: (u) => (
        <div className="min-w-[140px]">
          <div className="font-mono text-data">{formatPhone(u.phone)}</div>
          <div className="font-mono text-caption text-dust">{u.channel ?? 'whatsapp'}</div>
        </div>
      ),
    },
    {
      key: 'message',
      header: c.columns.message,
      cell: (u) => (
        <span className="block max-w-[320px] text-caption text-asphalt">
          {u.snippet ? `“${u.snippet}”` : '—'}
        </span>
      ),
    },
    {
      key: 'received',
      header: c.columns.received,
      cell: (u) => copy.ops.utc(formatDateTimeShort(u.createdAt, 'UTC')),
    },
    {
      key: 'org',
      header: c.columns.org,
      cell: (u) => (
        <div className="flex min-w-[300px] flex-wrap items-center gap-2">
          <Select
            value={choice[u.id] ?? ''}
            onValueChange={(v) => setChoice((all) => ({ ...all, [u.id]: v }))}
          >
            <SelectTrigger className="w-[200px]" aria-label={c.orgLabel(formatPhone(u.phone))}>
              <SelectValue placeholder={c.orgPlaceholder} />
            </SelectTrigger>
            <SelectContent>
              {orgs.map((o) => (
                <SelectItem key={o.id} value={o.id}>
                  {o.name} · {o.country}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            variant="secondary"
            size="dense"
            className="min-h-[44px]"
            disabled={!choice[u.id]}
            loading={assign.isPending && assign.variables?.contactId === u.id}
            onClick={() => assign.mutate({ contactId: u.id, orgId: choice[u.id]! })}
          >
            {c.assign}
          </Button>
          <Button
            variant="ghost"
            size="dense"
            className="min-h-[44px]"
            loading={ignore.isPending && ignore.variables?.contactId === u.id}
            onClick={() => ignore.mutate({ contactId: u.id })}
          >
            {c.ignore}
          </Button>
        </div>
      ),
    },
  ];

  return (
    <Card className="mb-6" data-testid="orgless-contacts">
      <CardHeader>
        <div>
          <CardTitle>{c.title}</CardTitle>
          <p className="mt-1 text-[15px] text-dust">{c.hint}</p>
        </div>
        <span className="font-mono text-[13px] text-dust">{contacts.length}</span>
      </CardHeader>
      <CardContent className="px-0 pb-2 pt-3">
        <DataTable
          columns={columns}
          rows={contacts}
          rowKey={(u) => u.id}
          aria-label={c.title}
          empty={{ title: c.empty }}
          className={contacts.length === 0 ? 'mx-5 mb-3' : undefined}
        />
      </CardContent>
    </Card>
  );
}
