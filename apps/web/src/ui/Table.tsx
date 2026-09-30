import type { ReactNode } from 'react';
import { tUi } from '../strings/ui.ts';
import { cx } from './cx.ts';

export interface TableColumn<Row> {
  readonly id: string;
  readonly header: ReactNode;
  readonly cell: (row: Row) => ReactNode;
  readonly align?: 'start' | 'end' | 'center';
  /** CSS width, e.g. '8rem' or '20%'. */
  readonly width?: string;
  /** Visually hide the header text (e.g. an actions column); it stays for screen readers. */
  readonly hideHeader?: boolean;
}

export interface TableProps<Row> {
  /** Accessible table name (zh-TW). Shown as a caption unless `hideCaption`. */
  caption: string;
  hideCaption?: boolean;
  columns: readonly TableColumn<Row>[];
  rows: readonly Row[];
  rowKey(row: Row): string;
  /** Shown in place of the rows when there are none. */
  empty?: ReactNode;
  className?: string;
  /** Dense rows for information-heavy lists (default true). */
  dense?: boolean;
}

/** A semantic data table (real <table>, <th scope="col">), styled for dense workbench lists. */
export function Table<Row>({ caption, hideCaption = false, columns, rows, rowKey, empty, className, dense = true }: TableProps<Row>) {
  return (
    <div className={cx('ui-table-wrap', className)}>
      <table className={cx('ui-table', dense && 'ui-table--dense')}>
        <caption className={hideCaption ? 'ui-visually-hidden' : 'ui-table__caption'}>{caption}</caption>
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column.id} scope="col" style={{ width: column.width, textAlign: column.align ?? 'start' }}>
                {column.hideHeader ? <span className="ui-visually-hidden">{column.header}</span> : column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={columns.length} className="ui-table__empty">
                {empty ?? tUi('table.empty')}
              </td>
            </tr>
          ) : (
            rows.map((row) => (
              <tr key={rowKey(row)}>
                {columns.map((column) => (
                  <td key={column.id} style={{ textAlign: column.align ?? 'start' }}>
                    {column.cell(row)}
                  </td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}
