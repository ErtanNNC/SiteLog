import type { ReactNode } from 'react';
import { useNavigate } from 'react-router';
import { copy } from '@/copy/en';
import { cn } from '@/lib/utils';
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from '../ui/Table';
import { EmptyState } from './States';

export interface Column<T> {
  key: string;
  header: ReactNode;
  cell: (row: T) => ReactNode;
  numeric?: boolean;
  className?: string;
  headerClassName?: string;
  /** Hide below md (keeps mobile tables narrow). */
  hideBelowMd?: boolean;
}

export interface DataTableProps<T> {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  /** Row link: the whole row becomes clickable (keyboard: Enter). */
  rowHref?: (row: T) => string | null | undefined;
  rowTone?: (row: T) => 'default' | 'missing' | 'attention';
  rowLabel?: (row: T) => string;
  footer?: ReactNode;
  empty?: { title: string; body?: string; action?: ReactNode };
  caption?: string;
  className?: string;
  dense?: boolean;
  'aria-label'?: string;
}

/** Sticky header, mono right-aligned numbers, row links, empty state, horizontal scroll container. */
export function DataTable<T>({
  columns,
  rows,
  rowKey,
  rowHref,
  rowTone,
  rowLabel,
  footer,
  empty,
  caption,
  className,
  dense,
  ...rest
}: DataTableProps<T>) {
  const navigate = useNavigate();
  if (rows.length === 0 && empty) {
    return (
      <EmptyState
        title={empty.title}
        body={empty.body}
        action={empty.action}
        className={className}
      />
    );
  }
  return (
    <div
      className={cn('w-full overflow-x-auto scrollbar-thin', className)}
      data-testid="data-table"
    >
      <Table aria-label={rest['aria-label']}>
        {caption ? <caption className="sr-only">{caption}</caption> : null}
        <TableHeader>
          <TableRow>
            {columns.map((c) => (
              <TableHead
                key={c.key}
                numeric={c.numeric}
                className={cn(c.hideBelowMd && 'hidden md:table-cell', c.headerClassName)}
              >
                {c.header}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.length === 0 ? (
            <TableRow>
              <TableCell colSpan={columns.length} className="py-8 text-center text-dust">
                {copy.table.empty}
              </TableCell>
            </TableRow>
          ) : (
            rows.map((row) => {
              const href = rowHref?.(row);
              const tone = rowTone?.(row) ?? 'default';
              const clickable = !!href;
              return (
                <TableRow
                  key={rowKey(row)}
                  tone={tone}
                  className={cn(
                    clickable && 'cursor-pointer hover:bg-concrete/70 focus-visible:bg-concrete/70',
                    dense && '[&>td]:py-2',
                  )}
                  tabIndex={clickable ? 0 : undefined}
                  role={clickable ? 'link' : undefined}
                  aria-label={clickable && rowLabel ? copy.table.rowLink(rowLabel(row)) : undefined}
                  onClick={clickable ? () => void navigate(href) : undefined}
                  onKeyDown={
                    clickable ? (e) => e.key === 'Enter' && void navigate(href) : undefined
                  }
                >
                  {columns.map((c) => (
                    <TableCell
                      key={c.key}
                      numeric={c.numeric}
                      className={cn(c.hideBelowMd && 'hidden md:table-cell', c.className)}
                    >
                      {c.cell(row)}
                    </TableCell>
                  ))}
                </TableRow>
              );
            })
          )}
        </TableBody>
        {footer ? <TableFooter>{footer}</TableFooter> : null}
      </Table>
    </div>
  );
}

export { TableCell as DataTableCell, TableRow as DataTableRow };
