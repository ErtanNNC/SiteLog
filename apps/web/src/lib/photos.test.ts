import { describe, expect, it, vi } from 'vitest';
import {
  PHOTO_JPEG_QUALITY,
  PHOTO_MAX_BYTES,
  PhotoError,
  exifDateToIso,
  parsePhotoHeader,
  photoFileError,
  photoTakenAt,
  preparePhoto,
  randomUuid,
  readPhotoHeader,
  scaledSize,
  type DecodedImage,
  type PhotoCodec,
} from './photos';

const NOW = new Date('2026-10-09T23:00:00Z');

function file(
  name: string,
  type: string,
  size = 1000,
  lastModified = Date.parse('2026-10-09T15:30:00Z'),
) {
  const f = new File(['x'], name, { type, lastModified });
  Object.defineProperty(f, 'size', { value: size });
  return f;
}

/** jsdom has no canvas: a codec that records what it was asked to do. */
function stubCodec(width: number, height: number) {
  const close = vi.fn();
  const image: DecodedImage = { width, height, source: {} as CanvasImageSource, close };
  const codec = {
    decode: vi.fn(async () => image),
    encode: vi.fn(async () => new Blob(['jpeg-bytes'], { type: 'image/jpeg' })),
  } satisfies PhotoCodec;
  return { codec, close, image };
}

/** A TIFF block with an Exif IFD holding the given ASCII tags (DateTimeOriginal & co). */
function exifTiff(tags: Record<number, string>, littleEndian = true): Uint8Array<ArrayBuffer> {
  const entries = Object.entries(tags).map(([tag, text]) => ({ tag: Number(tag), text }));
  const exifIfd = 8 + 2 + 12 + 4;
  const dataStart = exifIfd + 2 + entries.length * 12 + 4;
  const size = dataStart + entries.reduce((n, e) => n + e.text.length + 1, 0);
  const buf = new Uint8Array(size);
  const v = new DataView(buf.buffer);
  const le = littleEndian;
  buf.set(le ? [0x49, 0x49] : [0x4d, 0x4d], 0);
  v.setUint16(2, 42, le);
  v.setUint32(4, 8, le);
  // IFD0: one entry, the Exif IFD pointer.
  v.setUint16(8, 1, le);
  v.setUint16(10, 0x8769, le);
  v.setUint16(12, 4, le);
  v.setUint32(14, 1, le);
  v.setUint32(18, exifIfd, le);
  v.setUint32(22, 0, le);
  v.setUint16(exifIfd, entries.length, le);
  let data = dataStart;
  entries.forEach((e, i) => {
    const at = exifIfd + 2 + i * 12;
    v.setUint16(at, e.tag, le);
    v.setUint16(at + 2, 2, le); // ASCII
    v.setUint32(at + 4, e.text.length + 1, le);
    v.setUint32(at + 8, data, le);
    for (let k = 0; k < e.text.length; k++) buf[data + k] = e.text.charCodeAt(k);
    data += e.text.length + 1;
  });
  return buf;
}

/** A JPEG header: optional Exif APP1, then a baseline SOF0 with the pixel size. */
function jpegHeader(width: number, height: number, tiff?: Uint8Array): Uint8Array<ArrayBuffer> {
  const parts: number[] = [0xff, 0xd8];
  // An APP0 (JFIF) segment first, as cameras and phones write.
  parts.push(0xff, 0xe0, 0x00, 0x10, ...Array.from({ length: 14 }, () => 0));
  if (tiff) {
    const len = 2 + 6 + tiff.length;
    parts.push(0xff, 0xe1, len >> 8, len & 0xff, 0x45, 0x78, 0x69, 0x66, 0, 0, ...tiff);
  }
  parts.push(0xff, 0xc0, 0x00, 0x11, 8, height >> 8, height & 0xff, width >> 8, width & 0xff, 3);
  parts.push(...Array.from({ length: 9 }, () => 1), 0xff, 0xda);
  return new Uint8Array(parts);
}

