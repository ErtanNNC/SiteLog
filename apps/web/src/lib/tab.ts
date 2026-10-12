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
    else window.open(url, '_blank', 'noopener');
  };
}
