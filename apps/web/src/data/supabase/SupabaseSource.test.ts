import { describe, expect, it } from 'vitest';
import { emptyReportDataV1, type DailyReportDataV1 } from '@sitelog/shared/schemas/report.ts';
import type { Db } from '@/lib/supabase';
import { buildIndex, currentVersion, type RowSet } from '../assemble';
import type { ReportFilters } from '../types';
import { storedV1 } from '@/test/storedData';
import { DemoSource } from '../demo/DemoSource';
import { DemoStore, demoUserFor } from '../demo/store';
import { SupabaseSource } from './SupabaseSource';

/**
 * SupabaseSource over an in-memory PostgREST stand-in built from the demo dataset. Each query
 * applies its filters to the tables, so a page that loads too little shows up as a difference
 * from DemoSource (which assembles from every row), and every `.in()` list is recorded.
 */
type Row = Record<string, unknown>;

interface Call {
  table: string;
  method: string;
  column?: string;
  value?: unknown;
}

const FILED = new Set(['filed', 'signed_off']);

function tablesFrom(rows: RowSet): Record<string, Row[]> {
  const ix = buildIndex(rows);
  const live = (reportId: string, version: number) => {
    const r = ix.reportById.get(reportId);
    return r && r.current_version === version && FILED.has(r.status) ? r : null;
  };
  // Copies, so a test can add rows that only the "database" has.
  const copyOf = (xs: readonly object[]) => [...xs] as Row[];
  return {
    orgs: copyOf([rows.org]),
    org_settings: copyOf([rows.settings]),
    org_members: copyOf(rows.members),
    sites: copyOf(rows.sites),
    // site_options (20261014000001): the site columns every member reads, accounts included.
    site_options: rows.sites.map(({ id, org_id, name, project_code, timezone, status }) => ({
      id,
      org_id,
      name,
      project_code,
      timezone,
      status,
    })),
    companies: copyOf(rows.companies),
    reporters: copyOf(rows.reporters),
    site_reporters: copyOf(rows.siteReporters),
    site_recipients: copyOf(rows.recipients),
    site_days: copyOf(rows.siteDays),
    reports: copyOf(rows.reports),
    report_versions: copyOf(rows.versions),
    report_sources: copyOf(rows.sources),
    messages: copyOf(rows.messages),
    questions: copyOf(rows.questions),
    sub_invoices: copyOf(rows.invoices),
    evidence_packs: copyOf(rows.packs),
    // The views: rows of the current version of a filed / signed-off report, with its context.
    current_manpower: rows.manpower.flatMap((m) => {
      const r = live(m.report_id, m.version);
      return r
        ? [
            {
              ...m,
              site_id: r.site_id,
              org_id: r.org_id,
              date: ix.reportDate.get(r.id),
              report_no: r.report_no,
              report_status: r.status,
            },
          ]
        : [];
    }),
    current_weather: rows.weatherEvents.flatMap((w) => {
      const r = live(w.report_id, w.version);
      return r ? [{ ...w, org_id: r.org_id, report_no: r.report_no }] : [];
    }),
    transcripts: copyOf(rows.transcripts),
    // report_archive: a filed / signed-off report with its current version's flags.
    report_archive: rows.reports.flatMap((r) => {
      if (!FILED.has(r.status)) return [];
      const site = ix.siteById.get(r.site_id)!;
      const v = currentVersion(ix, r);
      const data = v?.data as unknown as DailyReportDataV1 | undefined;
      const lost = rows.weatherEvents
        .filter((w) => w.report_id === r.id && w.version === r.current_version)
        .reduce((a, w) => a + Number(w.lost_hours), 0);
      return [
        {
          ...r,
          date: ix.reportDate.get(r.id),
          site_name: site.name,
          project_code: site.project_code,
          lost_hours: lost,
          has_incident: (data?.safety.incidents.length ?? 0) > 0,
          summary: v?.summary ?? data?.summary ?? null,
        },
      ];
    }),
  };
}

/** Splits a PostgREST `or` list at its top-level commas. */
function orTerms(expr: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of expr) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

const likeMatch = (v: unknown, pattern: string) =>
  v != null && String(v).toLowerCase().includes(pattern.replace(/^%|%$/g, '').toLowerCase());

/** `column.op.value` as PostgREST reads it inside `or=(…)`. */
function orTerm(term: string): (r: Row) => boolean {
  const [column, op] = term.split('.', 2) as [string, string];
  const value = term.slice(column.length + op.length + 2);
  switch (op) {
    case 'ilike':
      return (r) => likeMatch(r[column], value);
    case 'eq':
      return (r) => String(r[column]) === value;
    case 'gt':
      return (r) => Number(r[column]) > Number(value);
    case 'in': {
      const list = value.replace(/^\(|\)$/g, '').split(',');
      return (r) => list.includes(String(r[column]));
    }
    default:
      throw new Error(`fake: unsupported or-term ${term}`);
  }
}

