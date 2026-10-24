import { describe, expect, it } from 'vitest';
import { pgArray } from './db';

describe('pgArray', () => {
  it('writes a Postgres array literal the server parses without a type cache', () => {
    expect(pgArray(['awaiting_answer', 'awaiting_confirmation'])).toBe(
      '{"awaiting_answer","awaiting_confirmation"}',
    );
    expect(pgArray([])).toBe('{}');
    expect(pgArray(['a"b', 'c\\d', 'x,y', null])).toBe('{"a\\"b","c\\\\d","x,y",NULL}');
  });
});
