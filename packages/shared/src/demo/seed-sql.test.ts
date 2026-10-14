import { describe, expect, it } from 'vitest';
import { buildSeedSql, demoOrgs, PRUNE, PRUNED_TABLES, pruneSql } from './seed-sql.ts';
import { DEMIR_ORG_ID } from './demir.ts';
import { DEMO_ORG_ID } from './kestrel.ts';
import { demoCalendar, todayIn } from './calendar.ts';

describe('buildSeedSql (supabase/seed.sql and --apply)', () => {
  it('is deterministic: generated twice, the same bytes', () => {
    expect(buildSeedSql()).toBe(buildSeedSql());
    expect(buildSeedSql({ date: '2026-10-14' })).toBe(buildSeedSql({ date: '2026-10-14' }));
    expect(buildSeedSql({ date: '2026-10-14' })).not.toBe(buildSeedSql());
  });

  it('seeds both demo orgs, refuses non-demo ones and scopes every delete to a demo org', () => {
    const sql = buildSeedSql();
    expect(demoOrgs().map((d) => d.org.id)).toEqual([DEMO_ORG_ID, DEMIR_ORG_ID]);
    expect(sql).toContain(`where id in ('${DEMO_ORG_ID}', '${DEMIR_ORG_ID}') and not is_demo`);
    expect(sql).toContain('where orgs.is_demo;');
    const deletes = sql.split('\n').filter((l) => /^delete from /.test(l));
    expect(deletes.length).toBeGreaterThan(50);
    for (const line of deletes)
      expect(line, line).toMatch(new RegExp(`'(${DEMO_ORG_ID}|${DEMIR_ORG_ID})'`));
    // No update or delete without a demo org in it; no truncate.
    expect(sql).not.toMatch(/\btruncate\b/i);
    for (const line of sql.split('\n').filter((l) => /^update /.test(l)))
      expect(line).toBe('update site_days sd set report_id = v.report_id::uuid');
    expect(sql).toContain('Demir Yapı A.Ş.');
    expect(sql).toContain("'İş güvenliği bilgilendirmesi'");
  });

  it('writes one scoped delete per prune entry, queued and running jobs first', () => {
    const lines = pruneSql(DEMO_ORG_ID).trimEnd().split('\n');
    expect(lines.map((l) => /^delete from (\w+) where /.exec(l)?.[1])).toEqual(
      PRUNE.map(([t]) => t),
    );
    expect(PRUNED_TABLES).toEqual(PRUNE.map(([t]) => t));
    expect(lines[0]).toMatch(/^delete from jobs where status in \('queued', 'running'\) and \(/);
    for (const key of ['orgId', 'siteId', 'reporterId', 'reportId', 'siteDayId', 'uploadId'])
      expect(lines[0]).toContain(`payload->>'${key}'`);
    for (const l of lines) expect(l).toContain(`'${DEMO_ORG_ID}'`);
  });

  it('leaves the built-in global terms out of an apply', () => {
    expect(buildSeedSql()).toContain("'llovió'");
    expect(buildSeedSql({ globalRows: false })).not.toContain("'llovió'");
  });
});

describe('demoCalendar', () => {
  it('maps the canonical days by whole weeks, today to the target', () => {
    const cal = demoCalendar('2026-10-14');
    expect(cal.today).toBe('2026-10-14');
    expect(cal.shiftDays).toBe(7);
    expect(cal.day('2026-10-09')).toBe('2026-10-14');
    expect(cal.day('2026-10-05')).toBe('2026-10-12');
    expect(cal.isHistory('2026-10-06')).toBe(true); // → Tue Oct 13
    expect(cal.isHistory('2026-10-07')).toBe(false); // → Wed Oct 14, today
    expect(cal.pastDay('2026-10-07')).toBe('2026-10-07');
    expect(cal.at('2026-10-09', '17:00', 'America/Chicago')).toBe('2026-10-14T22:00:00.000Z');
    expect(demoCalendar().day('2026-10-05')).toBe('2026-10-05');
  });

  it('gives today in a time zone', () => {
    expect(todayIn('America/Chicago', new Date('2026-10-15T03:00:00Z'))).toBe('2026-10-14');
    expect(todayIn('Europe/Istanbul', new Date('2026-10-14T22:00:00Z'))).toBe('2026-10-15');
  });
});
