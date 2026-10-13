import { Screen, ScreenTitle } from '@/components/Screen';
import { useFieldCopy } from '@/i18n/useFieldCopy';
import type { FieldScreen } from './paths';

/** A §9.3 route before its screen exists (W1-04): the shell, the route's title and one line. */
export function Placeholder({ screen }: { screen: FieldScreen }) {
  const { t } = useFieldCopy();
  const title = t(`routes.${screen}`);
  return (
    <Screen title={title} settings={screen === 'today'}>
      <ScreenTitle>{title}</ScreenTitle>
      <p className="m-0 text-dust">{t('placeholderBody')}</p>
    </Screen>
  );
}
