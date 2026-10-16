import { describe, expect, it } from 'vitest';
import { photosAddedNote } from './report-notes.ts';

describe('photosAddedNote (F9)', () => {
  it('says how many photos were added, in the report language', () => {
    expect(photosAddedNote('en', 2)).toBe('2 photos added');
    expect(photosAddedNote('en', 1)).toBe('1 photo added');
    expect(photosAddedNote('tr', 2)).toBe('2 fotoğraf eklendi');
    expect(photosAddedNote('tr', 1)).toBe('1 fotoğraf eklendi');
  });
});
