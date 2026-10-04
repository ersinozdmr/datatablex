import type { DataTableEndpointFieldMeta, DataTableEndpointMeta } from "@datatablex/core";
import type { ReactDataTableColumn } from "../types.js";
import { columnField } from "@datatablex/core";
import { ruleOperatorsFor } from "./filterRules.js";

function narrowColumn<T>(
  column: ReactDataTableColumn<T>,
  field: DataTableEndpointFieldMeta | undefined,
  serverOptions: boolean,
): ReactDataTableColumn<T> {
  // A column that is not in the whitelist (computed, or only rendered) can be
  // neither filtered nor sorted: trying it gets a FieldNotAllowedError.
  if (!field) return column.filterable || column.sortable ? { ...column, filterable: false, sortable: false } : column;

  const filterOperators = column.filterOperators
    ? column.filterOperators.filter((op) => field.filterOperators.includes(op))
    : field.filterOperators;
  const next: ReactDataTableColumn<T> = { ...column, filterOperators, sortable: Boolean(column.sortable) && field.sortable };
  // Hand-written `options` take priority (an empty array included); the options
  // are expected from the server only when none were given at all. The
  // capability does not widen: the column must still be `filterable: true`, and
  // at least one of the backend operators must remain.
  if (serverOptions && field.hasOptions && column.type === "enum" && column.options === undefined) next.optionsState = "idle";
  if (next.filterable) {
    // The filter bar offers only the rules whose compiled wire operators are
    // all open (see `ruleOperatorsFor`); a column left with none cannot be filtered.
    if (!ruleOperatorsFor(next).length) next.filterable = false;
  }
  return next;
}

/**
 * Narrows the columns by the endpoint meta: operators are intersected with the
 * ones the backend allows, a column the backend does not sort cannot be sorted,
 * and a column left with no rule the bar could offer cannot be filtered. It
 * does NOT WIDEN any capability: a column whose `filterable` or `sortable` was
 * not turned on stays off even when the meta has it on.
 *
 * `serverOptions` says whether the DataSource offers `getOptions`. When it
 * does, the enum columns that the meta reports with `hasOptions` and that have
 * no hand-written `options` get `optionsState: "idle"`.
 *
 * Returns the narrowed columns, and in `disabled` the `key` of every column
 * that was filterable or sortable before and is not any more.
 */
export function applyEndpointMeta<T>(
  columns: ReactDataTableColumn<T>[],
  meta: DataTableEndpointMeta,
  serverOptions = false,
): { columns: ReactDataTableColumn<T>[]; disabled: string[] } {
  const disabled: string[] = [];
  const narrowed = columns.map((column) => {
    const field = columnField(column);
    // A column with no backend counterpart (field: null) stays as it is, without looking at the meta.
    if (field === null) return column;
    const next = narrowColumn(column, meta.fields[field], serverOptions);
    if ((column.filterable && !next.filterable) || (column.sortable && !next.sortable)) disabled.push(column.key);
    return next;
  });
  return { columns: narrowed, disabled };
}