describe('parsePhotoHeader', () => {
  it('reads a JPEG’s size and its EXIF capture time with the offset', () => {
    const tiff = exifTiff({ 0x9003: '2026:10:08 14:05:33', 0x9011: '-05:00' });
    expect(parsePhotoHeader(jpegHeader(4032, 3024, tiff))).toEqual({
      width: 4032,
      height: 3024,
      takenAt: '2026-10-08T19:05:33.000Z',
    });
    // Big-endian (Motorola) EXIF, digitized time only.
    const be = exifTiff({ 0x9004: '2026:10:08 07:00:00', 0x9012: '+02:00' }, false);
    expect(parsePhotoHeader(jpegHeader(800, 600, be))).toEqual({
      width: 800,
      height: 600,
      takenAt: '2026-10-08T05:00:00.000Z',
    });
    expect(parsePhotoHeader(jpegHeader(12_000, 9_000))).toEqual({
      width: 12_000,
      height: 9_000,
      takenAt: null,
    });
  });

  it('reads PNG, WebP and GIF sizes', () => {
    const png = new Uint8Array(32);
    png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
    new DataView(png.buffer).setUint32(16, 6000);
    new DataView(png.buffer).setUint32(20, 4000);
    expect(parsePhotoHeader(png)).toEqual({ width: 6000, height: 4000, takenAt: null });

    const riff = (chunk: string, body: number[]) => {
      const b = new Uint8Array(40);
      b.set(
        [...'RIFF'].map((x) => x.charCodeAt(0)),
        0,
      );
      b.set(
        [...'WEBP'].map((x) => x.charCodeAt(0)),
        8,
      );
      b.set(
        [...chunk].map((x) => x.charCodeAt(0)),
        12,
      );
      b.set(body, 20);
      return b;
    };
    // VP8X: 24-bit width-1 and height-1 at 24 and 27.
    expect(parsePhotoHeader(riff('VP8X', [0, 0, 0, 0, 0x3f, 0x1f, 0, 0x6f, 0x17, 0]))).toEqual({
      width: 8000,
      height: 6000,
      takenAt: null,
    });
    // VP8L: 14-bit width-1 and height-1 after the 0x2f signature.
    const w = 1999;
    const h = 1499;
    const bits = w | (h << 14);
    expect(
      parsePhotoHeader(
        riff('VP8L', [
          0x2f,
          bits & 0xff,
          (bits >> 8) & 0xff,
          (bits >> 16) & 0xff,
          (bits >> 24) & 0xff,
        ]),
      ),
    ).toEqual({ width: 2000, height: 1500, takenAt: null });
    // VP8 (lossy): frame tag, start code, then 14-bit sizes.
    expect(
      parsePhotoHeader(riff('VP8 ', [0, 0, 0, 0x9d, 0x01, 0x2a, 0x40, 0x06, 0xb0, 0x04])),
    ).toEqual({ width: 1600, height: 1200, takenAt: null });

    const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x80, 0x02, 0xe0, 0x01]);
    expect(parsePhotoHeader(gif)).toEqual({ width: 640, height: 480, takenAt: null });
  });

  it('knows nothing about other or broken files', () => {
    const none = { width: null, height: null, takenAt: null };
    expect(parsePhotoHeader(new Uint8Array([0x25, 0x50, 0x44, 0x46]))).toEqual(none);
    expect(parsePhotoHeader(new Uint8Array([0xff, 0xd8, 0xff]))).toEqual(none);
    // A JPEG cut off inside its EXIF segment.
    const cut = jpegHeader(4000, 3000, exifTiff({ 0x9003: '2026:10:08 14:05:33' })).slice(0, 40);
    expect(parsePhotoHeader(cut)).toEqual(none);
    // A placeholder date.
    expect(
      parsePhotoHeader(jpegHeader(10, 10, exifTiff({ 0x9003: '0000:00:00 00:00:00' }))),
    ).toEqual({ width: 10, height: 10, takenAt: null });
  });

  it('reads a picked file’s first bytes', async () => {
    const tiff = exifTiff({ 0x9003: '2026:10:08 14:05:33', 0x9011: '+00:00' });
    const f = new File([jpegHeader(4032, 3024, tiff), new Uint8Array(1000)], 'a.jpg', {
      type: 'image/jpeg',
    });
    expect(await readPhotoHeader(f)).toEqual({
      width: 4032,
      height: 3024,
      takenAt: '2026-10-08T14:05:33.000Z',
    });
  });
});

