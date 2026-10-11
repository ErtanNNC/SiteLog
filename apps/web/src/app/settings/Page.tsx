import { useParams } from 'react-router';
import { ComingNext } from '../ComingNext';
import { copy } from '@/copy/en';

/** P12 · Settings (/settings/reports · pdf · recipients · payroll) — placeholder. */
export default function SettingsPage() {
  const { section } = useParams();
  const tabs = copy.settings.tabs as Record<string, string>;
  return <ComingNext title={copy.settings.title} eyebrow={tabs[section ?? 'reports'] ?? section} />;
}
