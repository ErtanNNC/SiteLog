import { useParams } from 'react-router';
import { ComingNext } from '../ComingNext';
import { copy } from '@/copy/en';

/** P7 · Report review — placeholder. */
export default function ReportDetailPage() {
  const { reportId } = useParams();
  return (
    <ComingNext
      title={copy.reports.title}
      eyebrow={reportId}
      breadcrumb={[{ label: copy.report.breadcrumb, to: '/reports' }, { label: reportId ?? '' }]}
    />
  );
}
