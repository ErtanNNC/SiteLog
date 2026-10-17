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
import { useSaveSettings, useSaveSiteRecipients, useSetOrgLogo, useSettings } from '@/data/hooks';
import type { OrgSettings, OrgSettingsPatch } from '@/data/types';
import type { CopyKey } from '@/i18n/keys';
import { useCopy } from '@/i18n/useCopy';
import { logoFileProblem } from '@/lib/logo';
import { cn } from '@/lib/utils';
import { FieldChannelsSection } from './FieldChannelsSection';
import { PayrollSection } from './PayrollSection';
import { PdfSection } from './PdfSection';
import { RecipientsSection, type RecipientsDraft } from './RecipientsSection';
import { ReportsSection } from './ReportsSection';
import { useUnsavedGuard } from './useUnsavedGuard';

/** P12 tabs, in the spec's order. */
const SECTIONS = ['reports', 'channels', 'pdf', 'recipients', 'payroll'] as const;
type Section = (typeof SECTIONS)[number];

const TAB_LABEL = {
  reports: 'settings.tabs.reports',
  channels: 'settings.tabs.fieldChannels',
  pdf: 'settings.tabs.pdf',
  recipients: 'settings.tabs.recipients',
  payroll: 'settings.tabs.payroll',
} as const satisfies Record<Section, CopyKey>;

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * P12 · Settings — section tabs + "Save changes" in the top bar, unsaved guard (§11.4, F18, F22).
 * EN/TR since W4-05.
 */
export default function SettingsPage() {
  const { t } = useCopy();
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
  // A field whose text cannot be saved (the daily link expiry) holds Save until it is fixed.
  const [invalid, setInvalid] = useState(false);
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
  const guard = useUnsavedGuard(dirty || invalid, '/settings');

  const save = async () => {
    if (!draft || !dirty || invalid) return;
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
    const problem = file ? logoFileProblem(file) : null;
    const error = problem ? t(`settings.pdf.${problem}`) : null;
    setLogoError(error);
    if (error) return;
    setLogoOverride({ url: file ? URL.createObjectURL(file) : null, at: Date.now() });
    setLogo.mutate(
      { file },
      {
        onSuccess: () => {
          if (file && isDemo) toast.message(t('settings.pdf.logoDemo'));
        },
        onError: () => setLogoOverride(null),
      },
    );
  };

  if (!section) return <Navigate to="/settings/reports" replace />;

  const controls = (
    <TopBarControls>
      <nav aria-label={t('settings.title')} className="hidden lg:block">
        <SectionTabs current={section} />
      </nav>
      <Button
        variant="primary"
        size="dense"
        disabled={!dirty || invalid}
        loading={saving}
        onClick={() => void save()}
        data-testid="save-settings"
      >
        <Save aria-hidden="true" />
        {t('settings.save')}
      </Button>
    </TopBarControls>
  );
  // Every branch renders it: the guard stays armed while a draft is dirty, so a guarded click
  // must always have a dialog to open.
  const leaveDialog = (
    <ConfirmDialog
      open={!!guard.pending}
      onOpenChange={(o) => !o && guard.cancel()}
      title={t('settings.unsavedTitle')}
      description={t('settings.unsavedBody')}
      confirmLabel={t('settings.leave')}
      cancelLabel={t('settings.stay')}
      destructive
      onConfirm={guard.proceed}
    />
  );

  // A failed first load leaves no data to seed the draft from: show the error, not a skeleton.
  // (A failed refetch keeps the loaded data and the draft, so the page stays editable.)
  if (settings.isError && !settings.data) {
    return (
      <>
        {controls}
        {leaveDialog}
        <ErrorState
          thing={t('settings.thing')}
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
        title={t('settings.title')}
        subtitle={t(TAB_LABEL[section])}
      />
      <div className="mb-5 lg:hidden">
        <SectionTabs current={section} />
      </div>

      {section === 'reports' ? <ReportsSection draft={draft} update={update} channelsLink /> : null}
      {section === 'channels' ? (
        <FieldChannelsSection
          draft={draft}
          update={update}
          org={settings.data.org}
          pack={settings.data.pack}
          onInvalidChange={setInvalid}
        />
      ) : null}
      {section === 'pdf' ? (
        <PdfSection
          draft={draft}
          update={update}
          org={settings.data.org}
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
  const { t } = useCopy();
  return (
    <div
      role="tablist"
      aria-label={t('settings.title')}
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
          {t(TAB_LABEL[s])}
        </Link>
      ))}
    </div>
  );
}
