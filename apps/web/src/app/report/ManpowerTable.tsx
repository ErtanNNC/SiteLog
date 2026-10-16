import { formatTimeInTz } from '@sitelog/shared/format.ts';
import type { ManpowerEntry, Source } from '@sitelog/shared/schemas/report.ts';
import { DataTable, type Column } from '@/components/sitelog/DataTable';
import { SourceLink } from '@/components/sitelog/SourceLink';
import { Badge } from '@/components/ui/Badge';
import { TableCell, TableRow } from '@/components/ui/Table';
import { manpowerChanges } from '@/data/assemble';
import type { ReportDetail } from '@/data/types';
import { useCopy } from '@/i18n/useCopy';
import { formatCrew, formatHoursNum } from '@/lib/format';
import { cn } from '@/lib/utils';

export interface ManpowerTableProps {
  detail: ReportDetail;
  /** Reveals an answer (question id, or a v1 reply's message id) in the Activity timeline. */
  onShowAnswer?: (anchor: string) => void;
  onOpenHistory?: () => void;
}

interface Row {
  index: number;
  entry: ManpowerEntry;
  badges: Array<{ kind: 'edited' | 'asked' | 'confirmed' | 'unconfirmed'; label: string }>;
  was: { workers: number | null; totalHours: number | null } | null;
}

/** Sources of one value (§10.3 v2), de-duplicated by kind + position or id, rendered as SourceLinks. */
export function SourceLinks({
  sources,
  detail,
  onShowAnswer,
  onOpenHistory,
  className,
}: {
  sources: Source[] | undefined;
  detail: ReportDetail;
  onShowAnswer?: (anchor: string) => void;
  onOpenHistory?: () => void;
  className?: string;
}) {
  if (!sources?.length) return null;
  const seen = new Set<string>();
  // A spoken answer's clip is cited too (`voice_note` 0:00 with the answer, W2-09): it plays.
  const clipIds = new Set([...detail.clips, ...detail.answerClips].map((c) => c.id));
  const spokenAnswers = new Set(
    detail.answerClips.flatMap((c) => (c.questionId ? [c.questionId] : [])),
  );
  const anchors = new Set(detail.activity.flatMap((e) => (e.anchor ? [e.anchor] : [])));
  // An answer to one of the report's questions shows when it came in. An upgraded v1 reply keeps
  // the reply message's id in questionId (report/upgrade.ts): it shows that message's time.
  const answer = (questionId: string) => {
    const q = detail.questions.find((x) => x.id === questionId);
    if (q) return { at: q.answeredAt, isReply: false };
    const m = detail.messages.find((x) => x.id === questionId);
    return { at: m?.at ?? null, isReply: true };
  };
  const editor = (s: Source) =>
    s.type === 'office_edit'
      ? (detail.versions.find((v) => v.author === 'office_user' && v.createdAt === s.at)
          ?.authorName ?? detail.versions.find((v) => v.author === 'office_user')?.authorName)
      : null;
  return (
    <span className={cn('inline-flex flex-wrap items-center gap-1', className)}>
      {sources.map((s, i) => {
        const key =
          s.type === 'voice_note'
            ? `voice_note:${s.uploadId}:${s.start}`
            : s.type === 'call'
              ? `call:${s.callId}:${s.start}`
              : s.type === 'office_edit'
                ? `edit:${s.at}`
                : s.type === 'reporter_edit'
                  ? `reporter_edit:${s.at}`
                  : s.type === 'weather_api'
                    ? 'wx'
                    : `answer:${s.questionId}`;
        const given = s.type === 'answer' ? answer(s.questionId) : null;
        if (seen.has(key)) return null;
        seen.add(key);
        return (
          <SourceLink
            key={`${key}-${i}`}
            source={s}
            clipIds={clipIds}
            timezone={detail.site.timezone}
            answerAt={given?.at ?? null}
            isReply={given?.isReply}
            editorName={editor(s)}
            onShowAnswer={
              s.type === 'answer' && anchors.has(s.questionId) ? onShowAnswer : undefined
            }
            spokenAnswer={s.type === 'answer' && spokenAnswers.has(s.questionId)}
            onOpenHistory={onOpenHistory}
          />
        );
      })}
    </span>
  );
}

