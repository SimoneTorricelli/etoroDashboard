/**
 * DataTable — tabella densa con header sticky, ordinamento client-side,
 * hover bg-2, righe cliccabili, colonne numeriche allineate a destra.
 * Generica: definisci colonne + righe e passa onRowClick.
 */
import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { ArrowUp } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface DataTableColumn<T> {
  key: string;
  header: ReactNode;
  /** Render della cella. */
  cell: (row: T) => ReactNode;
  /** Valore per l'ordinamento; se assente la colonna non è sortable. */
  sortValue?: (row: T) => number | string;
  align?: 'left' | 'right' | 'center';
  /** Larghezza fissa opzionale (es. "120px"). */
  width?: string;
  /** Sticky su mobile (prima colonna). */
  sticky?: boolean;
}

export interface DataTableProps<T> {
  columns: DataTableColumn<T>[];
  rows: T[];
  rowKey: (row: T) => string | number;
  onRowClick?: (row: T) => void;
  /** Chiave ordinamento iniziale. */
  defaultSortKey?: string;
  defaultSortDir?: 'asc' | 'desc';
  emptyMessage?: string;
  className?: string;
}

export function DataTable<T>({
  columns, rows, rowKey, onRowClick, defaultSortKey, defaultSortDir = 'desc', emptyMessage = 'Nessun dato', className,
}: DataTableProps<T>) {
  const [sortKey, setSortKey] = useState<string | null>(defaultSortKey ?? null);
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>(defaultSortDir);

  const sorted = useMemo(() => {
    if (!sortKey) return rows;
    const col = columns.find((c) => c.key === sortKey);
    if (!col?.sortValue) return rows;
    const dir = sortDir === 'asc' ? 1 : -1;
    return [...rows].sort((a, b) => {
      const va = col.sortValue!(a);
      const vb = col.sortValue!(b);
      if (typeof va === 'number' && typeof vb === 'number') return (va - vb) * dir;
      return String(va).localeCompare(String(vb)) * dir;
    });
  }, [rows, columns, sortKey, sortDir]);

  const toggleSort = (key: string) => {
    if (sortKey === key) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDir('desc');
    }
  };

  return (
    <div className={cn('overflow-x-auto', className)}>
      <table className="w-full border-collapse text-body">
        <thead>
          <tr className="border-b border-hairline bg-bg-2/60">
            {columns.map((col) => (
              <th
                key={col.key}
                style={{ width: col.width }}
                className={cn(
                  'sticky top-0 z-10 bg-bg-2 px-3 py-2 text-label font-medium uppercase tracking-[0.04em] text-text-2',
                  col.align === 'right' ? 'text-right' : col.align === 'center' ? 'text-center' : 'text-left',
                  col.sticky && 'left-0 z-20',
                  col.sortValue && 'cursor-pointer select-none hover:text-text-1',
                )}
                onClick={col.sortValue ? () => toggleSort(col.key) : undefined}
              >
                <span className="inline-flex items-center gap-1">
                  {col.header}
                  {col.sortValue && sortKey === col.key && (
                    <ArrowUp
                      className={cn('h-3 w-3 transition-transform duration-200', sortDir === 'desc' && 'rotate-180')}
                      aria-hidden
                    />
                  )}
                </span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sorted.length === 0 && (
            <tr>
              <td colSpan={columns.length} className="px-3 py-8 text-center text-caption text-text-2">
                {emptyMessage}
              </td>
            </tr>
          )}
          {sorted.map((row) => (
            <tr
              key={rowKey(row)}
              onClick={onRowClick ? () => onRowClick(row) : undefined}
              className={cn(
                'density-row border-b border-hairline last:border-0 transition-colors',
                onRowClick && 'cursor-pointer hover:bg-bg-2',
              )}
            >
              {columns.map((col) => (
                <td
                  key={col.key}
                  className={cn(
                    'px-3 py-2 align-middle tabular-nums',
                    col.align === 'right' ? 'text-right' : col.align === 'center' ? 'text-center' : 'text-left',
                    col.sticky && 'sticky left-0 bg-bg-1',
                  )}
                >
                  {col.cell(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
