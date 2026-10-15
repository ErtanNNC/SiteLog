import { Link2, MoreHorizontal, PhoneOff, UserPlus, Users } from 'lucide-react';
import { useState } from 'react';
import { MEMBER_ROLES, type MemberRole } from '@sitelog/shared/enums.ts';
import { formatPhone, formatTimeInTz } from '@sitelog/shared/format.ts';
import { useAuth } from '@/auth/AuthProvider';
import { DataTable, type Column } from '@/components/sitelog/DataTable';
import { PageHeader } from '@/components/sitelog/PageHeader';
import { PageSkeleton } from '@/components/sitelog/Skeletons';
import { EmptyState, ErrorState } from '@/components/sitelog/States';
import { Avatar } from '@/components/ui/Avatar';
import { Button } from '@/components/ui/Button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/Card';
import { ConfirmDialog } from '@/components/ui/Dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/DropdownMenu';
import { copy } from '@/copy/en';
import {
  useChangeMemberRole,
  useIgnoreUnknownSender,
  useRemoveMember,
  useResendInvite,
  useSetReporterStatus,
  useTeam,
} from '@/data/hooks';
import type { OfficeUser, ReporterChipStatus, TeamReporter, UnknownSenderItem } from '@/data/types';
import { formatLanguages } from '@/lib/format';
import { cn } from '@/lib/utils';
import { AddOfficeUserDialog } from './AddOfficeUserDialog';
import { EditReporterDialog } from './EditReporterDialog';
import { InviteReporterDialog } from './InviteReporterDialog';
import { LinkSenderDialog } from './LinkSenderDialog';

// `active` (§6.2) keeps the WhatsApp-era "Verified" label until the Team statuses of M10.
const CHIP: Record<ReporterChipStatus, { box: string; dot: string; label: string }> = {
  active: {
    box: 'bg-chip-filed-bg text-chip-filed-fg border-chip-filed-bg',
    dot: 'bg-filed',
    label: copy.chips.verified,
  },
  invite_sent: {
    box: 'bg-chip-await-bg text-chip-await-fg border-chip-await-bg',
    dot: 'bg-signal',
    label: copy.chips.inviteSent,
  },
  not_on_whatsapp: {
    box: 'bg-chip-miss-bg text-chip-miss-fg border-chip-miss-bg',
    dot: 'bg-missing',
    label: copy.chips.notOnWhatsApp,
  },
  opted_out: {
    box: 'bg-chip-review-bg text-chip-review-fg border-chip-review-bg',
    dot: 'bg-dust',
    label: copy.chips.optedOut,
  },
  disabled: {
    box: 'bg-chip-wx-bg text-chip-wx-fg border-chip-wx-bg',
    dot: 'bg-dust-light',
    label: copy.chips.disabled,
  },
};

function ReporterChip({ status }: { status: ReporterChipStatus }) {
  const s = CHIP[status];
  return (
    <span
      data-status={status}
      className={cn(
        'inline-flex h-7 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-chip border px-2.5 text-caption font-medium',
        s.box,
      )}
      aria-label={copy.a11y.statusChip(s.label)}
    >
      <span aria-hidden="true" className={cn('size-2 rounded-full', s.dot)} />
      {s.label}
    </span>
  );
}

const ROLE_PILL: Record<MemberRole, string> = {
  admin: 'border-asphalt bg-asphalt text-chalk',
  pm: 'border-chip-review-bg bg-chip-review-bg text-chip-review-fg',
  ops: 'border-rebar bg-concrete text-asphalt',
  accounts: 'border-rebar bg-chalk text-dust',
};

