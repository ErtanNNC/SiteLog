/**
 * Edit-mode form model for P7. Numbers are edited as strings (empty = unknown) and converted
 * back into valid report data on save; untouched sections (equipment, issues, newTerms…) are
 * carried over from the version being edited, photos from the PhotoPicker's draft. Changed rows
 * get an `office_edit` source so every value keeps its provenance (§10.3).
 *
 * The form shows the v2 view of the version (ReportDetail.data) but saves in the shape the
 * version is stored in (ReportDetail.storedData): a v1 version is edited into a v1 version, as
 * create_report_version takes it until the writers move to v2 (W1-12). The upgrade keeps every
 * list's order and length, so a form row's `origIndex` points at the same entry in both.
 */
import { z } from 'zod';
import {
  INCIDENT_SEVERITIES,
  StoredReportDataSchema,
  WORK_STATUSES,
  type DailyReportData,
  type DailyReportDataV1,
  type ManpowerEntry,
  type ManpowerEntryV1,
  type PhotoV1,
  type Source,
  type SourceV1,
  type StoredReportData,
} from '@sitelog/shared/schemas/report.ts';
import { round2 } from '@sitelog/shared/report/hours.ts';
import { upgradePhotosV1 } from '@sitelog/shared/report/upgrade.ts';
import { copy } from '@/copy/en';
import type { CompanyOption } from '@/data/types';

export const NEW_COMPANY = '__new__';

const t = copy.report.editMode;
const HHMM = /^\d{2}:\d{2}$/;
const optionalNumber = (min = 0, max = Number.POSITIVE_INFINITY) =>
  z
    .string()
    .trim()
    .refine((v) => {
      if (v === '') return true;
      const n = Number(v);
      return Number.isFinite(n) && n >= min && n <= max;
    }, t.number);
const optionalTime = z
  .string()
  .trim()
  .refine((v) => v === '' || HHMM.test(v), copy.siteDetail.settings.timeInvalid);

export const manpowerRowSchema = z
  .object({
    origIndex: z.number().int().nullable(),
    companyId: z.string(),
    companyName: z.string(),
    newCompanyName: z.string().trim(),
    trade: z.string().trim(),
    area: z.string().trim(),
    workers: optionalNumber(0, 999),
    hoursPerWorker: optionalNumber(0, 24),
  })
  .superRefine((row, ctx) => {
    if (row.companyId === '' || (row.companyId === NEW_COMPANY && !row.newCompanyName)) {
      ctx.addIssue({
        code: 'custom',
        path: [row.companyId === NEW_COMPANY ? 'newCompanyName' : 'companyId'],
        message: t.companyRequired,
      });
    }
  });

export const reportFormSchema = z.object({
  summary: z.string().trim(),
  conditionsText: z.string().trim(),
  periods: z.array(
    z.object({
      origIndex: z.number().int().nullable(),
      condition: z.string().trim().min(1, t.required),
      start: optionalTime,
      end: optionalTime,
      impact: z.string().trim(),
      lostHours: optionalNumber(0, 24),
    }),
  ),
  manpower: z.array(manpowerRowSchema),
  workPerformed: z.array(
    z.object({
      origIndex: z.number().int().nullable(),
      area: z.string().trim(),
      activity: z.string().trim().min(1, t.required),
      status: z.enum(WORK_STATUSES),
      percentComplete: optionalNumber(0, 100),
    }),
  ),
  deliveries: z.array(
    z.object({
      origIndex: z.number().int().nullable(),
      item: z.string().trim().min(1, t.required),
      quantity: z.string().trim(),
      supplier: z.string().trim(),
      time: optionalTime,
    }),
  ),
  safety: z.object({
    toolboxTalk: z.string().trim(),
    noIncidentsStated: z.boolean(),
    incidents: z.array(
      z.object({
        origIndex: z.number().int().nullable(),
        description: z.string().trim().min(1, t.required),
        severity: z.enum(INCIDENT_SEVERITIES),
      }),
    ),
  }),
  nextWorkday: z.array(
    z.object({
      origIndex: z.number().int().nullable(),
      item: z.string().trim().min(1, t.required),
    }),
  ),
});
export type ReportFormValues = z.infer<typeof reportFormSchema>;

