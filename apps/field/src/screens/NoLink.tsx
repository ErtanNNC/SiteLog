import { Screen, ScreenTitle } from '@/components/Screen';
import { useFieldCopy } from '@/i18n/useFieldCopy';

/** The installed app (or `/today`) opened before any link was resolved on this phone. */
export function NoLink() {
  const { t } = useFieldCopy();
  return (
    <Screen title={t('link.none.title')} dateLine={false}>
      <ScreenTitle>{t('link.none.title')}</ScreenTitle>
      <p className="m-0 text-dust">{t('link.none.body')}</p>
    </Screen>
  );
}
