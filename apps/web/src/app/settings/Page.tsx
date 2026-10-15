import { Save } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, Navigate, useParams } from 'react-router';
import { toast } from 'sonner';
import { useAuth } from '@/auth/AuthProvider';
import { TopBarControls } from '@/components/shell/TopBar';
import { ComingNext } from '@/app/ComingNext';
import { PageHeader } from '@/components/sitelog/PageHeader';
import { PageSkeleton } from '@/components/sitelog/Skeletons';
import { ErrorState } from '@/components/sitelog/States';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/Dialog';
import { copy } from '@/copy/en';
import { useSaveSettings, useSaveSiteRecipients, useSetOrgLogo, useSettings } from '@/data/hooks';
import type { OrgSettings, OrgSettingsPatch } from '@/data/types';
import { logoFileError } from '@/lib/logo';
import { cn } from '@/lib/utils';
import { PayrollSection } from './PayrollSection';
import { PdfSection } from './PdfSection';
import { RecipientsSection, type RecipientsDraft } from './RecipientsSection';
import { ReportsSection } from './ReportsSection';
import { useUnsavedGuard } from './useUnsavedGuard';

/** P12 tabs, in the spec's order. `channels` (Field channels) is a placeholder until W1-08. */
const SECTIONS = ['reports', 'channels', 'pdf', 'recipients', 'payroll'] as const;
type Section = (typeof SECTIONS)[number];

const TAB_LABEL: Record<Section, string> = {
  reports: copy.settings.tabs.reports,
  channels: copy.settings.tabs.fieldChannels,
  pdf: copy.settings.tabs.pdf,
  recipients: copy.settings.tabs.recipients,
  payroll: copy.settings.tabs.payroll,
};

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** P12 · Settings — section tabs + "Save changes" in the top bar, unsaved guard (§11.4, F18). */
export default function SettingsPage() {
  const { section: sectionParam } = useParams();
  const section = (SECTIONS as readonly string[]).includes(sectionParam ?? '')
    ? (sectionParam as Section)
    : null;
  const { isDemo } = useAuth();
  const settings = useSettings();
  const saveSettings = useSaveSettings();
  const saveRecipients = useSaveSiteRecipients();
  const setLogo = useSetOrgLogo();

  // Baseline (last loaded / saved) and the editable draft.
  const [baseline, setBaseline] = useState<{
    settings: OrgSettings;
    recipients: RecipientsDraft;
  } | null>(null);
  const [draft, setDraft] = useState<OrgSettings | null>(null);
  const [recipients, setRecipients] = useState<RecipientsDraft>([]);
  // The picked (or removed) logo shows at once; the stored one (signed URL) takes over after
  // the settings refetch that follows a successful upload, so the preview never flickers.
  const [logoOverride, setLogoOverride] = useState<{ url: string | null; at: number } | null>(null);
  const [logoError, setLogoError] = useState<string | null>(null);
  const overrideUrl = logoOverride?.url ?? null;
  useEffect(() => () => void (overrideUrl && URL.revokeObjectURL(overrideUrl)), [overrideUrl]);
  if (logoOverride && !setLogo.isPending && settings.dataUpdatedAt > logoOverride.at) {
    setLogoOverride(null);
  }

  // Seed the draft from the first load (adjusting state during render avoids an effect round-trip).
  if (settings.data && !baseline) {
    const base = { settings: settings.data.settings, recipients: settings.data.siteRecipients };
    setBaseline(base);
    setDraft(structuredClone(base.settings));
    setRecipients(structuredClone(base.recipients));
  }

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

  /** Logo upload / removal is saved right away (Storage + orgs.logo_path), not with "Save". */
  const onLogoChange = (file: File | null) => {
    const error = file ? logoFileError(file) : null;
    setLogoError(error);
    if (error) return;
    setLogoOverride({ url: file ? URL.createObjectURL(file) : null, at: Date.now() });
    setLogo.mutate(
      { file },
      {
        onSuccess: () => {
          if (file && isDemo) toast.message(copy.settings.pdf.logoDemo);
        },
        onError: () => setLogoOverride(null),
      },
    );
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
  // Every branch renders it: the guard stays armed while a draft is dirty (switching to the
  // Field channels tab keeps it), so a guarded click must always have a dialog to open.
  const leaveDialog = (
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
  );

  if (section === 'channels') {
    return (
      <>
        {controls}
        {leaveDialog}
        <ComingNext
          eyebrow={settings.data?.org.name}
          title={copy.settings.title}
          subtitle={TAB_LABEL.channels}
        >
          <div className="mb-5 lg:hidden">
            <SectionTabs current={section} />
          </div>
        </ComingNext>
      </>
    );
  }

  // A failed first load leaves no data to seed the draft from: show the error, not a skeleton.
  // (A failed refetch keeps the loaded data and the draft, so the page stays editable.)
  if (settings.isError && !settings.data) {
    return (
      <>
        {controls}
        {leaveDialog}
        <ErrorState
          thing={copy.nav.settings.toLowerCase()}
          error={settings.error}
          onRetry={() => void settings.refetch()}
        />
      </>
    );
  }
  if (!settings.data || !draft) {
    return (
      <>
        {controls}
        {leaveDialog}
        <PageSkeleton />
      </>
    );
  }

  return (
    <>
      {controls}
      <PageHeader
        eyebrow={settings.data.org.name}
        title={copy.settings.title}
        subtitle={TAB_LABEL[section]}
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
          logoUrl={logoOverride ? logoOverride.url : settings.data.org.logoUrl}
          onLogoChange={onLogoChange}
          logoBusy={setLogo.isPending}
          logoError={logoError}
        />
      ) : null}
      {section === 'recipients' ? (
        <RecipientsSection draft={recipients} update={setRecipients} />
      ) : null}
      {section === 'payroll' ? <PayrollSection draft={draft} update={update} /> : null}

      {leaveDialog}
    </>
  );
}

function SectionTabs({ current }: { current: Section }) {
  return (
    <div
      role="tablist"
      aria-label={copy.settings.title}
      className="inline-flex h-target max-w-full items-center gap-1 overflow-x-auto rounded-btn border border-rebar bg-chalk p-1 scrollbar-thin"
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
          {TAB_LABEL[s]}
        </Link>
      ))}
    </div>
  );
}
