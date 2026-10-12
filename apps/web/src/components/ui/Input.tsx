import { forwardRef, type InputHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

export const inputClasses =
  'flex h-11 w-full rounded-chip border border-rebar bg-chalk px-3 text-[15px] text-asphalt placeholder:text-dust focus-visible:border-asphalt disabled:cursor-not-allowed disabled:bg-concrete disabled:opacity-70 aria-invalid:border-missing';

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  ({ className, type = 'text', ...props }, ref) => (
    <input ref={ref} type={type} className={cn(inputClasses, className)} {...props} />
  ),
);
Input.displayName = 'Input';

export const Textarea = forwardRef<
  HTMLTextAreaElement,
  TextareaHTMLAttributes<HTMLTextAreaElement>
>(({ className, ...props }, ref) => (
  <textarea
    ref={ref}
    className={cn(inputClasses, 'h-auto min-h-24 py-2 leading-[22px]', className)}
    {...props}
  />
));
Textarea.displayName = 'Textarea';