const str = (v: string | number | null | undefined) =>
  v === null || v === undefined ? '' : String(v);

export function toFormValues(data: DailyReportData | DailyReportDataV1): ReportFormValues {
  return {
    summary: data.summary,
    conditionsText: data.weather.conditionsText,
    periods: data.weather.periods.map((p, i) => ({
      origIndex: i,
      condition: p.condition,
      start: p.start ?? '',
      end: p.end ?? '',
      impact: p.impact ?? '',
      lostHours: str(p.lostHours),
    })),
    manpower: data.manpower.map((m, i) => ({
      origIndex: i,
      companyId: m.companyId ?? NEW_COMPANY,
      companyName: m.companyName,
      newCompanyName: m.companyId ? '' : m.companyName,
      trade: m.trade ?? '',
      area: m.area ?? '',
      workers: str(m.workers),
      hoursPerWorker: str(m.hoursPerWorker),
    })),
    workPerformed: data.workPerformed.map((w, i) => ({
      origIndex: i,
      area: w.area,
      activity: w.activity,
      status: w.status,
      percentComplete: str(w.percentComplete),
    })),
    deliveries: data.deliveries.map((d, i) => ({
      origIndex: i,
      item: d.item,
      quantity: d.quantity ?? '',
      supplier: d.supplier ?? '',
      time: d.time ?? '',
    })),
    safety: {
      toolboxTalk: data.safety.toolboxTalk ?? '',
      noIncidentsStated: data.safety.noIncidentsStated,
      incidents: data.safety.incidents.map((x, i) => ({
        origIndex: i,
        description: x.description,
        severity: x.severity,
      })),
    },
    nextWorkday: data.nextWorkday.map((n, i) => ({ origIndex: i, item: n.item })),
  };
}

export function emptyManpowerRow(): ReportFormValues['manpower'][number] {
  return {
    origIndex: null,
    companyId: '',
    companyName: '',
    newCompanyName: '',
    trade: '',
    area: '',
    workers: '',
    hoursPerWorker: '',
  };
}

const num = (v: string): number | null => (v.trim() === '' ? null : Number(v));
const opt = (v: string): string | undefined => (v.trim() === '' ? undefined : v.trim());

/** A source of either version; `office_edit` is the same in both. */
type AnySource = Source | SourceV1;
type OfficeEdit = Extract<Source, { type: 'office_edit' }>;

function withEdit(
  sources: readonly AnySource[] | undefined,
  edit: OfficeEdit,
  changed: boolean,
): AnySource[] {
  const base = [...(sources ?? [])];
  if (!changed) return base;
  if (base.some((s) => s.type === 'office_edit' && s.at === edit.at)) return base;
  return [...base, edit];
}

/**
 * Rebuilds valid report data from the form, keeping sources and untouched sections, in the shape
 * of `base` (the stored version it edits: v1 stays v1, v2 stays v2).
 */