type Result = { data: unknown; error: { code: string; message: string } | null; count?: number };

class FakeQuery implements PromiseLike<Result> {
  private filters: Array<(r: Row) => boolean> = [];
  private sorts: Array<{ column: string; ascending: boolean; nullsFirst: boolean }> = [];
  private max: number | null = null;
  private offset = 0;
  private one = false;
  private embedReports = false;
  /** `alias:column->key` items of the select list (a JSON field read as its own column). */
  private jsonFields: Array<{ alias: string; column: string; key: string }> = [];
  private count = false;
  private head = false;

  constructor(
    private readonly db: FakeDb,
    private readonly table: string,
  ) {}

  private value(r: Row, column: string): unknown {
    const [head, tail] = column.split('.');
    if (!tail) return r[column];
    if (head === 'reports' && this.table === 'report_sources')
      return this.db.tables.reports!.find((x) => x.id === r.report_id)?.[tail];
    throw new Error(`fake: unsupported embedded filter ${column} on ${this.table}`);
  }

  private add(method: string, column: string, value: unknown, keep: (v: unknown) => boolean) {
    this.db.calls.push({ table: this.table, method, column, value });
    this.filters.push((r) => keep(this.value(r, column)));
    return this;
  }

  select(columns = '*', opts: { count?: string; head?: boolean } = {}) {
    if (columns.includes('reports!inner')) this.embedReports = true;
    this.jsonFields = [...columns.matchAll(/(\w+):(\w+)->(\w+)/g)].map(
      ([, alias, column, key]) => ({
        alias: alias!,
        column: column!,
        key: key!,
      }),
    );
    if (this.jsonFields.length)
      this.db.calls.push({ table: this.table, method: 'select', value: columns });
    this.count = !!opts.count;
    this.head = !!opts.head;
    return this;
  }
  eq(column: string, value: unknown) {
    return this.add('eq', column, value, (v) => v === value);
  }
  neq(column: string, value: unknown) {
    return this.add('neq', column, value, (v) => v !== value);
  }
  gt(column: string, value: number) {
    return this.add('gt', column, value, (v) => v != null && Number(v) > value);
  }
  or(expr: string) {
    this.db.calls.push({ table: this.table, method: 'or', value: expr });
    const terms = orTerms(expr).map(orTerm);
    this.filters.push((r) => terms.some((t) => t(r)));
    return this;
  }
  textSearch(column: string, query: string) {
    return this.add('textSearch', column, query, (v) => likeMatch(v, query));
  }
  in(column: string, values: readonly unknown[]) {
    return this.add('in', column, values, (v) => values.includes(v));
  }
  gte(column: string, value: string) {
    return this.add('gte', column, value, (v) => v != null && String(v) >= value);
  }
  lte(column: string, value: string) {
    return this.add('lte', column, value, (v) => v != null && String(v) <= value);
  }
  not(column: string, op: string, value: unknown) {
    if (op !== 'is' || value !== null) throw new Error(`fake: unsupported not(${op})`);
    return this.add('not.is.null', column, null, (v) => v != null);
  }
  order(column: string, opts: { ascending?: boolean; nullsFirst?: boolean } = {}) {
    const ascending = opts.ascending ?? true;
    // PostgREST's default: nulls last ascending, first descending.
    this.sorts.push({ column, ascending, nullsFirst: opts.nullsFirst ?? !ascending });
    return this;
  }
  limit(n: number) {
    this.max = n;
    return this;
  }
  range(from: number, to: number) {
    this.offset = from;
    this.max = to - from + 1;
    return this;
  }
  single() {
    this.one = true;
    return this;
  }

  private run(): Result {
    let out = (this.db.tables[this.table] ?? []).filter((r) => this.filters.every((f) => f(r)));
    const total = out.length;
    if (this.sorts.length) {
      out = [...out].sort((a, b) => {
        for (const { column, ascending, nullsFirst } of this.sorts) {
          const x = a[column] as string | null;
          const y = b[column] as string | null;
          if (x === y) continue;
          if (x == null) return nullsFirst ? -1 : 1;
          if (y == null) return nullsFirst ? 1 : -1;
          return (x < y ? -1 : 1) * (ascending ? 1 : -1);
        }
        return 0;
      });
    }
    const count = this.count ? total : undefined;
    if (this.head) return { data: null, error: null, count };
    // PostgREST answers 416 for an offset past the end of a counted result.
    if (this.count && this.offset > total)
      return {
        data: null,
        error: { code: 'PGRST103', message: 'Requested range not satisfiable' },
        count: undefined,
      };
    // PostgREST cuts every response at max_rows, without an error.
    const limit = Math.min(this.max ?? Infinity, this.db.maxRows);
    out = out.slice(this.offset, limit === Infinity ? undefined : this.offset + limit);
    if (this.embedReports)
      out = out.map((r) => ({ ...r, reports: { site_id: this.value(r, 'reports.site_id') } }));
    // Only the selected JSON field, not the whole column (as PostgREST answers).
    if (this.jsonFields.length)
      out = out.map((r) => {
        const row: Row = { ...r };
        for (const f of this.jsonFields) {
          const json = r[f.column] as Row | null | undefined;
          row[f.alias] = json?.[f.key] ?? null;
          delete row[f.column];
        }
        return row;
      });
    return { data: this.one ? (out[0] ?? null) : out, error: null, count };
  }

