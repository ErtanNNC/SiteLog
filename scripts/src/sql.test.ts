import { describe, expect, it } from 'vitest';
import { insertRows, lit } from './sql.ts';

describe('sql literals', () => {
  it('serialises scalars, arrays and json', () => {
    expect(lit(null)).toBe('NULL');
    expect(lit("O'Brien")).toBe("'O''Brien'");
    expect(lit(3.5)).toBe('3.5');
    expect(lit(true)).toBe('true');
    expect(lit(['a', "b'c"])).toBe("array['a','b''c']::text[]");
    expect(lit([1, 2])).toBe('array[1,2]');
    expect(lit([])).toBe("'{}'");
    expect(lit({ a: 1, b: "x'y" })).toBe(`'{"a":1,"b":"x''y"}'::jsonb`);
    expect(lit([{ start: 1 }])).toBe(`'[{"start":1}]'::jsonb`);
  });
  it('builds insert statements with omitted columns', () => {
    const sql = insertRows(
      'sites',
      [
        { id: 'x', name: 'A', tmp: 1 },
        { id: 'y', name: 'B', tmp: 2 },
      ],
      { omit: ['tmp'] },
    );
    expect(sql).toBe("insert into sites (id, name) values\n  ('x', 'A'),\n  ('y', 'B');\n");
    expect(() => insertRows('bad-table', [{ a: 1 }])).toThrow(/Bad identifier/);
  });
});
