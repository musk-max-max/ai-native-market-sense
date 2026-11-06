import type { ReactNode } from 'react';
import { EmptyState } from './EmptyState';
import { TESTIDS } from '../lib/testids';

export interface Column<T> {
  key: string;
  title: string;
  render: (row: T) => ReactNode;
  align?: 'left' | 'right';
  width?: string;
}

export interface DataTableProps<T> {
  columns: readonly Column<T>[];
  rows: readonly T[];
  rowKey: (row: T) => string;
  caption?: string;
  emptyText?: string;
  loading?: boolean;
  selectedKey?: string;
  onRowClick?: (row: T) => void;
  testId?: string;
}

/** 四中台共用数据表格（禁止各域各写一套表格）。 */
export function DataTable<T>({
  columns,
  rows,
  rowKey,
  caption,
  emptyText = '暂无数据',
  loading = false,
  selectedKey,
  onRowClick,
  testId,
}: DataTableProps<T>) {
  if (loading) {
    return <EmptyState title="加载中…" />;
  }
  if (rows.length === 0) {
    return <EmptyState title={emptyText} />;
  }

  return (
    <div className="c-table-wrap">
      <table className="c-table" data-testid={testId ?? TESTIDS.dataTable}>
        {caption ? <caption>{caption}</caption> : null}
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column.key} scope="col" style={column.width ? { width: column.width } : undefined}>
                {column.title}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const key = rowKey(row);
            const clickable = Boolean(onRowClick);
            return (
              <tr
                key={key}
                className={clickable ? 'is-clickable' : undefined}
                aria-selected={selectedKey === key ? true : undefined}
                onClick={onRowClick ? () => onRowClick(row) : undefined}
                data-testid={TESTIDS.dataTableRow(key)}
              >
                {columns.map((column) => (
                  <td key={column.key} style={column.align === 'right' ? { textAlign: 'right' } : undefined}>
                    {column.render(row)}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