  then<A = Result, B = never>(
    onfulfilled?: ((v: Result) => A | PromiseLike<A>) | null,
    onrejected?: ((e: unknown) => B | PromiseLike<B>) | null,
  ): PromiseLike<A | B> {
    return Promise.resolve(this.run()).then(onfulfilled, onrejected);
  }
}

class FakeDb {
  calls: Call[] = [];
  /** PostgREST's max_rows (supabase/config.toml: 1000); unlimited unless a test sets it. */
  maxRows = Infinity;
  signed: string[][] = [];
  uploads: Array<{ bucket: string; path: string; body: unknown; opts: unknown }> = [];
  rpcs: Array<{ fn: string; args: Record<string, unknown> }> = [];
  /** What each RPC answers. */
  rpcData: Record<string, unknown> = {};
  constructor(readonly tables: Record<string, Row[]>) {}
  from(table: string) {
    return new FakeQuery(this, table);
  }
  async rpc(fn: string, args: Record<string, unknown>) {
    this.rpcs.push({ fn, args });
    return { data: this.rpcData[fn] ?? null, error: null };
  }
  storage = {
    from: (bucket: string) => ({
      upload: async (path: string, body: unknown, opts: unknown) => {
        this.uploads.push({ bucket, path, body, opts });
        return { data: { path }, error: null };
      },
      createSignedUrl: async (path: string) => ({
        data: { signedUrl: `https://storage.test/${bucket}/${path}` },
        error: null,
      }),
      createSignedUrls: async (paths: string[]) => {
        this.signed.push(paths);
        return {
          data: paths.map((p) => ({
            path: p,
            signedUrl: `https://storage.test/${bucket}/${p}`,
            error: null,
          })),
          error: null,
        };
      },
    }),
  };
}

function sources(store = new DemoStore(), as: 'admin' | 'accounts' = 'admin') {
  const u = demoUserFor(as);
  const user = { id: u.id, email: u.email, name: u.name, role: u.role };
  const db = new FakeDb(tablesFrom(store.rows()));
  const live = new (class extends SupabaseSource {
    override now() {
      return store.now;
    }
  })(db as unknown as Db, store.data.org.id, user, async () => 'token');
  return { store, db, live, demo: new DemoSource(store, user) };
}

/** Site detail without the signed photo URLs (DemoSource has none). */
async function detailOf(source: SupabaseSource | DemoSource, siteId: string, month: string) {
  const d = await source.getSiteDetail(siteId, month);
  return { ...d, photos: (d.photos ?? []).map((p) => ({ ...p, url: null })) };
}

