import { describe, expect, it } from 'vitest';
import { heroDataV1, kestrelDemo } from '../demo/kestrel.ts';
import {
  DailyReportDataSchema,
  DailyReportDataV1Schema,
  StoredReportDataSchema,
  emptyReportDataV1,
  type DailyReportData,
  type DailyReportDataV1,
  type HoursBasisV1,
  type ManpowerEntryV1,
  type SourceV1,
} from '../schemas/report.ts';
import { deriveTotals } from './hours.ts';
import { versionPhotos } from './photos.ts';
import {
  UNDETERMINED_LANGUAGE,
  readReportData,
  upgradeHoursBasisV1,
  upgradeObservedV1,
  upgradePhotosV1,
  upgradeSourceV1,
  upgradeV1toV2,
} from './upgrade.ts';

/** report_versions.data as stored (jsonb): a JSON round trip. */
const stored = <T>(x: T): unknown => JSON.parse(JSON.stringify(x));

function deepFreeze<T>(x: T): T {
  if (x && typeof x === 'object') {
    for (const v of Object.values(x)) deepFreeze(v);
    Object.freeze(x);
  }
  return x;
}

const demo = kestrelDemo();
const heroReport = demo.reports.find((r) => r.report_no === 'RL-2041-0187')!;
/**
 * The §18.1 hero report (RL-2041-0187 v2, Apex 6 → 7) in the WhatsApp-era v1 shape: the seed
 * stores the hero as v1.2 data built from it (W1-06), so the upgrade is tested on this copy.
 */
const heroV1 = stored(heroDataV1()) as DailyReportDataV1;
const AUDIO = '1a4585bd-f630-4f17-8679-2191100d816d';

const MSG = '3f2a1c4e-0b1d-4c8e-9f6a-1b2c3d4e5f60';
const entry = (basis: HoursBasisV1, source: SourceV1[]): ManpowerEntryV1 => ({
  companyId: 'c1',
  companyNameHeard: 'Apex',
  companyName: 'Apex Concrete',
  workers: 6,
  hoursPerWorker: 8,
  totalHours: 48,
  hoursBasis: basis,
  confidence: 0.9,
  source,
});

describe('the §18.1 hero report', () => {
  it('round-trips through the v1 schema and the union unchanged in its v1 shape', () => {
    expect(heroReport.current_version).toBe(2);
    expect(heroV1.schemaVersion).toBe(1);
    expect(DailyReportDataV1Schema.parse(stored(heroV1))).toEqual(heroV1);
    expect(StoredReportDataSchema.parse(stored(heroV1))).toEqual(heroV1);
  });

  it('upgrades to a valid v2 that round-trips through the v2 schema and the union unchanged', () => {
    const v2 = upgradeV1toV2(heroV1);
    expect(DailyReportDataSchema.parse(stored(v2))).toEqual(v2);
    expect(StoredReportDataSchema.parse(stored(v2))).toEqual(v2);
    expect(stored(v2)).toStrictEqual(v2); // nothing JSON would drop (no undefined values)
    // Read as stored, either way: v1 through the upgrade, v2 as it is.
    expect(readReportData(StoredReportDataSchema.parse(stored(heroV1)))).toEqual(v2);
    const v2Stored = StoredReportDataSchema.parse(stored(v2));
    expect(readReportData(v2Stored)).toBe(v2Stored);
  });

  it('keeps every fact: same totals, items, photos and voice-note seconds', () => {
    const v2 = upgradeV1toV2(heroV1);
    expect(v2).toMatchObject({
      schemaVersion: 2,
      reportDate: '2026-10-09',
      reportLanguage: 'en',
      units: 'imperial',
      languageDetected: ['es', 'en'],
      summary: heroV1.summary,
      workingHours: { start: '07:00', end: '15:30' },
    });
    expect(deriveTotals(v2)).toEqual(deriveTotals(heroV1));
    expect(deriveTotals(v2)).toMatchObject({ crewOnSite: 24, totalHours: 192, lostHours: 3.5 });
    expect(v2.weather.observed).toEqual({
      precip: 0.4,
      tempMin: 58,
      tempMax: 64,
      wind: 9,
      gust: 18,
      provider: 'Open-Meteo',
    });
    expect(v2.weather.periods[0]!.source).toEqual([
      { type: 'voice_note', uploadId: AUDIO, start: 41, end: 52.3 },
    ]);
    expect(v2.manpower.map((m) => [m.companyName, m.workers, m.totalHours, m.hoursBasis])).toEqual(
      heroV1.manpower.map((m) => [m.companyName, m.workers, m.totalHours, 'stated']),
    );
    expect(v2.workPerformed[0]!.quantity).toEqual({
      value: 68,
      unit: 'yd³',
      heardAs: 'sixty-eight yards',
    });
    expect(v2.photos).toEqual(
      heroV1.photos.map((p) => ({ uploadId: p.messageId, caption: p.caption, takenAt: p.takenAt })),
    );
    expect(v2.newTerms).toEqual([
      {
        heard: 'colado',
        heardLanguage: UNDETERMINED_LANGUAGE,
        proposedOfficial: 'Concrete pour',
        kind: 'term',
        confidence: 0.86,
      },
    ]);
    // Same lists, same lengths and order: a v2 index points at the same v1 entry.
    for (const key of [
      'manpower',
      'workPerformed',
      'deliveries',
      'equipment',
      'issues',
      'nextWorkday',
      'photos',
      'newTerms',
      'missingRequired',
      'lowConfidence',
      'proposedQuestions',
    ] as const)
      expect(v2[key].length, key).toBe(heroV1[key].length);
  });
});

