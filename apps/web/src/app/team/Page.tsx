import { AlertTriangle, Link2, MoreHorizontal, PhoneOff, UserPlus, Users } from 'lucide-react';
import { useState } from 'react';
import { MEMBER_ROLES, type MemberRole } from '@sitelog/shared/enums.ts';
import { firstName, formatPhone, formatTimeInTz } from '@sitelog/shared/format.ts';
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
import {
  useChangeMemberRole,
  useIgnoreUnknownSender,
  useRemoveMember,
  useResendInvite,
  useRevokeReporterDevices,
  useSetReporterStatus,
  useTeam,
  useTextDailyLink,
} from '@/data/hooks';
import type {
  OfficeUser,
  ReporterChipStatus,
  TeamData,
  TeamReporter,
  UnknownSenderItem,
} from '@/data/types';
import { useCopy, type CopyT } from '@/i18n/useCopy';
import { cn } from '@/lib/utils';
import { AddOfficeUserDialog } from './AddOfficeUserDialog';
import { EditReporterDialog } from './EditReporterDialog';
import { InviteReporterDialog } from './InviteReporterDialog';
import { LinkSenderDialog } from './LinkSenderDialog';
import { OptOutDialog } from './OptOutDialog';
import { contactLabel, languageLabel } from './labels';

/** P10 statuses (W4-03): each chip says its status in words, the dot only repeats it. */
const CHIP: Record<ReporterChipStatus, { box: string; dot: string }> = {
  active: { box: 'bg-chip-filed-bg text-chip-filed-fg border-chip-filed-bg', dot: 'bg-filed' },
  invite_sent: {
    box: 'bg-chip-await-bg text-chip-await-fg border-chip-await-bg',
    dot: 'bg-signal',
  },
  undeliverable: {
    box: 'bg-chip-miss-bg text-chip-miss-fg border-chip-miss-bg',
    dot: 'bg-missing',
  },
  opted_out: {
    box: 'bg-chip-review-bg text-chip-review-fg border-chip-review-bg',
    dot: 'bg-dust',
  },
  disabled: { box: 'bg-chip-wx-bg text-chip-wx-fg border-chip-wx-bg', dot: 'bg-dust-light' },
};

function ReporterChip({ status, t }: { status: ReporterChipStatus; t: CopyT }) {
  const s = CHIP[status];
  const label = t(`team.status.${status}`);
  return (
    <span
      data-status={status}
      className={cn(
        'inline-flex h-7 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-chip border px-2.5 text-caption font-medium',
        s.box,
      )}
      aria-label={t('a11y.statusChipLabel', { label })}
    >
      <span aria-hidden="true" className={cn('size-2 rounded-full', s.dot)} />
      {label}
    </span>
  );
}

const ROLE_PILL: Record<MemberRole, string> = {
  admin: 'border-asphalt bg-asphalt text-chalk',
  pm: 'border-chip-review-bg bg-chip-review-bg text-chip-review-fg',
  ops: 'border-rebar bg-concrete text-asphalt',
  accounts: 'border-rebar bg-chalk text-dust',
};

/** The notes under a status: who stopped texts, the automatic re-send, the phones signed in. */
function statusNotes(r: TeamReporter, pack: TeamData['pack'], t: CopyT): string[] {
  const notes: string[] = [];
  if (r.chipStatus === 'opted_out') {
    if (r.optOutBy === 'person') notes.push(t('team.statusNotes.byPerson'));
    if (r.optOutBy === 'provider') notes.push(t('team.statusNotes.byProvider'));
    if (pack.twoWaySms) notes.push(t('team.optOutStartOnly', { first: firstName(r.name) }));
  }
  if (r.autoResent) notes.push(t('team.statusNotes.autoResent'));
  if (r.devices > 0) notes.push(t('team.statusNotes.devices', { count: r.devices }));
  return notes;
}

