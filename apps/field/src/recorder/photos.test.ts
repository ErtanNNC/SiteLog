import { describe, expect, it } from 'vitest';
import { audioFileMime, photoMime } from './photos';

describe('picked files (F5 Add photos, the native-recorder fallback)', () => {
  it('takes a photo’s own type, guesses from the name when empty, refuses the rest', () => {
    expect(photoMime({ type: 'image/jpeg', name: 'IMG_1.jpg' })).toBe('image/jpeg');
    expect(photoMime({ type: 'image/heic', name: 'IMG_2.HEIC' })).toBe('image/heic');
    expect(photoMime({ type: '', name: 'IMG_3.HEIC' })).toBe('image/heic');
    expect(photoMime({ type: '', name: 'photo.PNG' })).toBe('image/png');
    expect(photoMime({ type: 'image/gif', name: 'a.gif' })).toBeNull();
    expect(photoMime({ type: 'audio/webm', name: 'a.webm' })).toBeNull();
    expect(photoMime({ type: '', name: 'noext' })).toBeNull();
  });

  it('does the same for a recording picked from the phone', () => {
    expect(audioFileMime({ type: 'audio/mp4', name: 'Memo.m4a' })).toBe('audio/mp4');
    expect(audioFileMime({ type: 'audio/x-m4a', name: 'Memo.m4a' })).toBe('audio/x-m4a');
    expect(audioFileMime({ type: '', name: 'Memo.m4a' })).toBe('audio/mp4');
    expect(audioFileMime({ type: '', name: 'rec.opus' })).toBe('audio/ogg');
    expect(audioFileMime({ type: 'image/jpeg', name: 'a.jpg' })).toBeNull();
    expect(audioFileMime({ type: '', name: 'a.flac' })).toBeNull();
  });
});
