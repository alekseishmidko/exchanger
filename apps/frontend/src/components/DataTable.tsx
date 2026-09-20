import {
  ColumnDef,
  flexRender,
  getCoreRowModel,
  useReactTable,
} from '@tanstack/react-table';
import { memo, useMemo } from 'react';

type DataTableProps<T extends object> = Readonly<{
  title: string;
  rows: readonly T[];
  columns: ColumnDef<T>[];
  emptyText?: string;
}>;

/**
 * Универсальная таблица на TanStack Table.
 *
 * Компонент intentionally не знает о конкретных DTO биржи. Экран передаёт
 * публичные rows/columns, а таблица отвечает только за стабильный render,
 * empty-state и одинаковую визуальную плотность для order history, balances,
 * instruments, audit events и журнала HTTP-запросов.
 */
function DataTableComponent<T extends object>({
  title,
  rows,
  columns,
  emptyText = 'Нет данных',
}: DataTableProps<T>) {
  const data = useMemo(() => [...rows], [rows]);
  const table = useReactTable({
    data,
    columns,
    getCoreRowModel: getCoreRowModel(),
  });

  return (
    <section className="panel table-panel">
      <div className="panel-title-row">
        <h2>{title}</h2>
        <span className="muted">{rows.length} rows</span>
      </div>
      <div className="table-scroll">
        <table>
          <thead>
            {table.getHeaderGroups().map((headerGroup) => (
              <tr key={headerGroup.id}>
                {headerGroup.headers.map((header) => (
                  <th key={header.id}>
                    {header.isPlaceholder
                      ? null
                      : flexRender(header.column.columnDef.header, header.getContext())}
                  </th>
                ))}
              </tr>
            ))}
          </thead>
          <tbody>
            {table.getRowModel().rows.length === 0 ? (
              <tr>
                <td colSpan={columns.length} className="empty-cell">
                  {emptyText}
                </td>
              </tr>
            ) : (
              table.getRowModel().rows.map((row) => (
                <tr key={row.id}>
                  {row.getVisibleCells().map((cell) => (
                    <td key={cell.id}>{flexRender(cell.column.columnDef.cell, cell.getContext())}</td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/**
 * Memo-обёртка предотвращает повторный render тяжёлых таблиц при каждом запросе,
 * если сами rows/columns не изменились. Это особенно важно для manual console:
 * верхняя часть экрана часто меняет timeline/log state, но таблицы instruments,
 * balances и projections должны оставаться неподвижными.
 */
export const DataTable = memo(DataTableComponent) as typeof DataTableComponent;