export function toReportData<D extends StoredReportData>(
  values: ReportFormValues,
  base: D,
  ctx: { userId: string; at: string; companies: CompanyOption[] },
): D {
  const edit: OfficeEdit = { type: 'office_edit', userId: ctx.userId, at: ctx.at };
  const companyById = new Map(ctx.companies.map((c) => [c.id, c]));
  const baseManpower: ReadonlyArray<ManpowerEntry | ManpowerEntryV1> = base.manpower;

  const manpower = values.manpower.map((row) => {
    const prev = row.origIndex !== null ? baseManpower[row.origIndex] : undefined;
    const isNew = row.companyId === NEW_COMPANY;
    const company = isNew ? undefined : companyById.get(row.companyId);
    const companyName = isNew ? row.newCompanyName : (company?.name ?? row.companyName);
    const workers = num(row.workers);
    const hoursPerWorker = num(row.hoursPerWorker);
    const totalHours =
      workers !== null && hoursPerWorker !== null
        ? round2(workers * hoursPerWorker)
        : prev && prev.workers === workers && prev.hoursPerWorker === hoursPerWorker
          ? prev.totalHours
          : null;
    const hoursChanged =
      !prev || prev.workers !== workers || prev.hoursPerWorker !== hoursPerWorker;
    const changed =
      hoursChanged ||
      (prev.companyId ?? null) !== (isNew ? null : row.companyId) ||
      prev.companyName !== companyName ||
      (prev.trade ?? '') !== row.trade ||
      (prev.area ?? '') !== row.area;
    return {
      companyId: isNew ? null : row.companyId,
      companyNameHeard: prev?.companyNameHeard ?? companyName,
      companyName,
      trade: opt(row.trade) ?? (isNew ? undefined : (company?.trade ?? undefined)),
      area: opt(row.area),
      workers: workers === null ? null : Math.round(workers),
      hoursPerWorker,
      totalHours,
      hoursBasis: hoursChanged ? 'office_edit' : (prev?.hoursBasis ?? 'office_edit'),
      confidence: changed ? 1 : (prev?.confidence ?? 1),
      source: withEdit(prev?.source, edit, changed),
    };
  });

  const periods = values.periods.map((p) => {
    const prev = p.origIndex !== null ? base.weather.periods[p.origIndex] : undefined;
    const lostHours = num(p.lostHours) ?? 0;
    const changed =
      !prev ||
      prev.condition !== p.condition ||
      (prev.start ?? '') !== p.start ||
      (prev.end ?? '') !== p.end ||
      (prev.impact ?? '') !== p.impact ||
      prev.lostHours !== lostHours;
    return {
      ...(prev ?? {}),
      condition: p.condition,
      start: opt(p.start),
      end: opt(p.end),
      impact: opt(p.impact),
      lostHours,
      fullDay: prev?.fullDay,
      source: withEdit(prev?.source, edit, changed),
    };
  });

  const workPerformed = values.workPerformed.map((w) => {
    const prev = w.origIndex !== null ? base.workPerformed[w.origIndex] : undefined;
    const pct = num(w.percentComplete);
    const changed =
      !prev ||
      prev.area !== w.area ||
      prev.activity !== w.activity ||
      prev.status !== w.status ||
      (prev.percentComplete ?? null) !== pct;
    return {
      area: w.area,
      activity: w.activity,
      status: w.status,
      percentComplete: pct === null ? undefined : Math.round(pct),
      quantity: prev?.quantity,
      source: withEdit(prev?.source, edit, changed),
    };
  });

  const deliveries = values.deliveries.map((d) => {
    const prev = d.origIndex !== null ? base.deliveries[d.origIndex] : undefined;
    const changed =
      !prev ||
      prev.item !== d.item ||
      (prev.quantity ?? '') !== d.quantity ||
      (prev.supplier ?? '') !== d.supplier ||
      (prev.time ?? '') !== d.time;
    return {
      item: d.item,
      quantity: opt(d.quantity),
      supplier: opt(d.supplier),
      time: opt(d.time),
      source: withEdit(prev?.source, edit, changed),
    };
  });

  const incidents = values.safety.incidents.map((x) => {
    const prev = x.origIndex !== null ? base.safety.incidents[x.origIndex] : undefined;
    const changed = !prev || prev.description !== x.description || prev.severity !== x.severity;
    return {
      description: x.description,
      severity: x.severity,
      source: withEdit(prev?.source, edit, changed),
    };
  });
  const safetyChanged =
    (base.safety.toolboxTalk ?? '') !== values.safety.toolboxTalk ||
    base.safety.noIncidentsStated !== values.safety.noIncidentsStated ||
    incidents.length !== base.safety.incidents.length;

  const nextWorkday = values.nextWorkday.map((n) => {
    const prev = n.origIndex !== null ? base.nextWorkday[n.origIndex] : undefined;
    return { item: n.item, source: withEdit(prev?.source, edit, !prev || prev.item !== n.item) };
  });

  const data = {
    ...base,
    summary: values.summary,
    weather: { ...base.weather, conditionsText: values.conditionsText, periods },
    manpower,
    workPerformed,
    deliveries,
    safety: {
      ...base.safety,
      toolboxTalk: opt(values.safety.toolboxTalk),
      noIncidentsStated: values.safety.noIncidentsStated,
      incidents,
      source: withEdit(base.safety.source, edit, safetyChanged),
    },
    nextWorkday,
  };
  const parsed = StoredReportDataSchema.parse(data);
  if (parsed.schemaVersion !== base.schemaVersion) throw new Error('report data version changed');
  return parsed as D;
}

