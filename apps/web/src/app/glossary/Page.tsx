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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/Select';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/Tabs';
import { copy } from '@/copy/en';
import { useGlossary, useReviewGlossaryTerm } from '@/data/hooks';
import type { CompanyOption, GlossaryTerm } from '@/data/types';
import { cn } from '@/lib/utils';
import { AddTermDialog } from './AddTermDialog';

type Tab = 'all' | 'companies' | 'spanish';

const SOURCE_CHIP: Record<TermStatus, { box: string; label: string }> = {
  confirmed: { box: 'border-chip-filed-bg bg-chip-filed-bg text-chip-filed-fg', label: copy.chips.confirmed },
  auto_learned: { box: 'border-rebar bg-concrete text-asphalt', label: copy.chips.autoLearned },
  built_in: { box: 'border-rebar bg-chalk text-dust', label: copy.chips.builtIn },
  needs_review: {
    box: 'border-chip-review-bg bg-chip-review-bg text-chip-review-fg',
    label: copy.chips.needs_review,
  },
  rejected: { box: 'border-chip-miss-bg bg-chip-miss-bg text-chip-miss-fg', label: copy.chips.rejected },
};

function SourceChip({ status }: { status: TermStatus }) {
  const s = SOURCE_CHIP[status];
  return (
    <span
      data-status={status}
      className={cn(
        'inline-flex h-6 items-center whitespace-nowrap rounded-chip border px-2 font-mono text-[11px] font-medium uppercase tracking-[0.08em]',
        s.box,
      )}
    >
      {s.label}
    </span>
  );
}

/** P11 · Site glossary — review queue cards + all-terms table (§11.4, F17). */
export default function GlossaryPage() {
  const glossary = useGlossary();
  const [tab, setTab] = useState<Tab>('all');
  const [q, setQ] = useState('');
  const [addOpen, setAddOpen] = useState(false);

  const data = glossary.data;
  const needle = q.trim().toLowerCase();
  const terms = (data?.terms ?? []).filter((t) => {
    if (tab === 'companies' && t.kind !== 'company') return false;
    if (tab === 'spanish' && t.language !== 'es') return false;
    if (!needle) return true;
    return (
      t.heard.toLowerCase().includes(needle) || (t.official ?? '').toLowerCase().includes(needle)
    );
  });

  const columns: Column<GlossaryTerm>[] = [
    {
      key: 'heard',
      header: copy.glossary.columns.heard,
      cell: (t) => (
        <span className="font-medium">
          “{t.heard}”
          {t.language !== 'en' ? (
            <span className="ml-1.5 font-mono text-[11px] uppercase tracking-[0.08em] text-dust">
              {t.language}
            </span>
          ) : null}
        </span>
      ),
    },
    {
      key: 'official',
      header: copy.glossary.columns.official,
      cell: (t) => t.official ?? <span className="text-dust">{copy.glossary.unknownCompany}</span>,
    },
    {
      key: 'scope',
      header: copy.glossary.columns.scope,
      hideBelowMd: true,
      cell: (t) => (
        <span className="text-caption text-dust">
          {t.scopeSiteName ? copy.glossary.scope.site(t.scopeSiteName) : copy.glossary.scope.org}
        </span>
      ),
    },
    {
      key: 'times',
      header: copy.glossary.columns.times,
      numeric: true,
      cell: (t) => t.timesHeard,
    },
    {
      key: 'source',
      header: copy.glossary.columns.source,
      cell: (t) => <SourceChip status={t.status} />,
    },
  ];

  if (glossary.isPending) return <PageSkeleton />;
  if (glossary.isError || !data)
    return (
      <ErrorState
        thing={copy.nav.glossary.toLowerCase()}
        error={glossary.error}
        onRetry={() => void glossary.refetch()}
      />
    );

  return (
    <>
      <PageHeader
        title={copy.glossary.title}
        subtitle={copy.glossary.subtitle}
        actions={
          <Button variant="secondary" onClick={() => setAddOpen(true)}>
            <Plus aria-hidden="true" />
            {copy.glossary.addTerm}
          </Button>
        }
      />

      <section aria-label={copy.glossary.reviewTitle(data.reviewQueue.length)} className="mb-8">
        <h2 className="font-h2 mb-3 text-h2">{copy.glossary.reviewTitle(data.reviewQueue.length)}</h2>
        {data.reviewQueue.length === 0 ? (
          <EmptyState
            icon={BookOpen}
            title={copy.glossary.emptyReview}
            body={copy.glossary.emptyReviewBody}
          />
        ) : (
          <ul
            className="grid gap-4 [grid-template-columns:repeat(auto-fit,minmax(300px,1fr))]"
            data-testid="review-queue"
          >
            {data.reviewQueue.map((t) => (
              <li key={t.id}>
                <ReviewCard term={t} companies={data.companies} />
              </li>
            ))}
          </ul>
        )}
      </section>

      <Card>
        <div className="flex flex-col gap-3 border-b border-rebar px-5 py-4 md:flex-row md:items-center md:justify-between">
          <h2 className="font-h2 text-h2">{copy.glossary.all}</h2>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
            <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)}>
              <TabsList aria-label={copy.common.filter}>
                <TabsTrigger value="all">{copy.glossary.tabs.all}</TabsTrigger>
                <TabsTrigger value="companies">{copy.glossary.tabs.companies}</TabsTrigger>
                <TabsTrigger value="spanish">{copy.glossary.tabs.spanish}</TabsTrigger>
              </TabsList>
            </Tabs>
            <div className="relative">
              <Search
                className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-dust"
                aria-hidden="true"
              />
              <Input
                type="search"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder={copy.glossary.search}
                aria-label={copy.glossary.search}
                className="h-10 w-full pl-9 sm:w-[240px]"
              />
            </div>
          </div>
        </div>
        <CardContent className="px-0 pb-2 pt-0">
          <DataTable
            columns={columns}
            rows={terms}
            rowKey={(t) => t.id}
            aria-label={copy.glossary.all}
            empty={{ title: needle ? copy.glossary.noResults(q.trim()) : copy.glossary.empty }}
          />
        </CardContent>
      </Card>

      <AddTermDialog open={addOpen} onOpenChange={setAddOpen} sites={data.sites} />
    </>
  );
}

