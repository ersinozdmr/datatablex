import type { ReactNode } from "react";
import type { ExportDefinition } from "@datatablex/core";
import type { TableInstance, UseDataTableOptions } from "@datatablex/react";
import type { DataTableLocale } from "./locale.js";

/** Options of `DataTableProps.filterBar`. */
export interface FilterBarOptions {
  /**
   * `"simple"`: chips and per-rule editing. `"advanced"`: additionally offers
   * the advanced builder, which assembles nested `AND`/`OR` groups through a
   * draft, then apply flow. To share nested filters as a link, use it together
   * with `syncWithUrl`.
   *
   * @default "simple"
   */
  mode?: "simple" | "advanced";
  /**
   * Maximum depth of the filter tree, counted the same way as the backend's
   * `maxFilterDepth`. If omitted, the value from the endpoint metadata is used,
   * or 3 when there is no metadata. If a value larger than the metadata's is
   * given, the smaller one applies. It applies in both modes: in simple mode a
   * datetime "on a day" or "between" rule is compiled into a `gte` + `lt` group
   * and therefore counts as one level.
   *
   * @default 3
   */
  maxDepth?: number;
  /**
   * Maximum number of rules (leaves) in the filter tree, counted the same way as
   * the backend's `maxFilterCount`. If omitted, the value from the endpoint
   * metadata is used, or 50 when there is no metadata. If a value larger than
   * the metadata's is given, the smaller one applies.
   *
   * @default 50
   */
  maxRules?: number;
}

/** Props shared by both forms of `DataTableProps`. */
export interface DataTableCommonProps {
  /**
   * Show the search box in the toolbar.
   *
   * @default false
   */
  searchable?: boolean;
  /**
   * Show row selection checkboxes.
   *
   * @default false
   */
  selectable?: boolean;
  /**
   * Add the panel to show, hide and reorder columns to the toolbar.
   *
   * @default false
   */
  columnManagement?: boolean;
  /** Format x scope export actions offered in the toolbar. */
  export?: ExportDefinition;
  /** Content shown when the result is empty. */
  empty?: ReactNode;
  /**
   * Rendered ABOVE the table while `error` is set; if omitted, a default Ant
   * Design `Alert` is used. The toolbar, the column headers (filter and sort
   * menus) and the last successful data STAY IN PLACE, so the user can fix the
   * query that caused the error.
   */
  errorRender?: (error: Error, retry: () => Promise<void>) => ReactNode;
  /**
   * Font of the Ant Design components inside the table. Pass `false` to let the
   * table inherit the `fontFamily` of the consumer's `ConfigProvider` theme
   * as is (no theme layer is added for the font alone; table-specific theming
   * such as the transparent header background is still applied).
   *
   * @default '"Segoe UI", ui-sans-serif, system-ui, sans-serif'
   */
  fontFamily?: string | false;
  /**
   * Texts the table produces itself (toolbar, column menu, filter inputs,
   * export menu, default error and empty views). The given keys are merged over
   * the default `enUS`; for a full translation, spread a ready-made object such
   * as `trTR`. Ant Design's own texts (pagination and so on) are set with
   * `ConfigProvider.locale`. Developer errors thrown by `useDataTable`
   * (`[datatablex] ...`) are not covered.
   *
   * @default enUS
   * @example
   * ```tsx
   * <DataTable locale={{ apply: "Apply filters" }} ... />
   * ```
   */
  locale?: Partial<DataTableLocale>;
  /**
   * Filter bar above the table: it shows the active filters as chips and lets
   * the user add, edit and delete rules; it is the table's only filter
   * interface. It is on by default (simple mode) when there is a filterable
   * column; `false` hides it. The bar reads and writes `table.filters`; nodes it
   * cannot represent (for example `OR`) are kept and shown as a read-only
   * summary.
   *
   * @default true when a column is filterable or a locked filter exists
   */
  filterBar?: boolean | FilterBarOptions;
}

/**
 * Props of `<DataTable>`. It takes one of two forms, and the two cannot be
 * given TOGETHER:
 *
 * - **Controlled:** a ready-made `table` (the return value of `useDataTable`).
 *   The calling code owns the state; the hook options (`dataSource`, `columns`,
 *   `rowKey`, `lockedFilters` ...) must not be given, because they would be
 *   silently ignored.
 * - **Options:** all options of `useDataTable`; the component calls the hook
 *   itself.
 *
 * @example
 * Options form:
 * ```tsx
 * <DataTable
 *   dataSource={rows}
 *   columns={columns}
 *   rowKey="id"
 *   searchable
 *   selectable
 *   columnManagement
 * />
 * ```
 *
 * @example
 * Controlled form:
 * ```tsx
 * const table = useDataTable({ dataSource: rows, columns, rowKey: "id" });
 * return <DataTable table={table} searchable />;
 * ```
 */
export type DataTableProps<T> = DataTableCommonProps &
  (
    | ({ table: TableInstance<T> } & { [K in keyof UseDataTableOptions<T>]?: never })
    | (UseDataTableOptions<T> & { table?: never })
  );