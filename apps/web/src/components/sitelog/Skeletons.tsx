import { copy } from '@/copy/en';
import { cn } from '@/lib/utils';
import { Skeleton } from '../ui/Skeleton';

/** Skeletons matching layout — no spinners in tables (§11.5). */
export function PageSkeleton({
  fullscreen,
  className,
}: {
  fullscreen?: boolean;
  className?: string;
}) {
  return (
    <div
      className={cn(fullscreen && 'min-h-screen bg-concrete p-8', className)}
      role="status"
      aria-label={copy.a11y.loadingPage}
      aria-busy="true"
    >
      <div className="mb-6 space-y-2">
        <Skeleton className="h-4 w-40" />
        <Skeleton className="h-9 w-72" />
        <Skeleton className="h-4 w-96 max-w-full" />
      </div>
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-[132px] rounded-card" />
        ))}
      </div>
      <Skeleton className="mt-6 h-72 rounded-card" />
    </div>
  );
}

export function TableSkeleton({ rows = 6, className }: { rows?: number; className?: string }) {
  return (
    <div
      className={cn('space-y-2 p-5', className)}
      role="status"
      aria-busy="true"
      aria-label={copy.common.loading}
    >
      <Skeleton className="h-4 w-full" />
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} className="h-11 w-full" />
      ))}
    </div>
  );
}

export function CardsSkeleton({ count = 6, className }: { count?: number; className?: string }) {
  return (
    <div
      className={cn(
        'grid gap-4 [grid-template-columns:repeat(auto-fit,minmax(330px,1fr))]',
        className,
      )}
      role="status"
      aria-busy="true"
      aria-label={copy.common.loading}
    >
      {Array.from({ length: count }, (_, i) => (
        <Skeleton key={i} className="h-56 rounded-card" />
      ))}
    </div>
  );
}