describe('SupabaseSource.getSiteDetail', () => {
  it('matches DemoSource for every site in the current, past, future and pre-data months', async () => {
    const { store, live, demo } = sources();
    for (const site of store.data.sites)
      for (const month of ['2026-10', '2026-09', '2026-08', '2026-11'])
        expect(await detailOf(live, site.id, month), `${site.name} ${month}`).toEqual(
          await detailOf(demo, site.id, month),
        );
  });

  it('fills the Latest card from a report outside the viewed month (crew, hours, weather)', async () => {
    // Tue Nov 3: nothing filed in November yet, the latest report is Fri Oct 9.
    const store = new DemoStore();
    store.data.now = '2026-11-03T15:00:00.000Z';
    const { live, demo } = sources(store);
    const site = store.data.sites.find((s) => s.project_code === 'RL-2041')!;
    for (const month of ['2026-11', '2026-10', '2026-09']) {
      const d = await live.getSiteDetail(site.id, month);
      expect(d.latest, month).toMatchObject({
        date: '2026-10-09',
        crew: 24,
        hours: 192,
        weatherHours: 3.5,
      });
      expect(d.latest!.summary).not.toBe('');
      expect(await detailOf(live, site.id, month)).toEqual(await detailOf(demo, site.id, month));
    }
  });

  it('picks the latest by day, not filed_at, when a report is back-filled for an earlier day', async () => {
    const store = new DemoStore();
    const site = store.data.sites.find((s) => s.project_code === 'RL-2041')!;
    // Typed today (Oct 9) for a day before the demo history starts: filed_at is the newest.
    store.createOfficeReport({
      siteId: site.id,
      date: '2026-09-14',
      data: { ...emptyReportDataV1('2026-09-14'), summary: 'Back-filled from the paper diary.' },
      userId: demoUserFor('admin').id,
    });
    const { live, demo } = sources(store);
    for (const month of ['2026-10', '2026-09']) {
      const d = await live.getSiteDetail(site.id, month);
      expect(d.latest?.date).toBe('2026-10-09');
      expect(d.latest?.summary).not.toBe('');
      expect(await detailOf(live, site.id, month)).toEqual(await detailOf(demo, site.id, month));
    }
  });

  it('loads only the viewed month, chunks .in() lists and still shows every site photo', async () => {
    const { store, db, live, demo } = sources();
    const site = store.data.sites.find((s) => s.project_code === 'RL-2041')!;
    const siteReports = new Set(
      store.data.reports.filter((r) => r.site_id === site.id).map((r) => r.id),
    );
    const demoPhotos = store.data.sources.filter(
      (s) => s.kind === 'photo' && siteReports.has(s.report_id),
    ).length;
    // A long-running site: 150 more photos (more than one IN_CHUNK) on one of its reports, which
    // its current version lists (a copy of the row: the demo store keeps its own).
    const reportId = [...siteReports][0]!;
    const report = store.data.reports.find((r) => r.id === reportId)!;
    const versions = db.tables.report_versions!;
    const vIndex = versions.findIndex(
      (v) => v.report_id === reportId && v.version === report.current_version,
    );
    const vData = versions[vIndex]!.data as DailyReportDataV1;
    const extra: DailyReportDataV1['photos'] = [];
    versions[vIndex] = { ...versions[vIndex]!, data: { ...vData, photos: [...vData.photos] } };
    for (let i = 0; i < 150; i++) {
      const at = `2026-09-21T15:${String(i % 60).padStart(2, '0')}:00Z`;
      db.tables.messages!.push({
        ...store.data.messages[0]!,
        id: `msg-extra-${i}`,
        storage_path: `extra/${i}.jpg`,
        created_at: at,
      });
      db.tables.report_sources!.push({
        report_id: reportId,
        message_id: `msg-extra-${i}`,
        kind: 'photo',
        caption: null,
        taken_at: at,
      });
      extra.push({ messageId: `msg-extra-${i}`, takenAt: at });
    }
    (versions[vIndex]!.data as DailyReportDataV1).photos.push(...extra);

    db.calls = [];
    const d = await live.getSiteDetail(site.id, '2026-09');
    const dateCalls = db.calls.filter((c) => c.column === 'date');
    expect(dateCalls.filter((c) => c.method === 'gte').map((c) => c.value)).toEqual(
      expect.arrayContaining(['2026-09-01']),
    );
    expect(dateCalls.every((c) => c.method !== 'gte' || c.value === '2026-09-01')).toBe(true);
    // Only the latest-day lookup reaches past the month (to today).
    expect(
      dateCalls.filter((c) => c.method === 'lte' && c.value !== '2026-09-30').map((c) => c.table),
    ).toEqual(['site_days']);
    for (const c of db.calls.filter((c) => c.method === 'in'))
      expect((c.value as unknown[]).length, `${c.table}.${c.column}`).toBeLessThanOrEqual(100);

    expect(d.photoCount).toBe(demoPhotos + 150);
    expect(d.photos!.every((p) => p.url === `https://storage.test/photos/${p.storagePath}`)).toBe(
      true,
    );
    expect(db.signed).toHaveLength(1); // one batch request, not one per photo
    // Apart from the extra photos the page is the demo's.
    const strip = (x: Awaited<ReturnType<typeof detailOf>>) => ({
      ...x,
      photos: [],
      photoCount: 0,
    });
    expect(strip(await detailOf(live, site.id, '2026-09'))).toEqual(
      strip(await detailOf(demo, site.id, '2026-09')),
    );
  });
});

