import { Link, useParams } from 'react-router';
import { Logo } from '@/components/shell/Sidebar';
import { EmptyState } from '@/components/sitelog/States';
import { PageHeader } from '@/components/sitelog/PageHeader';
import { Button } from '@/components/ui/Button';
import { copy } from '@/copy/en';
import { useAuth } from '@/auth/AuthProvider';

/** P2 · Setup wizard (/setup, /setup/company, /setup/site, /setup/reports) — placeholder with its own dark header. */
export default function SetupPage() {
  const { step } = useParams();
  const { currentOrg } = useAuth();
  const steps = copy.setup.steps as Record<string, string>;
  return (
    <div className="min-h-screen bg-concrete">
      <header className="on-dark flex h-16 items-center justify-between bg-asphalt px-6 text-chalk">
        <div className="flex items-center gap-4">
          <Logo />
          <span className="hidden text-caption text-dust-light sm:inline">
            {copy.setup.header(currentOrg?.name ?? copy.setup.title)}
          </span>
        </div>
        <Button variant="ghost" size="dense" asChild>
          <Link to={currentOrg ? '/' : '/login'}>{copy.setup.saveLater}</Link>
        </Button>
      </header>
      <main className="mx-auto max-w-[1240px] px-4 py-7 md:px-8">
        <PageHeader eyebrow={steps[step ?? 'company'] ?? step} title={copy.setup.title} />
        <EmptyState title={copy.states.comingNextTitle} body={copy.states.comingNext} />
      </main>
    </div>
  );
}
