import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import {
  forwardRef,
  useContext,
  type ComponentPropsWithoutRef,
  type ComponentRef,
  type ReactNode,
} from 'react';
import { PinnedLanguage } from '@/i18n/context';
import { cn } from '@/lib/utils';

export const TooltipProvider = TooltipPrimitive.Provider;
export const Tooltip = TooltipPrimitive.Root;
export const TooltipTrigger = TooltipPrimitive.Trigger;

export const TooltipContent = forwardRef<
  ComponentRef<typeof TooltipPrimitive.Content>,
  ComponentPropsWithoutRef<typeof TooltipPrimitive.Content>
>(({ className, sideOffset = 6, ...props }, ref) => {
  // Portaled to <body>: carry an English-only page's language with it (WCAG 3.1.2).
  const pinned = useContext(PinnedLanguage);
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        ref={ref}
        lang={pinned ?? undefined}
        sideOffset={sideOffset}
        className={cn(
          'z-50 max-w-xs rounded-chip bg-asphalt px-3 py-1.5 text-caption text-chalk',
          className,
        )}
        {...props}
      />
    </TooltipPrimitive.Portal>
  );
});
TooltipContent.displayName = 'TooltipContent';

/** Convenience wrapper: <Tip label="…"><button/></Tip> */
export function Tip({
  label,
  children,
  side,
}: {
  label: ReactNode;
  children: ReactNode;
  side?: 'top' | 'bottom' | 'left' | 'right';
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side={side}>{label}</TooltipContent>
    </Tooltip>
  );
}
