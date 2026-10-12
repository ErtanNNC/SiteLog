/** URL of a file in `public/`, valid under any base path (the hosted demo is served from a sub-path). */
export function assetUrl(path: string): string {
  return `${import.meta.env.BASE_URL}${path.replace(/^\//, '')}`;
}
