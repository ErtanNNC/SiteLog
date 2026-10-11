import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, Navigate, useNavigate, useParams } from 'react-router';
import { toast } from 'sonner';
import { useAuth } from '@/auth/AuthProvider';
import { Logo } from '@/components/shell/Sidebar';
import { phoneValue, type PhoneCountryCode } from '@/components/sitelog/PhoneInput';
import { PageSkeleton } from '@/components/sitelog/Skeletons';
import { Button } from '@/components/ui/Button';
import { copy } from '@/copy/en';
import { useOptionalDataSource } from '@/data/DataProvider';
import {
  useCreateOrg,
  useCreateSite,
  useInviteReporter,
  useSaveSettings,
  useSaveSiteRecipients,
  useSettings,
  useSetupState,
} from '@/data/hooks';
import type { OrgSettings } from '@/data/types';
import { supabase } from '@/lib/supabase';
import { CompanyStep } from './CompanyStep';
import { Stepper } from './fields';
import { ReportsStep } from './ReportsStep';
import { SiteStep, type SiteSubmit } from './SiteStep';
import {
  clearProgress,
  emptySite,
  loadProgress,
  nextStep,
  saveProgress,
  SETUP_STEPS,
  type SetupProgress,
  type SetupStep,
} from './state';

/** P2 · Setup wizard — /setup/company · /setup/site · /setup/reports, outside the app shell (F2). */
export default function SetupPage() {
  const source = useOptionalDataSource();
  return source ? <Wizard /> : <NoOrgWizard />;
}

function useProgress() {
  const { user, currentOrg } = useAuth();
  const userId = user?.id ?? 'anon';
  const [progress, setProgressState] = useState<SetupProgress>(() => {
    const p = loadProgress(userId, currentOrg?.timezone);
    if (currentOrg) {
      p.done.company = true;
      if (!p.company.name) p.company.name = currentOrg.name;
      if (!p.company.timezone) p.company.timezone = currentOrg.timezone;
    }
    return p;
  });
  const setProgress = useCallback(
    (fn: (prev: SetupProgress) => SetupProgress) =>
      setProgressState((prev) => {
        const next = fn(prev);
        saveProgress(userId, next);
        return next;
      }),
    [userId],
  );
  return { progress, setProgress, userId };
}

function useLogoPreview() {
  const [logoUrl, setLogoUrl] = useState<string | null>(null);
  useEffect(() => () => void (logoUrl && URL.revokeObjectURL(logoUrl)), [logoUrl]);
  return {
    logoUrl,
    onLogoChange: (file: File | null) => {
      const url = file ? URL.createObjectURL(file) : null;
      setLogoUrl(url);
      return url;
    },
  };
}

function SetupLayout({
  step,
  done,
  title,
  subtitle,
  children,
}: {
  step: SetupStep;
  done: SetupProgress['done'];
  title: string;
  subtitle?: string;
  children: ReactNode;
}) {
  const { currentOrg } = useAuth();
  const navigate = useNavigate();
  return (
    <div className="min-h-screen bg-concrete">
      <header className="on-dark sticky top-0 z-30 flex h-16 items-center justify-between bg-asphalt px-4 text-chalk md:px-8">
        <div className="flex min-w-0 items-center gap-4">
          <Logo />
          <span className="hidden truncate text-caption text-dust-light sm:inline" data-testid="setup-header">
            {copy.setup.header(currentOrg?.name ?? copy.setup.title)}
          </span>
        </div>
        <Button
          variant="ghost"
          size="dense"
          className="border-iron bg-transparent text-chalk hover:bg-steel"
          onClick={() => {
            toast.success(copy.setup.savedLater);
            void navigate(currentOrg ? '/' : '/login');
          }}
        >
          {copy.setup.saveLater}
        </Button>
      </header>
      <main className="mx-auto max-w-[1240px] px-4 py-7 md:px-8">
        <div className="mb-6">
          <div className="eyebrow mb-1 text-dust">{copy.setup.title}</div>
          <h1 className="font-display text-[28px] leading-[34px] md:text-h1">{title}</h1>
          {subtitle ? <p className="mt-1 text-[15px] text-dust">{subtitle}</p> : null}
        </div>
        <div className="mb-6">
          <Stepper current={step} done={done} />
        </div>
        {children}
      </main>
    </div>
  );
}

