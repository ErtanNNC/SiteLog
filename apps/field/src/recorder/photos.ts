import { uploadMediaType } from '@sitelog/shared/field-contract.ts';

/** Extensions phones give photos whose `File.type` comes back empty (some Android pickers). */
const BY_EXTENSION: Readonly<Record<string, string>> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  heic: 'image/heic',
  heif: 'image/heif',
};

/**
 * The media type to upload a picked photo as (F5 "Add photos", F9): the file's own type when
 * field-api stores it as a photo, else one guessed from its name, else null (refused on the phone
 * with `media_type_not_allowed`, never sent).
 */
export function photoMime(file: Pick<File, 'type' | 'name'>): string | null {
  const own = uploadMediaType(file.type);
  if (own?.kind === 'photo') return own.mime;
  const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
  const guessed = BY_EXTENSION[ext];
  return guessed && uploadMediaType(guessed)?.kind === 'photo' ? guessed : null;
}

/** The media type of a file picked by the no-MediaRecorder fallback (`<input accept="audio/*">`). */
export function audioFileMime(file: Pick<File, 'type' | 'name'>): string | null {
  const own = uploadMediaType(file.type);
  if (own?.kind === 'audio') return own.mime;
  const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
  const guessed: Record<string, string> = {
    webm: 'audio/webm',
    m4a: 'audio/mp4',
    mp4: 'audio/mp4',
    aac: 'audio/aac',
    ogg: 'audio/ogg',
    opus: 'audio/ogg',
    mp3: 'audio/mpeg',
    wav: 'audio/wav',
  };
  const g = guessed[ext];
  return g && uploadMediaType(g)?.kind === 'audio' ? g : null;
}
