/**
 * Edit-mode form model for P7. Numbers are edited as strings (empty = unknown) and converted
 * back into a valid `DailyReportData` on save; untouched sections (photos, equipment, issues,
 * newTerms…) are carried over from the version being edited. Changed rows get an
 * `office_edit` source so every value keeps its provenance (§10.3).
 */
import { z } from 'zod';
import {
  DailyReportDataSchema,
  INCIDENT_SEVERITIES,
  WORK_STATUSES,
  type DailyReportData,
  type ManpowerEntry,
  type Source,
} from '@sitelog/shared/schemas/report.ts';
import { round2 } from '@sitelog/shared/report/hours.ts';
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

export function toFormValues(data: DailyReportData): ReportFormValues {
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

type OfficeEdit = Extract<Source, { type: 'office_edit' }>;

function withEdit(sources: Source[] | undefined, edit: OfficeEdit, changed: boolean): Source[] {
  const base = sources ?? [];
  if (!changed) return base;
  if (base.some((s) => s.type === 'office_edit' && s.at === edit.at)) return base;
  return [...base, edit];
}

/** Rebuilds a valid `DailyReportData` from the form, keeping sources and untouched sections. */
export function toReportData(
  values: ReportFormValues,
  base: DailyReportData,
  ctx: { userId: string; at: string; companies: CompanyOption[] },
): DailyReportData {
  const edit: OfficeEdit = { type: 'office_edit', userId: ctx.userId, at: ctx.at };
  const companyById = new Map(ctx.companies.map((c) => [c.id, c]));

  const manpower: ManpowerEntry[] = values.manpower.map((row) => {
    const prev = row.origIndex !== null ? base.manpower[row.origIndex] : undefined;
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

  const data: DailyReportData = {
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
  return DailyReportDataSchema.parse(data);
}

/** Cheap structural comparison for the "Nothing changed" guard. */
export function sameReportData(a: DailyReportData, b: DailyReportData): boolean {
  const strip = (d: DailyReportData) =>
    JSON.stringify({
      ...d,
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
  return strip(a) === strip(b);
}
