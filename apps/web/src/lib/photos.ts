/**
 * Photos the office adds to a report in the panel (New report, Edit). Each picked file is decoded,
 * turned upright (EXIF orientation), scaled so its long edge is at most PHOTO_MAX_EDGE and encoded
 * as JPEG before it goes to the private `photos` bucket: JPEG is what the PDF renderers embed
 * (react-pdf takes JPEG and PNG only) and keeps a phone photo near half a megabyte.
 *
 * Before decoding, the first bytes of the file give its pixel size (a photo over
 * PHOTO_MAX_PIXELS is refused: decoding it could take the tab down with the typed report) and its
 * EXIF capture time, which the re-encode drops: a phone hands a library pick over as a fresh copy,
 * so its last-modified time is when it was picked, not when it was taken.
 *
 * The decode / encode steps are a `PhotoCodec` so tests (jsdom has no canvas) can stub them.
 */
import { copy } from '@/copy/en';

const c = copy.report.editMode.photos;

/** Originals above this are refused before decoding (a phone photo is 2–12 MB). */
export const PHOTO_MAX_BYTES = 25 * 1024 * 1024;
/**
 * Originals with more pixels than this are refused before decoding: a decoded image takes 4 bytes
 * a pixel, so a 108 MP photo needs over 400 MB. 48–50 MP phone modes still pass.
 */
export const PHOTO_MAX_PIXELS = 50_000_000;
/** Long edge of the uploaded JPEG, in pixels. */
export const PHOTO_MAX_EDGE = 2000;
/** Read from the start of a file for its size and EXIF time (EXIF sits in the first 64 KB). */
const HEADER_BYTES = 256 * 1024;
export const PHOTO_JPEG_QUALITY = 0.82;
/** No `capture` attribute: phones offer the camera and the photo library. */
export const PHOTO_ACCEPT = 'image/*';
/** How long the <img> fallback may take to decode one file. */
const IMG_DECODE_TIMEOUT_MS = 20_000;

/** Some browsers report no type for HEIC and other camera formats; the extension decides then. */
const IMAGE_EXT = /\.(jpe?g|png|webp|gif|bmp|avif|heic|heif|tiff?)$/i;
const HEIC = /\.(heic|heif)$/i;

/** A picked file that cannot be used; `message` is the copy to show. */
export class PhotoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PhotoError';
  }
}

/** Checks a picked file before decoding: the error copy, or null when it can be prepared. */
export function photoFileError(file: Pick<File, 'name' | 'type' | 'size'>): string | null {
  const isImage = file.type ? file.type.startsWith('image/') : IMAGE_EXT.test(file.name);
  if (!isImage) return c.notImage(file.name);
  if (file.size > PHOTO_MAX_BYTES) return c.tooLarge(file.name);
  return null;
}

/** The copy for a file the browser could not decode (HEIC outside Safari, a broken file). */
export function unreadableMessage(file: Pick<File, 'name' | 'type'>): string {
  return HEIC.test(file.name) || /^image\/hei[cf]/i.test(file.type)
    ? c.heic(file.name)
    : c.unreadable(file.name);
}

