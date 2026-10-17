import type {
  DailyReportData,
  DailyReportDataV1,
  ExtractionOutput,
  ReportExtraction,
  HoursBasis,
  HoursBasisV1,
  ObservedWeather,
  ObservedWeatherV1,
  Photo,
  PhotoV1,
  Source,
  SourceV1,
  StoredReportData,
} from '../schemas/report.ts';

/**
 * Stored report data → the canonical v2 shape (§10.3), on read (GAP D20). Stored v1 versions are
 * never rewritten: the panel, the PDF builders, email and the evidence pack read every version
 * through `readReportData()`. From W1-12 the web pipeline, `create_office_report` and the panel
 * editor write v2; the WhatsApp worker writes v1 until step 22, so nothing here runs on write.
 *
 * The v1 → v2 mapping, field by field:
 * - `schemaVersion` 1 → 2; `reportLanguage` 'en' and `units` 'imperial' (every v1 report is a US,
 *   English report).
 * - Sources: `audio` → `voice_note` (`messageId` → `uploadId`, same UUID, `start`/`end` kept);
 *   `reply` → `answer` (a v1 reply has no question id, so `questionId` keeps the reply message's
 *   UUID, which is that question's `answered_message_id`); `office_edit` and `weather_api` as they
 *   are. A v1 `text` source (a typed WhatsApp message) has no v2 kind and is left out of the v2
 *   view; the stored version keeps it (open question 16, spec §19).
 * - `hoursBasis` 'reply' → 'answer'; the other bases are the same in both versions.
 * - `weather.observed`: `precipIn`, `tempMinF`, `tempMaxF`, `windMph`, `gustMph` → `precip`,
 *   `tempMin`, `tempMax`, `wind`, `gust` (values unchanged: imperial).
 * - `photos[].messageId` → `photos[].uploadId` (same UUID).
 * - `newTerms[].heardLanguage`: 'und' (BCP 47 "undetermined"): v1 did not record which language a
 *   term was heard in, and the upgrade does not guess it.
 * - `proposedQuestions[]`: `field`, `question` and `options` (v1's `target` is not in §10.3).
 *
 * Every other field is copied as it is. The function is pure: the input is not changed and the
 * result shares no objects with it. A list missing from old stored data (versions written before
 * `photos` existed have none) stays missing, so readers keep their fallbacks for it.
 */

/** BCP 47 for "undetermined": the heard language of a v1 new term (v1 never recorded it). */
export const UNDETERMINED_LANGUAGE = 'und';

export function upgradeV1toV2(data: DailyReportDataV1): DailyReportData {
  const v1 = structuredClone(data);
  const { observed } = v1.weather;
  return {
    schemaVersion: 2,
    reportDate: v1.reportDate,
    reportLanguage: 'en',
    units: 'imperial',
    languageDetected: v1.languageDetected,
    summary: v1.summary,
    ...(v1.workingHours ? { workingHours: v1.workingHours } : {}),
    weather: {
      ...(observed ? { observed: upgradeObservedV1(observed) } : {}),
      conditionsText: v1.weather.conditionsText,
      periods: mapList(v1.weather.periods, (p) => ({ ...p, source: upgradeSourcesV1(p.source) })),
    },
    manpower: mapList(v1.manpower, (m) => ({
      ...m,
      hoursBasis: upgradeHoursBasisV1(m.hoursBasis),
      source: upgradeSourcesV1(m.source),
    })),
    workPerformed: mapList(v1.workPerformed, (w) => ({ ...w, source: upgradeSourcesV1(w.source) })),
    deliveries: mapList(v1.deliveries, (d) => ({ ...d, source: upgradeSourcesV1(d.source) })),
    equipment: mapList(v1.equipment, (e) => ({ ...e, source: upgradeSourcesV1(e.source) })),
    safety: {
      ...v1.safety,
      incidents: mapList(v1.safety.incidents, (x) => ({
        ...x,
        source: upgradeSourcesV1(x.source),
      })),
      source: upgradeSourcesV1(v1.safety.source),
    },
    issues: mapList(v1.issues, (i) => ({ ...i, source: upgradeSourcesV1(i.source) })),
    nextWorkday: mapList(v1.nextWorkday, (n) => ({ ...n, source: upgradeSourcesV1(n.source) })),
    photos: upgradePhotosV1(v1.photos),
    newTerms: mapList(v1.newTerms, (t) => ({
      heard: t.heard,
      heardLanguage: UNDETERMINED_LANGUAGE,
      proposedOfficial: t.proposedOfficial,
      kind: t.kind,
      confidence: t.confidence,
    })),
    missingRequired: v1.missingRequired,
    lowConfidence: v1.lowConfidence,
    proposedQuestions: mapList(v1.proposedQuestions, (q) => ({
      field: q.field,
      question: q.question,
      options: q.options,
    })),
  };
}