describe('SupabaseSource: office photos', () => {
  const lena = demoUserFor('admin');
  const user = { id: lena.id, email: lena.email, name: lena.name, role: lena.role };
  const jpeg = () => new Blob(['jpeg'], { type: 'image/jpeg' });

  it('shows each report’s photos as its current version lists them, reading only data->photos', async () => {
    const store = new DemoStore();
    const setup = new DemoSource(store, user);
    const elm = store.data.sites.find((s) => s.project_code === 'ES-0377')!;
    const a = await setup.uploadReportPhoto(elm.id, jpeg(), 'image/jpeg');
    const b = await setup.uploadReportPhoto(elm.id, jpeg(), 'image/jpeg');
    const { reportId } = await setup.createOfficeReport({
      siteId: elm.id,
      date: '2026-10-09',
      data: { ...emptyReportDataV1('2026-10-09'), summary: 'Framing.' },
      photos: [
        { path: a.path, mime: a.mime, caption: 'North wall', takenAt: '2026-10-09T15:00:00Z' },
        { path: b.path, mime: b.mime, caption: null, takenAt: '2026-10-09T16:00:00Z' },
      ],
    });
    const v1 = storedV1(await setup.getReportDetail(reportId));
    // v2 drops the first photo and captions the second.
    await setup.createReportVersion(
      reportId,
      { ...v1, photos: [{ ...v1.photos[1]!, caption: 'South wall' }] },
      'Wrong photo',
    );

    const { db, live, demo } = sources(store);
    db.calls = [];
    const d = await live.getSiteDetail(elm.id, '2026-10');
    const office = d.photos!.filter((p) => p.reportId === reportId);
    expect(office).toEqual([
      expect.objectContaining({
        caption: 'South wall',
        takenAt: '2026-10-09T16:00:00.000Z',
        storagePath: b.path,
        url: `https://storage.test/photos/${b.path}`,
      }),
    ]);
    expect(await detailOf(live, elm.id, '2026-10')).toEqual(
      await detailOf(demo, elm.id, '2026-10'),
    );
    expect(db.calls).toContainEqual({
      table: 'report_versions',
      method: 'select',
      value: 'report_id, version, photos:data->photos, schemaVersion:data->schemaVersion',
    });
  });

  it('uploads to {org}/{site}/office/{uuid}.jpg without overwrite and passes p_photos', async () => {
    const { store, db, live } = sources();
    const elm = store.data.sites.find((s) => s.project_code === 'ES-0377')!;
    const up = await live.uploadReportPhoto(elm.id, jpeg(), 'image/jpeg');
    expect(up.mime).toBe('image/jpeg');
    expect(up.path).toMatch(
      new RegExp(
        `^${store.data.org.id}/${elm.id}/office/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\\.jpg$`,
      ),
    );
    expect(db.uploads).toEqual([
      {
        bucket: 'photos',
        path: up.path,
        body: expect.any(Blob),
        opts: { contentType: 'image/jpeg', upsert: false, cacheControl: '3600' },
      },
    ]);

    const photos = [
      { path: up.path, mime: up.mime, caption: 'Deck', takenAt: '2026-10-09T15:00:00Z' },
    ];
    db.rpcData.create_office_report = { reportId: 'r1', reportNo: 'ES-0377-0042', created: true };
    db.rpcData.create_report_version = { version: 2 };
    const data = emptyReportDataV1('2026-10-09');
    await live.createOfficeReport({ siteId: elm.id, date: '2026-10-09', data, photos });
    await live.createReportVersion('r1', data, 'Added a photo', photos);
    // Without photos the calls stay as before (the default p_photos is []).
    await live.createOfficeReport({ siteId: elm.id, date: '2026-10-08', data });
    await live.createReportVersion('r1', data, 'Typo');
    expect(db.rpcs).toEqual([
      {
        fn: 'create_office_report',
        args: { p_site_id: elm.id, p_date: '2026-10-09', p_data: data, p_photos: photos },
      },
      {
        fn: 'create_report_version',
        args: { p_report_id: 'r1', p_data: data, p_change_note: 'Added a photo', p_photos: photos },
      },
      {
        fn: 'create_office_report',
        args: { p_site_id: elm.id, p_date: '2026-10-08', p_data: data },
      },
      {
        fn: 'create_report_version',
        args: { p_report_id: 'r1', p_data: data, p_change_note: 'Typo' },
      },
    ]);
  });
});

describe('SupabaseSource.findDayReport', () => {
  it('finds the day’s report that is not void, like create_office_report, as DemoSource does', async () => {
    const { store, db, live, demo } = sources();
    const hero = store.data.reports.find((r) => r.report_no === 'RL-2041-0187')!;
    const elm = store.data.sites.find((s) => s.project_code === 'ES-0377')!;
    for (const [siteId, date] of [
      [hero.site_id, '2026-10-09'],
      [elm.id, '2026-08-01'],
      [elm.id, '2026-10-09'],
    ] as const)
      expect(await live.findDayReport(siteId, date)).toEqual(
        await demo.findDayReport(siteId, date),
      );
    expect(await live.findDayReport(hero.site_id, '2026-10-09')).toEqual({
      reportId: hero.id,
      reportNo: 'RL-2041-0187',
    });
    expect(db.calls).toContainEqual({
      table: 'reports',
      method: 'neq',
      column: 'status',
      value: 'void',
    });
    // A voided report does not hold the day.
    db.tables.reports = db.tables.reports!.map((r) =>
      r.id === hero.id ? { ...r, status: 'void' } : r,
    );
    expect(await live.findDayReport(hero.site_id, '2026-10-09')).toBeNull();
  });
});

