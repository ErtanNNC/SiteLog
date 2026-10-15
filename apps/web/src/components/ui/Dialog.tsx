import * as DialogPrimitive from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import {
  forwardRef,
  useContext,
  useRef,
  type ComponentPropsWithoutRef,
  type ComponentRef,
  type ReactNode,
} from 'react';
import { PinnedLanguage } from '@/i18n/context';
import { useCopy } from '@/i18n/useCopy';
import { cn } from '@/lib/utils';
import { Button } from './Button';

export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;
export const DialogPortal = DialogPrimitive.Portal;

export const DialogOverlay = forwardRef<
  ComponentRef<typeof DialogPrimitive.Overlay>,
  ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Overlay
    ref={ref}
    className={cn('fixed inset-0 z-50 bg-asphalt/60', className)}
    {...props}
  />
));
DialogOverlay.displayName = 'DialogOverlay';

export const DialogContent = forwardRef<
  ComponentRef<typeof DialogPrimitive.Content>,
  ComponentPropsWithoutRef<typeof DialogPrimitive.Content> & {
    side?: 'center' | 'left' | 'right';
    hideClose?: boolean;
  }
>(
  (
    {
      className,
      children,
      side = 'center',
      hideClose,
      onOpenAutoFocus,
      onCloseAutoFocus,
      ...props
    },
    ref,
  ) => {
    // Most dialogs here are opened from state (no <DialogTrigger>), and Radix then has nothing
    // to return focus to on close, so it lands on <body>. Remember the opener and restore it
    // (WCAG 2.4.3 focus order); a dialog with a DialogTrigger gets the same element back.
    const opener = useRef<HTMLElement | null>(null);
    // Portaled to <body>: carry an English-only page's language with it (WCAG 3.1.2).
    const pinned = useContext(PinnedLanguage);
    const { t } = useCopy();
    return (
      <DialogPortal>
        <DialogOverlay />
        <DialogPrimitive.Content
          ref={ref}
          lang={pinned ?? undefined}
          onOpenAutoFocus={(e) => {
            opener.current =
              document.activeElement instanceof HTMLElement &&
              document.activeElement !== document.body
                ? document.activeElement
                : null;
            onOpenAutoFocus?.(e);
          }}
          onCloseAutoFocus={(e) => {
            onCloseAutoFocus?.(e);
            if (e.defaultPrevented) return;
            const el = opener.current;
            opener.current = null;
            if (el?.isConnected) {
              e.preventDefault();
              el.focus();
            }
          }}
          className={cn(
            'fixed z-50 flex flex-col bg-chalk text-asphalt outline-none',
            side === 'center' &&
              'left-1/2 top-1/2 w-[calc(100%-32px)] max-w-lg -translate-x-1/2 -translate-y-1/2 rounded-card border border-rebar p-6',
            side === 'left' &&
              'inset-y-0 left-0 h-full w-[280px] max-w-[85vw] border-r border-iron',
            side === 'right' &&
              'inset-y-0 right-0 h-full w-full max-w-md border-l border-rebar p-6',
            className,
          )}
          {...props}
        >
          {children}
          {!hideClose && (
            <DialogPrimitive.Close asChild>
              <Button
                variant="subtle"
                size="iconDense"
                className="absolute right-3 top-3"
                aria-label={t('a11y.closeDialog')}
              >
                <X aria-hidden="true" />
              </Button>
            </DialogPrimitive.Close>
          )}
        </DialogPrimitive.Content>
      </DialogPortal>
    );
  },
);
DialogContent.displayName = 'DialogContent';

export function DialogHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('flex flex-col gap-1.5 pr-10 text-left', className)} {...props} />;
}

export function DialogFooter({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn('mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end', className)}
      {...props}
    />
  );
}

export const DialogTitle = forwardRef<
  ComponentRef<typeof DialogPrimitive.Title>,
  ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title ref={ref} className={cn('font-h2 text-h2', className)} {...props} />
));
DialogTitle.displayName = 'DialogTitle';

export const DialogDescription = forwardRef<
  ComponentRef<typeof DialogPrimitive.Description>,
  ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description
    ref={ref}
    className={cn('text-[15px] text-dust', className)}
    {...props}
  />
));
DialogDescription.displayName = 'DialogDescription';

export interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
  loading?: boolean;
  onConfirm: () => void | Promise<void>;
  children?: ReactNode;
}

/** Confirmation dialog ("Sign off RL-2041-0187 v2?", "Mark no work at …?"). */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  cancelLabel,
  destructive,
  loading,
  onConfirm,
  children,
}: ConfirmDialogProps) {
  const { t } = useCopy();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description ? <DialogDescription>{description}</DialogDescription> : null}
        </DialogHeader>
        {children}
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="ghost">{cancelLabel ?? t('common.cancel')}</Button>
          </DialogClose>
          <Button
            variant={destructive ? 'destructive' : 'primary'}
            loading={loading}
            onClick={() => void onConfirm()}
          >
            {confirmLabel ?? t('common.confirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
