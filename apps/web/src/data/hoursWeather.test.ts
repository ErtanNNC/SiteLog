import { describe, expect, it } from 'vitest';
import { PACK_START_GRACE_MS } from './assemble';
import { DemoSource } from './demo/DemoSource';
import { DemoStore, demoUserFor } from './demo/store';

function demo(store = new DemoStore()) {
  const u = demoUserFor('admin');
  return new DemoSource(store, { id: u.id, email: u.email, name: u.name, role: u.role });
}

/** A confirmed subcontractor that sent an invoice for week 41 but is in no report that week. */
function invoiceOnly(store: DemoStore) {
  const company = {
    ...store.data.companies.find((c) => !c.is_self_perform && c.status === 'confirmed')!,
    id: 'company-summit',
    name: 'Summit Glazing',
    trade: 'Glazing',
    aliases: [],
  };
  store.data.companies.push(company);
  store.addInvoice(
    {
      companyId: company.id,
      invoiceNo: 'SG-0042',
      periodStart: '2026-10-05',
      periodEnd: '2026-10-09',
      lines: ['05', '06', '07', '08', '09'].map((d) => ({ date: `2026-10-${d}`, hours: 8 })),
      totalHours: 40,
      file: null,
    },
    demoUserFor('accounts').id,
  );
  return company;
}

describe('assembleHours', () => {
  it('lists an invoice for a company with no reported hours as a gap of every invoiced hour', async () => {
    const store = new DemoStore();
    const before = await demo(store).getHours('2026-W41');
    const company = invoiceOnly(store);
    const hours = await demo(store).getHours('2026-W41');

    const row = hours.rows.find((r) => r.companyId === company.id)!;
    expect(row).toMatchObject({
      key: company.id,
      companyName: 'Summit Glazing',
      trade: 'Glazing',
      siteNames: [],
      days: [0, 0, 0, 0, 0],
      reported: 0,
      invoiced: 40,
      gap: 40,
      status: 'gap',
      unconfirmed: false,
      invoiceNo: 'SG-0042',
      invoiceStatus: 'open',
    });
    const detail = hours.invoices.find((i) => i.invoiceId === row.invoiceId)!;
    expect(detail.totals).toEqual({ invoiced: 40, reported: 0, gap: 40 });
    expect(detail.evidence).toEqual([]);
    // It was not on site: the company count stays; the gap KPIs count it.
    expect(hours.kpis.companies).toBe(before.kpis.companies);
    expect(hours.kpis.gapSubs).toBe(before.kpis.gapSubs + 1);
    expect(hours.kpis.gapHours).toBe(before.kpis.gapHours + 40);
    expect(hours.totals.invoiced).toBe(before.totals.invoiced + 40);

    // One site: invoices are not compared, so no invoice-only row.
    const site = store.data.sites[0]!.id;
    expect(
      (await demo(store).getHours('2026-W41', site)).rows.map((r) => r.companyId),
    ).not.toContain(company.id);
    // Another week: the invoice does not overlap it.
    expect((await demo(store).getHours('2026-W40')).rows.map((r) => r.companyId)).not.toContain(
      company.id,
    );
  });
});

describe('assembleWeather', () => {
  it('keeps every site in the picker when one is chosen, and the chosen one when archived', async () => {
    const store = new DemoStore();
    const all = await demo(store).getWeather('2026-10');
    const hillcrest = store.data.sites.find((s) => s.project_code === 'HS-0418')!;
    const filtered = await demo(store).getWeather('2026-10', hillcrest.id);
    expect(filtered.sites).toEqual(all.sites);
    expect(filtered.kpis.siteDays).toBe(3);

    hillcrest.status = 'archived';
    expect((await demo(store).getWeather('2026-10')).sites.map((s) => s.id)).not.toContain(
      hillcrest.id,
    );
    expect(
      (await demo(store).getWeather('2026-10', hillcrest.id)).sites.map((s) => s.id),
    ).toContain(hillcrest.id);
  });

  it('shows every site for a site that is not the org’s', async () => {
    const store = new DemoStore();
    const all = await demo(store).getWeather('2026-10');
    const stale = await demo(store).getWeather('2026-10', 'not-a-site');
    expect(stale).toEqual(all);
    expect(stale.siteId).toBeNull();
  });

  it('marks a pack still queued after the grace period as not started', async () => {
    const store = new DemoStore();
    const now = store.now.getTime();
    const base = store.data.packs[0]!;
    const queued = (id: string, agoMs: number) => ({
      ...base,
      id,
      status: 'queued' as const,
      pdf_path: null,
      ready_at: null,
      created_at: new Date(now - agoMs).toISOString(),
    });
    store.data.packs.push(
      queued('pack-stuck', PACK_START_GRACE_MS + 60_000),
      queued('pack-new', 60_000),
    );
    const packs = (await demo(store).getWeather('2026-10')).packs;
    const by = (id: string) => packs.find((p) => p.id === id)!;
    expect(by('pack-stuck').notStarted).toBe(true);
    expect(by('pack-new').notStarted).toBe(false);
    expect(by(base.id).notStarted).toBe(false); // ready
  });
});