/** Typed in the panel (no WhatsApp): optionally with an incident. */
function typed(date: string, summary: string, incident: boolean): DailyReportDataV1 {
  const d = emptyReportDataV1(date);
  return {
    ...d,
    summary,
    safety: {
      ...d.safety,
      incidents: incident
        ? [
            {
              description: 'Cut hand on rebar; first aid on site.',
              severity: 'first_aid',
              source: [],
            },
          ]
        : [],
    },
  };
}

/**
 * The demo archive plus two reports typed in the panel and back-dated: one whose incident a later
 * edit removed (v2), and one that still records an incident.
 */
function archiveStore() {
  const store = new DemoStore();
  const admin = demoUserFor('admin').id;
  const site = (code: string) => store.data.sites.find((s) => s.project_code === code)!;
  const edited = store.createOfficeReport({
    siteId: site('RL-2041').id,
    date: '2026-09-14',
    data: typed('2026-09-14', 'Back-filled from the paper diary: crane hit a barrier.', true),
    userId: admin,
  });
  store.createReportVersion(
    edited.reportId,
    typed('2026-09-14', 'Back-filled from the paper diary.', false),
    'The incident was at another site',
    admin,
  );
  const incident = store.createOfficeReport({
    siteId: site('OM-1187').id,
    date: '2026-09-15',
    data: typed('2026-09-15', 'Crane inspection on the east side.', true),
    userId: admin,
  });
  return { store, edited, incident };
}

describe('SupabaseSource.listReports', () => {
  it('matches DemoSource for every filter, status, search and page', async () => {
    const { store } = archiveStore();
    const { live, demo } = sources(store);
    const riverside = store.data.sites.find((s) => s.project_code === 'RL-2041')!.id;
    const cases: ReportFilters[] = [
      { status: 'all' },
      { status: 'all', page: 2 },
      { status: 'all', page: 3, pageSize: 10 },
      { status: 'needs_review' },
      { status: 'filed' },
      { status: 'signed_off' },
      { status: 'weather_day' },
      { hasWeatherDelay: true },
      { hasWeatherDelay: true, pageSize: 3 },
      { edited: true },
      { late: true },
      { incident: true },
      { q: 'llovió' },
      { q: 'riverside' },
      { q: 'RL-2041' },
      { q: 'paper diary' },
      { q: '()' },
      { from: '2026-09-01', to: '2026-09-30' },
      { siteId: riverside, hasWeatherDelay: true },
    ];
    for (const f of cases)
      expect(await live.listReports(f), JSON.stringify(f)).toEqual(await demo.listReports(f));
  });

  it('finds typed reports by their text and keeps an edited one the office’s, not the site manager’s', async () => {
    const { store, edited } = archiveStore();
    const { live } = sources(store);
    const res = await live.listReports({ q: 'paper diary' });
    expect(res.items.map((i) => i.reportNo)).toEqual([edited.reportNo]);
    expect(res.items[0]).toMatchObject({ version: 2, managerName: null, date: '2026-09-14' });
    // The old v1 text no longer matches.
    expect((await live.listReports({ q: 'crane hit' })).total).toBe(0);
  });

  it('filters incidents on the current version only', async () => {
    const { store, edited, incident } = archiveStore();
    const { live } = sources(store);
    const res = await live.listReports({ incident: true });
    expect(res.items.map((i) => i.reportId)).toEqual([incident.reportId]);
    expect(res.items[0]!.flags.map((f) => f.kind)).toContain('incident');
    expect(res.items.map((i) => i.reportId)).not.toContain(edited.reportId);
  });

  it('sorts by report date, so a back-filled report is not listed first', async () => {
    const { store, edited } = archiveStore();
    const { live } = sources(store);
    const all = await live.listReports({ status: 'all', pageSize: 500 });
    const dates = all.items.map((i) => i.date);
    expect(dates).toEqual([...dates].sort().reverse());
    expect(all.items[0]!.reportId).not.toBe(edited.reportId);
  });

  it('sums lost weather hours over the whole filtered set, not the page', async () => {
    const { live, demo } = sources();
    const page = await live.listReports({ hasWeatherDelay: true, pageSize: 3 });
    expect(page.items).toHaveLength(3);
    expect(page.total).toBe(10);
    expect(page.weatherHours).toBe(36.5);
    expect(page.weatherHours).toBe(
      (await demo.listReports({ hasWeatherDelay: true })).weatherHours,
    );
  });

  it('answers a page past the end with an empty page and the real total (PostgREST 416)', async () => {
    const { live, demo } = sources();
    const past = await live.listReports({ status: 'all', page: 99 });
    expect(past.items).toEqual([]);
    expect(past.page).toBe(99);
    expect(past.page).toBeGreaterThan(past.pageCount);
    expect(past).toEqual(await demo.listReports({ status: 'all', page: 99 }));
  });

  it('filters weather delays and incidents server-side, with no id lists in the URL', async () => {
    const { db, live } = sources();
    db.calls = [];
    await live.listReports({ hasWeatherDelay: true, incident: true });
    const archive = db.calls.filter((c) => c.table === 'report_archive');
    expect(archive.filter((c) => c.method === 'in')).toEqual([]);
    expect(archive.filter((c) => c.method === 'or').map((c) => c.value)).toEqual(
      expect.arrayContaining(['lost_hours.gt.0,kind.eq.weather_day']),
    );
    expect(archive).toContainEqual({
      table: 'report_archive',
      method: 'eq',
      column: 'has_incident',
      value: true,
    });
    for (const c of db.calls.filter((c) => c.method === 'in'))
      expect((c.value as unknown[]).length, `${c.table}.${c.column}`).toBeLessThanOrEqual(100);
  });
});

