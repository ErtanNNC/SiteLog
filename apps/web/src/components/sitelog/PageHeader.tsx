import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { useCopy } from '@/i18n/useCopy';
import { cn } from '@/lib/utils';

export interface PageHeaderProps {
  eyebrow?: ReactNode;
  title: ReactNode;
  subtitle?: ReactNode;
  /** Right-aligned actions; at most one primary orange button. */
  actions?: ReactNode;
  breadcrumb?: Array<{ label: string; to?: string }>;
  className?: string;
}

/** Mono eyebrow · H1 34 px Archivo Expanded 800 · subtitle · actions. */
export function PageHeader({
  eyebrow,
  title,
  subtitle,
  actions,
  breadcrumb,
  className,
}: PageHeaderProps) {
  const { t } = useCopy();
  return (
    <header
      className={cn(
        'mb-6 flex flex-col gap-4 md:flex-row md:items-end md:justify-between',
        className,
      )}
    >
      <div className="min-w-0">
        {breadcrumb?.length ? (
          <nav
            aria-label={t('siteDetail.breadcrumbLabel')}
            className="mb-2 flex flex-wrap items-center gap-1 text-caption text-dust"
          >
            {breadcrumb.map((b, i) => (
              <span key={`${b.label}-${i}`} className="inline-flex items-center gap-1">
                {b.to ? (
                  <Link to={b.to} className="hover:text-asphalt hover:underline">
                    {b.label}
                  </Link>
                ) : (
                  <span className="text-asphalt">{b.label}</span>
                )}
                {i < breadcrumb.length - 1 ? <span aria-hidden="true">/</span> : null}
              </span>
            ))}
          </nav>
        ) : null}
        {eyebrow ? <div className="eyebrow mb-1 text-dust">{eyebrow}</div> : null}
        <h1 className="font-display text-[28px] leading-[34px] md:text-h1">{title}</h1>
        {subtitle ? <p className="mt-1 text-[15px] text-dust">{subtitle}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
    </header>
  );
}