describe('exifDateToIso', () => {
  it('uses the offset when there is one, else this browser’s time zone', () => {
    expect(exifDateToIso('2026:10:08 14:05:33', '+09:30')).toBe('2026-10-08T04:35:33.000Z');
    expect(exifDateToIso('2026:10:08 14:05:33')).toBe(
      new Date(2026, 9, 8, 14, 5, 33).toISOString(),
    );
    expect(exifDateToIso('2026:10:08 14:05:33', 'garbage')).toBe(
      new Date(2026, 9, 8, 14, 5, 33).toISOString(),
    );
    expect(exifDateToIso('2026:13:08 14:05:33')).toBeNull();
    expect(exifDateToIso('    :  :     :  :  ')).toBeNull();
  });
});

describe('photoFileError', () => {
  it('accepts images up to 25 MB, by type or (without one) by extension', () => {
    expect(photoFileError(file('a.jpg', 'image/jpeg'))).toBeNull();
    expect(photoFileError(file('a.png', 'image/png', PHOTO_MAX_BYTES))).toBeNull();
    expect(photoFileError(file('IMG_0012.HEIC', ''))).toBeNull();
    expect(photoFileError(file('IMG_0012.heic', 'image/heic'))).toBeNull();
  });

  it('refuses other files and originals over 25 MB with the file name', () => {
    expect(photoFileError(file('notes.pdf', 'application/pdf'))).toBe('notes.pdf is not an image.');
    expect(photoFileError(file('notes', ''))).toBe('notes is not an image.');
    expect(photoFileError(file('big.jpg', 'image/jpeg', PHOTO_MAX_BYTES + 1))).toBe(
      'big.jpg is larger than 25 MB.',
    );
  });
});

describe('scaledSize', () => {
  it('scales the long edge down to 2000 px and keeps the aspect ratio', () => {
    expect(scaledSize(4032, 3024)).toEqual({ width: 2000, height: 1500 });
    expect(scaledSize(3024, 4032)).toEqual({ width: 1500, height: 2000 });
    expect(scaledSize(8000, 10)).toEqual({ width: 2000, height: 3 });
    expect(scaledSize(10_000, 1)).toEqual({ width: 2000, height: 1 });
  });

  it('never enlarges a small image', () => {
    expect(scaledSize(1600, 1200)).toEqual({ width: 1600, height: 1200 });
    expect(scaledSize(2000, 2000)).toEqual({ width: 2000, height: 2000 });
    expect(scaledSize(640, 480, 320)).toEqual({ width: 320, height: 240 });
  });

  it('refuses an image without a size', () => {
    expect(() => scaledSize(0, 100)).toThrow(RangeError);
    expect(() => scaledSize(Number.NaN, 100)).toThrow(RangeError);
  });
});

describe('photoTakenAt', () => {
  it('is the file’s last-modified time, never later than now', () => {
    expect(photoTakenAt({ lastModified: Date.parse('2026-10-09T15:30:00Z') }, NOW)).toBe(
      '2026-10-09T15:30:00.000Z',
    );
    expect(photoTakenAt({ lastModified: Date.parse('2027-01-01T00:00:00Z') }, NOW)).toBe(
      NOW.toISOString(),
    );
    expect(photoTakenAt({ lastModified: 0 }, NOW)).toBe(NOW.toISOString());
    expect(photoTakenAt({ lastModified: Number.NaN }, NOW)).toBe(NOW.toISOString());
  });

  it('prefers the EXIF capture time (a library pick’s file is as new as the pick)', () => {
    const picked = { lastModified: NOW.getTime() - 60_000 };
    expect(photoTakenAt(picked, NOW, '2026-10-08T19:05:33.000Z')).toBe('2026-10-08T19:05:33.000Z');
    // A camera clock in the future does not count.
    expect(photoTakenAt(picked, NOW, '2027-01-01T00:00:00.000Z')).toBe(
      new Date(picked.lastModified).toISOString(),
    );
    expect(photoTakenAt(picked, NOW, null)).toBe(new Date(picked.lastModified).toISOString());
  });
});