describe('SupabaseSource.getPdfUrls', () => {
  it('exports the filtered archive in archive order and names the reports without a PDF', async () => {
    const { store, edited, incident } = archiveStore();
    const { live, demo } = sources(store);
    const filters: ReportFilters = { status: 'all', from: '2026-09-01', to: '2026-10-09' };
    const batch = await live.getPdfUrls({ filters });
    const archive = await demo.listReports({ ...filters, pageSize: 200 });
    expect(batch.total).toBe(archive.total);
    const order = archive.items.map((i) => i.reportNo);
    const got = [...batch.files.map((f) => f.reportNo), ...batch.missing.map((m) => m.reportNo)];
    expect([...got].sort()).toEqual([...order].sort());
    expect(batch.files.map((f) => f.reportNo)).toEqual(
      order.filter((no) => batch.files.some((f) => f.reportNo === no)),
    );
    // The typed report has no stored PDF yet (the export renders it in the browser); the demo
    // store gives the edited one's v2 a path, as the worker would.
    expect(batch.missing).toEqual([{ reportId: incident.reportId, reportNo: incident.reportNo }]);
    expect(batch.files.map((f) => f.reportId)).toContain(edited.reportId);
  });
});

/** Copies of a report with new ids, so a test can spread rows over more reports than IN_CHUNK. */
function extraReports(db: FakeDb, base: Row, n: number): string[] {
  const ids = Array.from({ length: n }, (_, i) => `report-extra-${String(i).padStart(3, '0')}`);
  for (const id of ids) db.tables.reports!.push({ ...base, id });
  return ids;
}

/** The site and company pickers in id order: SupabaseSource reads them by name, the demo store in seed order. */
function byId<T extends { sites: Array<{ id: string }>; companies?: Array<{ id: string }> }>(
  x: T,
): T {
  const sort = <U extends { id: string }>(xs: U[]) =>
    [...xs].sort((a, b) => a.id.localeCompare(b.id));
  return { ...x, sites: sort(x.sites), ...(x.companies ? { companies: sort(x.companies) } : {}) };
}

function inListsChunked(db: FakeDb) {
  const lists = db.calls.filter((c) => c.method === 'in');
  for (const c of lists)
    expect((c.value as unknown[]).length, `${c.table}.${c.column}`).toBeLessThanOrEqual(100);
  return lists;
}