/** P10 · Team & numbers — reporters, unknown numbers, office users (§11.4, F3, F15, F16, F24). */
export default function TeamPage() {
  const { t } = useCopy();
  const { currentOrg, user, role } = useAuth();
  const tz = currentOrg?.timezone ?? 'UTC';
  const team = useTeam();
  const ignore = useIgnoreUnknownSender();
  const setStatus = useSetReporterStatus();
  const resend = useResendInvite();
  const textLink = useTextDailyLink();
  const revoke = useRevokeReporterDevices();
  const changeRole = useChangeMemberRole();
  const removeMember = useRemoveMember();
  const [inviteOpen, setInviteOpen] = useState(false);
  const [addUserOpen, setAddUserOpen] = useState(false);
  const [linking, setLinking] = useState<UnknownSenderItem | null>(null);
  const [removing, setRemoving] = useState<OfficeUser | null>(null);
  const [disabling, setDisabling] = useState<TeamReporter | null>(null);
  const [editing, setEditing] = useState<TeamReporter | null>(null);
  const [revoking, setRevoking] = useState<TeamReporter | null>(null);
  const [clearing, setClearing] = useState<TeamReporter | null>(null);

  const data = team.data;
  const adminCount = data?.officeUsers.filter((u) => u.role === 'admin').length ?? 0;
  const speaks = (codes: string[]) => codes.map((c) => languageLabel(t, c)).join(' · ');

  const columns: Column<TeamReporter>[] = data
    ? [
        {
          key: 'name',
          header: t('team.columns.name'),
          cell: (r) => (
            <div className="min-w-[150px]">
              <div className="font-semibold">{r.name}</div>
              <div className="text-caption text-dust">{t(`team.roles.${r.role}`)}</div>
            </div>
          ),
        },
        {
          key: 'mobile',
          header: t('team.columns.mobile'),
          cell: (r) => (
            <span className="whitespace-nowrap font-mono text-data tabular">
              {formatPhone(r.phone)}
            </span>
          ),
        },
        {
          key: 'prefers',
          header: t('team.columns.prefers'),
          cell: (r) => (
            <div className="flex min-w-[110px] flex-col items-start gap-1">
              <span className="whitespace-nowrap font-mono text-[13px]" data-testid="contact-pref">
                {contactLabel(t, r.contactPref, r.messageChannel)}
              </span>
              {r.channelUnreachable && r.messageChannel ? (
                <span className="inline-flex items-center gap-1 text-caption text-dust">
                  <AlertTriangle className="size-3.5 shrink-0" aria-hidden="true" />
                  {t('team.channelNotAgreed', {
                    channel: t(`team.channels.${r.messageChannel}`),
                  })}
                </span>
              ) : null}
            </div>
          ),
        },
        {
          key: 'sites',
          header: t('team.columns.sites'),
          hideBelowMd: true,
          cell: (r) =>
            r.sites.length === 0 ? (
              <span className="text-dust">{t('team.noSites')}</span>
            ) : (
              <div className="flex max-w-[240px] flex-wrap gap-1">
                {r.sites.map((s) => (
                  <span
                    key={s.id}
                    className={cn(
                      'inline-flex h-6 items-center whitespace-nowrap rounded-chip border px-1.5 text-[12px] font-medium',
                      s.isPrimary ? 'border-asphalt text-asphalt' : 'border-rebar text-dust',
                    )}
                    title={s.isPrimary ? `${s.name} · ${t('team.primary')}` : s.name}
                  >
                    {s.shortName}
                  </span>
                ))}
              </div>
            ),
        },
        {
          key: 'language',
          header: t('team.columns.language'),
          hideBelowMd: true,
          cell: (r) => (
            <div className="min-w-[100px]">
              <div data-testid="reporter-locale">{t(`team.locales.${r.locale}`)}</div>
              {r.languages.length ? (
                <div className="text-caption text-dust">
                  {t('team.speaks', { languages: speaks(r.languages) })}
                </div>
              ) : null}
            </div>
          ),
        },
        {
          key: 'onTime',
          header: t('team.columns.onTime'),
          numeric: true,
          hideBelowMd: true,
          cell: (r) => (
            <span title={t('team.reportsCount', { count: r.reports30 })}>
              {r.onTime30 === null ? '—' : `${r.onTime30}%`}
              <span className="ml-1 text-dust">· {r.reports30}</span>
            </span>
          ),
        },
        {
          key: 'status',
          header: t('team.columns.status'),
          cell: (r) => (
            <div className="flex min-w-[150px] flex-col items-start gap-1">
              <ReporterChip status={r.chipStatus} t={t} />
              {statusNotes(r, data.pack, t).map((note) => (
                <span key={note} className="text-caption text-dust">
                  {note}
                </span>
              ))}
            </div>
          ),
        },
        {
          key: 'menu',
          header: <span className="sr-only">{t('common.moreActions')}</span>,
          className: 'w-12',
          cell: (r) => (
            <ReporterMenu
              r={r}
              t={t}
              canClearOptOut={
                role === 'admin' &&
                r.chipStatus === 'opted_out' &&
                !data.pack.twoWaySms &&
                r.optOutBy !== 'person'
              }
              onEdit={() => setEditing(r)}
              onResend={() => resend.mutate({ reporterId: r.id, name: r.name })}
              onTextLink={(siteId) =>
                textLink.mutate({ siteId, first: firstName(r.name), reporterId: r.id })
              }
              onRevoke={() => setRevoking(r)}
              onClearOptOut={() => setClearing(r)}
              onEnable={() =>
                setStatus.mutate({ reporterId: r.id, status: 'invited', name: r.name })
              }
              onDisable={() => setDisabling(r)}
            />
          ),
        },
      ]
    : [];

  if (team.isPending) return <PageSkeleton />;
  if (team.isError || !data)
    return (
      <ErrorState thing={t('team.thing')} error={team.error} onRetry={() => void team.refetch()} />
    );

  return (
    <>
      <PageHeader
        title={t('team.title')}
        subtitle={t('team.subtitle')}
        actions={
          <Button variant="primary" onClick={() => setInviteOpen(true)}>
            <UserPlus aria-hidden="true" />
            {t('team.inviteReporter')}
          </Button>
        }
      />

      {data.unknownSenders.length > 0 ? (
        <section className="mb-6 space-y-3" aria-label={t('team.unknown.title')}>
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
                    <p className="font-semibold">{t('team.unknown.title')}</p>
                    <p className="font-mono text-[13px] text-asphalt">
                      {t('team.unknown.body', {
                        phone: formatPhone(u.phone),
                        time: formatTimeInTz(u.at, tz),
                      })}
                      {u.guessedSiteName ? (
                        <span className="text-dust">
                          {' '}
                          · {t('team.unknown.guessed', { site: u.guessedSiteName })}
                        </span>
                      ) : null}
                    </p>
                    {u.snippet ? (
                      <p className="mt-1 text-[15px] text-dust">
                        {t('team.unknown.snippet', { text: u.snippet })}
                      </p>
                    ) : null}
                  </div>
                </div>
                <div className="flex shrink-0 flex-wrap gap-2">
                  {/* W1-16: a caller or texter is linked too (api-link-unknown-contact), as a
                      reporter invited until they consent (F3). */}
                  <Button variant="secondary" onClick={() => setLinking(u)}>
                    <Link2 aria-hidden="true" />
                    {u.guessedSiteName
                      ? t('team.unknown.link', { site: u.guessedSiteName })
                      : t('team.unknown.linkOther')}
                  </Button>
                  <Button
                    variant="ghost"
                    loading={ignore.isPending}
                    onClick={() => ignore.mutate({ unknownSenderId: u.id })}
                  >
                    {t('team.unknown.ignore')}
                  </Button>
                </div>
              </div>
            </div>
          ))}
        </section>
      ) : null}

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,2fr)_minmax(320px,1fr)]">
        <Card className="min-w-0">
          <CardHeader>
            <CardTitle>{t('team.reporters')}</CardTitle>
            <span className="font-mono text-[13px] text-dust">{data.reporters.length}</span>
          </CardHeader>
          <CardContent className="px-0 pb-2 pt-3">
            <DataTable
              columns={columns}
              rows={data.reporters}
              rowKey={(r) => r.id}
              aria-label={t('team.reporters')}
              empty={{
                title: t('team.empty'),
                action: (
                  <Button variant="primary" onClick={() => setInviteOpen(true)}>
                    {t('team.inviteReporter')}
                  </Button>
                ),
              }}
            />
          </CardContent>
        </Card>

        <aside className="min-w-0 space-y-6" aria-label={t('team.office')}>
          <Card>
            <CardHeader>
              <CardTitle>{t('team.office')}</CardTitle>
              <Button variant="ghost" onClick={() => setAddUserOpen(true)}>
                <UserPlus aria-hidden="true" />
                {t('team.addOfficeUser')}
              </Button>
            </CardHeader>
            <CardContent className="pt-3">
              {data.officeUsers.length === 0 ? (
                <EmptyState icon={Users} title={t('team.officeEmpty')} />
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
                            {isSelf ? <span className="text-dust"> · {t('team.you')}</span> : null}
                          </div>
                          <div className="truncate text-caption text-dust">
                            {u.email ?? u.title ?? ''}
                          </div>
                          {u.uiLocale ? (
                            <div className="truncate text-caption text-dust">
                              {t('team.officeLanguage', {
                                language: t(`team.uiLocales.${u.uiLocale}`),
                              })}
                            </div>
                          ) : null}
                        </div>
                        <span
                          className={cn(
                            'inline-flex h-6 items-center rounded-chip border px-2 font-mono text-[11px] font-medium uppercase tracking-[0.08em]',
                            ROLE_PILL[u.role],
                          )}
                        >
                          {t(`team.officeRoles.${u.role}`)}
                        </span>
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button
                              variant="subtle"
                              size="icon"
                              aria-label={t('a11y.menuForName', { name: u.name })}
                            >
                              <MoreHorizontal aria-hidden="true" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuLabel>{t('team.changeRole')}</DropdownMenuLabel>
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
                                  {t(`team.officeRoles.${r}`)}
                                </DropdownMenuRadioItem>
                              ))}
                            </DropdownMenuRadioGroup>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                              destructive
                              disabled={lastAdmin}
                              onSelect={() => setRemoving(u)}
                            >
                              {t('team.removeUser')}
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </li>
                    );
                  })}
                </ul>
              )}
              {adminCount <= 1 ? (
                <p className="mt-2 text-caption text-dust">{t('team.addUser.lastAdmin')}</p>
              ) : null}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>{t('team.howMatching')}</CardTitle>
            </CardHeader>
            <CardContent className="pt-2 text-[15px] text-dust">
              {t('team.howMatchingBody')}
            </CardContent>
          </Card>
        </aside>
      </div>

      <InviteReporterDialog
        open={inviteOpen}
        onOpenChange={setInviteOpen}
        sites={data.sites}
        pack={data.pack}
      />
      <EditReporterDialog
        key={`edit:${editing?.id ?? 'none'}`}
        reporter={editing}
        onOpenChange={(o) => !o && setEditing(null)}
        sites={data.sites}
        pack={data.pack}
      />
      <AddOfficeUserDialog
        open={addUserOpen}
        onOpenChange={setAddUserOpen}
        orgLocale={data.orgLocale}
      />
      <LinkSenderDialog
        key={`link:${linking?.id ?? 'none'}`}
        sender={linking}
        onOpenChange={(o) => !o && setLinking(null)}
        sites={data.sites}
      />
      <OptOutDialog
        key={`optout:${clearing?.id ?? 'none'}`}
        reporter={clearing}
        onOpenChange={(o) => !o && setClearing(null)}
      />
      <ConfirmDialog
        open={!!removing}
        onOpenChange={(o) => !o && setRemoving(null)}
        title={removing ? t('team.removeDialog.title', { name: removing.name }) : ''}
        description={t('team.removeDialog.body')}
        confirmLabel={t('team.removeDialog.confirm')}
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
        title={disabling ? t('team.disableDialog.title', { name: disabling.name }) : ''}
        description={t('team.disableDialog.body')}
        confirmLabel={t('team.rowMenu.disable')}
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
      <ConfirmDialog
        open={!!revoking}
        onOpenChange={(o) => !o && setRevoking(null)}
        title={revoking ? t('team.revokeDialog.title', { name: revoking.name }) : ''}
        description={
          revoking
            ? t('team.revokeDialog.body', {
                first: firstName(revoking.name),
                phone: formatPhone(revoking.phone),
              })
            : ''
        }
        confirmLabel={t('team.revokeDialog.confirm')}
        destructive
        loading={revoke.isPending}
        onConfirm={() => {
          if (!revoking) return;
          revoke.mutate(
            { reporterId: revoking.id, name: revoking.name },
            { onSettled: () => setRevoking(null) },
          );
        }}
      >
        {revoking ? (
          <p className="mt-3 font-mono text-[13px] text-dust" data-testid="revoke-count">
            {t('team.revokeDialog.count', { count: revoking.devices })}
          </p>
        ) : null}
      </ConfirmDialog>
    </>
  );
}

