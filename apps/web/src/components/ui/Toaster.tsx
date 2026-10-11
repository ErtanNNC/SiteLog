import { Toaster as Sonner } from 'sonner';

export function Toaster() {
  return (
    <Sonner
      position="bottom-right"
      closeButton
      toastOptions={{
        unstyled: true,
        classNames: {
          toast:
            'flex w-full items-center gap-3 rounded-card border border-rebar bg-chalk px-4 py-3 text-[15px] text-asphalt font-sans',
          title: 'font-semibold',
          description: 'text-dust text-caption',
          error: 'border-missing',
          success: 'border-filed',
          closeButton: 'text-dust',
        },
      }}
    />
  );
}
