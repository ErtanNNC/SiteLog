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

export const progressKey = (userId: string) => `sitelog.setup.${userId}`;

export function loadProgress(userId: string, timezone = DEFAULT_TZ): SetupProgress {
  const saved = storage.get<Partial<SetupProgress> | null>(progressKey(userId), null);
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

export function saveProgress(userId: string, progress: SetupProgress): void {
  storage.set(progressKey(userId), { ...progress, updatedAt: new Date().toISOString() });
}

export function clearProgress(userId: string): void {
  storage.remove(progressKey(userId));
}

/** First step that is not done yet (wizard resumes here). */
export function nextStep(done: SetupProgress['done']): SetupStep {
  return SETUP_STEPS.find((s) => !done[s]) ?? 'reports';
}
