import { Hammer } from 'lucide-react';
import type { ReactNode } from 'react';
import { PageHeader } from '@/components/sitelog/PageHeader';
import { EmptyState } from '@/components/sitelog/States';
import { copy } from '@/copy/en';

/** Route placeholder: other agents replace the page file; the route and shell already work. */
export function ComingNext({
  title,
  subtitle,
  eyebrow,
  breadcrumb,
}: {
  title: string;
  subtitle?: string;
  eyebrow?: string;
  breadcrumb?: Array<{ label: string; to?: string }>;
}): ReactNode {
  return (
    <>
      <PageHeader title={title} subtitle={subtitle} eyebrow={eyebrow} breadcrumb={breadcrumb} />
      <EmptyState icon={Hammer} title={copy.states.comingNextTitle} body={copy.states.comingNext} />
    </>
  );
}