/** Supabase user without an org: only the company step is possible until `create_org` runs. */
function NoOrgWizard() {
  const { refreshOrgs } = useAuth();
  const { progress, setProgress } = useProgress();
  const logo = useLogoPreview();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const { step } = useParams();
  if (step && step !== 'company') return <Navigate to="/setup/company" replace />;
  const create = async () => {
    if (!supabase) {
      toast.error(copy.errors.generic);
      return;
    }
    setBusy(true);
    try {
      const { data, error } = await supabase.rpc('create_org', {
        p_name: progress.company.name.trim(),
        p_timezone: progress.company.timezone,
        p_address: progress.company.address.trim() || null,
        p_license_no: progress.company.licenseNo.trim() || null,
      } as never);
      if (error) throw new Error(error.message);
      const id = (data as { id?: string } | null)?.id;
      if (!id) throw new Error(copy.errors.generic);
      setProgress((p) => ({ ...p, done: { ...p.done, company: true }, flow: 'wizard' }));
      await refreshOrgs();
      toast.success(copy.toasts.orgCreated(progress.company.name.trim()));
      void navigate('/setup/site', { replace: true });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : copy.errors.generic);
    } finally {
      setBusy(false);
    }
  };
  return (
    <SetupLayout step="company" done={progress.done} title={copy.setup.title}>
      <CompanyStep
        draft={progress.company}
        onChange={(company) => setProgress((p) => ({ ...p, company }))}
        onContinue={() => void create()}
        busy={busy}
        logoUrl={logo.logoUrl}
        onLogoChange={logo.onLogoChange}
      />
    </SetupLayout>
  );
}

