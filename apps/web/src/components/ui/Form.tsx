/**
 * react-hook-form + zod helpers. Usage:
 *   const form = useForm({ resolver: zodResolver(schema) });
 *   <Form {...form}><FormField control={form.control} name="email" render={({ field }) => (
 *     <FormItem><FormLabel>…</FormLabel><FormControl><Input {...field} /></FormControl><FormMessage /></FormItem>
 *   )} /></Form>
 */
import { Slot } from '@radix-ui/react-slot';
import {
  createContext,
  forwardRef,
  useContext,
  useId,
  type ComponentPropsWithoutRef,
  type HTMLAttributes,
} from 'react';
import {
  Controller,
  FormProvider,
  useFormContext,
  type ControllerProps,
  type FieldPath,
  type FieldValues,
} from 'react-hook-form';
import { cn } from '@/lib/utils';
import { Label } from './Label';

export const Form = FormProvider;

const FieldCtx = createContext<{ name: string } | null>(null);
const ItemCtx = createContext<{ id: string } | null>(null);

export function FormField<
  TFieldValues extends FieldValues = FieldValues,
  TName extends FieldPath<TFieldValues> = FieldPath<TFieldValues>,
>(props: ControllerProps<TFieldValues, TName>) {
  return (
    <FieldCtx.Provider value={{ name: props.name }}>
      <Controller {...props} />
    </FieldCtx.Provider>
  );
}

export function useFormField() {
  const field = useContext(FieldCtx);
  const item = useContext(ItemCtx);
  const { getFieldState, formState } = useFormContext();
  if (!field || !item) throw new Error('useFormField must be used inside <FormField><FormItem>');
  const state = getFieldState(field.name, formState);
  return {
    name: field.name,
    id: item.id,
    formItemId: `${item.id}-form-item`,
    formDescriptionId: `${item.id}-form-item-description`,
    formMessageId: `${item.id}-form-item-message`,
    ...state,
  };
}

export const FormItem = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => {
    const id = useId();
    return (
      <ItemCtx.Provider value={{ id }}>
        <div ref={ref} className={cn('grid gap-1.5', className)} {...props} />
      </ItemCtx.Provider>
    );
  },
);
FormItem.displayName = 'FormItem';

export const FormLabel = forwardRef<HTMLLabelElement, ComponentPropsWithoutRef<typeof Label>>(
  ({ className, ...props }, ref) => {
    const { error, formItemId } = useFormField();
    return (
      <Label
        ref={ref}
        className={cn(error && 'text-missing', className)}
        htmlFor={formItemId}
        {...props}
      />
    );
  },
);
FormLabel.displayName = 'FormLabel';

export const FormControl = forwardRef<HTMLElement, ComponentPropsWithoutRef<typeof Slot>>(
  ({ ...props }, ref) => {
    const { error, formItemId, formDescriptionId, formMessageId } = useFormField();
    return (
      <Slot
        ref={ref}
        id={formItemId}
        aria-describedby={error ? `${formDescriptionId} ${formMessageId}` : formDescriptionId}
        aria-invalid={!!error}
        {...props}
      />
    );
  },
);
FormControl.displayName = 'FormControl';

export const FormDescription = forwardRef<
  HTMLParagraphElement,
  HTMLAttributes<HTMLParagraphElement>
>(({ className, ...props }, ref) => {
  const { formDescriptionId } = useFormField();
  return (
    <p
      ref={ref}
      id={formDescriptionId}
      className={cn('text-caption text-dust', className)}
      {...props}
    />
  );
});
FormDescription.displayName = 'FormDescription';

export const FormMessage = forwardRef<HTMLParagraphElement, HTMLAttributes<HTMLParagraphElement>>(
  ({ className, children, ...props }, ref) => {
    const { error, formMessageId } = useFormField();
    const body = error ? String(error.message ?? '') : children;
    if (!body) return null;
    return (
      <p
        ref={ref}
        id={formMessageId}
        role="alert"
        className={cn('text-caption font-medium text-missing', className)}
        {...props}
      >
        {body}
      </p>
    );
  },
);
FormMessage.displayName = 'FormMessage';