/** P10 · Team & numbers — reporters, unknown numbers, office users (§11.4, F3, F11, F20). */
export default function TeamPage() {
  const { currentOrg, user } = useAuth();
  const tz = currentOrg?.timezone ?? 'UTC';
  const team = useTeam();
  const ignore = useIgnoreUnknownSender();
  const setStatus = useSetReporterStatus();
  const resend = useResendInvite();
  const changeRole = useChangeMemberRole();
  const removeMember = useRemoveMember();
  const [inviteOpen, setInviteOpen] = useState(false);
  const [addUserOpen, setAddUserOpen] = useState(false);
  const [linking, setLinking] = useState<UnknownSenderItem | null>(null);
  const [removing, setRemoving] = useState<OfficeUser | null>(null);
  const [disabling, setDisabling] = useState<TeamReporter | null>(null);
  const [editing, setEditing] = useState<TeamReporter | null>(null);

  const data = team.data;
  const adminCount = data?.officeUsers.filter((u) => u.role === 'admin').length ?? 0;

  const columns: Column<TeamReporter>[] = [
    {
      key: 'name',
      header: copy.team.columns.name,
      cell: (r) => (
        <div className="min-w-[160px]">
          <div className="font-semibold">{r.name}</div>
          <div className="text-caption text-dust">{copy.team.roles[r.role]}</div>
        </div>
      ),
    },
    {
      key: 'phone',
      header: copy.team.columns.whatsapp,
      cell: (r) => <span className="font-mono text-data tabular">{formatPhone(r.phone)}</span>,
    },
    {
      key: 'sites',
      header: copy.team.columns.sites,
      cell: (r) =>
        r.sites.length === 0 ? (
          <span className="text-dust">{copy.team.noSites}</span>
        ) : (
          <div className="flex max-w-[260px] flex-wrap gap-1">
            {r.sites.map((s) => (
              <span
                key={s.id}
                className={cn(
                  'inline-flex h-6 items-center whitespace-nowrap rounded-chip border px-1.5 text-[12px] font-medium',
                  s.isPrimary ? 'border-asphalt text-asphalt' : 'border-rebar text-dust',
                )}
                title={s.isPrimary ? `${s.name} · ${copy.team.primary}` : s.name}
              >
                {s.shortName}
              </span>
            ))}
          </div>
        ),
    },
    {
      key: 'speaks',
      header: copy.team.columns.speaks,
      hideBelowMd: true,
      cell: (r) => <span className="font-mono text-data">{formatLanguages(r.languages)}</span>,
    },
    {
      key: 'onTime',
      header: copy.team.columns.onTime,
      numeric: true,
      hideBelowMd: true,
      cell: (r) => (
        <span title={copy.team.reportsCount(r.reports30)}>
          {r.onTime30 === null ? '—' : `${r.onTime30}%`}
          <span className="ml-1 text-dust">· {r.reports30}</span>
        </span>
      ),
    },
    {
      key: 'status',
      header: copy.team.columns.status,
      cell: (r) => (
        <div className="flex flex-col items-start gap-1">
          <ReporterChip status={r.chipStatus} />
          <span className="font-mono text-[12px] text-dust" data-testid="contact-pref">
            {copy.team.prefers[r.contactPref]}
          </span>
        </div>
      ),
    },
    {
      key: 'menu',
      header: <span className="sr-only">{copy.common.moreActions}</span>,
      className: 'w-12',
      cell: (r) => (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="subtle" size="iconDense" aria-label={copy.a11y.menuFor(r.name)}>
              <MoreHorizontal aria-hidden="true" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={() => setEditing(r)}>
              {copy.team.rowMenu.edit}
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={r.chipStatus === 'active'}
              onSelect={() => resend.mutate({ reporterId: r.id, name: r.name })}
            >
              {copy.team.rowMenu.resendInvite}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            {r.status === 'disabled' ? (
              <DropdownMenuItem
                onSelect={() =>
                  setStatus.mutate({ reporterId: r.id, status: 'invited', name: r.name })
                }
              >
                {copy.team.rowMenu.resendInvite}
              </DropdownMenuItem>
            ) : (
              <DropdownMenuItem destructive onSelect={() => setDisabling(r)}>
                {copy.team.rowMenu.disable}
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      ),
    },
  ];

  if (team.isPending) return <PageSkeleton />;
  if (team.isError || !data)
    return (
      <ErrorState
        thing={copy.nav.team.toLowerCase()}
        error={team.error}
        onRetry={() => void team.refetch()}
      />
    );

  return (
    <>
      <PageHeader
        title={copy.team.title}
        subtitle={copy.team.subtitle}
        actions={
          <Button variant="primary" onClick={() => setInviteOpen(true)}>
            <UserPlus aria-hidden="true" />
            {copy.team.inviteReporter}
          </Button>
        }
      />

      {data.unknownSenders.length > 0 ? (
        <section className="mb-6 space-y-3" aria-label={copy.team.unknown.title}>
          {data.unknownSenders.map((u) => (
            <div
              key={u.id}
              role="alert"
              data-testid="unknown-sender"
              className="rounded-card border border-signal-deep/50 bg-signal-tint/40 p-4 md:p-5"
            >
              <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                <div className="flex min-w-0 items-start gap-3">
                  <PhoneOff
                    className="mt-0.5 size-5 shrink-0 text-signal-deep"
                    aria-hidden="true"
                  />
                  <div className="min-w-0">
                    <p className="font-semibold">{copy.team.unknown.title}</p>
                    <p className="font-mono text-[13px] text-asphalt">
                      {copy.team.unknown.body(formatPhone(u.phone), formatTimeInTz(u.at, tz))}
                      {u.guessedSiteName ? (
                        <span className="text-dust">
                          {' '}
                          · {copy.team.unknown.guessed(u.guessedSiteName)}
                        </span>
                      ) : null}
                    </p>
                    {u.snippet ? (
                      <p className="mt-1 text-[15px] text-dust">
                        {copy.team.unknown.snippet(u.snippet)}
                      </p>
                    ) : null}
                  </div>
                </div>
                <div className="flex shrink-0 flex-wrap gap-2">
                  {/* W1-16: a caller or texter is linked too (api-link-unknown-contact), as a
                      reporter invited until they consent (F3). */}
                  <Button variant="secondary" size="dense" onClick={() => setLinking(u)}>
                    <Link2 aria-hidden="true" />
                    {u.guessedSiteName
                      ? copy.team.unknown.link(u.guessedSiteName)
                      : copy.team.unknown.linkOther}
                  </Button>
                  <Button
                    variant="ghost"
                    size="dense"
                    loading={ignore.isPending}
                    onClick={() => ignore.mutate({ unknownSenderId: u.id })}
                  >
                    {copy.team.unknown.ignore}
                  </Button>
                </div>
              </div>
            </div>
          ))}
        </section>
      ) : null}

      <div className="grid gap-6 xl:grid-cols-[minmax(0,2fr)_minmax(320px,1fr)]">
        <Card>
          <CardHeader>
            <CardTitle>{copy.team.reporters}</CardTitle>
            <span className="font-mono text-[13px] text-dust">{data.reporters.length}</span>
          </CardHeader>
          <CardContent className="px-0 pb-2 pt-3">
            <DataTable
              columns={columns}
              rows={data.reporters}
              rowKey={(r) => r.id}
              aria-label={copy.team.reporters}
              empty={{
                title: copy.team.empty,
                action: (
                  <Button variant="primary" onClick={() => setInviteOpen(true)}>
                    {copy.team.inviteReporter}
                  </Button>
                ),
              }}
            />
          </CardContent>
        </Card>

        <aside className="space-y-6" aria-label={copy.team.office}>
          <Card>
            <CardHeader>
              <CardTitle>{copy.team.office}</CardTitle>
              <Button variant="ghost" size="dense" onClick={() => setAddUserOpen(true)}>
                <UserPlus aria-hidden="true" />
                {copy.team.addOfficeUser}
              </Button>
            </CardHeader>
            <CardContent className="pt-3">
              {data.officeUsers.length === 0 ? (
                <EmptyState icon={Users} title={copy.team.officeEmpty} />
              ) : (
                <ul className="divide-y divide-rebar" data-testid="office-users">
                  {data.officeUsers.map((u) => {
                    const isSelf = u.userId === user?.id;
                    const lastAdmin = u.role === 'admin' && adminCount <= 1;
                    return (
                      <li key={u.userId} className="flex items-center gap-3 py-3">
                        <Avatar name={u.name} size="sm" />
                        <div className="min-w-0 flex-1">
                          <div className="truncate font-medium">
                            {u.name}
                            {isSelf ? <span className="text-dust"> · {copy.team.you}</span> : null}
                          </div>
                          <div className="truncate text-caption text-dust">
                            {u.email ?? u.title ?? ''}
                          </div>
                        </div>
                        <span
                          className={cn(
                            'inline-flex h-6 items-center rounded-chip border px-2 font-mono text-[11px] font-medium uppercase tracking-[0.08em]',
                            ROLE_PILL[u.role],
                          )}
                        >
                          {copy.team.officeRoles[u.role]}
                        </span>
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button
                              variant="subtle"
                              size="iconDense"
                              aria-label={copy.a11y.menuFor(u.name)}
                            >
                              <MoreHorizontal aria-hidden="true" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuLabel>{copy.team.changeRole}</DropdownMenuLabel>
                            <DropdownMenuRadioGroup
                              value={u.role}
                              onValueChange={(v) =>
                                changeRole.mutate({ userId: u.userId, role: v as MemberRole })
                              }
                            >
                              {MEMBER_ROLES.map((r) => (
                                <DropdownMenuRadioItem
                                  key={r}
                                  value={r}
                                  disabled={lastAdmin && r !== 'admin'}
                                >
                                  {copy.team.officeRoles[r]}
                                </DropdownMenuRadioItem>
                              ))}
                            </DropdownMenuRadioGroup>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                              destructive
                              disabled={lastAdmin}
                              onSelect={() => setRemoving(u)}
                            >
                              {copy.team.removeUser}
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </li>
                    );
                  })}
                </ul>
              )}
              {adminCount <= 1 ? (
                <p className="mt-2 text-caption text-dust">{copy.team.addUser.lastAdmin}</p>
              ) : null}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>{copy.team.howMatching}</CardTitle>
            </CardHeader>
            <CardContent className="pt-2 text-[15px] text-dust">
              {copy.team.howMatchingBody}
            </CardContent>
          </Card>
        </aside>
      </div>

      <InviteReporterDialog open={inviteOpen} onOpenChange={setInviteOpen} sites={data.sites} />
      <EditReporterDialog
        key={`edit:${editing?.id ?? 'none'}`}
        reporter={editing}
        onOpenChange={(o) => !o && setEditing(null)}
        sites={data.sites}
      />
      <AddOfficeUserDialog open={addUserOpen} onOpenChange={setAddUserOpen} />
      <LinkSenderDialog
        key={`link:${linking?.id ?? 'none'}`}
        sender={linking}
        onOpenChange={(o) => !o && setLinking(null)}
        sites={data.sites}
      />
      <ConfirmDialog
        open={!!removing}
        onOpenChange={(o) => !o && setRemoving(null)}
        title={removing ? copy.team.removeDialog.title(removing.name) : ''}
        description={copy.team.removeDialog.body}
        confirmLabel={copy.team.removeDialog.confirm}
        destructive
        loading={removeMember.isPending}
        onConfirm={() => {
          if (!removing) return;
          removeMember.mutate({ userId: removing.userId }, { onSettled: () => setRemoving(null) });
        }}
      />
      <ConfirmDialog
        open={!!disabling}
        onOpenChange={(o) => !o && setDisabling(null)}
        title={disabling ? copy.team.disableDialog.title(disabling.name) : ''}
        description={copy.team.disableDialog.body}
        confirmLabel={copy.team.rowMenu.disable}
        destructive
        loading={setStatus.isPending}
        onConfirm={() => {
          if (!disabling) return;
          setStatus.mutate(
            { reporterId: disabling.id, status: 'disabled', name: disabling.name },
            { onSettled: () => setDisabling(null) },
          );
        }}
      />
    </>
  );
}
