import { Save } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, Navigate, useParams } from 'react-router';
import { toast } from 'sonner';
import { useAuth } from '@/auth/AuthProvider';
import { TopBarControls } from '@/components/shell/TopBar';
import { PageHeader } from '@/components/sitelog/PageHeader';
import { PageSkeleton } from '@/components/sitelog/Skeletons';
import { ErrorState } from '@/components/sitelog/States';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/Dialog';
import { copy } from '@/copy/en';
import { useDataSource } from '@/data/DataProvider';
import { useSaveSettings, useSaveSiteRecipients, useSettings } from '@/data/hooks';
import type { OrgSettings, OrgSettingsPatch } from '@/data/types';
import { cn, storage } from '@/lib/utils';
import { PAYROLL_COLUMNS, PayrollSection } from './PayrollSection';
import { PdfSection } from './PdfSection';
import { RecipientsSection, type RecipientsDraft } from './RecipientsSection';
import { ReportsSection } from './ReportsSection';
import { useUnsavedGuard } from './useUnsavedGuard';

const SECTIONS = ['reports', 'pdf', 'recipients', 'payroll'] as const;
type Section = (typeof SECTIONS)[number];

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** P12 · Settings — section tabs + "Save changes" in the top bar, unsaved guard (§11.4, F18). */
export default function SettingsPage() {
  const { section: sectionParam } = useParams();
  const section = (SECTIONS as readonly string[]).includes(sectionParam ?? '')
    ? (sectionParam as Section)
    : null;
  const source = useDataSource();
  const { isDemo } = useAuth();
  const settings = useSettings();
  const saveSettings = useSaveSettings();
  const saveRecipients = useSaveSiteRecipients();

  // Baseline (last loaded / saved) and the editable draft.
  const [baseline, setBaseline] = useState<{ settings: OrgSettings; recipients: RecipientsDraft } | null>(
    null,
  );
  const [draft, setDraft] = useState<OrgSettings | null>(null);
  const [recipients, setRecipients] = useState<RecipientsDraft>([]);
  const [logoUrl, setLogoUrl] = useState<string | null>(null);
  const columnsKey = `sitelog.payrollColumns.${source.orgId}`;
  const [columns, setColumns] = useState<string[]>(() =>
    storage.get<string[]>(columnsKey, [...PAYROLL_COLUMNS]),
  );

  useEffect(() => {
    if (!settings.data || baseline) return;
    const base = { settings: settings.data.settings, recipients: settings.data.siteRecipients };
    setBaseline(base);
    setDraft(structuredClone(base.settings));
    setRecipients(structuredClone(base.recipients));
  }, [settings.data, baseline]);

  const update = useCallback(
    (patch: Partial<OrgSettings>) => setDraft((d) => (d ? { ...d, ...patch } : d)),
    [],
  );

  const settingsPatch = useMemo<OrgSettingsPatch>(() => {
    if (!draft || !baseline) return {};
    const patch: Record<string, unknown> = {};
    for (const key of Object.keys(draft) as Array<keyof OrgSettings>) {
      if (!sameJson(draft[key], baseline.settings[key])) patch[key] = draft[key];
    }
    return patch as OrgSettingsPatch;
  }, [draft, baseline]);
  const changedRecipients = useMemo(
    () =>
      recipients.filter((r) => {
        const b = baseline?.recipients.find((x) => x.siteId === r.siteId);
        return !b || !sameJson(b.emails, r.emails);
      }),
    [recipients, baseline],
  );
  const dirty = Object.keys(settingsPatch).length > 0 || changedRecipients.length > 0;
  const saving = saveSettings.isPending || saveRecipients.isPending;
  const guard = useUnsavedGuard(dirty, '/settings');

  const save = async () => {
    if (!draft || !dirty) return;
    try {
      if (Object.keys(settingsPatch).length) await saveSettings.mutateAsync(settingsPatch);
      for (const r of changedRecipients) {
        await saveRecipients.mutateAsync({ siteId: r.siteId, emails: r.emails });
      }
      setBaseline({ settings: structuredClone(draft), recipients: structuredClone(recipients) });
    } catch {
      /* the mutation hook already toasted */
    }
  };

  const onLogoChange = (file: File | null) => {
    if (logoUrl) URL.revokeObjectURL(logoUrl);
    if (!file) {
      setLogoUrl(null);
      return;
    }
    if (file.size > 2 * 1024 * 1024) {
      toast.error(copy.setup.company.logoTooLarge);
      return;
    }
    setLogoUrl(URL.createObjectURL(file));
    if (isDemo) toast.message(copy.settings.pdf.logoPreviewOnly);
  };

  const onColumnsChange = (next: string[]) => {
    setColumns(next);
    storage.set(columnsKey, next);
  };

  if (!section) return <Navigate to="/settings/reports" replace />;

  const controls = (
    <TopBarControls>
      <nav aria-label={copy.settings.title} className="hidden lg:block">
        <SectionTabs current={section} />
      </nav>
      <Button
        variant="primary"
        size="dense"
        disabled={!dirty}
        loading={saving}
        onClick={() => void save()}
        data-testid="save-settings"
      >
        <Save aria-hidden="true" />
        {copy.settings.save}
      </Button>
    </TopBarControls>
  );

  if (settings.isPending || !draft) {
    return (
      <>
        {controls}
        <PageSkeleton />
      </>
    );
  }
  if (settings.isError || !settings.data) {
    return (
      <>
        {controls}
        <ErrorState
          thing={copy.nav.settings.toLowerCase()}
          error={settings.error}
          onRetry={() => void settings.refetch()}
        />
      </>
    );
  }

  return (
    <>
      {controls}
      <PageHeader
        eyebrow={settings.data.org.name}
        title={copy.settings.tabs[section]}
        subtitle={copy.settings.title}
      />
      <div className="mb-5 lg:hidden">
        <SectionTabs current={section} />
      </div>

      {section === 'reports' ? <ReportsSection draft={draft} update={update} /> : null}
      {section === 'pdf' ? (
        <PdfSection
          draft={draft}
          update={update}
          orgName={settings.data.org.name}
          logoUrl={logoUrl}
          onLogoChange={onLogoChange}
        />
      ) : null}
      {section === 'recipients' ? (
        <RecipientsSection draft={recipients} update={setRecipients} />
      ) : null}
      {section === 'payroll' ? (
        <PayrollSection
          draft={draft}
          update={update}
          columns={columns}
          onColumnsChange={onColumnsChange}
        />
      ) : null}

      <ConfirmDialog
        open={!!guard.pending}
        onOpenChange={(o) => !o && guard.cancel()}
        title={copy.settings.unsavedTitle}
        description={copy.settings.unsavedBody}
        confirmLabel={copy.settings.leave}
        cancelLabel={copy.settings.stay}
        destructive
        onConfirm={guard.proceed}
      />
    </>
  );
}

function SectionTabs({ current }: { current: Section }) {
  return (
    <div
      role="tablist"
      aria-label={copy.settings.title}
      className="inline-flex h-11 max-w-full items-center gap-1 overflow-x-auto rounded-btn border border-rebar bg-chalk p-1 scrollbar-thin"
    >
      {SECTIONS.map((s) => (
        <Link
          key={s}
          to={`/settings/${s}`}
          role="tab"
          aria-selected={s === current}
          className={cn(
            'inline-flex h-9 items-center whitespace-nowrap rounded-chip px-3 text-[15px] font-medium',
            s === current ? 'bg-asphalt text-chalk' : 'text-dust hover:text-asphalt',
          )}
        >
          {copy.settings.tabs[s]}
        </Link>
      ))}
    </div>
  );
}
