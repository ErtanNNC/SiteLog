import { useCopy } from '@/i18n/useCopy';
import { ComingNext } from '../ComingNext';

/**
 * `/dev/phone` · Demo phone (§11.1, admins): the texts of the `console` SMS driver, one thread per
 * reporter. A placeholder until W1-08 builds it, with its "staging or `is_demo` orgs" gate.
 */
export default function DevPhonePage() {
  const { t } = useCopy();
  return <ComingNext title={t('nav.devPhone')} subtitle={t('devPhone.subtitle')} />;
}
