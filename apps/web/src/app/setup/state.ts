import { storage } from '@/lib/utils';
import type { PhoneCountryCode } from '@/components/sitelog/PhoneInput';

export const SETUP_STEPS = ['company', 'site', 'reports'] as const;
export type SetupStep = (typeof SETUP_STEPS)[number];

export interface CompanyDraft {
  name: string;
  address: string;
  licenseNo: string;
  timezone: string;
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

export function emptyCompany(timezone = DEFAULT_TZ): CompanyDraft {
  return { name: '', address: '', licenseNo: '', timezone };
}

export function emptySite(timezone = DEFAULT_TZ): SiteDraft {
  return {
    name: '',
    projectCode: '',
    address: '',
    lat: '',
    lng: '',
    timezone,
    deadline: '17:30',
    managerName: '',
    managerCountry: 'US',
    managerPhone: '',
    languages: ['en'],
    hasBackup: false,
    backupName: '',
    backupCountry: 'US',
    backupPhone: '',
  };
}

export function emptyProgress(timezone = DEFAULT_TZ): SetupProgress {
  return {
    done: {},
    company: emptyCompany(timezone),
    site: emptySite(timezone),
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

export function loadProgress(
  userId: string,
  orgId: string | null,
  timezone = DEFAULT_TZ,
): SetupProgress {
  const saved = storage.get<Partial<SetupProgress> | null>(progressKey(userId, orgId), null);
  const base = emptyProgress(timezone);
  if (!saved) return base;
  return {
    ...base,
    ...saved,
    done: { ...saved.done },
    company: { ...base.company, ...saved.company },
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
