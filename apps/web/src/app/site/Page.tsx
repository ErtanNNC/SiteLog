import { useParams } from 'react-router';
import { ComingNext } from '../ComingNext';
import { copy } from '@/copy/en';

/** P5 · Site detail — placeholder (route + shell wired; page to be built). */
export default function SiteDetailPage() {
  const { siteId } = useParams();
  return (
    <ComingNext
      title={copy.nav.sites}
      eyebrow={siteId}
      breadcrumb={[{ label: copy.siteDetail.breadcrumb, to: '/sites' }, { label: siteId ?? '' }]}
    />
  );
}
