import { useFieldCopy } from '@/i18n/useFieldCopy';

/** What a crashed screen shows: one line and a reload, in the app's language. */
export function CrashScreen() {
  const { tc } = useFieldCopy();
  return (
    <main className="flex min-h-dvh flex-col justify-center gap-4 bg-chalk px-[18px] text-asphalt">
      <title>{tc('appName')}</title>
      <h1 className="m-0 text-[24px] leading-8 font-bold">{tc('errorTitle')}</h1>
      <button
        type="button"
        onClick={() => window.location.reload()}
        className="h-target rounded-btn bg-asphalt px-5 text-[17px] font-bold text-chalk"
      >
        {tc('retry')}
      </button>
    </main>
  );
}
