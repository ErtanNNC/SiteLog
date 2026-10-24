/**
 * P7's review reasons (§10.5, §10.9): the words of each `reports.review_reasons` code, and the
 * call second a `call_mismatch` points at. Pure, so the page and its tests share them.
 */
import type { Source } from '@sitelog/shared/schemas/report.ts';
import type { ReportDetail } from '@/data/types';
import type { LooseT } from '@/i18n/useLooseCopy';

/**
 * A `call_mismatch` reason (§19 Q74, Q123): `call_mismatch:<path>` (W1-17, no values) or, since
 * the post-call reconcile (W3-11), `call_mismatch:<path>:<heard>:<confirmed>`. A value left empty
 * is null; a code without both values is worded generically (Q74).
 */
export interface CallMismatch {
  path: string;
  heard: string | null;
  confirmed: string | null;
}

export function parseCallMismatch(reason: string): CallMismatch | null {
  const [kind, path = '', heard, ...rest] = reason.split(':');
  if (kind !== 'call_mismatch') return null;
  const confirmed = rest.join(':');
  return {
    path,
    heard: heard?.trim() ? heard.trim() : null,
    confirmed: confirmed.trim() ? confirmed.trim() : null,
  };
}

/** A reason path's keys: "manpower[2].workers" and "manpower.2.workers" → manpower, 2, workers. */
function pathKeys(path: string): string[] {
  return path
    .replace(/\[(\d+)\]/g, '.$1')
    .split('.')
    .filter(Boolean);
}

/** A stated number in the panel's language ("8.5" → "8,5" in Turkish); anything else as written. */
function numberWords(value: string, language: string): string {
  const n = Number(value);
  if (!/^-?\d+(\.\d+)?$/.test(value) || !Number.isFinite(n)) return value;
  return new Intl.NumberFormat(language === 'tr' ? 'tr-TR' : 'en-US', {
    maximumFractionDigits: 2,
  }).format(n);
}

/** What the values belong to: the crew's company, or the weather period ("Rain 11:00–15:00"). */
function mismatchOf(detail: ReportDetail, keys: string[]): string | null {
  if (keys[0] === 'manpower') return detail.data.manpower[Number(keys[1])]?.companyName ?? null;
  if (keys[0] === 'weather' && keys[1] === 'periods') {
    const p = detail.data.weather.periods[Number(keys[2])];
    if (!p) return null;
    return p.start && p.end ? `${p.condition} ${p.start}–${p.end}` : p.condition;
  }
  return null;
}

/**
 * P7's `call_mismatch` line: "The call recording says 5 workers, the confirmed report says 4 —
 * check" (§11.4 P7), led by the crew or period it is about; without both values the generic
 * line naming the path (Q74).
 */
export function callMismatchText(
  m: CallMismatch,
  detail: ReportDetail,
  t: LooseT,
  language: string,
): string {
  if (m.heard === null || m.confirmed === null)
    return t('report.reasons.call_mismatch', { path: m.path || '—' });
  const keys = pathKeys(m.path);
  const leaf = keys[keys.length - 1] ?? '';
  const heard = numberWords(m.heard, language);
  const confirmed = numberWords(m.confirmed, language);
  const vars = { heard, confirmed, path: m.path };
  const line =
    leaf === 'workers'
      ? t('report.reasons.call_mismatch_workers', {
          ...vars,
          count: Number.isFinite(Number(m.heard)) ? Number(m.heard) : 2,
        })
      : leaf === 'hoursPerWorker'
        ? t('report.reasons.call_mismatch_hours', vars)
        : leaf === 'lostHours'
          ? t('report.reasons.call_mismatch_lostHours', vars)
          : t('report.reasons.call_mismatch_value', vars);
  const what = mismatchOf(detail, keys);
  return what ? t('report.reasons.call_mismatch_of', { what, line }) : line;
}

/** The review reason's words (P7 banner): `kind:value` codes of `reports.review_reasons`. */
export function reasonText(
  reason: string,
  detail: ReportDetail,
  t: LooseT,
  language: string,
): string {
  const [kind = '', ...rest] = reason.split(':');
  const value = rest.join(':');
  switch (kind) {
    case 'unknown_company':
      return t('report.reasons.unknown_company', { name: value });
    case 'low_confidence':
      return t('report.reasons.low_confidence', { path: value });
    case 'unanswered':
      return t('report.reasons.unanswered', { field: value });
    case 'unconfirmed':
      return t('report.reasons.unconfirmed');
    case 'call_mismatch':
      return callMismatchText(parseCallMismatch(reason)!, detail, t, language);
    case 'no_photo':
      return t('report.reasons.no_photo');
    case 'call_unreconciled':
      return t('report.reasons.call_unreconciled');
    default:
      return reason;
  }
}

/**
 * The call second a `call_mismatch` reason points at (P7 "Play at 2:15"): the first call source
 * of the value at its path ("manpower[1].workers", "manpower.1.workers"), if the report holds
 * that call's recording.
 */
export function callSourceAt(
  detail: ReportDetail,
  path: string,
): { callId: string; start: number } | null {
  const keys = pathKeys(path);
  let node: unknown = detail.data;
  let sources: Source[] | undefined;
  for (const k of keys) {
    if (!node || typeof node !== 'object') break;
    const rec = node as Record<string, unknown>;
    if (Array.isArray(rec.source)) sources = rec.source as Source[];
    node = Array.isArray(node) ? node[Number(k)] : rec[k];
  }
  if (node && typeof node === 'object' && Array.isArray((node as { source?: unknown }).source))
    sources = (node as { source: Source[] }).source;
  const call = sources?.find(
    (s): s is Extract<Source, { type: 'call' }> =>
      s.type === 'call' && detail.clips.some((c) => c.id === s.callId),
  );
  return call ? { callId: call.callId, start: call.start } : null;
}