/** Manpower table with EDITED Vn / ASKED hh:mm / CONFIRMED BY REPLY / UNCONFIRMED badges and the previous-version diff. */
export function ManpowerTable({ detail, onShowAnswer, onOpenHistory }: ManpowerTableProps) {
  const { t } = useCopy();
  const tz = detail.site.timezone;
  // WhatsApp-era reports were confirmed by a reply; v1.2 by an answer on the recorder or a call.
  const confirmedLabel =
    detail.report.channel === null ? t('report.confirmedByReply') : t('report.confirmedByAnswer');
  const changes = manpowerChanges(detail.previousData, detail.data);
  const companyById = new Map(detail.companies.map((c) => [c.id, c]));

  const rows: Row[] = detail.data.manpower.map((entry, index) => {
    const badges: Row['badges'] = [];
    const change = changes.get(index);
    if (change)
      badges.push({ kind: 'edited', label: t('report.diff.edited', { version: detail.version }) });
    const q = detail.questions.find(
      (x) =>
        x.manpowerIndex === index ||
        (x.companyName !== null && x.companyName === entry.companyName),
    );
    if (q?.answeredAt) badges.push({ kind: 'confirmed', label: confirmedLabel });
    else if (q?.askedAt)
      badges.push({
        kind: 'asked',
        label: t('report.questionAsked', { time: formatTimeInTz(q.askedAt, tz) }),
      });
    else if (entry.hoursBasis === 'answer')
      badges.push({ kind: 'confirmed', label: confirmedLabel });
    const company = entry.companyId ? companyById.get(entry.companyId) : undefined;
    if (!company || company.status === 'unconfirmed')
      badges.push({ kind: 'unconfirmed', label: t('chips.unconfirmed') });
    return { index, entry, badges, was: change ?? null };
  });

  const BADGE: Record<Row['badges'][number]['kind'], 'level' | 'tint' | 'filed' | 'dashed'> = {
    edited: 'level',
    asked: 'tint',
    confirmed: 'filed',
    unconfirmed: 'dashed',
  };

  const Diff = ({ now, was, changed }: { now: string; was: string; changed: boolean }) => (
    <span className="inline-flex flex-col items-end leading-tight">
      <span className={cn(changed && 'font-semibold')}>{now}</span>
      {changed ? (
        <span className="text-[11px] text-dust">
          <s aria-hidden="true">{was}</s>
          <span className="sr-only">{t('report.diff.was', { value: was })}</span>
        </span>
      ) : null}
    </span>
  );

  const columns: Column<Row>[] = [
    {
      key: 'company',
      header: t('report.manpower.company'),
      cell: (r) => (
        <div className="min-w-[180px]">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="font-semibold">{r.entry.companyName}</span>
            {r.badges.map((b) => (
              <Badge key={b.kind} variant={BADGE[b.kind]} data-badge={b.kind}>
                {b.label}
              </Badge>
            ))}
          </div>
          {r.entry.companyNameHeard &&
          r.entry.companyNameHeard.toLowerCase() !== r.entry.companyName.toLowerCase() ? (
            <div className="text-caption text-dust">
              {t('report.work.heardAs', { words: r.entry.companyNameHeard })}
            </div>
          ) : null}
        </div>
      ),
    },
    {
      key: 'trade',
      header: t('report.manpower.tradeArea'),
      hideBelowMd: true,
      cell: (r) => (
        <span className="text-caption text-dust">
          {[r.entry.trade ?? companyById.get(r.entry.companyId ?? '')?.trade, r.entry.area]
            .filter(Boolean)
            .join(' · ') || '—'}
        </span>
      ),
    },
    {
      key: 'workers',
      header: t('report.manpower.workers'),
      numeric: true,
      cell: (r) => (
        <Diff
          now={formatCrew(r.entry.workers)}
          was={formatCrew(r.was?.workers)}
          changed={!!r.was && r.was.workers !== r.entry.workers}
        />
      ),
    },
    {
      key: 'hours',
      header: t('report.manpower.hours'),
      numeric: true,
      cell: (r) => (
        <Diff
          now={formatHoursNum(r.entry.totalHours)}
          was={formatHoursNum(r.was?.totalHours)}
          changed={!!r.was && r.was.totalHours !== r.entry.totalHours}
        />
      ),
    },
    {
      key: 'source',
      header: t('report.manpower.source'),
      hideBelowMd: true,
      cell: (r) => (
        <SourceLinks
          sources={r.entry.source}
          detail={detail}
          onShowAnswer={onShowAnswer}
          onOpenHistory={onOpenHistory}
        />
      ),
    },
  ];

  return (
    <DataTable
      columns={columns}
      rows={rows}
      rowKey={(r) => `${r.index}-${r.entry.companyName}`}
      aria-label={t('report.sections.manpower')}
      footer={
        <TableRow>
          <TableCell className="font-semibold">{t('report.manpower.total')}</TableCell>
          <TableCell className="hidden md:table-cell" />
          <TableCell numeric data-testid="manpower-total-crew">
            {formatCrew(detail.totals.crewOnSite)}
            {!detail.totals.headcountKnown ? '+' : ''}
          </TableCell>
          <TableCell numeric data-testid="manpower-total-hours">
            {formatHoursNum(detail.totals.totalHours)}
            {!detail.totals.hoursKnown ? '+' : ''}
          </TableCell>
          <TableCell className="hidden md:table-cell" />
        </TableRow>
      }
    />
  );
}
