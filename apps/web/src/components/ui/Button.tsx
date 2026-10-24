import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import { LoaderCircle } from 'lucide-react';
import { forwardRef, type ButtonHTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

/**
 * §14.3 buttons: 44 px (dense 40 px, `sm` for inline text actions), radius 6. Heights come from the
 * `target` tokens in pixels: the panel's 15 px root would make `h-11` 41.25 px. Primary = Signal bg + Asphalt text 700.
 * Secondary = Asphalt bg + Chalk text. Ghost = Chalk + Rebar border. Destructive = text-only red.
 */
export const buttonVariants = cva(
  'inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-btn text-[15px] font-semibold leading-none transition-colors disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-5 [&_svg]:shrink-0 [&_svg]:stroke-2',
  {
    variants: {
      variant: {
        primary: 'bg-signal text-asphalt font-bold hover:bg-signal-deep hover:text-chalk',
        secondary: 'bg-asphalt text-chalk hover:bg-steel',
        ghost: 'border border-rebar bg-chalk text-asphalt hover:bg-concrete',
        subtle: 'bg-transparent text-asphalt hover:bg-concrete',
        destructive: 'bg-transparent text-missing hover:bg-chip-miss-bg',
        link: 'h-auto rounded-none bg-transparent p-0 text-level underline-offset-4 hover:underline',
      },
      size: {
        default: 'h-target px-4',
        dense: 'h-target-dense px-3 text-sm',
        sm: 'h-9 px-3 text-sm',
        icon: 'size-target p-0',
        iconDense: 'size-target-dense p-0',
      },
    },
    defaultVariants: { variant: 'ghost', size: 'default' },
  },
);

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  asChild?: boolean;
  loading?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  (
    {
      className,
      variant,
      size,
      asChild = false,
      loading = false,
      disabled,
      children,
      type,
      ...props
    },
    ref,
  ) => {
    const Comp = asChild ? Slot : 'button';
    return (
      <Comp
        ref={ref}
        type={asChild ? undefined : (type ?? 'button')}
        className={cn(buttonVariants({ variant, size }), className)}
        disabled={disabled || loading}
        aria-busy={loading || undefined}
        {...props}
      >
        {loading ? (
          <>
            <LoaderCircle className="animate-sl-spin" aria-hidden="true" />
            {children}
          </>
        ) : (
          children
        )}
      </Comp>
    );
  },
);
Button.displayName = 'Button';