/**
 * `data` with `photos` set from photo-draft entries (keyed by the photo's message id, as
 * usePhotoDraft gives them) in the version's own shape: v1 `messageId`, v2 `uploadId` (same UUID).
 */
export function withPhotoEntries<D extends StoredReportData>(
  data: D,
  photos: readonly PhotoV1[],
): D {
  return {
    ...data,
    photos: data.schemaVersion === 1 ? [...photos] : upgradePhotosV1(photos),
  };
}

/**
 * A report typed in the panel: version 1 is the office's own record, not an edit of one, so its
 * rows carry no `office_edit` source (that would print as EDITED). Later edits add them as usual.
 */
export function withoutOfficeEdits<D extends StoredReportData>(stored: D): D {
  // The same walk over either version: only the office_edit sources go.
  const data = stored as StoredReportData as DailyReportDataV1;
  const keep = (sources: SourceV1[]) => sources.filter((s) => s.type !== 'office_edit');
  const out: DailyReportDataV1 = {
    ...data,
    weather: {
      ...data.weather,
      periods: data.weather.periods.map((p) => ({ ...p, source: keep(p.source) })),
    },
    manpower: data.manpower.map((m) => ({ ...m, source: keep(m.source) })),
    workPerformed: data.workPerformed.map((w) => ({ ...w, source: keep(w.source) })),
    deliveries: data.deliveries.map((d) => ({ ...d, source: keep(d.source) })),
    equipment: data.equipment.map((e) => ({ ...e, source: keep(e.source) })),
    safety: {
      ...data.safety,
      source: keep(data.safety.source),
      incidents: data.safety.incidents.map((x) => ({ ...x, source: keep(x.source) })),
    },
    issues: data.issues.map((i) => ({ ...i, source: keep(i.source) })),
    nextWorkday: data.nextWorkday.map((n) => ({ ...n, source: keep(n.source) })),
  };
  return out as StoredReportData as D;
}

/** JSON with object keys sorted, so key order (zod's parse reorders them) does not count. */
function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0)))
      : v,
  );
}

/**
 * Cheap structural comparison for the "Nothing changed" guard. Photos count by which ones are
 * listed, in what order and with what caption (their times are the server's to keep).
 */
export function sameReportData(a: StoredReportData, b: StoredReportData): boolean {
  const photoId = (p: { messageId: string } | { uploadId: string }) =>
    ('uploadId' in p ? p.uploadId : p.messageId).toLowerCase();
  // Both sides have the shape of one stored version: a walk over v1 types reads either.
  const strip = (d: DailyReportDataV1) =>
    stableJson({
      ...d,
      photos: (d.photos ?? []).map((p) => [photoId(p), p.caption?.trim() || null]),
      manpower: d.manpower.map(({ source: _s, confidence: _c, ...m }) => m),
      weather: {
        ...d.weather,
        periods: d.weather.periods.map(({ source: _s, ...p }) => p),
      },
      workPerformed: d.workPerformed.map(({ source: _s, ...w }) => w),
      deliveries: d.deliveries.map(({ source: _s, ...x }) => x),
      safety: {
        ...d.safety,
        source: undefined,
        incidents: d.safety.incidents.map(({ source: _s, ...x }) => x),
      },
      nextWorkday: d.nextWorkday.map(({ source: _s, ...x }) => x),
    });
  if (a.schemaVersion !== b.schemaVersion) return false;
  return (
    strip(a as StoredReportData as DailyReportDataV1) ===
    strip(b as StoredReportData as DailyReportDataV1)
  );
}
