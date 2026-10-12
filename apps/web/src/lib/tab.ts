/**
 * Opens a blank tab synchronously — inside the click handler, so popup blockers allow it — and
 * returns a function that sends it to a URL once an async lookup (signed URL) resolves, or closes
 * it when there is nothing to show.
 */
export function pendingTab(): (url: string | null) => void {
  let win: Window | null = null;
  try {
    win = window.open('', '_blank');
    if (win) win.opener = null;
  } catch {
    win = null;
  }
  return (url) => {
    if (!url) {
      win?.close();
      return;
    }
    if (win && !win.closed) win.location.href = url;
    else openInNewTab(url);
  };
}

/**
 * Opens a URL in a new tab. `blob:` URLs (PDFs rendered in this page) open without `noopener`:
 * Chrome only resolves a blob URL in the browsing-context group that created it, so a noopener
 * tab stays blank.
 */
export function openInNewTab(url: string): void {
  if (url.startsWith('blob:')) window.open(url, '_blank');
  else window.open(url, '_blank', 'noopener');
}
