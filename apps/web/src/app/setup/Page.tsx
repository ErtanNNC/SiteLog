import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, Navigate, useNavigate, useParams } from 'react-router';
import { toast } from 'sonner';
import type { CountryPack } from '@sitelog/shared/countries.ts';
import { reachableByPhone } from '@sitelog/shared/line-check.ts';
import { useAuth } from '@/auth/AuthProvider';
import { RequireRole, ROUTE_ROLES } from '@/auth/guards';
import { Logo } from '@/components/shell/Sidebar';
import { phoneValue } from '@/components/sitelog/PhoneInput';
import { PageSkeleton } from '@/components/sitelog/Skeletons';
import { ErrorState } from '@/components/sitelog/States';
import { Button } from '@/components/ui/Button';
import { translate, useCopy } from '@/i18n/useCopy';
import { useOptionalDataSource } from '@/data/DataProvider';
import {
  useCreateSite,
  useInviteReporter,
  useSaveSettings,
  useSaveSiteRecipients,
  useSetOrgLogo,
  useSettings,
  useSetupState,
  useUpdateOrg,
} from '@/data/hooks';
import type { CreateSiteResult, UpdateOrgInput } from '@/data/source';
import { uploadOrgLogo } from '@/data/supabase/SupabaseSource';
import type { OrgSettings } from '@/data/types';
import { supabase } from '@/lib/supabase';
import { sitePriceFor } from '../sites/price';
import { CompanyStep } from './CompanyStep';
import { browserPackCountry, packFor, siteDefaultsFor, useCountryPacks } from './countries';
import { Stepper } from './fields';
import { ReportsStep } from './ReportsStep';
import { SiteStep, type SiteSubmit } from './SiteStep';
import {
  clearProgress,
  DEFAULT_COUNTRY,
  emptySite,
  loadProgress,
  nextStep,
  saveProgress,
  SETUP_STEPS,
  type SetupProgress,
  type SetupStep,
} from './state';

/**
 * P2 · Setup wizard — /setup/company · /setup/site · /setup/reports, outside the app shell (F2).
 * A user without an org creates one (company step only); in an org, only admins set it up (the
 * site insert, recipients and settings are admin-only in RLS). The country packs (spec §4.6) load
 * first: the company step lists them, and a new site's manager defaults come from the org's.
 *
 * A failed load blocks only a user without an org, who must choose a country: the error keeps the
 * wizard's header, so "Save and finish later" still signs them out. An org already has its
 * country, and without its pack a new site's manager starts with the fallback defaults
 * (`siteDefaultsFor`), so its wizard (and "Add site") runs on.
 */
export default function SetupPage() {
  const source = useOptionalDataSource();
  const packs = useCountryPacks();
  const { t } = useCopy();
  if (source && (packs.data || packs.isError)) {
    return (
      <RequireRole roles={ROUTE_ROLES.setup} page="setup.pageName">
        <Wizard packs={packs.data ?? []} />
      </RequireRole>
    );
  }
  if (packs.data) return <NoOrgWizard packs={packs.data} />;
  if (!packs.isError) return <PageSkeleton fullscreen />;
  return (
    <SetupLayout step="company" done={{}} title={t('setup.title')}>
      <ErrorState
        thing={t('setup.company.countryList')}
        error={packs.error}
        onRetry={() => void packs.refetch()}
      />
    </SetupLayout>
  );
}

/**
 * The org's country (`orgs.country`), or the wizard's preselected one before the org exists: the
 * pack of the browser's region, else US (spec §19 Q32). An org summary without it (an older cached
 * list) reads as the column default.
 */
function useOrgCountry(packs: readonly CountryPack[]): string {
  const { currentOrg } = useAuth();
  if (currentOrg) return currentOrg.country ?? DEFAULT_COUNTRY;
  return browserPackCountry(packs) ?? DEFAULT_COUNTRY;
}

function useProgress(packs: readonly CountryPack[]) {
  const { user, currentOrg } = useAuth();
  const userId = user?.id ?? 'anon';
  const orgId = currentOrg?.id ?? null;
  const country = useOrgCountry(packs);
  const [progress, setProgressState] = useState<SetupProgress>(() => {
    const pack = packFor(packs, country);
    const p = loadProgress(userId, orgId, {
      country,
      timezone: currentOrg?.timezone ?? pack?.defaultTimezone,
      site: siteDefaultsFor(pack),
    });
    if (currentOrg) {
      p.done.company = true;
      if (!p.company.name) p.company.name = currentOrg.name;
      if (!p.company.timezone) p.company.timezone = currentOrg.timezone;
      // The org's country is fixed (spec §19 Q31), whatever an older run saved.
      p.company.country = country;
    }
    return p;
  });
  const setProgress = useCallback(
    (fn: (prev: SetupProgress) => SetupProgress) =>
      setProgressState((prev) => {
        const next = fn(prev);
        saveProgress(userId, orgId, next);
        return next;
      }),
    [userId, orgId],
  );
  return { progress, setProgress, userId, orgId };
}