describe('preparePhoto', () => {
  it('decodes, scales to 2000 px, encodes JPEG at 0.82 and frees the decoded image', async () => {
    const { codec, close, image } = stubCodec(4032, 3024);
    const photo = await preparePhoto(file('IMG_0001.png', 'image/png'), codec, NOW);
    expect(codec.encode).toHaveBeenCalledWith(
      image,
      { width: 2000, height: 1500 },
      PHOTO_JPEG_QUALITY,
    );
    expect(photo).toEqual({
      blob: expect.any(Blob),
      mime: 'image/jpeg',
      width: 2000,
      height: 1500,
      takenAt: '2026-10-09T15:30:00.000Z',
    });
    expect(photo.blob.type).toBe('image/jpeg');
    expect(close).toHaveBeenCalledOnce();
  });

  it('takes the time from EXIF and refuses a photo over 50 megapixels before decoding', async () => {
    const { codec } = stubCodec(4032, 3024);
    const tiff = exifTiff({ 0x9003: '2026:10:08 14:05:33', 0x9011: '-05:00' });
    const withExif = new File([jpegHeader(4032, 3024, tiff)], 'IMG_0042.jpg', {
      type: 'image/jpeg',
      lastModified: Date.parse('2026-10-09T22:59:00Z'),
    });
    expect((await preparePhoto(withExif, codec, NOW)).takenAt).toBe('2026-10-08T19:05:33.000Z');

    const huge = new File([jpegHeader(12_000, 9_000)], '108mp.jpg', { type: 'image/jpeg' });
    codec.decode.mockClear();
    await expect(preparePhoto(huge, codec, NOW)).rejects.toThrow(
      new PhotoError(
        '108mp.jpg is a 108-megapixel photo, too large to prepare here. Use a copy under 50 megapixels.',
      ),
    );
    expect(codec.decode).not.toHaveBeenCalled();
    // A 50 MP phone mode still passes.
    const fifty = new File([jpegHeader(8160, 6120)], '50mp.jpg', { type: 'image/jpeg' });
    await expect(preparePhoto(fifty, codec, NOW)).resolves.toMatchObject({ width: 2000 });
  });

  it('labels an encoder result without a type as JPEG', async () => {
    const { codec } = stubCodec(800, 600);
    codec.encode.mockResolvedValueOnce(new Blob(['raw']));
    const photo = await preparePhoto(file('a.jpg', 'image/jpeg'), codec, NOW);
    expect(photo.blob.type).toBe('image/jpeg');
    expect(photo).toMatchObject({ width: 800, height: 600 });
  });

  it('refuses a non-image before decoding it', async () => {
    const { codec } = stubCodec(10, 10);
    await expect(preparePhoto(file('a.txt', 'text/plain'), codec)).rejects.toThrow(
      new PhotoError('a.txt is not an image.'),
    );
    expect(codec.decode).not.toHaveBeenCalled();
  });

  it('explains a HEIC photo the browser cannot decode, and any other unreadable file', async () => {
    const { codec } = stubCodec(10, 10);
    codec.decode.mockRejectedValue(new Error('InvalidStateError'));
    await expect(preparePhoto(file('IMG_0012.HEIC', ''), codec)).rejects.toThrow(
      'IMG_0012.HEIC is a HEIC photo this browser can’t open. Use Safari, or save it as JPEG first.',
    );
    await expect(preparePhoto(file('scan.png', 'image/png'), codec)).rejects.toThrow(
      'scan.png couldn’t be opened. Try a JPEG or PNG.',
    );
  });

  it('frees the decoded image when encoding fails or the image has no size', async () => {
    const failing = stubCodec(4000, 3000);
    failing.codec.encode.mockRejectedValueOnce(new Error('no canvas'));
    await expect(preparePhoto(file('a.jpg', 'image/jpeg'), failing.codec)).rejects.toBeInstanceOf(
      PhotoError,
    );
    expect(failing.close).toHaveBeenCalledOnce();
    const empty = stubCodec(0, 0);
    await expect(preparePhoto(file('b.jpg', 'image/jpeg'), empty.codec)).rejects.toThrow(
      'b.jpg couldn’t be opened. Try a JPEG or PNG.',
    );
    expect(empty.close).toHaveBeenCalledOnce();
  });
});

describe('randomUuid', () => {
  it('is a lowercase v4 UUID, with or without crypto.randomUUID', () => {
    const v4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
    expect(randomUuid()).toMatch(v4);
    // Not a secure context (plain http on a LAN address): no crypto.randomUUID.
    const original = Object.getOwnPropertyDescriptor(globalThis.crypto, 'randomUUID');
    Object.defineProperty(globalThis.crypto, 'randomUUID', {
      value: undefined,
      configurable: true,
    });
    try {
      const a = randomUuid();
      expect(a).toMatch(v4);
      expect(randomUuid()).not.toBe(a);
    } finally {
      if (original) Object.defineProperty(globalThis.crypto, 'randomUUID', original);
      else delete (globalThis.crypto as { randomUUID?: unknown }).randomUUID;
    }
  });
});