/**
 * The v2 view of any stored version: v2 as it is, v1 through `upgradeV1toV2`. Data without a
 * `schemaVersion` is read as v1 (the only shape written before it existed); any other version
 * throws rather than being misread. Like the readers before it, this does not validate: legacy
 * rows that miss a list are passed on with the gap (see `upgradeV1toV2`).
 */
export function readReportData(data: StoredReportData): DailyReportData {
  const version = (data as { schemaVersion?: unknown }).schemaVersion;
  if (version === 2) return data as DailyReportData;
  if (version === 1 || version === undefined) return upgradeV1toV2(data as DailyReportDataV1);
  throw new Error(`Unsupported report schemaVersion: ${String(version)}`);
}

/** One v1 source in v2 terms; null for a v1 `text` source, which v2 has no kind for. */
export function upgradeSourceV1(source: SourceV1): Source | null {
  switch (source.type) {
    case 'audio':
      return {
        type: 'voice_note',
        uploadId: source.messageId,
        start: source.start,
        ...(source.end !== undefined ? { end: source.end } : {}),
      };
    case 'reply':
      return { type: 'answer', questionId: source.messageId };
    case 'office_edit':
      return { type: 'office_edit', userId: source.userId, at: source.at };
    case 'weather_api':
      return { type: 'weather_api' };
    case 'text':
      return null;
  }
}

export function upgradeSourcesV1(sources: readonly SourceV1[]): Source[] {
  if (!Array.isArray(sources)) return sources as unknown as Source[];
  return sources.flatMap((s) => {
    const v2 = upgradeSourceV1(s);
    return v2 ? [v2] : [];
  });
}

export function upgradeHoursBasisV1(basis: HoursBasisV1): HoursBasis {
  return basis === 'reply' ? 'answer' : basis;
}

export function upgradeObservedV1(o: ObservedWeatherV1): ObservedWeather {
  return {
    precip: o.precipIn,
    tempMin: o.tempMinF,
    tempMax: o.tempMaxF,
    wind: o.windMph,
    ...(o.gustMph !== undefined ? { gust: o.gustMph } : {}),
    provider: o.provider,
  };
}

/**
 * `photos[]` of a v1 version (or a raw `data->photos` list read on its own) in v2 terms: the same
 * UUID as `uploadId`, caption and time unchanged. Entries that are not objects are passed on for
 * `versionPhotos` to skip, as it skips them in a v1 list.
 */
export function upgradePhotosV1(photos: readonly PhotoV1[]): Photo[] {
  return mapList(photos, (p) => {
    if (!p || typeof p !== 'object') return p as unknown as Photo;
    const { messageId, ...rest } = p;
    return { uploadId: messageId, ...rest };
  });
}

/** `xs.map(f)`, passing a value that is not an array (a list old data lacks) through unchanged. */
function mapList<T, U>(xs: readonly T[], f: (x: T) => U): U[] {
  return Array.isArray(xs) ? xs.map(f) : (xs as unknown as U[]);
}

// ───────────────────────────── v2 → v1, for the v1.0 consumers of the golden set ─────────────

/**
 * The golden set (fixtures/transcripts, expected, tool-outputs) is v2 from W1-12. Two v1.0 consumers
 * still read it in v1 terms until step 22 retires them: the WhatsApp worker's integration and load
 * tests (its extraction is v1) and the panel's WhatsApp simulator (`/try`). This maps v2 back, the
 * inverse of `upgradeV1toV2`: `voice_note` → `audio` (`uploadId` → `messageId`, or a `text` source
 * for an id in `textIds`: a typed WhatsApp report), `answer` → `reply` (`questionId` →
 * `messageId`), `hoursBasis` 'answer' → 'reply', photos `uploadId` → `messageId`, the new terms
 * without `heardLanguage`. A `call` source has no v1 form and is left out. Never used on stored
 * data: stored versions are never rewritten (D20).
 */
