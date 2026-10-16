import { BookOpen, Check, Plus, Search, X } from 'lucide-react';
import { useState } from 'react';
import type { TermStatus } from '@sitelog/shared/enums.ts';
import { DataTable, type Column } from '@/components/sitelog/DataTable';
import { PageHeader } from '@/components/sitelog/PageHeader';
import { PageSkeleton } from '@/components/sitelog/Skeletons';
import { EmptyState, ErrorState } from '@/components/sitelog/States';
import { Button } from '@/components/ui/Button';
import { Card, CardContent } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { Label } from '@/components/ui/Label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/Select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/Tabs';
import { useGlossary, useReviewGlossaryTerm } from '@/data/hooks';
import type { CompanyOption, GlossaryTerm } from '@/data/types';
import { useCopy, type CopyT } from '@/i18n/useCopy';
import { cn } from '@/lib/utils';
import { AddTermDialog } from './AddTermDialog';

type Tab = 'all' | 'companies' | 'spanish' | 'turkish';

/** P11's language tabs: the language a term was heard in (`glossary_terms.language`). */
const TAB_LANGUAGE: Partial<Record<Tab, string>> = { spanish: 'es', turkish: 'tr' };

type ChipKey =
  | 'chips.confirmed'
  | 'chips.autoLearned'
  | 'chips.builtIn'
  | 'chips.needs_review'
  | 'chips.rejected';

const SOURCE_CHIP: Record<TermStatus, { box: string; label: ChipKey }> = {
  confirmed: {
    box: 'border-chip-filed-bg bg-chip-filed-bg text-chip-filed-fg',
    label: 'chips.confirmed',
  },
  auto_learned: { box: 'border-rebar bg-concrete text-asphalt', label: 'chips.autoLearned' },
  built_in: { box: 'border-rebar bg-chalk text-dust', label: 'chips.builtIn' },
  needs_review: {
    box: 'border-chip-review-bg bg-chip-review-bg text-chip-review-fg',
    label: 'chips.needs_review',
  },
  rejected: {
    box: 'border-chip-miss-bg bg-chip-miss-bg text-chip-miss-fg',
    label: 'chips.rejected',
  },
};

function SourceChip({ status, t }: { status: TermStatus; t: CopyT }) {
  const s = SOURCE_CHIP[status];
  return (
    <span
      data-status={status}
      className={cn(
        'inline-flex h-6 items-center whitespace-nowrap rounded-chip border px-2 font-mono text-[11px] font-medium uppercase tracking-[0.08em]',
        s.box,
      )}
    >
      {t(s.label)}
    </span>
  );
}

/** "Heard 4× · Oakmont": how often, and the first word of the term's site when it has one. */
function heardLine(t: CopyT, term: GlossaryTerm): string {
  const site = term.scopeSiteName?.split(' ')[0];
  return site
    ? t('glossary.heardAt', { times: term.timesHeard, site })
    : t('glossary.heard', { times: term.timesHeard });
}

/**
 * P11 · Site glossary — review queue cards + all-terms table (§11.4, F17, F21), EN/TR (W3-08).
 * Tabs All · Companies · Spanish · Turkish. Every write is an audited RPC: the review card's
 * Approve, Change, Reject, Add as subcontractor and Map to… (`review_glossary_term`), and Add term
 * (`add_glossary_term`).
 */