describe('upgradeV1toV2: every source kind and hours basis', () => {
  it('maps each v1 source kind', () => {
    expect(upgradeSourceV1({ type: 'audio', messageId: MSG, start: 12.4, end: 18.9 })).toEqual({
      type: 'voice_note',
      uploadId: MSG,
      start: 12.4,
      end: 18.9,
    });
    expect(upgradeSourceV1({ type: 'audio', messageId: MSG, start: 0 })).toEqual({
      type: 'voice_note',
      uploadId: MSG,
      start: 0,
    });
    // A v1 reply has no question id: the reply message's UUID stands in for it.
    expect(upgradeSourceV1({ type: 'reply', messageId: MSG })).toEqual({
      type: 'answer',
      questionId: MSG,
    });
    expect(
      upgradeSourceV1({ type: 'office_edit', userId: 'u1', at: '2026-10-10T01:10:00Z' }),
    ).toEqual({ type: 'office_edit', userId: 'u1', at: '2026-10-10T01:10:00Z' });
    expect(upgradeSourceV1({ type: 'weather_api' })).toEqual({ type: 'weather_api' });
    // A typed WhatsApp message has no v2 kind (spec §19, question 16).
    expect(upgradeSourceV1({ type: 'text', messageId: MSG })).toBeNull();
  });

  it('maps each hours basis: reply → answer, the rest unchanged', () => {
    expect(
      (['stated', 'full_day_default', 'reply', 'office_edit', 'unknown'] as const).map(
        upgradeHoursBasisV1,
      ),
    ).toEqual(['stated', 'full_day_default', 'answer', 'office_edit', 'unknown']);
  });

  it('upgrades the sources of every section, in order, leaving text sources out', () => {
    const all: SourceV1[] = [
      { type: 'audio', messageId: MSG, start: 5 },
      { type: 'text', messageId: 'typed' },
      { type: 'reply', messageId: 'reply-1' },
      { type: 'office_edit', userId: 'u1', at: 'T' },
      { type: 'weather_api' },
    ];
    const expected = [
      { type: 'voice_note', uploadId: MSG, start: 5 },
      { type: 'answer', questionId: 'reply-1' },
      { type: 'office_edit', userId: 'u1', at: 'T' },
      { type: 'weather_api' },
    ];
    const base = emptyReportDataV1('2026-10-09');
    const v1: DailyReportDataV1 = {
      ...base,
      weather: {
        conditionsText: 'Rain',
        periods: [{ condition: 'Rain', lostHours: 2, source: all }],
      },
      manpower: (['stated', 'full_day_default', 'reply', 'office_edit', 'unknown'] as const).map(
        (b) => entry(b, all),
      ),
      workPerformed: [{ area: 'L4', activity: 'Pour', status: 'complete', source: all }],
      deliveries: [{ item: 'Rebar', source: all }],
      equipment: [{ item: 'Pump', source: all }],
      safety: {
        incidents: [{ description: 'Trip', severity: 'near_miss', source: all }],
        noIncidentsStated: false,
        visitors: ['Inspector'],
        source: all,
      },
      issues: [{ description: 'Handrail', source: all }],
      nextWorkday: [{ item: 'Pump at 07:00', source: all }],
    };
    expect(DailyReportDataV1Schema.parse(v1)).toEqual(v1);
    const v2 = DailyReportDataSchema.parse(upgradeV1toV2(v1));
    const sources = [
      ...v2.weather.periods,
      ...v2.manpower,
      ...v2.workPerformed,
      ...v2.deliveries,
      ...v2.equipment,
      ...v2.safety.incidents,
      v2.safety,
      ...v2.issues,
      ...v2.nextWorkday,
    ].map((x) => x.source);
    expect(sources).toHaveLength(13);
    for (const s of sources) expect(s).toEqual(expected);
    expect(v2.manpower.map((m) => m.hoursBasis)).toEqual([
      'stated',
      'full_day_default',
      'answer',
      'office_edit',
      'unknown',
    ]);
  });

  it('maps observed weather field by field, gust only when there is one', () => {
    const o = { precipIn: 0.42, tempMinF: 51, tempMaxF: 66, windMph: 12, provider: 'Open-Meteo' };
    expect(upgradeObservedV1(o)).toEqual({
      precip: 0.42,
      tempMin: 51,
      tempMax: 66,
      wind: 12,
      provider: 'Open-Meteo',
    });
    expect(upgradeObservedV1({ ...o, gustMph: 31 })).toMatchObject({ gust: 31 });
  });

  it('keeps photo UUIDs as upload ids, and a caption only where there is one', () => {
    expect(
      upgradePhotosV1([
        { messageId: MSG, caption: 'North wall', takenAt: '2026-10-09T16:00:00Z' },
        { messageId: 'p2', takenAt: '2026-10-09T17:00:00Z' },
      ]),
    ).toEqual([
      { uploadId: MSG, caption: 'North wall', takenAt: '2026-10-09T16:00:00Z' },
      { uploadId: 'p2', takenAt: '2026-10-09T17:00:00Z' },
    ]);
    // The panel matches the upgraded list to the report's photo sources by the same UUID.
    const sources = [{ message_id: MSG, kind: 'photo', caption: null, taken_at: null }];
    const shown = versionPhotos(
      upgradePhotosV1([{ messageId: MSG, caption: 'x', takenAt: 'T' }]),
      sources,
    );
    expect(shown.map((p) => [p.source.message_id, p.caption])).toEqual([[MSG, 'x']]);
  });

  it('keeps the §10.3 fields of proposed questions (v1 target is not one)', () => {
    const v1: DailyReportDataV1 = {
      ...emptyReportDataV1('2026-10-09'),
      proposedQuestions: [
        {
          field: 'manpower.workers',
          question: 'How many from Delta?',
          options: ['4', '5'],
          target: { companyNameHeard: 'the Delta guys', manpowerIndex: 2 },
        },
      ],
    };
    expect(upgradeV1toV2(v1).proposedQuestions).toEqual([
      { field: 'manpower.workers', question: 'How many from Delta?', options: ['4', '5'] },
    ]);
  });
});

