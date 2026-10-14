import { heroDataV1 } from '@sitelog/shared/demo/kestrel.ts';
import { heroSummary } from '@sitelog/shared/demo/hero.ts';
import { upgradeV1toV2 } from '@sitelog/shared/report/upgrade.ts';
import type { DailyReportData, DailyReportDataV1 } from '@sitelog/shared/schemas/report.ts';
import type { DemoStore } from '@/data/demo/store';

/**
 * Stores the hero report RL-2041-0187 as the same facts in one shape: v1 (WhatsApp era) or that v1
 * upgraded to v2. The seed stores the hero as native v1.2 data (W1-06: Delta's headcount from the
 * recorder answer), so tests that compare the two read paths start from this common v1.
 */
export function storeHeroAs(store: DemoStore, schemaVersion: 1 | 2): string {
  const hero = store.data.reports.find((r) => r.report_no === 'RL-2041-0187')!;
  for (const v of store.data.versions) {
    if (v.report_id !== hero.id) continue;
    const v1: DailyReportDataV1 = heroDataV1();
    if (v.version === 1) {
      const apex = v1.manpower.find((m) => m.companyName === 'Apex Concrete')!;
      apex.workers = 6;
      apex.totalHours = 48;
      v1.summary = heroSummary(23, 184);
    }
    const data: DailyReportDataV1 | DailyReportData = schemaVersion === 1 ? v1 : upgradeV1toV2(v1);
    v.data = data as unknown as typeof v.data;
  }
  return hero.id;
}
