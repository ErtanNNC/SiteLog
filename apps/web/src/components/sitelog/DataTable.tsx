import type { MouseEvent, ReactNode } from 'react';
import { useNavigate } from 'react-router';
import { copy } from '@/copy/en';
import { useScrollRegion } from '@/lib/useScrollRegion';
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
  /**
   * Row link for pointer users: a click anywhere on the row opens it. Keyboard and screen-reader
   * users get the real link a cell renders (every rowHref table must render one), so the row
   * itself is not a second, nested tab stop and keeps its table-row semantics.
   */
  rowHref?: (row: T) => string | null | undefined;
  rowTone?: (row: T) => 'default' | 'missing' | 'attention';
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
  footer,
  empty,
  caption,
  className,
  dense,
  ...rest
}: DataTableProps<T>) {
  const navigate = useNavigate();
  const scrollRegion = useScrollRegion(rest['aria-label'] ?? caption);
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
      {...scrollRegion}
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
                    clickable && 'cursor-pointer hover:bg-concrete/70',
                    dense && '[&>td]:py-2',
                  )}
                  data-href={href ?? undefined}
                  onClick={clickable ? (e) => onRowClick(e, () => void navigate(href)) : undefined}
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

/** Clicks on a link, button or field inside the row do their own thing, not the row's. */
function onRowClick(e: MouseEvent<HTMLTableRowElement>, open: () => void) {
  const target = e.target as Element | null;
  if (target?.closest('a, button, input, select, textarea, label, [role="button"]')) return;
  open();
}

export { TableCell as DataTableCell, TableRow as DataTableRow };
