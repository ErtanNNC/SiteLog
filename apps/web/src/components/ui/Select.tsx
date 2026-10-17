import * as SelectPrimitive from '@radix-ui/react-select';
import { Check, ChevronDown } from 'lucide-react';
import { forwardRef, useContext, type ComponentPropsWithoutRef, type ComponentRef } from 'react';
import { PinnedLanguage } from '@/i18n/context';
import { cn } from '@/lib/utils';

export const Select = SelectPrimitive.Root;
export const SelectGroup = SelectPrimitive.Group;
export const SelectValue = SelectPrimitive.Value;

export const SelectTrigger = forwardRef<
  ComponentRef<typeof SelectPrimitive.Trigger>,
  ComponentPropsWithoutRef<typeof SelectPrimitive.Trigger> & { dense?: boolean }
>(({ className, children, dense, ...props }, ref) => (
  <SelectPrimitive.Trigger
    ref={ref}
    className={cn(
      'flex w-full items-center justify-between gap-2 rounded-chip border border-rebar bg-chalk px-3 text-[15px] text-asphalt data-[placeholder]:text-dust focus-visible:border-asphalt disabled:cursor-not-allowed disabled:opacity-50 [&>span]:truncate',
      dense ? 'h-target-dense' : 'h-target',
      className,
    )}
    {...props}
  >
    {children}
    <SelectPrimitive.Icon asChild>
      <ChevronDown className="size-5 shrink-0 text-dust" aria-hidden="true" />
    </SelectPrimitive.Icon>
  </SelectPrimitive.Trigger>
));
SelectTrigger.displayName = 'SelectTrigger';

export const SelectContent = forwardRef<
  ComponentRef<typeof SelectPrimitive.Content>,
  ComponentPropsWithoutRef<typeof SelectPrimitive.Content>
>(({ className, children, position = 'popper', ...props }, ref) => {
  // Portaled to <body>: carry an English-only page's language with it (WCAG 3.1.2).
  const pinned = useContext(PinnedLanguage);
  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Content
        ref={ref}
        lang={pinned ?? undefined}
        position={position}
        className={cn(
          'relative z-50 max-h-80 min-w-[8rem] overflow-hidden rounded-card border border-rebar bg-chalk text-asphalt',
          position === 'popper' &&
            'w-full min-w-[var(--radix-select-trigger-width)] data-[side=bottom]:translate-y-1',
          className,
        )}
        {...props}
      >
        <SelectPrimitive.Viewport className="p-1">{children}</SelectPrimitive.Viewport>
      </SelectPrimitive.Content>
    </SelectPrimitive.Portal>
  );
});
SelectContent.displayName = 'SelectContent';

export const SelectItem = forwardRef<
  ComponentRef<typeof SelectPrimitive.Item>,
  ComponentPropsWithoutRef<typeof SelectPrimitive.Item>
>(({ className, children, ...props }, ref) => (
  <SelectPrimitive.Item
    ref={ref}
    className={cn(
      'relative flex min-h-target w-full cursor-pointer select-none items-center rounded-chip py-2 pl-3 pr-9 text-[15px] outline-none data-[highlighted]:bg-concrete data-[disabled]:pointer-events-none data-[disabled]:opacity-50',
      className,
    )}
    {...props}
  >
    <span className="absolute right-3 flex size-5 items-center justify-center">
      <SelectPrimitive.ItemIndicator>
        <Check className="size-4" aria-hidden="true" />
      </SelectPrimitive.ItemIndicator>
    </span>
    <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
  </SelectPrimitive.Item>
));
SelectItem.displayName = 'SelectItem';

export const SelectLabel = forwardRef<
  ComponentRef<typeof SelectPrimitive.Label>,
  ComponentPropsWithoutRef<typeof SelectPrimitive.Label>
>(({ className, ...props }, ref) => (
  <SelectPrimitive.Label
    ref={ref}
    className={cn('eyebrow px-3 py-2 text-dust', className)}
    {...props}
  />
));
SelectLabel.displayName = 'SelectLabel';
