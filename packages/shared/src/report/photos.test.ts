import { describe, expect, it } from 'vitest';
import {
  isOfficePhotoMime,
  officePhotoStoragePath,
  placeOfficePhotos,
  versionPhotos,
  type PhotoSourceLike,
} from './photos.ts';

const src = (id: string, kind = 'photo', caption: string | null = null): PhotoSourceLike => ({
  message_id: id,
  kind,
  caption,
  taken_at: `2026-10-09T17:0${id.length % 10}:00.000Z`,
});

const sources = [
  src('a', 'audio'),
  src('p1', 'photo', 'Level 2 deck'),
  src('p2', 'photo', 'End of day'),
  src('p3', 'photo'),
];

describe('versionPhotos', () => {
  it('follows data.photos: order, captions and times of the version', () => {
    const out = versionPhotos(
      [
        { uploadId: 'p3', caption: '  North wall  ', takenAt: '2026-10-09T16:00:00.000Z' },
        { uploadId: 'p1', takenAt: '2026-10-09T15:00:00.000Z' },
      ],
      sources,
    );
    expect(out.map((p) => [p.source.message_id, p.caption, p.takenAt])).toEqual([
      ['p3', 'North wall', '2026-10-09T16:00:00.000Z'],
      // A caption removed in this version stays removed (no fallback to the source caption).
      ['p1', null, '2026-10-09T15:00:00.000Z'],
    ]);
  });

  it('skips entries that are not photos of the report and repeated entries', () => {
    const out = versionPhotos(
      [
        { uploadId: 'a', takenAt: 'x' },
        { uploadId: 'gone', takenAt: 'x' },
        { uploadId: 'P2', caption: 'first', takenAt: '' },
        { uploadId: 'p2', caption: 'second', takenAt: 'y' },
      ],
      sources,
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.source.message_id).toBe('p2');
    expect(out[0]!.caption).toBe('first');
    expect(out[0]!.takenAt).toBe(sources[2]!.taken_at); // empty time falls back to the source's
  });

  it('shows no photos for a version that lists none', () => {
    expect(versionPhotos([], sources)).toEqual([]);
  });

  it('falls back to every photo source for legacy data without photos', () => {
    const out = versionPhotos(undefined, sources);
    expect(out.map((p) => [p.source.message_id, p.caption])).toEqual([
      ['p1', 'Level 2 deck'],
      ['p2', 'End of day'],
      ['p3', null],
    ]);
    expect(versionPhotos(null, sources)).toHaveLength(3);
  });
});

describe('office photo paths', () => {
  it('builds the path the RPCs accept', () => {
    expect(
      officePhotoStoragePath(
        'org-1',
        'site-1',
        'ABCDEF00-0000-4000-8000-000000000001',
        'image/png',
      ),
    ).toBe('org-1/site-1/office/abcdef00-0000-4000-8000-000000000001.png');
    expect(officePhotoStoragePath('o', 's', 'id', 'image/jpeg')).toBe('o/s/office/id.jpg');
    expect(isOfficePhotoMime('image/webp')).toBe(true);
    expect(isOfficePhotoMime('image/gif')).toBe(false);
  });
});

describe('placeOfficePhotos', () => {
  it('inserts uploads at their positions, lowest first, and appends the rest in order', () => {
    // The panel showed: N0, K0, N1, K1, then N2 (no position) and N3 (past the end).
    const out = placeOfficePhotos(
      ['K0', 'K1'],
      ['N2', 'N1', 'N3', 'N0'],
      [{}, { position: 2 }, { position: 99 }, { position: 0 }],
    );
    expect(out).toEqual(['N0', 'K0', 'N1', 'K1', 'N3', 'N2']);
  });

  it('keeps upload order without positions and leaves the inputs alone', () => {
    const kept = ['K0'];
    expect(placeOfficePhotos(kept, ['A', 'B'], [{ position: null }, {}])).toEqual(['K0', 'A', 'B']);
    expect(kept).toEqual(['K0']);
    expect(placeOfficePhotos([], ['A', 'B', 'C'], [{ position: 1 }, { position: 1 }, {}])).toEqual([
      'A',
      'B',
      'C',
    ]);
  });
});