export default function GlossaryPage() {
  const { t } = useCopy();
  const glossary = useGlossary();
  const [tab, setTab] = useState<Tab>('all');
  const [q, setQ] = useState('');
  const [addOpen, setAddOpen] = useState(false);

  const data = glossary.data;
  const needle = q.trim().toLocaleLowerCase();
  const language = TAB_LANGUAGE[tab];
  const terms = (data?.terms ?? []).filter((term) => {
    if (tab === 'companies' && term.kind !== 'company') return false;
    if (language && term.language !== language) return false;
    if (!needle) return true;
    return (
      term.heard.toLocaleLowerCase().includes(needle) ||
      (term.official ?? '').toLocaleLowerCase().includes(needle)
    );
  });

  const columns: Column<GlossaryTerm>[] = [
    {
      key: 'heard',
      header: t('glossary.columns.heard'),
      cell: (term) => (
        <span className="font-medium">
          “{term.heard}”
          {term.language !== 'en' ? (
            <span className="ml-1.5 font-mono text-[11px] uppercase tracking-[0.08em] text-dust">
              {term.language}
            </span>
          ) : null}
        </span>
      ),
    },
    {
      key: 'official',
      header: t('glossary.columns.official'),
      cell: (term) =>
        term.official ?? <span className="text-dust">{t('glossary.unknownCompany')}</span>,
    },
    {
      key: 'scope',
      header: t('glossary.columns.scope'),
      hideBelowMd: true,
      cell: (term) => (
        <span className="text-caption text-dust">
          {term.scopeSiteName ?? t('glossary.scope.org')}
        </span>
      ),
    },
    {
      key: 'times',
      header: t('glossary.columns.times'),
      numeric: true,
      cell: (term) => term.timesHeard,
    },
    {
      key: 'source',
      header: t('glossary.columns.source'),
      cell: (term) => <SourceChip status={term.status} t={t} />,
    },
  ];

  if (glossary.isPending) return <PageSkeleton />;
  if (glossary.isError || !data)
    return (
      <ErrorState
        thing={t('glossary.thing')}
        error={glossary.error}
        onRetry={() => void glossary.refetch()}
      />
    );

  const reviewTitle = t('glossary.reviewTitle', { n: data.reviewQueue.length });
  return (
    <>
      <PageHeader
        title={t('glossary.title')}
        subtitle={t('glossary.subtitle')}
        actions={
          <Button variant="secondary" onClick={() => setAddOpen(true)}>
            <Plus aria-hidden="true" />
            {t('glossary.addTerm')}
          </Button>
        }
      />

      <section aria-label={reviewTitle} className="mb-8">
        <h2 className="font-h2 mb-3 text-h2">{reviewTitle}</h2>
        {data.reviewQueue.length === 0 ? (
          <EmptyState
            icon={BookOpen}
            title={t('glossary.emptyReview')}
            body={t('glossary.emptyReviewBody')}
          />
        ) : (
          <ul
            className="grid gap-4 [grid-template-columns:repeat(auto-fit,minmax(min(300px,100%),1fr))]"
            data-testid="review-queue"
          >
            {data.reviewQueue.map((term) => (
              <li key={term.id}>
                <ReviewCard term={term} companies={data.companies} />
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* The filter tabs control the terms table, which is their tab panel. */}
      <Card>
        <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)}>
          <div className="flex flex-col gap-3 border-b border-rebar px-5 py-4 md:flex-row md:items-center md:justify-between">
            <h2 className="font-h2 text-h2">{t('glossary.all')}</h2>
            <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-center">
              <TabsList aria-label={t('common.filter')} className="max-w-full overflow-x-auto">
                <TabsTrigger value="all">{t('glossary.tabs.all')}</TabsTrigger>
                <TabsTrigger value="companies">{t('glossary.tabs.companies')}</TabsTrigger>
                <TabsTrigger value="spanish">{t('glossary.tabs.spanish')}</TabsTrigger>
                <TabsTrigger value="turkish">{t('glossary.tabs.turkish')}</TabsTrigger>
              </TabsList>
              <div className="relative">
                <Search
                  className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-dust"
                  aria-hidden="true"
                />
                <Input
                  type="search"
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  placeholder={t('glossary.search')}
                  aria-label={t('glossary.search')}
                  className="h-target-dense w-full pl-9 sm:w-[240px]"
                />
              </div>
            </div>
          </div>
          <TabsContent value={tab} className="mt-0">
            <CardContent className="px-0 pb-2 pt-0">
              <DataTable
                columns={columns}
                rows={terms}
                rowKey={(term) => term.id}
                aria-label={t('glossary.all')}
                empty={{
                  title: needle ? t('glossary.noResults', { q: q.trim() }) : t('glossary.empty'),
                }}
              />
            </CardContent>
          </TabsContent>
        </Tabs>
      </Card>

      <AddTermDialog open={addOpen} onOpenChange={setAddOpen} sites={data.sites} />
    </>
  );
}

function ReviewCard({ term, companies }: { term: GlossaryTerm; companies: CompanyOption[] }) {
  const { t } = useCopy();
  const review = useReviewGlossaryTerm();
  const [mode, setMode] = useState<'idle' | 'change' | 'map'>('idle');
  const [official, setOfficial] = useState(term.official ?? '');
  const [companyId, setCompanyId] = useState('');
  const isCompany = term.kind === 'company';
  const busy = review.isPending;
  const done = (action: Parameters<typeof review.mutate>[0]['action'], extra = {}) =>
    review.mutate({ termId: term.id, action, ...extra }, { onSuccess: () => setMode('idle') });

  return (
    <Card data-testid="review-card" data-kind={term.kind} className="flex h-full flex-col">
      <CardContent className="flex flex-1 flex-col p-5">
        <div className="eyebrow text-dust">
          {heardLine(t, term)}
          {term.language !== 'en' ? ` · ${term.language}` : ''}
        </div>
        <p className="font-h2 mt-2 break-words text-[22px] leading-7">“{term.heard}”</p>
        <p className="mt-1 flex items-center gap-2 text-[15px] text-dust">
          <span aria-hidden="true">→</span>
          <span className="sr-only">{t('glossary.arrow')}</span>
          <span className={cn('text-asphalt', !term.official && 'italic text-dust')}>
            {term.official ?? t('glossary.unknownCompany')}
          </span>
        </p>

        {mode === 'change' ? (
          <form
            className="mt-4 grid gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (official.trim()) done('change', { official: official.trim() });
            }}
          >
            <Label htmlFor={`change-${term.id}`}>{t('glossary.changeLabel')}</Label>
            <Input
              id={`change-${term.id}`}
              value={official}
              onChange={(e) => setOfficial(e.target.value)}
              autoFocus
            />
            <div className="flex gap-2">
              <Button type="submit" variant="secondary" size="dense" loading={busy}>
                <Check aria-hidden="true" />
                {t('glossary.saveChange')}
              </Button>
              <Button variant="ghost" size="dense" onClick={() => setMode('idle')}>
                <X aria-hidden="true" />
                {t('common.cancel')}
              </Button>
            </div>
          </form>
        ) : mode === 'map' ? (
          <form
            className="mt-4 grid gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (companyId) done('map_company', { companyId });
            }}
          >
            <Label htmlFor={`map-${term.id}`}>{t('glossary.mapToLabel')}</Label>
            <Select value={companyId} onValueChange={setCompanyId}>
              <SelectTrigger id={`map-${term.id}`}>
                <SelectValue placeholder={t('glossary.mapToPlaceholder')} />
              </SelectTrigger>
              <SelectContent>
                {companies
                  .filter((c) => !c.isSelfPerform)
                  .map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.name}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
            <div className="flex gap-2">
              <Button
                type="submit"
                variant="secondary"
                size="dense"
                loading={busy}
                disabled={!companyId}
              >
                {t('glossary.mapConfirm')}
              </Button>
              <Button variant="ghost" size="dense" onClick={() => setMode('idle')}>
                {t('common.cancel')}
              </Button>
            </div>
          </form>
        ) : (
          <div className="mt-auto flex flex-wrap gap-2 pt-4">
            {isCompany ? (
              <>
                <Button
                  variant="secondary"
                  size="dense"
                  loading={busy}
                  onClick={() => done('add_company')}
                >
                  {t('glossary.addAsSub')}
                </Button>
                <Button variant="ghost" size="dense" onClick={() => setMode('map')}>
                  {t('glossary.mapTo')}
                </Button>
              </>
            ) : (
              <>
                <Button
                  variant="secondary"
                  size="dense"
                  loading={busy}
                  onClick={() => done('approve')}
                >
                  <Check aria-hidden="true" />
                  {t('glossary.approve')}
                </Button>
                <Button variant="ghost" size="dense" onClick={() => setMode('change')}>
                  {t('glossary.change')}
                </Button>
              </>
            )}
            <Button
              variant="destructive"
              size="dense"
              loading={busy}
              onClick={() => done('reject')}
            >
              {t('glossary.reject')}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
