import { storage } from '@/lib/utils';
import type { PhoneCountryCode } from '@/components/sitelog/PhoneInput';
import { FALLBACK_SITE_DEFAULTS, type SiteDefaults } from './countries';

export const SETUP_STEPS = ['company', 'site', 'reports'] as const;
export type SetupStep = (typeof SETUP_STEPS)[number];

export interface CompanyDraft {
  name: string;
  address: string;
  licenseNo: string;
  /** `countries.code`, the org's country pack (spec §4.6): create_org's `p_country`. */
  country: string;
  timezone: string;
  /** The user chose the time zone: choosing another country no longer presets it. */
  timezoneTouched: boolean;
}

export interface SiteDraft {
  name: string;
  projectCode: string;
  address: string;
  lat: string;
  lng: string;
  timezone: string;
  deadline: string;
  managerName: string;
  managerCountry: PhoneCountryCode;
  managerPhone: string;
  languages: string[];
  hasBackup: boolean;
  backupName: string;
  backupCountry: PhoneCountryCode;
  backupPhone: string;
}

export interface ReportsDraft {
  recipients: string[];
}

/** Wizard progress persisted in localStorage (F2 acceptance: "Save and finish later" resumes). */
export interface SetupProgress {
  /** Steps completed so far. */
  done: Partial<Record<SetupStep, boolean>>;
  company: CompanyDraft;
  site: SiteDraft;
  reports: ReportsDraft;
  /** Sites created during this wizard run (ids + names), for step 3 recipients. */
  createdSites: Array<{ id: string; name: string; code: string }>;
  /** Set when step 1 was completed in this run; otherwise `/setup/site` is "Add site" mode. */
  flow?: 'wizard' | 'add-site';
  updatedAt: string;
}

export const DEFAULT_TZ = 'America/Chicago';

/**
 * The wizard's preselected country: create_org's default and `orgs.country`'s column default
 * (spec §19 Q32: US preselected until self-serve onboarding). Saved progress from before the
 * country choice reads as this one.
 */
export const DEFAULT_COUNTRY = 'US';

/** `timezone`: the country pack's default time zone (`countries.default_timezone`). */
export function emptyCompany(country = DEFAULT_COUNTRY, timezone = DEFAULT_TZ): CompanyDraft {
  return { name: '', address: '', licenseNo: '', country, timezone, timezoneTouched: false };
}

/** `defaults`: the org's country pack (`siteDefaultsFor`): the managers' phone country and language. */
export function emptySite(
  timezone = DEFAULT_TZ,
  defaults: SiteDefaults = FALLBACK_SITE_DEFAULTS,
): SiteDraft {
  return {
    name: '',
    projectCode: '',
    address: '',
    lat: '',
    lng: '',
    timezone,
    deadline: '17:30',
    managerName: '',
    managerCountry: defaults.phoneCountry,
    managerPhone: '',
    languages: [...defaults.languages],
    hasBackup: false,
    backupName: '',
    backupCountry: defaults.phoneCountry,
    backupPhone: '',
  };
}

/** Where a fresh wizard run starts: the org's (or the preselected) country and its defaults. */
export interface ProgressDefaults {
  country?: string;
  timezone?: string;
  site?: SiteDefaults;
}

export function emptyProgress({
  country = DEFAULT_COUNTRY,
  timezone = DEFAULT_TZ,
  site = FALLBACK_SITE_DEFAULTS,
}: ProgressDefaults = {}): SetupProgress {
  return {
    done: {},
    company: emptyCompany(country, timezone),
    site: emptySite(timezone, site),
    reports: { recipients: [] },
    createdSites: [],
    updatedAt: new Date(0).toISOString(),
  };
}

/**
 * Per user and org: `createdSites` are ids of one org, so progress saved in one org must never
 * resume in another (its "Finish" would rewrite that org's site recipients). A user without an
 * org (the company step only) has no org id yet.
 */
export const progressKey = (userId: string, orgId?: string | null) =>
  orgId ? `sitelog.setup.${userId}.${orgId}` : `sitelog.setup.${userId}`;

/**
 * Saved progress over the defaults. Progress saved before the country choice has no `country`
 * (reads as the default's, US for a user without an org) and no `timezoneTouched`: a time zone
 * other than the default counts as chosen, so picking a country never overwrites it.
 */
export function loadProgress(
  userId: string,
  orgId: string | null,
  defaults: ProgressDefaults = {},
): SetupProgress {
  const saved = storage.get<Partial<SetupProgress> | null>(progressKey(userId, orgId), null);
  const base = emptyProgress(defaults);
  if (!saved) return base;
  const company: Partial<CompanyDraft> = saved.company ?? {};
  return {
    ...base,
    ...saved,
    done: { ...saved.done },
    company: {
      ...base.company,
      ...company,
      timezoneTouched:
        company.timezoneTouched ??
        (company.timezone !== undefined && company.timezone !== base.company.timezone),
    },
    site: { ...base.site, ...saved.site },
    reports: { ...base.reports, ...saved.reports },
    createdSites: saved.createdSites ?? [],
  };
}

export function saveProgress(userId: string, orgId: string | null, progress: SetupProgress): void {
  storage.set(progressKey(userId, orgId), { ...progress, updatedAt: new Date().toISOString() });
}

export function clearProgress(userId: string, orgId: string | null): void {
  storage.remove(progressKey(userId, orgId));
}

/** First step that is not done yet (wizard resumes here). */
export function nextStep(done: SetupProgress['done']): SetupStep {
  return SETUP_STEPS.find((s) => !done[s]) ?? 'reports';
}