function ReviewCard({ term, companies }: { term: GlossaryTerm; companies: CompanyOption[] }) {
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
          {copy.glossary.heard(term.timesHeard, term.scopeSiteName ? term.scopeSiteName.split(' ')[0]! : null)}
          {term.language !== 'en' ? ` · ${term.language}` : ''}
        </div>
        <p className="font-h2 mt-2 text-[22px] leading-7">“{term.heard}”</p>
        <p className="mt-1 flex items-center gap-2 text-[15px] text-dust">
          <span aria-hidden="true">→</span>
          <span className="sr-only">{copy.glossary.arrow}</span>
          <span className={cn('text-asphalt', !term.official && 'italic text-dust')}>
            {term.official ?? copy.glossary.unknownCompany}
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
            <Label htmlFor={`change-${term.id}`}>{copy.glossary.changeLabel}</Label>
            <Input
              id={`change-${term.id}`}
              value={official}
              onChange={(e) => setOfficial(e.target.value)}
              autoFocus
            />
            <div className="flex gap-2">
              <Button type="submit" variant="secondary" size="dense" loading={busy}>
                <Check aria-hidden="true" />
                {copy.glossary.saveChange}
              </Button>
              <Button variant="ghost" size="dense" onClick={() => setMode('idle')}>
                <X aria-hidden="true" />
                {copy.common.cancel}
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
            <Label htmlFor={`map-${term.id}`}>{copy.glossary.mapToLabel}</Label>
            <Select value={companyId} onValueChange={setCompanyId}>
              <SelectTrigger id={`map-${term.id}`}>
                <SelectValue placeholder={copy.glossary.mapToPlaceholder} />
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
              <Button type="submit" variant="secondary" size="dense" loading={busy} disabled={!companyId}>
                {copy.glossary.mapConfirm}
              </Button>
              <Button variant="ghost" size="dense" onClick={() => setMode('idle')}>
                {copy.common.cancel}
              </Button>
            </div>
          </form>
        ) : (
          <div className="mt-auto flex flex-wrap gap-2 pt-4">
            {isCompany ? (
              <>
                <Button variant="secondary" size="dense" loading={busy} onClick={() => done('add_company')}>
                  {copy.glossary.addAsSub}
                </Button>
                <Button variant="ghost" size="dense" onClick={() => setMode('map')}>
                  {copy.glossary.mapTo}
                </Button>
              </>
            ) : (
              <>
                <Button variant="secondary" size="dense" loading={busy} onClick={() => done('approve')}>
                  <Check aria-hidden="true" />
                  {copy.glossary.approve}
                </Button>
                <Button variant="ghost" size="dense" onClick={() => setMode('change')}>
                  {copy.glossary.change}
                </Button>
              </>
            )}
            <Button variant="destructive" size="dense" loading={busy} onClick={() => done('reject')}>
              {copy.glossary.reject}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