/** The picked logo (validated by CompanyStep): previewed now, uploaded once the org exists. */
function useLogoPreview() {
  const [logo, setLogo] = useState<{ file: File; url: string } | null>(null);
  useEffect(() => () => void (logo && URL.revokeObjectURL(logo.url)), [logo]);
  return {
    logoUrl: logo?.url ?? null,
    file: logo?.file ?? null,
    onLogoChange: (file: File | null) => {
      const url = file ? URL.createObjectURL(file) : null;
      setLogo(file && url ? { file, url } : null);
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
  const { currentOrg, signOut } = useAuth();
  const { t } = useCopy();
  const navigate = useNavigate();
  /**
   * In an org the panel is the way out. Without one every page leads back here, so leaving means
   * signing out; the progress stays saved for this user and resumes after the next sign-in.
   */
  const leave = async () => {
    if (currentOrg) {
      toast.success(t('setup.savedLater'));
      void navigate('/');
      return;
    }
    toast.success(t('setup.savedLaterSignedOut'));
    await signOut().catch(() => undefined);
    void navigate('/login', { replace: true });
  };
  return (
    <div className="min-h-screen bg-concrete">
      <header className="on-dark flex h-16 items-center justify-between bg-asphalt px-4 text-chalk md:px-8">
        <div className="flex min-w-0 items-center gap-4">
          <Logo />
          <span
            className="hidden truncate text-caption text-dust-light sm:inline"
            data-testid="setup-header"
          >
            {t('setup.header', { company: currentOrg?.name ?? t('setup.title') })}
          </span>
        </div>
        <Button
          variant="ghost"
          size="dense"
          className="border-iron bg-transparent text-chalk hover:bg-steel"
          onClick={() => void leave()}
        >
          {t('setup.saveLater')}
        </Button>
      </header>
      <main className="mx-auto max-w-[1240px] px-4 py-7 md:px-8">
        <div className="mb-6">
          <div className="eyebrow mb-1 text-dust">{t('setup.title')}</div>
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
function NoOrgWizard({ packs }: { packs: readonly CountryPack[] }) {
  const { refreshOrgs } = useAuth();
  const { t } = useCopy();
  const { progress, setProgress, userId } = useProgress(packs);
  const company = progress.company;
  const logo = useLogoPreview();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const { step } = useParams();
  if (step && step !== 'company') return <Navigate to="/setup/company" replace />;
  const create = async () => {
    if (!supabase) {
      toast.error(t('errors.generic'));
      return;
    }
    setBusy(true);
    try {
      const { data, error } = await supabase.rpc('create_org', {
        p_name: company.name.trim(),
        p_timezone: company.timezone,
        p_address: company.address.trim() || null,
        p_license_no: company.licenseNo.trim() || null,
        // The country pack: create_org presets locale, units, currency (and paper) from it.
        p_country: company.country,
      } as never);
      if (error) throw new Error(createOrgError(error));
      const id = (data as { id?: string } | null)?.id;
      if (!id) throw new Error(t('errors.generic'));
      // The wizard continues in the new org, whose progress is kept under its own key.
      clearProgress(userId, null);
      saveProgress(userId, id, {
        ...progress,
        company,
        site: emptySite(company.timezone, siteDefaultsFor(packFor(packs, company.country))),
        done: { ...progress.done, company: true },
        flow: 'wizard',
      });
      if (logo.file) {
        await uploadOrgLogo(supabase, id, logo.file).catch(() =>
          toast.error(t('setup.company.logoUploadFailed')),
        );
      }
      await refreshOrgs();
      toast.success(t('toasts.orgCreated', { name: company.name.trim() }));
      void navigate('/setup/site', { replace: true });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('errors.generic'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <SetupLayout step="company" done={progress.done} title={t('setup.title')}>
      <CompanyStep
        draft={company}
        onChange={(next) => setProgress((p) => ({ ...p, company: next }))}
        onContinue={() => void create()}
        busy={busy}
        logoUrl={logo.logoUrl}
        onLogoChange={logo.onLogoChange}
        packs={packs}
      />
    </SetupLayout>
  );
}

/** create_org's errors for the toast: an unknown country (22023) gets the copy, others as sent. */
function createOrgError(error: { code?: string; message: string }): string {
  if (error.code === '22023') return translate('setup.company.errors.unknownCountry');
  return error.message;
}

function Wizard({ packs }: { packs: readonly CountryPack[] }) {
  const { step: stepParam } = useParams();
  const navigate = useNavigate();
  const { currentOrg, isDemo, refreshOrgs } = useAuth();
  const { progress, setProgress, userId, orgId } = useProgress(packs);
  const orgCountry = useOrgCountry(packs);
  const orgPack = packFor(packs, orgCountry);
  const settings = useSettings();
  // W4-05 (§19 Q231): a new manager starts with the org's default preference.
  const siteDefaults = {
    ...siteDefaultsFor(orgPack),
    ...(settings.data ? { contactPref: settings.data.settings.default_contact_pref } : {}),
  };
  const { t, language } = useCopy();
  // W4-10 (§19 Q234): the org's own price, in the panel's language.
  const priceText = sitePriceFor(currentOrg?.price, language);
  const logo = useLogoPreview();
  const setupState = useSetupState();
  const updateOrg = useUpdateOrg();
  const createSite = useCreateSite();
  const inviteReporter = useInviteReporter();
  const saveSettings = useSaveSettings();
  const saveRecipients = useSaveSiteRecipients();
  const setLogo = useSetOrgLogo({ quiet: true });

  const [draft, setDraft] = useState<OrgSettings | null>(null);
  // The org exists here: the company step edits its stored details, seeded once from the load.
  const [companySeeded, setCompanySeeded] = useState(false);
  if (settings.data && !draft) setDraft(structuredClone(settings.data.settings));
  if (settings.data && !companySeeded) {
    const org = settings.data.org;
    const pref = settings.data.settings.default_contact_pref;
    setCompanySeeded(true);
    setProgress((p) => ({
      ...p,
      // A site draft nobody has typed in yet takes the org's default preference (§19 Q231).
      ...(!p.site.name && !p.site.managerName && !p.site.managerPhone
        ? { site: { ...p.site, contactPref: pref, backupContactPref: pref } }
        : {}),
      company: {
        name: org.name,
        address: org.address ?? '',
        licenseNo: org.licenseNo ?? '',
        country: orgCountry,
        timezone: org.timezone,
        timezoneTouched: true,
      },
    }));
  }
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

  /** Saves edits to the current org (never a second create_org) and the picked logo. */
  const continueFromCompany = async () => {
    const org = settings.data?.org;
    if (!org) return;
    const next: UpdateOrgInput = {
      name: progress.company.name.trim(),
      timezone: progress.company.timezone,
      address: progress.company.address.trim() || null,
      licenseNo: progress.company.licenseNo.trim() || null,
    };
    const changed =
      next.name !== org.name ||
      next.timezone !== org.timezone ||
      next.address !== (org.address ?? null) ||
      next.licenseNo !== (org.licenseNo ?? null);
    try {
      if (changed) await updateOrg.mutateAsync(next);
    } catch {
      return; // toasted by the mutation hook
    }
    setProgress((p) => ({ ...p, done: { ...p.done, company: true }, flow: 'wizard' }));
    if (logo.file) {
      await setLogo
        .mutateAsync({ file: logo.file })
        .catch(() => toast.error(t('setup.company.logoSaveFailed')));
    }
    // The org switcher and the setup header show the company name from the auth org list.
    if (changed) await refreshOrgs().catch(() => undefined);
    void navigate('/setup/site');
  };

  const submitSite = async ({ draft: s, lat, lng }: SiteSubmit, another: boolean) => {
    const name = s.name.trim();
    const code = s.projectCode.trim();
    const manager = s.managerName.trim();
    // None ticked: the pack's first field language, as a new site's draft starts.
    const languages = s.languages.length ? s.languages : siteDefaults.languages;
    let created: CreateSiteResult;
    try {
      created = await createSite.mutateAsync({
        name,
        projectCode: code,
        address: s.address.trim() || null,
        lat,
        lng,
        timezone: s.timezone,
        deadline: s.deadline ? `${s.deadline}:00` : null,
        recipients: progress.reports.recipients,
        reporter: {
          name: manager,
          phone: normalizedPhone(s.managerCountry, s.managerPhone),
          role: 'site_manager',
          siteIds: [],
          languages,
          locale: s.locale,
          contactPref: s.contactPref,
          smsAttested: s.smsAttested,
        },
      });
    } catch {
      return; // toasted by the mutation hook; no site was created
    }
    const { siteId } = created;
    // The site exists from here on: record it first, so a failed invite below never leads to a
    // retry that creates it again (or trips over its project number).
    if (!addSiteMode) {
      setProgress((p) => ({
        ...p,
        done: { ...p.done, site: true },
        createdSites: [...p.createdSites, { id: siteId, name, code }],
        site: emptySite(p.company.timezone, siteDefaults),
      }));
    }
    if (created.recipientsError) toast.error(t('setup.site.recipientsFailed'));
    let invited = !created.inviteError;
    if (created.inviteError) {
      toast.error(t('setup.site.inviteFailed', { name: manager, reason: created.inviteError }));
    }
    if (s.hasBackup && s.backupName.trim() && s.backupPhone.trim()) {
      try {
        await inviteReporter.mutateAsync({
          name: s.backupName.trim(),
          phone: normalizedPhone(s.backupCountry, s.backupPhone),
          role: 'backup',
          siteIds: [siteId],
          languages,
          locale: s.backupLocale,
          contactPref: s.backupContactPref,
          smsAttested: s.backupSmsAttested,
        });
      } catch {
        invited = false; // toasted by the mutation hook
      }
    }
    if (invited) toast.success(t('setup.site.sent', { name: manager }));
    // Only the org switcher's site count depends on it.
    await refreshOrgs().catch(() => undefined);
    if (addSiteMode) {
      clearProgress(userId, orgId);
      void navigate('/sites');
      return;
    }
    if (!another) void navigate('/setup/reports');
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
      // Add the wizard's recipients to each site created in this run. A list saved in Settings
      // meanwhile (a run can be finished days later) is kept, not replaced, so read the lists
      // fresh; a site that is not among them (gone, or stale progress) is skipped.
      const fresh = await settings.refetch();
      const lists = (fresh.data ?? settings.data).siteRecipients;
      for (const site of progress.createdSites) {
        const current = lists.find((r) => r.siteId === site.id);
        if (!current) continue;
        const emails = [...new Set([...current.emails, ...progress.reports.recipients])];
        if (emails.length !== current.emails.length) {
          await saveRecipients.mutateAsync({ siteId: site.id, emails });
        }
      }
      clearProgress(userId, orgId);
      toast.success(t('setup.reports.finished'));
      await refreshOrgs().catch(() => undefined);
      void navigate('/', { replace: true });
    } catch {
      /* toasted by the mutation hooks */
    }
  };

  const title = addSiteMode ? t('setup.addSiteTitle') : t('setup.title');
  const subtitle = addSiteMode
    ? priceText
      ? t('setup.addSiteSubtitlePrice', { price: priceText })
      : t('setup.addSiteSubtitle')
    : undefined;
  // Only a failed first load (nothing to edit); a failed refetch keeps the loaded data.
  const settingsError =
    settings.isError && !settings.data ? (
      <ErrorState
        thing={t('nav.settings').toLocaleLowerCase(language)}
        error={settings.error}
        onRetry={() => void settings.refetch()}
      />
    ) : null;

  return (
    <SetupLayout step={step} done={progress.done} title={title} subtitle={subtitle}>
      {step === 'company'
        ? (settingsError ??
          (companySeeded ? (
            <CompanyStep
              draft={progress.company}
              onChange={(company) => setProgress((p) => ({ ...p, company }))}
              onContinue={() => void continueFromCompany()}
              busy={updateOrg.isPending || setLogo.isPending}
              logoUrl={logo.logoUrl}
              onLogoChange={logo.onLogoChange}
              packs={packs}
              countryLocked
            />
          ) : (
            <PageSkeleton />
          )))
        : null}
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
          orgLocale={currentOrg?.locale}
          packCountry={orgCountry}
          pack={orgPack}
          reachable={
            orgPack
              ? reachableByPhone({ isDemo: isDemo || currentOrg?.demoOrg === true }, orgPack)
              : false
          }
          price={currentOrg?.price}
        />
      ) : null}
      {step === 'reports'
        ? (settingsError ??
          (draft ? (
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
          )))
        : null}
      {step === 'company' && currentOrg ? (
        <p className="mt-4 text-caption text-dust">
          <Link to="/" className="text-level underline-offset-4 hover:underline">
            {t('states.goHome')}
          </Link>
        </p>
      ) : null}
    </SetupLayout>
  );
}

/** PhoneInput already validated; re-derive E.164 from the stored raw input. */
function normalizedPhone(country: string, raw: string): string {
  return phoneValue(country, raw).e164 ?? raw;
}