export interface DowngradeOptions {
  /** Voice-note ids that were typed WhatsApp messages in v1 (become `text` sources). */
  textIds?: ReadonlySet<string>;
}

export function downgradeSourceV2(source: Source, opts: DowngradeOptions = {}): SourceV1 | null {
  switch (source.type) {
    case 'voice_note':
      if (opts.textIds?.has(source.uploadId)) return { type: 'text', messageId: source.uploadId };
      return {
        type: 'audio',
        messageId: source.uploadId,
        start: source.start,
        ...(source.end !== undefined ? { end: source.end } : {}),
      };
    case 'answer':
      return { type: 'reply', messageId: source.questionId };
    case 'office_edit':
      return { type: 'office_edit', userId: source.userId, at: source.at };
    case 'weather_api':
      return { type: 'weather_api' };
    // Spec §19 Q80 (W2-10): v1 has no reporter edit either; the WhatsApp worker never writes one.
    case 'call':
    case 'reporter_edit':
      return null;
  }
}

function downgradeSources(sources: readonly Source[], opts: DowngradeOptions): SourceV1[] {
  return sources.flatMap((s) => {
    const v1 = downgradeSourceV2(s, opts);
    return v1 ? [v1] : [];
  });
}

/** The model's v2 output (`submit_daily_report`) in v1 terms. */
export function downgradeExtractionV2(
  out: ReportExtraction,
  opts: DowngradeOptions = {},
): ExtractionOutput {
  const x = structuredClone(out);
  const src = (list: readonly Source[]) => downgradeSources(list, opts);
  return {
    languageDetected: x.languageDetected,
    summary: x.summary,
    ...(x.workingHours ? { workingHours: x.workingHours } : {}),
    weather: {
      conditionsText: x.weather.conditionsText,
      periods: x.weather.periods.map((p) => ({ ...p, source: src(p.source) })),
    },
    manpower: x.manpower.map((m) => ({
      ...m,
      hoursBasis: m.hoursBasis === 'answer' ? 'reply' : m.hoursBasis,
      source: src(m.source),
    })),
    workPerformed: x.workPerformed.map((w) => ({ ...w, source: src(w.source) })),
    deliveries: x.deliveries.map((d) => ({ ...d, source: src(d.source) })),
    equipment: x.equipment.map((e) => ({ ...e, source: src(e.source) })),
    safety: {
      ...x.safety,
      incidents: x.safety.incidents.map((i) => ({ ...i, source: src(i.source) })),
      source: src(x.safety.source),
    },
    issues: x.issues.map((i) => ({ ...i, source: src(i.source) })),
    nextWorkday: x.nextWorkday.map((n) => ({ ...n, source: src(n.source) })),
    newTerms: x.newTerms.map(({ heardLanguage: _l, ...t }) => t),
    missingRequired: x.missingRequired,
    lowConfidence: x.lowConfidence,
    proposedQuestions: x.proposedQuestions.map((q) => ({
      field: q.field,
      question: q.question,
      options: q.options,
    })),
  };
}

/** v2 report data in v1 terms (imperial only: v1 has no metric weather). */
export function downgradeV2toV1(
  data: DailyReportData,
  opts: DowngradeOptions = {},
): DailyReportDataV1 {
  if (data.units !== 'imperial' && data.weather.observed)
    throw new Error('downgradeV2toV1: v1 report data has imperial weather only');
  const { schemaVersion: _v, reportDate, reportLanguage: _l, units: _u, photos, ...rest } = data;
  const out = downgradeExtractionV2(
    {
      ...rest,
      weather: { conditionsText: rest.weather.conditionsText, periods: rest.weather.periods },
    },
    opts,
  );
  const o = data.weather.observed;
  return {
    ...out,
    schemaVersion: 1,
    reportDate,
    weather: {
      ...(o
        ? {
            observed: {
              precipIn: o.precip,
              tempMinF: o.tempMin,
              tempMaxF: o.tempMax,
              windMph: o.wind,
              ...(o.gust !== undefined ? { gustMph: o.gust } : {}),
              provider: o.provider,
            },
          }
        : {}),
      conditionsText: out.weather.conditionsText,
      periods: out.weather.periods,
    },
    photos: photos.map(({ uploadId, ...p }) => ({ messageId: uploadId, ...p })),
  };
}
