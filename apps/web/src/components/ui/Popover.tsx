import * as PopoverPrimitive from '@radix-ui/react-popover';
import { forwardRef, useContext, type ComponentPropsWithoutRef, type ComponentRef } from 'react';
import { PinnedLanguage } from '@/i18n/context';
import { cn } from '@/lib/utils';

export const Popover = PopoverPrimitive.Root;
export const PopoverTrigger = PopoverPrimitive.Trigger;
export const PopoverAnchor = PopoverPrimitive.Anchor;
export const PopoverClose = PopoverPrimitive.Close;

export const PopoverContent = forwardRef<
  ComponentRef<typeof PopoverPrimitive.Content>,
  ComponentPropsWithoutRef<typeof PopoverPrimitive.Content>
>(({ className, align = 'end', sideOffset = 8, ...props }, ref) => {
  // Portaled to <body>: carry an English-only page's language with it (WCAG 3.1.2).
  const pinned = useContext(PinnedLanguage);
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        ref={ref}
        lang={pinned ?? undefined}
        align={align}
        sideOffset={sideOffset}
        className={cn(
          'z-50 w-80 rounded-card border border-rebar bg-chalk p-4 text-asphalt outline-none',
          className,
        )}
        {...props}
      />
    </PopoverPrimitive.Portal>
  );
});
PopoverContent.displayName = 'PopoverContent';