function Wizard() {
  const { step: stepParam } = useParams();
  const navigate = useNavigate();
  const { currentOrg, isDemo, refreshOrgs } = useAuth();
  const { progress, setProgress, userId } = useProgress();
  const logo = useLogoPreview();
  const setupState = useSetupState();
  const settings = useSettings();
  const createOrg = useCreateOrg();
  const createSite = useCreateSite();
  const inviteReporter = useInviteReporter();
  const saveSettings = useSaveSettings();
  const saveRecipients = useSaveSiteRecipients();

  const [draft, setDraft] = useState<OrgSettings | null>(null);
  useEffect(() => {
    if (settings.data && !draft) setDraft(structuredClone(settings.data.settings));
  }, [settings.data, draft]);
  const update = useCallback(
    (patch: Partial<OrgSettings>) => setDraft((d) => (d ? { ...d, ...patch } : d)),
    [],
  );

  const step = (SETUP_STEPS as readonly string[]).includes(stepParam ?? '')
    ? (stepParam as SetupStep)
    : null;
  // "Add site" mode: the org already has sites and the user came for one more (from /sites).
  const addSiteMode =
    step === 'site' &&
    (setupState.data?.siteCount ?? 0) > 0 &&
    progress.flow !== 'wizard' &&
    !progress.createdSites.length;
  // Project numbers must be unique per org: the ones created in this run plus the org's sites.
  const existingCodes = useMemo(
    () => [...(setupState.data?.projectCodes ?? []), ...progress.createdSites.map((s) => s.code)],
    [setupState.data, progress.createdSites],
  );

  if (!step) return <Navigate to={`/setup/${nextStep(progress.done)}`} replace />;
  if (step !== 'company' && !progress.done.company) return <Navigate to="/setup/company" replace />;
  if (step === 'reports' && !progress.done.site && !addSiteMode)
    return <Navigate to="/setup/site" replace />;

  const companyName = currentOrg?.name ?? progress.company.name;

  const continueFromCompany = () => {
    createOrg.mutate(
      {
        name: progress.company.name.trim(),
        timezone: progress.company.timezone,
        address: progress.company.address.trim() || null,
        licenseNo: progress.company.licenseNo.trim() || null,
      },
      {
        onSuccess: async () => {
          setProgress((p) => ({ ...p, done: { ...p.done, company: true }, flow: 'wizard' }));
          await refreshOrgs();
          void navigate('/setup/site');
        },
      },
    );
  };

  const submitSite = async ({ draft: s, lat, lng }: SiteSubmit, another: boolean) => {
    try {
      const phone = s.managerPhone;
      const { siteId } = await createSite.mutateAsync({
        name: s.name.trim(),
        projectCode: s.projectCode.trim(),
        address: s.address.trim() || null,
        lat,
        lng,
        timezone: s.timezone,
        deadline: s.deadline ? `${s.deadline}:00` : null,
        recipients: progress.reports.recipients,
        reporter: {
          name: s.managerName.trim(),
          phone: normalizedPhone(s.managerCountry, phone),
          role: 'site_manager',
          siteIds: [],
          languages: s.languages.length ? s.languages : ['en'],
        },
      });
      if (s.hasBackup && s.backupName.trim() && s.backupPhone.trim()) {
        await inviteReporter.mutateAsync({
          name: s.backupName.trim(),
          phone: normalizedPhone(s.backupCountry, s.backupPhone),
          role: 'backup',
          siteIds: [siteId],
          languages: s.languages.length ? s.languages : ['en'],
        });
      }
      toast.success(copy.setup.site.sent(s.managerName.trim()));
      await refreshOrgs();
      if (addSiteMode) {
        clearProgress(userId);
        void navigate('/sites');
        return;
      }
      setProgress((p) => ({
        ...p,
        done: { ...p.done, site: true },
        createdSites: [
          ...p.createdSites,
          { id: siteId, name: s.name.trim(), code: s.projectCode.trim() },
        ],
        site: emptySite(p.company.timezone),
      }));
      if (!another) void navigate('/setup/reports');
    } catch {
      /* toasted by the mutation hooks */
    }
  };

  const finish = async () => {
    if (!draft || !settings.data) return;
    try {
      const patch: Record<string, unknown> = {};
      for (const key of Object.keys(draft) as Array<keyof OrgSettings>) {
        if (JSON.stringify(draft[key]) !== JSON.stringify(settings.data.settings[key]))
          patch[key] = draft[key];
      }
      await saveSettings.mutateAsync(patch);
      for (const site of progress.createdSites) {
        await saveRecipients.mutateAsync({ siteId: site.id, emails: progress.reports.recipients });
      }
      clearProgress(userId);
      toast.success(copy.setup.reports.finished);
      await refreshOrgs();
      void navigate('/', { replace: true });
    } catch {
      /* toasted by the mutation hooks */
    }
  };

  const title = addSiteMode ? copy.setup.addSiteTitle : copy.setup.title;
  const subtitle = addSiteMode ? copy.setup.addSiteSubtitle : undefined;

  return (
    <SetupLayout step={step} done={progress.done} title={title} subtitle={subtitle}>
      {step === 'company' ? (
        <CompanyStep
          draft={progress.company}
          onChange={(company) => setProgress((p) => ({ ...p, company }))}
          onContinue={continueFromCompany}
          busy={createOrg.isPending}
          logoUrl={logo.logoUrl}
          onLogoChange={logo.onLogoChange}
        />
      ) : null}
      {step === 'site' ? (
        <SiteStep
          draft={progress.site}
          onChange={(site) => setProgress((p) => ({ ...p, site }))}
          onBack={() => void navigate(addSiteMode ? '/sites' : '/setup/company')}
          onSubmit={(input, another) => void submitSite(input, another)}
          busy={createSite.isPending || inviteReporter.isPending}
          companyName={companyName}
          existingCodes={existingCodes}
          createdCount={progress.createdSites.length}
          canGeocode={!isDemo}
          siteCount={(setupState.data?.siteCount ?? 0) + 1}
        />
      ) : null}
      {step === 'reports' ? (
        draft ? (
          <ReportsStep
            draft={draft}
            update={update}
            recipients={progress.reports.recipients}
            onRecipientsChange={(recipients) =>
              setProgress((p) => ({ ...p, reports: { ...p.reports, recipients } }))
            }
            onBack={() => void navigate('/setup/site')}
            onFinish={() => void finish()}
            busy={saveSettings.isPending || saveRecipients.isPending}
          />
        ) : (
          <PageSkeleton />
        )
      ) : null}
      {step === 'company' && currentOrg ? (
        <p className="mt-4 text-caption text-dust">
          <Link to="/" className="text-level underline-offset-4 hover:underline">
            {copy.states.goHome}
          </Link>
        </p>
      ) : null}
    </SetupLayout>
  );
}

/** PhoneInput already validated; re-derive E.164 from the stored raw input. */
function normalizedPhone(country: PhoneCountryCode, raw: string): string {
  return phoneValue(country, raw).e164 ?? raw;
}
