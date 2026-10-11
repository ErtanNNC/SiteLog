import { describe, expect, it } from 'vitest';
import { applyPatch, getAtPointer, parsePointer } from './patch.ts';

describe('applyPatch', () => {
  const doc = {
    manpower: [{ workers: 6, name: 'Apex' }],
    weather: { periods: [] as unknown[] },
    'a/b': 1,
  };

  it('replaces a nested value without mutating the input', () => {
    const out = applyPatch(doc, [{ op: 'replace', path: '/manpower/0/workers', value: 7 }]);
    expect(out.manpower[0]!.workers).toBe(7);
    expect(doc.manpower[0]!.workers).toBe(6);
  });
  it('adds to arrays with index and "-"', () => {
    const out = applyPatch(doc, [
      { op: 'add', path: '/weather/periods/-', value: { condition: 'Rain' } },
      { op: 'add', path: '/manpower/0', value: { workers: 1, name: 'New' } },
    ]);
    expect(out.weather.periods).toEqual([{ condition: 'Rain' }]);
    expect(out.manpower.map((m) => m.name)).toEqual(['New', 'Apex']);
  });
  it('removes array elements and object keys', () => {
    const out = applyPatch(doc, [
      { op: 'remove', path: '/manpower/0' },
      { op: 'remove', path: '/a~1b' },
    ]);
    expect(out.manpower).toEqual([]);
    expect('a/b' in out).toBe(false);
  });
  it('rejects replace on a missing path', () => {
    expect(() =>
      applyPatch(doc, [{ op: 'replace', path: '/manpower/5/workers', value: 1 }]),
    ).toThrow(/does not exist/);
    expect(() => applyPatch(doc, [{ op: 'replace', path: '/nope', value: 1 }])).toThrow(
      /does not exist/,
    );
  });
  it('parses escaped pointers', () => {
    expect(parsePointer('/a~1b/c~0d')).toEqual(['a/b', 'c~d']);
    expect(getAtPointer(doc, '/manpower/0/name')).toBe('Apex');
    expect(getAtPointer(doc, '/manpower/x')).toBeUndefined();
  });
});