describe('SupabaseSource.getHours', () => {
  it('matches DemoSource for every week and site', async () => {
    const { store, live, demo } = sources();
    for (const week of ['2026-W39', '2026-W40', '2026-W41'])
      for (const siteId of [null, ...store.data.sites.map((s) => s.id)])
        expect(byId(await live.getHours(week, siteId)), `${week} ${siteId}`).toEqual(
          byId(await demo.getHours(week, siteId)),
        );
  });

  it('reads every manpower row past max_rows and chunks the report ids', async () => {
    const { db, live, demo } = sources();
    db.maxRows = 1000;
    const base = db.tables.current_manpower!.find((m) => m.date === '2026-10-05')!;
    const report = db.tables.reports!.find((r) => r.id === base.report_id)!;
    const ids = extraReports(db, report, 150);
    // 1,200 more one-hour rows (more than one max_rows page) over 150 reports.
    for (let i = 0; i < 1200; i++)
      db.tables.current_manpower!.push({
        ...base,
        id: `mp-extra-${String(i).padStart(4, '0')}`,
        report_id: ids[i % ids.length],
        hours: 1,
      });
    db.calls = [];
    const hours = await live.getHours('2026-W41');
    const before = await demo.getHours('2026-W41');
    expect(hours.kpis.subHours).toBe(before.kpis.subHours + 1200);
    const lists = inListsChunked(db);
    expect(lists.filter((c) => c.table === 'reports').length).toBeGreaterThan(1);
  });

  it('lists the invoice evidence for an accounts user, who cannot read reports', async () => {
    const { db, live } = sources(new DemoStore(), 'accounts');
    db.calls = [];
    const hours = await live.getHours('2026-W41');
    expect(db.calls.filter((c) => c.table === 'reports' || c.table === 'report_sources')).toEqual(
      [],
    );
    const admin = await sources().live.getHours('2026-W41');
    const pick = (h: typeof hours) =>
      h.invoices
        .find((i) => i.invoiceNo === 'BL-3381')!
        .evidence.map((e) => [e.date, e.reportId, e.reportNo, e.siteName]);
    expect(pick(hours).length).toBeGreaterThan(0);
    expect(pick(hours)).toEqual(pick(admin));
    expect(pick(hours).every(([, , no, site]) => !!no && !!site)).toBe(true);
  });

  it('names the sites for an accounts user from site_options, as RLS hides the sites table', async () => {
    const { db, live } = sources(new DemoStore(), 'accounts');
    // What RLS returns to accounts (20261014000001): no site, report or source row.
    db.tables.sites = [];
    db.tables.reports = [];
    db.tables.report_sources = [];
    db.calls = [];
    const hours = await live.getHours('2026-W41');
    expect(db.calls.some((c) => c.table === 'sites')).toBe(false);
    expect(db.calls.some((c) => c.table === 'site_options')).toBe(true);
    const admin = await sources().live.getHours('2026-W41');
    expect(hours.sites).toEqual(admin.sites);
    expect(hours.rows.map((r) => [r.companyName, r.siteNames])).toEqual(
      admin.rows.map((r) => [r.companyName, r.siteNames]),
    );
    expect(hours.sites.length).toBeGreaterThan(0);
    for (const siteId of [null, ...admin.sites.map((o) => o.id)]) {
      const mine = await live.getHours('2026-W41', siteId);
      const theirs = await sources().live.getHours('2026-W41', siteId);
      expect(mine.kpis, String(siteId)).toEqual(theirs.kpis);
    }
  });
});

describe('SupabaseSource.getWeather', () => {
  /** DemoSource has no signed URL for the ready pack. */
  const unsigned = (w: Awaited<ReturnType<SupabaseSource['getWeather']>>) =>
    byId({ ...w, packs: w.packs.map((p) => ({ ...p, url: null })) });

  it('matches DemoSource for every month and site, and reads only the delays', async () => {
    const store = new DemoStore();
    const site = store.data.sites.find((s) => s.project_code === 'RL-2041')!;
    // Typed in the panel: a stoppage with no photo, and nobody was asked for one.
    const data = emptyReportDataV1('2026-09-14');
    data.weather.periods.push({ condition: 'Heavy rain', lostHours: 3, source: [] });
    const typed = store.createOfficeReport({
      siteId: site.id,
      date: '2026-09-14',
      data,
      userId: demoUserFor('admin').id,
    });
    const { db, live, demo } = sources(store);
    db.calls = [];
    for (const month of ['2026-10', '2026-09'])
      for (const siteId of [null, 'not-a-site', ...store.data.sites.map((s) => s.id)])
        expect(unsigned(await live.getWeather(month, siteId)), `${month} ${siteId}`).toEqual(
          byId(await demo.getWeather(month, siteId)),
        );
    expect(db.calls).toContainEqual({
      table: 'current_weather',
      method: 'or',
      value: 'lost_hours.gt.0,full_day.eq.true',
    });
    const sept = await live.getWeather('2026-09', null);
    const entry = sept.entries.find((e) => e.reportId === typed.reportId)!;
    expect(entry.reportNo).toBe(typed.reportNo);
    expect(entry.evidence).toMatchObject({ photos: 0, photoRequested: false });
  });

  it('reads every stoppage past max_rows and chunks the report ids', async () => {
    const { db, live, demo } = sources();
    db.maxRows = 1000;
    const base = db.tables.current_weather!.find((w) => Number(w.lost_hours) > 0)!;
    const report = db.tables.reports!.find((r) => r.id === base.report_id)!;
    const ids = extraReports(db, report, 150);
    for (let i = 0; i < 1200; i++)
      db.tables.current_weather!.push({
        ...base,
        id: `wx-extra-${String(i).padStart(4, '0')}`,
        report_id: ids[i % ids.length],
        lost_hours: 0.5,
      });
    db.calls = [];
    const month = String(base.date).slice(0, 7);
    const log = await live.getWeather(month);
    const before = await demo.getWeather(month);
    expect(log.entries).toHaveLength(before.entries.length + 1200);
    expect(log.kpis.hours).toBe(before.kpis.hours + 600);
    const lists = inListsChunked(db);
    expect(lists.filter((c) => c.table === 'reports').length).toBeGreaterThan(1);
  });
});