/**
 * P10 row menu (W4-03): Edit · Re-send welcome · Text today's link (one per site when they have
 * several) · Revoke devices · Turn texts back on (an admin, one-way packs, §19 Q242) · Disable.
 * Call now (F3, the office's attestation) is W4-04's.
 */
function ReporterMenu({
  r,
  t,
  canClearOptOut,
  onEdit,
  onResend,
  onTextLink,
  onRevoke,
  onClearOptOut,
  onEnable,
  onDisable,
}: {
  r: TeamReporter;
  t: CopyT;
  canClearOptOut: boolean;
  onEdit: () => void;
  onResend: () => void;
  onTextLink: (siteId: string) => void;
  onRevoke: () => void;
  onClearOptOut: () => void;
  onEnable: () => void;
  onDisable: () => void;
}) {
  const active = r.chipStatus === 'active';
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="subtle" size="icon" aria-label={t('a11y.menuForName', { name: r.name })}>
          <MoreHorizontal aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={onEdit}>{t('team.rowMenu.edit')}</DropdownMenuItem>
        {r.status !== 'disabled' ? (
          <DropdownMenuItem disabled={active || r.status === 'opted_out'} onSelect={onResend}>
            {t('team.rowMenu.resendWelcome')}
          </DropdownMenuItem>
        ) : null}
        {r.sites.length <= 1 ? (
          <DropdownMenuItem
            disabled={!active || r.sites.length === 0}
            onSelect={() => r.sites[0] && onTextLink(r.sites[0].id)}
          >
            {t('team.rowMenu.textLink')}
          </DropdownMenuItem>
        ) : (
          r.sites.map((s) => (
            <DropdownMenuItem key={s.id} disabled={!active} onSelect={() => onTextLink(s.id)}>
              {t('team.rowMenu.textLinkAt', { site: s.shortName })}
            </DropdownMenuItem>
          ))
        )}
        <DropdownMenuItem onSelect={onRevoke}>{t('team.rowMenu.revokeDevices')}</DropdownMenuItem>
        {canClearOptOut ? (
          <DropdownMenuItem onSelect={onClearOptOut}>
            {t('team.rowMenu.clearOptOut')}
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuSeparator />
        {r.status === 'disabled' ? (
          <DropdownMenuItem onSelect={onEnable}>{t('team.rowMenu.enable')}</DropdownMenuItem>
        ) : (
          <DropdownMenuItem destructive onSelect={onDisable}>
            {t('team.rowMenu.disable')}
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
