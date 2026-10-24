import { Screen } from '@/components/Screen';
import { useFieldCopy } from '@/i18n/useFieldCopy';

/** While a lazy screen's chunk loads (Talk now, W3-13): the dark call screen's frame, "Loading…". */
export function RouteLoading() {
  const { t, tc } = useFieldCopy();
  return (
    <Screen title={t('talk.title')} dark dateLine={false}>
      <h1 className="sr-only">{t('talk.title')}</h1>
      <p role="status" className="m-0 text-dust-light">
        {tc('loading')}
      </p>
    </Screen>
  );
}
