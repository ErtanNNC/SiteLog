import { copy } from '@/copy/en';

/** §F2: the company logo is a PNG or SVG of at most 2 MB. */
export const LOGO_MAX_BYTES = 2 * 1024 * 1024;
export const LOGO_TYPES: readonly string[] = ['image/png', 'image/svg+xml'];
export const LOGO_ACCEPT = LOGO_TYPES.join(',');

/**
 * What is wrong with a logo file, as its copy key (the same name under `setup.company.*` and
 * `settings.pdf.*`); null when it is fine.
 */
export function logoFileProblem(
  file: Pick<File, 'type' | 'size'>,
): 'logoWrongType' | 'logoTooLarge' | null {
  if (!LOGO_TYPES.includes(file.type)) return 'logoWrongType';
  if (file.size > LOGO_MAX_BYTES) return 'logoTooLarge';
  return null;
}

/** Client-side check before upload; returns the error copy (English) or `null` when fine. */
export function logoFileError(file: Pick<File, 'type' | 'size'>): string | null {
  const problem = logoFileProblem(file);
  return problem ? copy.setup.company[problem] : null;
}

/** Longest side of the PNG rendition of an SVG logo (sharp at the PDF letterhead size). */
export const LOGO_RASTER_PX = 1200;

/**
 * PNG rendition of an SVG logo, uploaded next to it as `logo.png`: react-pdf cannot embed SVG
 * files, so the worker prints this copy on reports. Resolves `null` when the browser cannot
 * rasterise it (no canvas, broken SVG, 5 s timeout); the PDF then shows the company name.
 */
export async function rasterizeSvgLogo(file: Blob, maxPx = LOGO_RASTER_PX): Promise<Blob | null> {
  if (typeof document === 'undefined' || typeof Image === 'undefined') return null;
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement | null>((resolve) => {
      const el = new Image();
      const timer = setTimeout(() => resolve(null), 5000);
      el.onload = () => {
        clearTimeout(timer);
        resolve(el);
      };
      el.onerror = () => {
        clearTimeout(timer);
        resolve(null);
      };
      el.src = url;
    });
    if (!img) return null;
    const w = img.naturalWidth || 300;
    const h = img.naturalHeight || 150;
    const scale = maxPx / Math.max(w, h);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(w * scale));
    canvas.height = Math.max(1, Math.round(h * scale));
    const g = canvas.getContext('2d');
    if (!g) return null;
    g.drawImage(img, 0, 0, canvas.width, canvas.height);
    return await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
  } catch {
    return null;
  } finally {
    URL.revokeObjectURL(url);
  }
}
