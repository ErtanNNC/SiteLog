import { Hammer } from 'lucide-react';
import type { ReactNode } from 'react';
import { PageHeader } from '@/components/sitelog/PageHeader';
import { EmptyState } from '@/components/sitelog/States';
import { useCopy } from '@/i18n/useCopy';

/**
 * A route that exists before its page does (`/dev/phone`, `/settings/channels`): the page header,
 * then "Coming next". `children` sit between the two (e.g. a page's tabs).
 */
export function ComingNext({
  title,
  subtitle,
  eyebrow,
  breadcrumb,
  children,
}: {
  title: string;
  subtitle?: string;
  eyebrow?: string;
  breadcrumb?: Array<{ label: string; to?: string }>;
  children?: ReactNode;
}): ReactNode {
  const { t } = useCopy();
  return (
    <>
      <PageHeader title={title} subtitle={subtitle} eyebrow={eyebrow} breadcrumb={breadcrumb} />
      {children}
      <EmptyState icon={Hammer} title={t('states.comingNextTitle')} body={t('states.comingNext')} />
    </>
  );
}
