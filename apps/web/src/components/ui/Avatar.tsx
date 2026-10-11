import * as AvatarPrimitive from '@radix-ui/react-avatar';
import * as SeparatorPrimitive from '@radix-ui/react-separator';
import * as ScrollAreaPrimitive from '@radix-ui/react-scroll-area';
import { forwardRef, type ComponentPropsWithoutRef, type ComponentRef } from 'react';
import { initials } from '@sitelog/shared/format.ts';
import { cn } from '@/lib/utils';

export const Avatar = forwardRef<
  ComponentRef<typeof AvatarPrimitive.Root>,
  ComponentPropsWithoutRef<typeof AvatarPrimitive.Root> & {
    name: string;
    src?: string | null;
    size?: 'sm' | 'md' | 'lg';
    dark?: boolean;
  }
>(({ className, name, src, size = 'md', dark, ...props }, ref) => (
  <AvatarPrimitive.Root
    ref={ref}
    className={cn(
      'relative flex shrink-0 overflow-hidden rounded-full',
      size === 'sm' ? 'size-8' : size === 'lg' ? 'size-12' : 'size-10',
      className,
    )}
    {...props}
  >
    {src ? (
      <AvatarPrimitive.Image
        src={src}
        alt={name}
        className="aspect-square size-full object-cover"
      />
    ) : null}
    <AvatarPrimitive.Fallback
      delayMs={src ? 300 : 0}
      className={cn(
        'flex size-full items-center justify-center rounded-full font-mono text-[12px] font-semibold uppercase',
        dark ? 'bg-steel text-chalk' : 'bg-concrete text-asphalt',
      )}
      aria-label={name}
    >
      {initials(name) || '?'}
    </AvatarPrimitive.Fallback>
  </AvatarPrimitive.Root>
));
Avatar.displayName = 'Avatar';

export const Separator = forwardRef<
  ComponentRef<typeof SeparatorPrimitive.Root>,
  ComponentPropsWithoutRef<typeof SeparatorPrimitive.Root>
>(({ className, orientation = 'horizontal', decorative = true, ...props }, ref) => (
  <SeparatorPrimitive.Root
    ref={ref}
    decorative={decorative}
    orientation={orientation}
    className={cn(
      'shrink-0 bg-rebar',
      orientation === 'horizontal' ? 'h-px w-full' : 'h-full w-px',
      className,
    )}
    {...props}
  />
));
Separator.displayName = 'Separator';

export const ScrollArea = forwardRef<
  ComponentRef<typeof ScrollAreaPrimitive.Root>,
  ComponentPropsWithoutRef<typeof ScrollAreaPrimitive.Root>
>(({ className, children, ...props }, ref) => (
  <ScrollAreaPrimitive.Root
    ref={ref}
    className={cn('relative overflow-hidden', className)}
    {...props}
  >
    <ScrollAreaPrimitive.Viewport className="size-full rounded-[inherit]">
      {children}
    </ScrollAreaPrimitive.Viewport>
    <ScrollAreaPrimitive.Scrollbar
      orientation="vertical"
      className="flex w-2.5 touch-none select-none p-px"
    >
      <ScrollAreaPrimitive.Thumb className="relative flex-1 rounded-full bg-rebar" />
    </ScrollAreaPrimitive.Scrollbar>
    <ScrollAreaPrimitive.Corner />
  </ScrollAreaPrimitive.Root>
));
ScrollArea.displayName = 'ScrollArea';
