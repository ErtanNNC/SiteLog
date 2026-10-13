import { Link } from 'react-router';
import { Screen, ScreenTitle } from '@/components/Screen';
import { useFieldCopy } from '@/i18n/useFieldCopy';
import { HOME_PATH } from './paths';

/**
 * Any path that is not a §9.3 route (the field host serves the app for every path), such as a
 * truncated SMS link. The installed app has no URL bar or back button (`display: standalone`), so
 * the screen's one action (§14.6, in the bottom action bar) goes to Today.
 */
export function NotFound() {
  const { t } = useFieldCopy();
  return (
    <Screen title={t('notFound.title')} dateLine={false}>
      <ScreenTitle>{t('notFound.title')}</ScreenTitle>
      <p className="m-0 text-dust">{t('notFound.body')}</p>
      <div className="sticky bottom-0 mt-auto bg-chalk pt-3">
        <Link
          to={HOME_PATH}
          replace
          className="flex h-target w-full items-center justify-center rounded-btn bg-asphalt px-5 text-center text-[17px] font-bold text-chalk no-underline"
        >
          {t('notFound.action')}
        </Link>
      </div>
    </Screen>
  );
}
