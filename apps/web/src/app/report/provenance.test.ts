import { fillCopy } from '@sitelog/shared/report/progress.ts';
import { describe, expect, it } from 'vitest';
import { copy } from '@/copy/en';
import { assembleReportDetail } from '@/data/assemble';
import { DemoStore } from '@/data/demo/store';
import type { ReportDetail } from '@/data/types';
import type { CopyKey } from '@/i18n/keys';
import { durationPhrase, provenancePhrases, wordPhrases } from './provenance';

/** English words for a phrase, straight from copy/en.ts (the i18next EN resource). */
function en(key: CopyKey, vars: Record<string, string | number> = {}): string {
  const text = key
    .split('.')
    .reduce<unknown>((node, k) => (node as Record<string, unknown>)[k], copy);
  return fillCopy(String(text), vars);
}

const duration = (s: number) => {
  const d = durationPhrase(s);
  return en(d.key, d.vars);
};
const line = (d: ReportDetail, enteredBy: string | null = null) =>
  wordPhrases(en, provenancePhrases(d, enteredBy, duration));

function detailOf(pick: (r: DemoStore['data']['reports'][number]) => boolean) {
  const store = new DemoStore();
  const report = store.data.reports.find(pick)!;
  return assembleReportDetail(store.rows(), { now: store.now, userId: 'u' }, report.id);
}

describe('P7 provenance line', () => {
  it('words a link report confirmed on the recorder and edited there (artboard)', () => {
    const d = detailOf((r) => r.report_no === 'RL-2041-0187');
    expect(line(d)).toBe(
      'Reported by Marco Ruiz · voice note via text link at 17:38 · confirmed on the recorder 17:43 · edited 20:10',
    );
  });

  it('words a call report with its length, confirmed by voice (P7 example)', () => {
    const d = detailOf((r) => r.channel === 'voice' && r.report_no.startsWith('HS-'));
    expect(line(d)).toMatch(
      /^Reported by Aisha Bello · phone call 18:41 \(\d+ min \d{2} s\) · confirmed by voice$/,
    );
  });

  it('keeps the WhatsApp wording for a report from before the channel layer (D13)', () => {
    const d = detailOf((r) => r.report_no === 'RL-2041-0187');
    const v1 = {
      ...d,
      report: { ...d.report, channel: null, confirmedVia: null },
      versions: d.versions.map((v) => ({ ...v, via: null })),
    };
    expect(line(v1)).toBe(
      'Reported by Marco Ruiz by WhatsApp voice at 17:38 · confirmed 17:43 · edited by reply 20:10',
    );
  });

  it('says who typed an office report, with no confirmation', () => {
    const d = detailOf((r) => r.report_no === 'RL-2041-0187');
    const typed = { ...d, report: { ...d.report, channel: 'office' as const } };
    expect(line(typed, 'Lena Ortiz')).toMatch(/^Entered by Lena Ortiz in SiteLog at \d{2}:\d{2}/);
    expect(line(typed, 'Lena Ortiz')).not.toContain('confirmed');
  });

  it('words an edit made on a call and the sign-off', () => {
    const d = detailOf((r) => r.report_no === 'RL-2041-0187');
    const signed = {
      ...d,
      report: {
        ...d.report,
        status: 'signed_off' as const,
        signedOffAt: '2026-10-10T13:30:00.000Z',
        signedOffByName: 'Sam Kowalski',
      },
      versions: d.versions.map((v) => (v.version === 2 ? { ...v, via: 'voice' as const } : v)),
    };
    expect(line(signed)).toMatch(/· edited on a call 20:10 · signed off by Sam Kowalski 08:30$/);
  });

  it('pads seconds after minutes: "2 min 05 s"', () => {
    expect(duration(125)).toBe('2 min 05 s');
    expect(duration(120)).toBe('2 min');
    expect(duration(48)).toBe('48 s');
  });
});
