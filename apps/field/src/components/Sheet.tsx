import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useFieldCopy } from '@/i18n/useFieldCopy';

/**
 * A bottom sheet (§14.6: one decision per screen): a modal dialog that slides from the bottom,
 * closed by its Cancel, the scrim or Escape. It renders at the end of `<body>` and makes the rest
 * of the page `inert` while open, so Tab and a screen reader stay inside it. Focus moves into it
 * when it opens and back to the opener when it closes: once, not on every render of the screen
 * behind it (a re-render must never pull focus out of a field the reporter is typing in).
 */
export function Sheet({
  open,
  titleId,
  onClose,
  children,
}: {
  open: boolean;
  /** The id of the heading inside the sheet (`aria-labelledby`). */
  titleId: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const { tc } = useFieldCopy();
  const host = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  // The latest onClose, without making the focus effect depend on it (callers pass an arrow).
  const close = useRef(onClose);
  useEffect(() => {
    close.current = onClose;
  });

  useEffect(() => {
    if (!open) return;
    const opener = document.activeElement;
    const behind = Array.from(document.body.children).filter(
      (el) => el !== host.current && !el.hasAttribute('inert'),
    );
    behind.forEach((el) => el.setAttribute('inert', ''));
    panel.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close.current();
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      behind.forEach((el) => el.removeAttribute('inert'));
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
  }, [open]);

  if (!open) return null;
  return createPortal(
    <div ref={host} className="fixed inset-0 z-20 flex flex-col justify-end">
      <button
        type="button"
        aria-label={tc('close')}
        onClick={() => close.current()}
        className="absolute inset-0 border-0 bg-asphalt/60 p-0"
      />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="relative flex max-h-[85dvh] flex-col gap-4 overflow-y-auto [&>*]:flex-none rounded-t-card border-t border-rebar bg-chalk px-[18px] pt-5 pb-6 text-asphalt outline-none"
      >
        {children}
      </div>
    </div>,
    document.body,
  );
}