/** Size of the uploaded image: the long edge at most `maxEdge`, never enlarged. */
export function scaledSize(
  width: number,
  height: number,
  maxEdge: number = PHOTO_MAX_EDGE,
): { width: number; height: number } {
  if (!(width > 0) || !(height > 0)) throw new RangeError('image has no size');
  const scale = Math.min(1, maxEdge / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/**
 * When the photo was taken: its EXIF capture time when there is one, else the file's
 * last-modified time; never later than `now`.
 */
export function photoTakenAt(
  file: Pick<File, 'lastModified'>,
  now: Date = new Date(),
  exifTakenAt?: string | null,
): string {
  const exif = exifTakenAt ? Date.parse(exifTakenAt) : Number.NaN;
  if (Number.isFinite(exif) && exif > 0 && exif <= now.getTime())
    return new Date(exif).toISOString();
  const t = file.lastModified;
  return Number.isFinite(t) && t > 0 && t <= now.getTime()
    ? new Date(t).toISOString()
    : now.toISOString();
}

/** What the first bytes of a picked file say, before it is decoded. */
export interface PhotoHeader {
  /** Pixel size as stored (JPEG, PNG, WebP, GIF); null when the format or bytes are unknown. */
  width: number | null;
  height: number | null;
  /** EXIF DateTimeOriginal (or DateTimeDigitized) as an ISO instant; null when there is none. */
  takenAt: string | null;
}

const NO_HEADER: PhotoHeader = { width: null, height: null, takenAt: null };

/**
 * EXIF date "YYYY:MM:DD HH:MM:SS" with its offset ("+02:00", OffsetTimeOriginal) as an ISO
 * instant. Without an offset the time is read in this browser's time zone (an office near its
 * sites); phones of the last years write the offset.
 */
export function exifDateToIso(value: string, offset?: string | null): string | null {
  const m = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(value.trim());
  if (!m) return null;
  const [y, mo, d, h, mi, sec] = m.slice(1).map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  if (y < 1990 || y > 2100 || mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || sec > 60)
    return null;
  const off = offset?.trim();
  const t =
    off && /^[+-]\d{2}:\d{2}$/.test(off)
      ? Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}${off}`)
      : new Date(y, mo - 1, d, h, mi, sec).getTime();
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

/** The EXIF capture time in a TIFF block (the body of a JPEG's "Exif" APP1 segment). */
function exifTakenAt(b: Uint8Array, start: number, end: number): string | null {
  const le = b[start] === 0x49 && b[start + 1] === 0x49;
  if (!le && !(b[start] === 0x4d && b[start + 1] === 0x4d)) return null;
  const u16 = (o: number) =>
    o + 2 > end ? -1 : le ? b[o]! | (b[o + 1]! << 8) : (b[o]! << 8) | b[o + 1]!;
  const u32 = (o: number) =>
    o + 4 > end
      ? -1
      : le
        ? (b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16)) + b[o + 3]! * 0x1000000
        : b[o]! * 0x1000000 + ((b[o + 1]! << 16) | (b[o + 2]! << 8) | b[o + 3]!);
  if (u16(start + 2) !== 42) return null;
  // Tag → its ASCII value (or, for a pointer, its number) in one IFD.
  const readIfd = (offset: number, wanted: number[]): Map<number, string | number> => {
    const out = new Map<number, string | number>();
    const at = start + offset;
    const count = u16(at);
    if (offset <= 0 || count < 0 || count > 512) return out;
    for (let i = 0; i < count; i++) {
      const e = at + 2 + i * 12;
      const tag = u16(e);
      if (tag < 0) break;
      if (!wanted.includes(tag)) continue;
      const type = u16(e + 2);
      const n = u32(e + 4);
      if (type === 4 || type === 13)
        out.set(tag, u32(e + 8)); // LONG / IFD pointer
      else if (type === 2 && n > 0 && n < 64) {
        const from = n <= 4 ? e + 8 : start + u32(e + 8);
        if (from < start || from + n > end) continue;
        let text = '';
        for (let k = 0; k < n && b[from + k] !== 0; k++) text += String.fromCharCode(b[from + k]!);
        out.set(tag, text);
      }
    }
    return out;
  };
  const ifd0 = readIfd(u32(start + 4), [0x8769]);
  const exifIfd = ifd0.get(0x8769);
  if (typeof exifIfd !== 'number' || exifIfd <= 0) return null;
  const exif = readIfd(exifIfd, [0x9003, 0x9004, 0x9011, 0x9012]);
  const str = (tag: number) => {
    const v = exif.get(tag);
    return typeof v === 'string' ? v : null;
  };
  return (
    (str(0x9003) && exifDateToIso(str(0x9003)!, str(0x9011))) ||
    (str(0x9004) && exifDateToIso(str(0x9004)!, str(0x9012))) ||
    null
  );
}

/** Pixel size and EXIF capture time from the first bytes of a JPEG, PNG, WebP or GIF. */
export function parsePhotoHeader(b: Uint8Array): PhotoHeader {
  const n = b.length;
  const be16 = (o: number) => (b[o]! << 8) | b[o + 1]!;
  const le16 = (o: number) => b[o]! | (b[o + 1]! << 8);
  const ascii = (o: number, len: number) =>
    o + len > n ? '' : String.fromCharCode(...b.subarray(o, o + len));
  const size = (width: number, height: number): Pick<PhotoHeader, 'width' | 'height'> =>
    width > 0 && height > 0 ? { width, height } : { width: null, height: null };

  if (n >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    let takenAt: string | null = null;
    let i = 2;
    while (i + 4 <= n) {
      if (b[i] !== 0xff) break;
      const marker = b[i + 1]!;
      if (marker === 0xff) {
        i += 1; // fill byte
        continue;
      }
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        i += 2;
        continue;
      }
      if (marker === 0xd9 || marker === 0xda) break;
      const len = be16(i + 2);
      if (len < 2) break;
      const body = i + 4;
      if (marker === 0xe1 && takenAt === null && ascii(body, 6) === 'Exif\0\0')
        takenAt = exifTakenAt(b, body + 6, Math.min(n, i + 2 + len));
      const sof =
        marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (sof) {
        if (body + 5 > n) break;
        return { ...size(be16(body + 3), be16(body + 1)), takenAt };
      }
      i += 2 + len;
    }
    return { ...NO_HEADER, takenAt };
  }
  if (n >= 24 && b[0] === 0x89 && ascii(1, 3) === 'PNG' && ascii(12, 4) === 'IHDR') {
    const u32 = (o: number) =>
      b[o]! * 0x1000000 + ((b[o + 1]! << 16) | (b[o + 2]! << 8) | b[o + 3]!);
    return { ...size(u32(16), u32(20)), takenAt: null };
  }
  if (n >= 30 && ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') {
    const chunk = ascii(12, 4);
    if (chunk === 'VP8 ') return { ...size(le16(26) & 0x3fff, le16(28) & 0x3fff), takenAt: null };
    if (chunk === 'VP8L') {
      const [b0, b1, b2, b3] = [b[21]!, b[22]!, b[23]!, b[24]!];
      return {
        ...size(
          1 + (((b1 & 0x3f) << 8) | b0),
          1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6)),
        ),
        takenAt: null,
      };
    }
    if (chunk === 'VP8X')
      return {
        ...size(
          1 + (b[24]! | (b[25]! << 8) | (b[26]! << 16)),
          1 + (b[27]! | (b[28]! << 8) | (b[29]! << 16)),
        ),
        takenAt: null,
      };
    return NO_HEADER;
  }
  if (n >= 10 && ascii(0, 4) === 'GIF8') return { ...size(le16(6), le16(8)), takenAt: null };
  return NO_HEADER;
}

async function headBytes(file: Blob, length: number): Promise<Uint8Array> {
  const part = file.slice(0, length);
  if (typeof part.arrayBuffer === 'function') return new Uint8Array(await part.arrayBuffer());
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.onerror = () => reject(reader.error ?? new Error('read failed'));
    reader.readAsArrayBuffer(part);
  });
}

/** parsePhotoHeader() of a picked file; nothing known when it cannot be read. */
export async function readPhotoHeader(file: Blob): Promise<PhotoHeader> {
  try {
    return parsePhotoHeader(await headBytes(file, HEADER_BYTES));
  } catch {
    return NO_HEADER;
  }
}

export interface DecodedImage {
  width: number;
  height: number;
  source: CanvasImageSource;
  /** Frees the decoded pixels (ImageBitmap.close) or the object URL behind an <img>. */
  close(): void;
}

export interface PhotoCodec {
  decode(file: Blob): Promise<DecodedImage>;
  encode(
    image: DecodedImage,
    size: { width: number; height: number },
    quality: number,
  ): Promise<Blob>;
}

function decodeWithImg(file: Blob): Promise<DecodedImage> {
  const url = URL.createObjectURL(file);
  return new Promise((resolve, reject) => {
    const img = new Image();
    const fail = (why: string) => {
      clearTimeout(timer);
      URL.revokeObjectURL(url);
      reject(new Error(why));
    };
    const timer = setTimeout(() => fail('decode timed out'), IMG_DECODE_TIMEOUT_MS);
    img.onload = () => {
      clearTimeout(timer);
      resolve({
        width: img.naturalWidth,
        height: img.naturalHeight,
        source: img,
        close: () => URL.revokeObjectURL(url),
      });
    };
    img.onerror = () => fail('decode failed');
    img.decoding = 'async';
    img.src = url;
  });
}

/** createImageBitmap (EXIF-aware) when it can, else an <img>; a canvas encodes the JPEG. */
export const browserCodec: PhotoCodec = {
  async decode(file) {
    if (typeof createImageBitmap === 'function') {
      try {
        const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
        return {
          width: bitmap.width,
          height: bitmap.height,
          source: bitmap,
          close: () => bitmap.close(),
        };
      } catch {
        // Older Safari rejects the options or the format; the <img> path below can still work.
      }
    }
    if (typeof Image === 'undefined') throw new Error('no image decoder');
    return decodeWithImg(file);
  },
  async encode(image, size, quality) {
    const canvas = document.createElement('canvas');
    canvas.width = size.width;
    canvas.height = size.height;
    const g = canvas.getContext('2d');
    if (!g) throw new Error('no canvas');
    // JPEG has no transparency: transparent parts of a PNG print white, not black.
    g.fillStyle = '#ffffff';
    g.fillRect(0, 0, size.width, size.height);
    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = 'high';
    g.drawImage(image.source, 0, 0, size.width, size.height);
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, 'image/jpeg', quality),
    );
    // Releases the backing store at once (iOS Safari caps the total canvas memory).
    canvas.width = 0;
    canvas.height = 0;
    if (!blob) throw new Error('encode failed');
    return blob;
  },
};

export interface PreparedPhoto {
  /** The JPEG to upload. */
  blob: Blob;
  mime: 'image/jpeg';
  width: number;
  height: number;
  /** ISO timestamp: EXIF capture time, else file.lastModified (photoTakenAt). */
  takenAt: string;
}

/**
 * A picked file as the JPEG to upload. Throws a PhotoError with the copy to show when the file
 * is not an image, is larger than PHOTO_MAX_BYTES or PHOTO_MAX_PIXELS or cannot be decoded in
 * this browser.
 */
export async function preparePhoto(
  file: File,
  codec: PhotoCodec = browserCodec,
  now: Date = new Date(),
): Promise<PreparedPhoto> {
  const error = photoFileError(file);
  if (error) throw new PhotoError(error);
  const header = await readPhotoHeader(file);
  if (header.width && header.height && header.width * header.height > PHOTO_MAX_PIXELS)
    throw new PhotoError(
      c.tooManyPixels(file.name, Math.round((header.width * header.height) / 1e6)),
    );
  let image: DecodedImage;
  try {
    image = await codec.decode(file);
  } catch {
    throw new PhotoError(unreadableMessage(file));
  }
  try {
    if (!(image.width > 0) || !(image.height > 0)) throw new PhotoError(unreadableMessage(file));
    const size = scaledSize(image.width, image.height);
    let blob: Blob;
    try {
      blob = await codec.encode(image, size, PHOTO_JPEG_QUALITY);
    } catch {
      throw new PhotoError(unreadableMessage(file));
    }
    if (blob.type !== 'image/jpeg') blob = new Blob([blob], { type: 'image/jpeg' });
    return { blob, mime: 'image/jpeg', ...size, takenAt: photoTakenAt(file, now, header.takenAt) };
  } finally {
    image.close();
  }
}

/** A v4 UUID (object names in the bucket); crypto.randomUUID needs a secure context. */
export function randomUuid(): string {
  const cr = globalThis.crypto;
  if (typeof cr?.randomUUID === 'function') return cr.randomUUID();
  const b = cr.getRandomValues(new Uint8Array(16));
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
