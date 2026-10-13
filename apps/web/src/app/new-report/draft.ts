import type { ReportFormValues } from '../report/reportForm';

/**
 * New report keeps what the office is typing in sessionStorage: on a phone, opening the camera
 * from "Add photos" can make the browser drop the background tab, and it reloads when the user
 * comes back. The draft is per tab, org and user, restored on mount and cleared once the report
 * is filed or the office cancels. Picked photos are not kept (only the form, site and date).
 */
export interface NewReportDraft {
  v: 1;
  siteId: string;
  /** YYYY-MM-DD the report is for (picked, or the site's today when it was saved). */
  date: string;
  values: ReportFormValues;
}

export function newReportDraftKey(orgId: string, userId: string): string {
  return `sitelog:new-report:${orgId}:${userId}`;
}

/** The value has the shape of `like` (arrays, objects key by key, primitive types). */
function sameShape(value: unknown, like: unknown): boolean {
  if (Array.isArray(like)) return Array.isArray(value);
  if (like && typeof like === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const v = value as Record<string, unknown>;
    return Object.entries(like).every(([k, x]) => sameShape(v[k], x));
  }
  return typeof value === typeof like;
}

/** The saved draft, or null when there is none or it does not fit the form any more. */
export function readNewReportDraft(key: string, blank: ReportFormValues): NewReportDraft | null {
  try {
    const raw = window.sessionStorage.getItem(key);
    if (!raw) return null;
    const d = JSON.parse(raw) as Partial<NewReportDraft> | null;
    if (
      d?.v !== 1 ||
      typeof d.siteId !== 'string' ||
      typeof d.date !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}$/.test(d.date) ||
      !sameShape(d.values, blank)
    )
      return null;
    return d as NewReportDraft;
  } catch {
    return null;
  }
}

/** Saves the draft, or removes it (null). Storage that is full or blocked is ignored. */
export function writeNewReportDraft(key: string, draft: NewReportDraft | null): void {
  try {
    if (draft) window.sessionStorage.setItem(key, JSON.stringify(draft));
    else window.sessionStorage.removeItem(key);
  } catch {
    // A convenience only: the form still works without it.
  }
}