describe('upgradeV1toV2: pure and tolerant', () => {
  it('does not change its input and shares no objects with it', () => {
    const input = deepFreeze(structuredClone(heroV1));
    const before = JSON.stringify(input);
    const out = upgradeV1toV2(input);
    expect(JSON.stringify(input)).toBe(before);
    // Mutating the result leaves the input alone.
    out.languageDetected.push('tr');
    out.workingHours!.start = '06:00';
    out.workPerformed[0]!.quantity!.value = 1;
    out.safety.visitors.push('x');
    expect(JSON.stringify(input)).toBe(before);
    expect(upgradeV1toV2(input)).toEqual(upgradeV1toV2(heroV1));
  });

  it('leaves out what v1 left out: no observed weather, no working hours, no gust', () => {
    const v2 = upgradeV1toV2(emptyReportDataV1('2026-10-09'));
    expect(v2).not.toHaveProperty('workingHours');
    expect(v2.weather).not.toHaveProperty('observed');
    expect(DailyReportDataSchema.parse(v2)).toEqual(v2);
  });

  it('passes a list legacy data lacks through as missing (photos predate data.photos)', () => {
    const { photos: _photos, ...legacy } = structuredClone(heroV1);
    void _photos;
    const v2 = readReportData(legacy as DailyReportDataV1);
    expect(v2.photos).toBeUndefined();
    expect(v2.manpower).toHaveLength(heroV1.manpower.length);
  });

  it('reads data without schemaVersion as v1 and refuses an unknown version', () => {
    const { schemaVersion: _v, ...unversioned } = structuredClone(heroV1);
    void _v;
    expect(readReportData(unversioned as DailyReportDataV1)).toEqual(upgradeV1toV2(heroV1));
    expect(() =>
      readReportData({ ...heroV1, schemaVersion: 3 } as unknown as DailyReportDataV1),
    ).toThrow('Unsupported report schemaVersion: 3');
  });

  it('upgrades every version of the demo dataset into valid v2 data', () => {
    expect(demo.versions.length).toBeGreaterThan(50);
    for (const v of demo.versions) {
      const data = StoredReportDataSchema.parse(v.data);
      const v2: DailyReportData = readReportData(data);
      expect(DailyReportDataSchema.safeParse(v2).success, `${v.report_id} v${v.version}`).toBe(
        true,
      );
    }
  });
});
