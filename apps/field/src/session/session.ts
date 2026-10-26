import type { FieldCountryView } from '@sitelog/shared/countries.ts';
import type { FieldSite, ResolveResponse } from '@sitelog/shared/field-contract.ts';

/**
 * What the app keeps of a resolved link (F4 step 1, W1-09): the code and `resolve`'s answer, so
 * `/today`, `/record` and `/report/:id` work after a reload, and the installed app's `/` (the
 * manifest's start_url) opens Today without the SMS. Stored in localStorage; the device cookie is
 * httpOnly and never here. Nothing in it is a secret beyond the link code, which the SMS carries.
 */
export const SESSION_KEY = 'sitelog-field:session';

export interface FieldSession {
  code: string;
  reporter: ResolveResponse['reporter'];
  org: ResolveResponse['org'];
  link: ResolveResponse['link'];
  country: FieldCountryView;
  /** Listed once the device is verified (`resolve`). */
  sites: FieldSite[];
  needsDeviceCheck: boolean;
  needsConsent: boolean;
  /** The site chosen on Today (F14 switcher); null = the link's site or the nearest deadline. */
  siteId: string | null;
  /** The report date chosen on Today when more than one was allowed (F5); null = the default. */
  date: string | null;
  /**
   * W3-17 (`resolve`'s `placesCalls`, spec §19 Q51): TalkOlog places automated calls for the
   * reporter's org. Absent in a session saved before W3-17: false until the next `resolve`.
   */
  placesCalls?: boolean;
}

type Storage = Pick<globalThis.Storage, 'getItem' | 'setItem' | 'removeItem'>;

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    // Some private modes throw on access.
    return null;
  }
}

export function sessionFromResolve(
  code: string,
  res: ResolveResponse,
  previous: FieldSession | null = null,
): FieldSession {
  const same = previous?.code === code ? previous : null;
  return {
    code,
    reporter: res.reporter,
    org: res.org,
    link: res.link,
    country: res.country,
    sites: res.sites,
    needsDeviceCheck: res.needsDeviceCheck,
    needsConsent: res.needsConsent,
    siteId: same?.siteId && res.sites.some((s) => s.id === same.siteId) ? same.siteId : null,
    date: same?.date ?? null,
    placesCalls: res.placesCalls === true,
  };
}

function isSession(value: unknown): value is FieldSession {
  if (!value || typeof value !== 'object') return false;
  const s = value as Record<string, unknown>;
  return (
    typeof s.code === 'string' &&
    !!s.reporter &&
    typeof s.reporter === 'object' &&
    !!s.country &&
    typeof s.country === 'object' &&
    Array.isArray(s.sites)
  );
}

export function loadSession(store: Storage | null = storage()): FieldSession | null {
  try {
    const raw = store?.getItem(SESSION_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return isSession(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function saveSession(session: FieldSession | null, store: Storage | null = storage()): void {
  try {
    if (!session) store?.removeItem(SESSION_KEY);
    else store?.setItem(SESSION_KEY, JSON.stringify(session));
  } catch {
    // A full or refused store: the session lives in memory for this page.
  }
}

/** The site Today shows: the chosen one if still listed, else the link's, else the first. */
export function currentSite(session: FieldSession): FieldSite | null {
  const active = session.sites.filter((s) => s.status === 'active');
  return (
    active.find((s) => s.id === session.siteId) ??
    active.find((s) => s.id === session.link.siteId) ??
    active[0] ??
    null
  );
}
